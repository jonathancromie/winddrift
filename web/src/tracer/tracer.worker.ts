import { decodeFrame } from "../data/frame";
import type { TimedFrame } from "../data/manifest";
import { WindField } from "./field";
import { PRESETS, runPlume, type Plume, type PresetName } from "./plume";

export interface TracerRun {
  type: "run";
  id: number;
  lon: number;
  lat: number;
  startMs: number;
  endMs: number;
  preset: PresetName;
  dataUrl: string;
  baseFrames: TimedFrame[];
  nestFrames: TimedFrame[];
  nestFadeMs: number;
}

export type TracerRequest = TracerRun | { type: "cancel"; id: number };

export type TracerResponse =
  | { type: "update"; id: number; plume: Plume; done: boolean; loads: number }
  | { type: "failed"; id: number; message: string };

let currentRun = 0;

async function run(request: TracerRun): Promise<void> {
  currentRun = request.id;
  const isCancelled = () => currentRun !== request.id;
  const field = new WindField(request.baseFrames, request.nestFrames, async (frame) => {
    const response = await fetch(`${request.dataUrl}${frame.url}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return decodeFrame(await response.arrayBuffer());
  }, request.nestFadeMs);
  const preset = PRESETS[request.preset];
  const send = (plume: Plume, done: boolean) => {
    // Copies, because the run keeps writing to its own arrays.
    const copy: Plume = {
      ...plume,
      positions: plume.positions.slice(),
      settledAt: plume.settledAt.slice(),
    };
    const message: TracerResponse = { type: "update", id: request.id, plume: copy, done, loads: field.loads };
    self.postMessage(message, { transfer: [copy.positions.buffer, copy.settledAt.buffer] });
  };
  try {
    await runPlume(
      {
        lon: request.lon,
        lat: request.lat,
        startMs: request.startMs,
        endMs: request.endMs,
        diffusivity: preset.diffusivity,
        settlingHours: preset.settlingHours,
        seed: request.id * 7919 + 1,
      },
      { prepare: (a, b) => field.prepare(a, b), sample: (x, y, t) => field.sample(x, y, t) },
      send,
      isCancelled,
    );
  } catch (error) {
    if (isCancelled()) return;
    const message: TracerResponse = { type: "failed", id: request.id, message: String(error) };
    self.postMessage(message);
  }
}

self.onmessage = (event: MessageEvent<TracerRequest>) => {
  if (event.data.type === "run") void run(event.data);
  else if (currentRun === event.data.id) currentRun = 0;
};
