import { Map as MapLibreMap, NavigationControl, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "./styles.css";
import type { WorkerResponse } from "./data/frame.worker";
import { FrameStore, type FrameLoader } from "./data/frameStore";
import { prepareFrames, type Manifest } from "./data/manifest";
import { ParticleLayer } from "./render/particleLayer";
import { advance, framesToRequest, pairToDisplay } from "./timeline/playback";

setWorkerUrl(mapWorkerUrl);

const DATA_URL = import.meta.env.VITE_DATA_URL ?? `${import.meta.env.BASE_URL}data/`;
const BASEMAP = "https://tiles.openfreemap.org/styles/dark";
const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const TEXTURE_CAPACITY = 24;
const CSS_PIXELS_PER_PARTICLE = 30;
const PLAY_ICON = "M4 2.5v11l9-5.5z";
const PAUSE_ICON = "M4 2.5h3v11H4zM9 2.5h3v11H9z";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function showNotice(message: string): void {
  const notice = element("notice");
  notice.textContent = message;
  notice.hidden = false;
}

function createLoader(): FrameLoader {
  const worker = new Worker(new URL("./data/frame.worker.ts", import.meta.url), { type: "module" });
  const loader: FrameLoader = {
    post: (request) => worker.postMessage(request),
    onmessage: null,
  };
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => loader.onmessage?.(event.data);
  return loader;
}

function formatTime(timeMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(timeMs);
}

function addTerrain(map: MapLibreMap, beforeId: string | undefined): void {
  map.addSource("terrain", {
    type: "raster-dem",
    tiles: [TERRAIN_TILES],
    encoding: "terrarium",
    tileSize: 256,
    maxzoom: 12,
    attribution: '<a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a>',
  });
  map.addLayer(
    {
      id: "hillshade",
      type: "hillshade",
      source: "terrain",
      paint: {
        "hillshade-exaggeration": 0.35,
        "hillshade-shadow-color": "#000000",
        "hillshade-highlight-color": "#3a4652",
        "hillshade-accent-color": "#10161d",
      },
    },
    beforeId,
  );
}

async function start(): Promise<void> {
  if (!document.createElement("canvas").getContext("webgl2")) {
    showNotice("WindDrift needs WebGL2, which this browser or device doesn't support.");
    return;
  }

  const response = await fetch(`${DATA_URL}manifest.json`);
  if (!response.ok) throw new Error(`Couldn't load wind data (HTTP ${response.status}).`);
  const manifest = (await response.json()) as Manifest;
  const frames = prepareFrames(manifest.models.gfs.frames);

  const map = new MapLibreMap({
    container: "map",
    style: BASEMAP,
    center: [-98, 38],
    zoom: 3.4,
    minZoom: 1.5,
    maxZoom: 11,
    renderWorldCopies: false,
    attributionControl: { customAttribution: "Wind: NOAA GFS" },
  });
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  await map.once("load");

  const firstSymbol = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
  addTerrain(map, firstSymbol);

  const mobile = matchMedia("(pointer: coarse)").matches;
  const forcedParticles = Number(new URLSearchParams(location.search).get("particles"));
  const layer = forcedParticles
    ? new ParticleLayer(forcedParticles, 0.001)
    : new ParticleLayer(mobile ? 30_000 : 100_000, CSS_PIXELS_PER_PARTICLE);
  map.addLayer(layer, firstSymbol);

  const slider = element<HTMLInputElement>("time");
  const label = element<HTMLOutputElement>("time-label");
  const status = element("status");
  const playButton = element<HTMLButtonElement>("play");
  const playIcon = element("play-icon");
  element("source").textContent = "10 m wind · NOAA GFS forecast";

  const firstMs = frames[0].timeMs;
  const lastMs = frames[frames.length - 1].timeMs;
  slider.min = String(firstMs);
  slider.max = String(lastMs);

  let timeMs = Math.min(Math.max(Date.now(), firstMs), lastMs);
  let playing = false;
  let buffering = false;
  let failed = false;

  const store: FrameStore<WebGLTexture> = new FrameStore<WebGLTexture>({
    urls: frames.map((frame) => `${DATA_URL}${frame.url}`),
    loader: createLoader(),
    upload: (grid, data) => layer.createWindTexture(grid, data),
    release: (texture) => layer.deleteWindTexture(texture),
    capacity: TEXTURE_CAPACITY,
    onChange: () => {
      failed = false;
      applyTime();
    },
    onError: (url, message) => {
      console.error(`Wind frame failed: ${url}: ${message}`);
      failed = true;
      updateStatus();
    },
  });

  function updateStatus(): void {
    status.textContent = failed ? "Couldn't load wind data" : buffering ? "Loading wind data…" : "";
  }

  function applyTime(): void {
    store.request(framesToRequest(frames, timeMs));
    const pair = pairToDisplay(frames, timeMs, store);
    if (pair) {
      const a = store.get(pair.a)!;
      const b = store.get(pair.b)!;
      layer.setWind({ a: a.resource, b: b.resource, mix: pair.mix, grid: a.grid });
    }
    buffering = !pair?.exact;
    slider.value = String(timeMs);
    label.textContent = formatTime(timeMs);
    updateStatus();
  }

  function setPlaying(next: boolean): void {
    playing = next;
    playIcon.setAttribute("d", next ? PAUSE_ICON : PLAY_ICON);
    playButton.setAttribute("aria-label", next ? "Pause" : "Play");
    if (next) {
      if (timeMs >= lastMs) timeMs = firstMs;
      lastTick = performance.now();
      requestAnimationFrame(tick);
    }
  }

  let lastTick = 0;
  function tick(now: number): void {
    if (!playing) return;
    const seconds = Math.min((now - lastTick) / 1000, 0.1);
    lastTick = now;
    const result = advance(frames, timeMs, seconds, 1, store);
    timeMs = result.timeMs;
    applyTime();
    if (result.ended) setPlaying(false);
    else requestAnimationFrame(tick);
  }

  slider.addEventListener("input", () => {
    timeMs = Number(slider.value);
    applyTime();
  });
  playButton.addEventListener("click", () => setPlaying(!playing));

  if (new URLSearchParams(location.search).has("debug")) {
    const stats = element("stats");
    stats.hidden = false;
    setInterval(() => {
      const fps = 1000 / layer.stats.frameMs;
      stats.textContent = `${fps.toFixed(0)} fps · ${layer.stats.particles.toLocaleString()} particles`;
    }, 500);
    Object.assign(window, { winddrift: { map, layer, store } });
  }

  applyTime();
}

start().catch((error: unknown) => {
  console.error(error);
  showNotice(error instanceof Error ? error.message : "Something went wrong loading WindDrift.");
});
