import type { Feature } from "geojson";
import { Map as MapLibreMap, NavigationControl, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "./styles.css";
import type { FrameGrid } from "./data/frame";
import type { WorkerResponse } from "./data/frame.worker";
import { FrameStore, type FrameLoader } from "./data/frameStore";
import {
  coarsen,
  NEST_FADE_MS,
  nestWeight,
  prepareFrames,
  type Manifest,
  type TimedFrame,
  type ViewsIndex,
} from "./data/manifest";
import { nightRing } from "./render/night";
import { ParticleLayer, type WindTextures } from "./render/particleLayer";
import { buildShare, parseShare, type ShareState } from "./share";
import { TracerController } from "./tracer/controller";
import {
  advance,
  dataAgeText,
  HOUR_MS,
  loadPlan,
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
const NIGHT_REFRESH_MS = 10 * 60 * 1000;
const NIGHT_SOURCE = "night";
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

function dateFormats(timeZone?: string) {
  return {
    full: new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone,
    }),
    short: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone }),
  };
}

/** Fill the view picker. The site still works if this fails, so failure only hides it. */
async function populateViews(picker: HTMLSelectElement, currentView?: string): Promise<void> {
  try {
    const response = await fetch(`${DATA_URL}views/index.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { views } = (await response.json()) as ViewsIndex;
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const view of views) {
      let group = groups.get(view.group);
      if (!group) {
        group = document.createElement("optgroup");
        group.label = view.group;
        groups.set(view.group, group);
        picker.append(group);
      }
      group.append(new Option(view.title, view.id, false, view.id === currentView));
    }
  } catch (error) {
    console.warn(`Showcase views unavailable: ${String(error)}`);
    if (!currentView) picker.hidden = true;
  }
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

  const shared = parseShare(location.search);
  const response = await fetch(`${DATA_URL}${shared.view ? `views/${shared.view}/` : ""}manifest.json`);
  const missing = shared.view ? `There's no view called "${shared.view}".` : "Couldn't load wind data.";
  if (!response.ok) throw new Error(missing);
  const manifest = (await response.json().catch(() => {
    throw new Error(missing);
  })) as Manifest;
  const view = manifest.view;
  const formats = dateFormats(view?.timeZone);
  const baseFrames = prepareFrames(manifest.models.gfs.frames);
  const nestFrames = prepareFrames(manifest.models.hrrr.frames);

  const map = new MapLibreMap({
    container: "map",
    style: BASEMAP,
    center: shared.camera ? [shared.camera.lon, shared.camera.lat] : (view?.center ?? [-98, 38]),
    zoom: shared.camera?.zoom ?? view?.zoom ?? 3.4,
    minZoom: 1.5,
    maxBounds: view?.maxBounds,
    maxZoom: 11,
    renderWorldCopies: false,
    attributionControl: { customAttribution: "Wind: NOAA HRRR and GFS" },
  });
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  // Start once the style is ready. Waiting for "load" would hold the wind back until every
  // map and terrain tile had arrived.
  await map.once("style.load");

  const firstSymbol = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
  addTerrain(map, firstSymbol);
  if (view?.night) addNight(map, firstSymbol);

  const params = new URLSearchParams(location.search);
  const mobile = matchMedia("(pointer: coarse)").matches;
  const forcedParticles = Number(params.get("particles"));
  const layer = forcedParticles
    ? new ParticleLayer(forcedParticles, 0.001)
    : new ParticleLayer(mobile ? 30_000 : 100_000, CSS_PIXELS_PER_PARTICLE);
  map.addLayer(layer, firstSymbol);

  // For people who ask for less motion: particles draw a still picture of the wind, and move
  // only briefly when the time or the map changes.
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  layer.setStill(reducedMotion.matches);
  reducedMotion.addEventListener("change", () => layer.setStill(reducedMotion.matches));
  map.on("move", () => layer.wake());

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

  // A replay spans its regional frames. Its global frames extend past them to cover both ends.
  const nestStartMs = nestFrames[0].timeMs;
  const nestEndMs = nestFrames[nestFrames.length - 1].timeMs;
  const firstMs = view ? nestStartMs : Math.min(baseFrames[0].timeMs, nestStartMs);
  const lastMs = view ? nestEndMs : Math.max(baseFrames[baseFrames.length - 1].timeMs, nestEndMs);
  slider.min = String(firstMs);
  slider.max = String(lastMs);
  element("range-start").textContent = formats.short.format(firstMs);
  element("range-end").textContent = formats.short.format(lastMs);

  const nestFadeMs = view ? 0 : NEST_FADE_MS;
  const tracer = new TracerController(
    map,
    DATA_URL,
    baseFrames,
    nestFrames,
    lastMs,
    (ms) => formats.full.format(ms),
    nestFadeMs,
  );
  tracer.addLayers(firstSymbol);

  const clamp = (timeMs: number) => Math.min(Math.max(timeMs, firstMs), lastMs);
  const openingTime = view ? (view.opensAt ? Date.parse(view.opensAt) : firstMs) : Date.now();
  let timeMs = clamp(shared.timeMs ?? openingTime);
  let timeChosen = shared.timeMs !== undefined;
  let cameraMoved = shared.camera !== undefined;
  let lastNightMs = Number.NEGATIVE_INFINITY;
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

    const weight = nestWeight(nestFrames, timeMs, nestFadeMs);
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
    if (view) return;
    track.style.setProperty("--now", String(timelineFraction(Date.now(), firstMs, lastMs)));
    element("data-age").textContent = dataAgeText(Date.parse(manifest.generated), Date.now());
  }

  function cameraKey(): string {
    const center = map.getCenter();
    return `${center.lng.toFixed(3)},${center.lat.toFixed(3)},${map.getZoom().toFixed(2)}`;
  }

  function currentShareState(forLink: boolean): ShareState {
    const center = map.getCenter();
    return {
      view: view?.id,
      timeMs: forLink || timeChosen ? timeMs : undefined,
      camera: forLink || cameraMoved ? { lon: center.lng, lat: center.lat, zoom: map.getZoom() } : undefined,
      tracer: tracer.shareState,
    };
  }

  /** Keep the address current, so reloading or copying it returns to the same place. */
  function syncAddress(): void {
    history.replaceState(null, "", location.pathname + buildShare(currentShareState(false), location.search));
  }

  function updateNight(): void {
    // The terminator barely moves in a few minutes, and redrawing it isn't free.
    if (!view?.night || Math.abs(timeMs - lastNightMs) < NIGHT_REFRESH_MS) return;
    lastNightMs = timeMs;
    (map.getSource(NIGHT_SOURCE) as GeoJSONSource).setData(nightShape(timeMs));
  }

  function applyTime(): void {
    const plan = loadPlan(
      activeFrames(baseFrames),
      activeFrames(nestFrames),
      timeMs,
      {
        playing,
        lookahead: playing ? speed.lookahead : SPEEDS[0].lookahead,
        nestActive: nestWeight(nestFrames, timeMs, nestFadeMs) > 0,
      },
      (index) => baseStore.isReady(index),
      (index) => nestStore.isReady(index),
    );
    baseStore.request(plan.base);
    nestStore.request(plan.nest);

    const { wind, ready, nested } = currentWind();
    if (wind) layer.setWind(wind);
    tracer.setTime(timeMs);
    updateNight();
    updateStatus(!ready);

    slider.value = String(timeMs);
    const timeText = formats.full.format(timeMs);
    const phaseText = view ? "Replay" : phaseAt(timeMs, Date.now());
    label.textContent = timeText;
    phase.textContent = phaseText;
    phase.dataset.phase = phaseText;
    slider.setAttribute("aria-valuetext", `${timeText}, ${phaseText}`);
    const regional = view?.loop ? "10 m wind · HRRR at about 3 km" : "10 m wind · HRRR over the US, GFS elsewhere";
    source.textContent = nested ? regional : "10 m wind · GFS";
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
    if (!next && timeChosen) syncAddress();
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
    timeChosen = true;
    applyTime();
    syncAddress();
  }

  function tick(now: number): void {
    if (!playing) return;
    const seconds = Math.min((now - lastTick) / 1000, 0.1);
    lastTick = now;
    const result = advance(timeMs, lastMs, seconds, speed.multiplier, currentWind().ready);
    timeMs = result.ended && view?.loop ? firstMs : result.timeMs;
    timeChosen = true;
    applyTime();
    if (result.ended && !view?.loop) setPlaying(false);
    else requestAnimationFrame(tick);
  }

  slider.addEventListener("input", () => {
    timeMs = Number(slider.value);
    timeChosen = true;
    applyTime();
  });
  slider.addEventListener("change", syncAddress);
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
    if (view) {
      location.assign(location.pathname);
      return;
    }
    setPlaying(false);
    timeMs = clamp(Date.now());
    timeChosen = false;
    applyTime();
    syncAddress();
  });

  const picker = element<HTMLSelectElement>("views");
  void populateViews(picker, view?.id);
  picker.addEventListener("change", () => {
    location.assign(location.pathname + buildShare({ view: picker.value || undefined }, location.search));
  });

  const shareButton = element<HTMLButtonElement>("share");
  shareButton.addEventListener("click", async () => {
    const link = location.origin + location.pathname + buildShare(currentShareState(true));
    let message = "Copied";
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      history.replaceState(null, "", link);
      message = "Copy from address bar";
    }
    shareButton.textContent = message;
    setTimeout(() => (shareButton.textContent = "Share"), 2500);
  });

  // Only a real change counts: resizing the window also ends in this event.
  const openingCamera = cameraKey();
  map.on("moveend", () => {
    if (cameraKey() === openingCamera && !cameraMoved) return;
    cameraMoved = true;
    syncAddress();
  });
  tracer.onChange = syncAddress;

  if (view) {
    nowButton.textContent = "Live";
    nowButton.setAttribute("aria-label", "Back to live wind");
    track.classList.add("replay");
    track.style.setProperty("--now", "1");
    element("data-age").textContent = view.loop ? "Loops every 24 hours" : "";
    const summary = element("view-summary");
    summary.textContent = view.summary;
    summary.hidden = false;
    document.title = `${view.title} · WindDrift`;
  }

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

  // A shared link's tracer comes first, then one the view opens with.
  const release = shared.tracer ?? viewTracer(view);
  if (release && release.timeMs >= firstMs && release.timeMs <= lastMs) {
    tracer.restore(release.lon, release.lat, release.timeMs, release.preset);
  }
}

function viewTracer(view: Manifest["view"]): ShareState["tracer"] {
  if (!view?.tracer) return undefined;
  const { lon, lat, time } = view.tracer;
  return { lon, lat, timeMs: Date.parse(time), preset: "smoke" };
}

function nightShape(timeMs: number): Feature {
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [nightRing(timeMs)] } };
}

function addNight(map: MapLibreMap, beforeId: string | undefined): void {
  map.addSource(NIGHT_SOURCE, { type: "geojson", data: nightShape(Date.now()) });
  map.addLayer(
    { id: "night", type: "fill", source: NIGHT_SOURCE, paint: { "fill-color": "#000000", "fill-opacity": 0.45 } },
    beforeId,
  );
}

start().catch((error: unknown) => {
  console.error(error);
  element("status").textContent = "";
  showNotice(error instanceof Error ? error.message : "Something went wrong loading WindDrift.");
});
