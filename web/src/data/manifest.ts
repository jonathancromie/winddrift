export interface ManifestFrame {
  time: string;
  url: string;
  bytes: number;
}

/** Details of a showcase view: a replay of an event, or a looping day. */
export interface ViewDetails {
  id: string;
  title: string;
  group: string;
  summary: string;
  center: [number, number];
  zoom: number;
  timeZone: string;
  loop: boolean;
  night: boolean;
  opensAt?: string;
  tracer?: { lon: number; lat: number; time: string };
  maxBounds?: [[number, number], [number, number]];
}

export interface ViewsIndex {
  views: { id: string; title: string; group: string }[];
}

export interface Manifest {
  generated: string;
  models: Record<string, { cycle: string; frames: ManifestFrame[] }>;
  view?: ViewDetails;
}

export interface TimedFrame extends ManifestFrame {
  timeMs: number;
  /** Position in the model's full frame list, which also survives in coarser lists. */
  index: number;
}

/** How long a regional model takes to fade in and out at the ends of its time range. */
export const NEST_FADE_MS = 3 * 3600 * 1000;

export interface FramePair {
  a: number;
  b: number;
  mix: number;
}

export function prepareFrames(frames: ManifestFrame[]): TimedFrame[] {
  if (frames.length === 0) throw new Error("Manifest has no frames");
  return frames
    .map((frame) => ({ ...frame, timeMs: Date.parse(frame.time) }))
    .sort((x, y) => x.timeMs - y.timeMs)
    .map((frame, index) => ({ ...frame, index }));
}

/** Keep only frames on a whole multiple of `hours`, plus both ends so the range stays the same. */
export function coarsen(frames: TimedFrame[], hours: number): TimedFrame[] {
  const stepMs = hours * 3600 * 1000;
  const last = frames.length - 1;
  return frames.filter((frame, i) => i === 0 || i === last || frame.timeMs % stepMs === 0);
}

/**
 * How strongly a regional model applies at a time. It fades in and out inside its own
 * range, using real frames throughout, so reaching its last hour causes no jump.
 */
export function nestWeight(frames: TimedFrame[], timeMs: number, fadeMs: number): number {
  const fromStart = timeMs - frames[0].timeMs;
  const toEnd = frames[frames.length - 1].timeMs - timeMs;
  // A replay has regional wind for its whole range, so it has no need to fade.
  if (fadeMs <= 0) return fromStart >= 0 && toEnd >= 0 ? 1 : 0;
  return Math.max(0, Math.min(1, fromStart / fadeMs, toEnd / fadeMs));
}

/** Find the frames either side of a time. Times outside the range clamp to the end frame. */
export function framePairAt(frames: TimedFrame[], timeMs: number): FramePair {
  const last = frames.length - 1;
  if (timeMs <= frames[0].timeMs) return { a: 0, b: 0, mix: 0 };
  if (timeMs >= frames[last].timeMs) return { a: last, b: last, mix: 0 };

  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (frames[middle].timeMs <= timeMs) low = middle;
    else high = middle;
  }
  const mix = (timeMs - frames[low].timeMs) / (frames[high].timeMs - frames[low].timeMs);
  return { a: low, b: high, mix };
}
