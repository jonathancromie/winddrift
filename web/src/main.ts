import { Map as MapLibreMap, NavigationControl, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "./styles.css";
import type { FrameGrid } from "./data/frame";
import type { WorkerResponse } from "./data/frame.worker";
import { FrameStore, type FrameLoader } from "./data/frameStore";
import { coarsen, NEST_FADE_MS, nestWeight, prepareFrames, type Manifest, type TimedFrame } from "./data/manifest";
import { ParticleLayer, type WindTextures } from "./render/particleLayer";
import { TracerController } from "./tracer/controller";
import {
  advance,
  framesToRequest,
  HOUR_MS,
  pairToDisplay,
  phaseAt,
  SPEEDS,
  stepTime,
  timelineFraction,
} from "./timeline/playback";

setWorkerUrl(mapWorkerUrl);

const DATA_URL = import.meta.env.VITE_DATA_URL ?? `${import.meta.env.BASE_URL}data/`;
const BASEMAP = "https://tiles.openfreemap.org/styles/dark";
const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const TEXTURE_CAPACITY = 16;
const CSS_PIXELS_PER_PARTICLE = 30;
const LONG_STEP_MS = 3 * HOUR_MS;
const NOW_REFRESH_MS = 60 * 1000;
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

const fullDate = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

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
  const baseFrames = prepareFrames(manifest.models.gfs.frames);
  const nestFrames = prepareFrames(manifest.models.hrrr.frames);

  const map = new MapLibreMap({
    container: "map",
    style: BASEMAP,
    center: [-98, 38],
    zoom: 3.4,
    minZoom: 1.5,
    maxZoom: 11,
    renderWorldCopies: false,
    attributionControl: { customAttribution: "Wind: NOAA HRRR and GFS" },
  });
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  await map.once("load");

  const firstSymbol = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
  addTerrain(map, firstSymbol);

  const params = new URLSearchParams(location.search);
  const mobile = matchMedia("(pointer: coarse)").matches;
  const forcedParticles = Number(params.get("particles"));
  const layer = forcedParticles
    ? new ParticleLayer(forcedParticles, 0.001)
    : new ParticleLayer(mobile ? 30_000 : 100_000, CSS_PIXELS_PER_PARTICLE);
  map.addLayer(layer, firstSymbol);

  const slider = element<HTMLInputElement>("time");
  const track = element("time-track");
  const label = element<HTMLOutputElement>("time-label");
  const phase = element("phase");
  const status = element("status");
  const source = element("source");
  const playButton = element<HTMLButtonElement>("play");
  const playIcon = element("play-icon");
  const nowButton = element<HTMLButtonElement>("now");
  const speedGroup = element("speeds");
  const speedButtons = SPEEDS.map((option, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    button.setAttribute("aria-label", `${option.multiplier} times speed`);
    button.setAttribute("aria-pressed", String(i === 0));
    speedGroup.append(button);
    return button;
  });

  const firstMs = Math.min(baseFrames[0].timeMs, nestFrames[0].timeMs);
  const lastMs = Math.max(baseFrames[baseFrames.length - 1].timeMs, nestFrames[nestFrames.length - 1].timeMs);
  slider.min = String(firstMs);
  slider.max = String(lastMs);
  element("range-start").textContent = shortDate.format(firstMs);
  element("range-end").textContent = shortDate.format(lastMs);

  const tracer = new TracerController(map, DATA_URL, baseFrames, nestFrames, lastMs, (ms) => fullDate.format(ms));
  tracer.addLayers(firstSymbol);

  const clamp = (timeMs: number) => Math.min(Math.max(timeMs, firstMs), lastMs);
  let timeMs = clamp(Date.now());
  let playing = false;
  let speed = SPEEDS[0];
  let lastTick = 0;
  let failed = false;
  let nestMask: WebGLTexture | null = null;

  function createStore(frames: TimedFrame[], onMask?: (grid: FrameGrid, mask: Uint8Array) => void) {
    return new FrameStore<WebGLTexture>({
      urls: frames.map((frame) => `${DATA_URL}${frame.url}`),
      loader: createLoader(),
      upload: (grid, data) => layer.createWindTexture(grid, data),
      release: (texture) => layer.deleteWindTexture(texture),
      onMask,
      capacity: TEXTURE_CAPACITY,
      onChange: () => {
        failed = false;
        applyTime();
      },
      onError: (url, message) => {
        console.error(`Wind frame failed: ${url}: ${message}`);
        failed = true;
        updateStatus(true);
      },
    });
  }
  const baseStore = createStore(baseFrames);
  const nestStore = createStore(nestFrames, (grid, mask) => {
    nestMask = layer.createMaskTexture(grid, mask);
  });

  /** While playing fast, use wider-spaced frames. Paused views always use every frame. */
  function activeFrames(frames: TimedFrame[]): TimedFrame[] {
    return playing && speed.strideHours > 1 ? coarsen(frames, speed.strideHours) : frames;
  }

  /** Regional frames show only when exact, because coarse wind beats wind from the wrong time. */
  function currentWind(): { wind: WindTextures | null; ready: boolean; nested: boolean } {
    const base = pairToDisplay(activeFrames(baseFrames), timeMs, baseStore);
    if (!base) return { wind: null, ready: false, nested: false };
    const a = baseStore.get(base.a)!;
    const b = baseStore.get(base.b)!;
    const wind: WindTextures = { a: a.resource, b: b.resource, mix: base.mix, grid: a.grid };

    const weight = nestWeight(nestFrames, timeMs, NEST_FADE_MS);
    const pair = weight > 0 ? pairToDisplay(activeFrames(nestFrames), timeMs, nestStore) : null;
    if (pair?.exact && nestMask) {
      const nestA = nestStore.get(pair.a)!;
      const nestB = nestStore.get(pair.b)!;
      wind.nest = {
        a: nestA.resource,
        b: nestB.resource,
        mix: pair.mix,
        grid: nestA.grid,
        mask: nestMask,
        weight,
      };
    }
    const ready = base.exact && (weight === 0 || wind.nest !== undefined);
    return { wind, ready, nested: wind.nest !== undefined };
  }

  function updateStatus(loading: boolean): void {
    status.textContent = failed ? "Couldn't load wind data" : loading ? "Loading wind data…" : "";
  }

  function updateNowMarker(): void {
    track.style.setProperty("--now", String(timelineFraction(Date.now(), firstMs, lastMs)));
  }

  function applyTime(): void {
    const lookahead = playing ? speed.lookahead : SPEEDS[0].lookahead;
    baseStore.request(framesToRequest(activeFrames(baseFrames), timeMs, lookahead));
    const weight = nestWeight(nestFrames, timeMs, NEST_FADE_MS);
    nestStore.request(weight > 0 ? framesToRequest(activeFrames(nestFrames), timeMs, lookahead) : []);

    const { wind, ready, nested } = currentWind();
    if (wind) layer.setWind(wind);
    tracer.setTime(timeMs);
    updateStatus(!ready);

    slider.value = String(timeMs);
    const timeText = fullDate.format(timeMs);
    const phaseText = phaseAt(timeMs, Date.now());
    label.textContent = timeText;
    phase.textContent = phaseText;
    phase.dataset.phase = phaseText;
    slider.setAttribute("aria-valuetext", `${timeText}, ${phaseText}`);
    source.textContent = nested ? "10 m wind · HRRR over the US, GFS elsewhere" : "10 m wind · GFS";
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
    // Pausing or starting can change which frames are in use.
    applyTime();
  }

  function setSpeed(next: (typeof SPEEDS)[number]): void {
    speed = next;
    speedButtons.forEach((button, i) => {
      button.setAttribute("aria-pressed", String(SPEEDS[i] === next));
    });
    applyTime();
  }

  function step(direction: 1 | -1, long: boolean): void {
    setPlaying(false);
    timeMs = stepTime(timeMs, direction, long ? LONG_STEP_MS : HOUR_MS, firstMs, lastMs);
    applyTime();
  }

  function tick(now: number): void {
    if (!playing) return;
    const seconds = Math.min((now - lastTick) / 1000, 0.1);
    lastTick = now;
    const result = advance(timeMs, lastMs, seconds, speed.multiplier, currentWind().ready);
    timeMs = result.timeMs;
    applyTime();
    if (result.ended) setPlaying(false);
    else requestAnimationFrame(tick);
  }

  slider.addEventListener("input", () => {
    timeMs = Number(slider.value);
    applyTime();
  });
  // The slider's own step is too fine for the arrow keys to be useful over several days.
  slider.addEventListener("keydown", (event) => {
    const direction = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
    if (!direction) return;
    event.preventDefault();
    step(direction as 1 | -1, event.shiftKey);
  });
  playButton.addEventListener("click", () => setPlaying(!playing));
  element("step-back").addEventListener("click", (event) => step(-1, event.shiftKey));
  element("step-forward").addEventListener("click", (event) => step(1, event.shiftKey));
  speedButtons.forEach((button, i) => button.addEventListener("click", () => setSpeed(SPEEDS[i])));
  nowButton.addEventListener("click", () => {
    setPlaying(false);
    timeMs = clamp(Date.now());
    applyTime();
  });

  updateNowMarker();
  setInterval(updateNowMarker, NOW_REFRESH_MS);

  if (params.has("debug")) {
    const stats = element("stats");
    stats.hidden = false;
    setInterval(() => {
      const fps = 1000 / layer.stats.frameMs;
      stats.textContent = `${fps.toFixed(0)} fps · ${layer.stats.particles.toLocaleString()} particles`;
    }, 500);
    Object.assign(window, { winddrift: { map, layer, tracer, baseStore, nestStore, currentWind, baseFrames, nestFrames } });
  }

  applyTime();
}

start().catch((error: unknown) => {
  console.error(error);
  showNotice(error instanceof Error ? error.message : "Something went wrong loading WindDrift.");
});
