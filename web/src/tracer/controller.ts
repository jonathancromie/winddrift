import type { Feature, FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { TimedFrame } from "../data/manifest";
import { centerPath, headPositions, PRESETS, type Plume, type PresetName } from "./plume";
import type { TracerRequest, TracerResponse } from "./tracer.worker";
import { TracerLayer } from "./tracerLayer";

const RELEASE_HOURS = 72;
const SOURCE_ID = "tracer-path";

interface Release {
  lon: number;
  lat: number;
  startMs: number;
}

export function formatPlace(lon: number, lat: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lon).toFixed(2)}°${ew}`;
}

/** The end of a run: 72 hours on, or sooner if the wind data ends first. */
export function releaseEnd(startMs: number, lastMs: number): number {
  return Math.min(startMs + RELEASE_HOURS * 3600000, lastMs);
}

/** Connects map clicks, the worker, the plume layer and the tracer panel. */
export class TracerController {
  readonly layer = new TracerLayer();
  /** Hours and frames for the last finished run, for debugging. */
  lastRun: { ms: number; loads: number } | null = null;

  private readonly worker = new Worker(new URL("./tracer.worker.ts", import.meta.url), { type: "module" });
  private readonly panel = document.getElementById("tracer")!;
  private readonly hint = document.getElementById("tracer-hint")!;
  private readonly title = document.getElementById("tracer-title")!;
  private readonly detail = document.getElementById("tracer-detail")!;
  private readonly clearButton = document.getElementById("tracer-clear") as HTMLButtonElement;
  private readonly presetButtons = new Map<PresetName, HTMLButtonElement>();

  private runId = 0;
  private startedAt = 0;
  private release: Release | null = null;
  private plume: Plume | null = null;
  private computing = false;
  private failed = false;
  private preset: PresetName = "smoke";
  private timeMs = 0;
  private drawnPoint = -1;
  private path: [number, number][] = [];
  private readonly scratch = new Float32Array(400);

  constructor(
    private readonly map: MapLibreMap,
    private readonly dataUrl: string,
    private readonly baseFrames: TimedFrame[],
    private readonly nestFrames: TimedFrame[],
    private readonly lastMs: number,
    private readonly formatTime: (timeMs: number) => string,
  ) {
    this.worker.onmessage = (event: MessageEvent<TracerResponse>) => this.handle(event.data);
    this.worker.onerror = (event) => {
      console.error(`Tracer worker failed: ${event.message}`);
      this.fail();
    };

    const group = document.getElementById("tracer-presets")!;
    for (const name of Object.keys(PRESETS) as PresetName[]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = PRESETS[name].label;
      button.setAttribute("aria-pressed", String(name === this.preset));
      button.addEventListener("click", () => this.setPreset(name));
      group.append(button);
      this.presetButtons.set(name, button);
    }
    this.clearButton.addEventListener("click", () => this.clear());

    map.getCanvas().style.cursor = "crosshair";
    map.on("click", (event) => this.drop(event.lngLat.lng, event.lngLat.lat));
  }

  /** Add the map layers. Call once the style has loaded, with the layer to sit beneath. */
  addLayers(beforeId: string | undefined): void {
    const map = this.map;
    map.addLayer(this.layer, beforeId);
    map.addSource(SOURCE_ID, { type: "geojson", data: this.pathData() });
    map.addLayer(
      {
        id: "tracer-route",
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "kind"], "route"],
        paint: { "line-color": ["get", "color"], "line-width": 1, "line-opacity": 0.35, "line-dasharray": [2, 3] },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: "tracer-travelled",
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "kind"], "travelled"],
        paint: { "line-color": ["get", "color"], "line-width": 2, "line-opacity": 0.9 },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: "tracer-origin",
        type: "circle",
        source: SOURCE_ID,
        filter: ["==", ["get", "kind"], "origin"],
        paint: {
          "circle-radius": 5,
          "circle-color": "#0b1016",
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 2,
        },
      },
      beforeId,
    );
  }

  /** Follow the timeline. Called whenever its time changes. */
  setTime(timeMs: number): void {
    this.timeMs = timeMs;
    this.layer.setTime(timeMs);
    this.updateTravelled();
    this.updatePanel();
  }

  drop(lon: number, lat: number): void {
    this.release = { lon, lat, startMs: this.timeMs };
    this.start();
  }

  private setPreset(name: PresetName): void {
    this.preset = name;
    this.presetButtons.forEach((button, key) => button.setAttribute("aria-pressed", String(key === name)));
    // The same release again, so the two kinds can be compared directly.
    if (this.release) this.start();
    else this.updatePanel();
  }

  private start(): void {
    const release = this.release!;
    this.cancelRun();
    this.runId++;
    this.plume = null;
    this.path = [];
    this.drawnPoint = -1;
    this.computing = true;
    this.failed = false;
    this.startedAt = performance.now();
    this.layer.setPlume(null, PRESETS[this.preset].color);
    const request: TracerRequest = {
      type: "run",
      id: this.runId,
      lon: release.lon,
      lat: release.lat,
      startMs: release.startMs,
      endMs: releaseEnd(release.startMs, this.lastMs),
      preset: this.preset,
      dataUrl: this.dataUrl,
      baseFrames: this.baseFrames,
      nestFrames: this.nestFrames,
    };
    this.worker.postMessage(request);
    this.updatePath();
    this.updatePanel();
  }

  private cancelRun(): void {
    if (this.computing) {
      const request: TracerRequest = { type: "cancel", id: this.runId };
      this.worker.postMessage(request);
    }
  }

  private clear(): void {
    this.cancelRun();
    this.runId++;
    this.release = null;
    this.plume = null;
    this.path = [];
    this.computing = false;
    this.failed = false;
    this.layer.setPlume(null, PRESETS[this.preset].color);
    this.updatePath();
    this.updatePanel();
  }

  private fail(): void {
    this.computing = false;
    this.failed = true;
    this.updatePanel();
  }

  private handle(response: TracerResponse): void {
    if (response.id !== this.runId) return;
    if (response.type === "failed") {
      console.error(`Tracer failed: ${response.message}`);
      this.fail();
      return;
    }
    this.plume = response.plume;
    this.computing = !response.done;
    if (response.done) {
      this.lastRun = { ms: Math.round(performance.now() - this.startedAt), loads: response.loads };
    }
    this.layer.setPlume(response.plume, PRESETS[this.preset].color);
    this.layer.setTime(this.timeMs);
    this.path = centerPath(response.plume);
    this.drawnPoint = -1;
    this.updatePath();
    this.updatePanel();
  }

  private currentPoint(): number {
    const { plume } = this;
    if (!plume || this.timeMs < plume.startMs) return 0;
    return Math.floor((this.timeMs - plume.startMs) / plume.recordMs);
  }

  private updateTravelled(): void {
    const point = this.currentPoint();
    if (point !== this.drawnPoint) this.updatePath();
  }

  private updatePath(): void {
    this.drawnPoint = this.currentPoint();
    const source = this.map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(this.pathData());
  }

  private pathData(): FeatureCollection {
    const features: Feature[] = [];
    if (this.release) {
      const color = cssColor(PRESETS[this.preset].color);
      features.push({
        type: "Feature",
        properties: { kind: "origin", color },
        geometry: { type: "Point", coordinates: [this.release.lon, this.release.lat] },
      });
      if (this.path.length > 1) {
        for (const line of splitAtAntimeridian(this.path)) {
          features.push({
            type: "Feature",
            properties: { kind: "route", color },
            geometry: { type: "LineString", coordinates: line },
          });
        }
        const started = this.plume && this.timeMs >= this.plume.startMs;
        const travelled = started ? this.path.slice(0, this.drawnPoint + 2) : [];
        if (travelled.length > 1) {
          for (const line of splitAtAntimeridian(travelled)) {
            features.push({
              type: "Feature",
              properties: { kind: "travelled", color },
              geometry: { type: "LineString", coordinates: line },
            });
          }
        }
      }
    }
    return { type: "FeatureCollection", features };
  }

  private updatePanel(): void {
    const active = this.release !== null;
    this.panel.dataset.active = String(active);
    this.hint.hidden = active;
    this.title.hidden = !active;
    this.detail.hidden = !active;
    this.clearButton.hidden = !active;
    if (!this.release) return;

    const label = PRESETS[this.preset].label;
    this.title.textContent = `${label} from ${formatPlace(this.release.lon, this.release.lat)}`;
    this.detail.textContent = this.detailText(this.release);
  }

  private detailText(release: Release): string {
    if (this.failed) return "Couldn't compute this drift. Try releasing it again.";
    const { plume } = this;
    if (this.timeMs < release.startMs) return `Released ${this.formatTime(release.startMs)}, later than the time shown.`;
    const hours = Math.floor((this.timeMs - release.startMs) / 3600000);
    if (!plume) return "Computing drift…";

    const total = (plume.capacity - 1) * plume.recordMs;
    const computed = (plume.points - 1) * plume.recordMs;
    if (this.computing && this.timeMs - release.startMs > computed) {
      return `Computing drift… ${Math.round((computed / total) * 100)}%`;
    }
    const airborne = headPositions(plume, this.timeMs, this.scratch);
    const share = Math.round((airborne / plume.members) * 100);
    const totalHours = Math.round(total / 3600000);
    const shown = Math.min(hours, totalHours);
    const ended = hours >= totalHours && totalHours < RELEASE_HOURS ? " · wind data ends here" : "";
    return `${shown} of ${totalHours} h · ${share}% airborne${ended}`;
  }
}

function cssColor([r, g, b]: [number, number, number]): string {
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

/** Break a path where it jumps across the antimeridian, so it doesn't streak across the map. */
export function splitAtAntimeridian(path: [number, number][]): [number, number][][] {
  const lines: [number, number][][] = [];
  let current: [number, number][] = [];
  for (const point of path) {
    if (current.length > 0 && Math.abs(point[0] - current[current.length - 1][0]) > 180) {
      if (current.length > 1) lines.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 1) lines.push(current);
  return lines;
}
