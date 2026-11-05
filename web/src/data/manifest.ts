export interface ManifestFrame {
  time: string;
  url: string;
  bytes: number;
}

export interface Manifest {
  generated: string;
  models: Record<string, { cycle: string; frames: ManifestFrame[] }>;
}

export interface TimedFrame extends ManifestFrame {
  timeMs: number;
}

export interface FramePair {
  a: number;
  b: number;
  mix: number;
}

export function prepareFrames(frames: ManifestFrame[]): TimedFrame[] {
  if (frames.length === 0) throw new Error("Manifest has no frames");
  return frames
    .map((frame) => ({ ...frame, timeMs: Date.parse(frame.time) }))
    .sort((x, y) => x.timeMs - y.timeMs);
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
