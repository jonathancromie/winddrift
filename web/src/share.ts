import type { PresetName } from "./tracer/plume";

/** Everything a link can restore. Anything missing or invalid falls back to the default. */
export interface ShareState {
  view?: string;
  timeMs?: number;
  camera?: { lon: number; lat: number; zoom: number };
  tracer?: { lon: number; lat: number; timeMs: number; preset: PresetName };
}

const VIEW_ID = /^[a-z0-9-]{1,40}$/;

function inRange(value: number, low: number, high: number): boolean {
  return Number.isFinite(value) && value >= low && value <= high;
}

function numbers(text: string | null, count: number): number[] | null {
  if (!text) return null;
  const parts = text.split(",").map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
  return parts.length === count && parts.every(Number.isFinite) ? parts : null;
}

export function parseShare(search: string): ShareState {
  const params = new URLSearchParams(search);
  const state: ShareState = {};

  const view = params.get("view");
  if (view && VIEW_ID.test(view)) state.view = view;

  const time = Date.parse(params.get("t") ?? "");
  if (Number.isFinite(time)) state.timeMs = time;

  const camera = numbers(params.get("at"), 3);
  if (camera && inRange(camera[0], -180, 180) && inRange(camera[1], -90, 90) && inRange(camera[2], 0, 24)) {
    state.camera = { lon: camera[0], lat: camera[1], zoom: camera[2] };
  }

  const tracerPlace = numbers(params.get("tracer"), 2);
  const tracerTime = Date.parse(params.get("released") ?? "");
  if (
    tracerPlace &&
    inRange(tracerPlace[0], -180, 180) &&
    inRange(tracerPlace[1], -90, 90) &&
    Number.isFinite(tracerTime)
  ) {
    state.tracer = {
      lon: tracerPlace[0],
      lat: tracerPlace[1],
      timeMs: tracerTime,
      preset: params.get("kind") === "pollen" ? "pollen" : "smoke",
    };
  }
  return state;
}

function isoMinute(timeMs: number): string {
  return new Date(Math.round(timeMs / 60000) * 60000).toISOString().replace(":00.000Z", "Z");
}

/** Build the query string for a state. Debug settings already in the URL are kept. */
export function buildShare(state: ShareState, existingSearch = ""): string {
  const params = new URLSearchParams();
  const existing = new URLSearchParams(existingSearch);
  for (const key of ["debug", "particles"]) {
    const value = existing.get(key);
    if (value !== null) params.set(key, value);
  }
  if (state.view) params.set("view", state.view);
  if (state.timeMs !== undefined) params.set("t", isoMinute(state.timeMs));
  if (state.camera) {
    const { lon, lat, zoom } = state.camera;
    params.set("at", `${lon.toFixed(3)},${lat.toFixed(3)},${zoom.toFixed(2)}`);
  }
  if (state.tracer) {
    const { lon, lat, timeMs, preset } = state.tracer;
    params.set("tracer", `${lon.toFixed(3)},${lat.toFixed(3)}`);
    params.set("released", isoMinute(timeMs));
    params.set("kind", preset);
  }
  const text = params.toString().replaceAll("%2C", ",").replaceAll("%3A", ":");
  return text ? `?${text}` : "";
}

export function isValidViewId(id: string): boolean {
  return VIEW_ID.test(id);
}
