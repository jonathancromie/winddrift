import { framePairAt, type FramePair, type TimedFrame } from "../data/manifest";

/** Model time per real second at normal speed: one model hour every five seconds. */
export const MODEL_MS_PER_SECOND = (60 * 60 * 1000) / 5;
const LOOKAHEAD_FRAMES = 2;

export interface ReadyCheck {
  isReady(index: number): boolean;
  nearestReady(index: number): number | undefined;
}

export interface DisplayPair extends FramePair {
  /** False when a stand-in is showing because the exact frames haven't loaded. */
  exact: boolean;
}

/** Frames to keep loaded for a time: the current pair first, then what comes next. */
export function framesToRequest(frames: TimedFrame[], timeMs: number): number[] {
  const { a, b } = framePairAt(frames, timeMs);
  const indices = [a];
  if (b !== a) indices.push(b);
  for (let i = 1; i <= LOOKAHEAD_FRAMES; i++) {
    if (b + i < frames.length) indices.push(b + i);
  }
  return indices;
}

/** The best pair to draw now: the exact pair if loaded, otherwise the nearest frame held still. */
export function pairToDisplay(
  frames: TimedFrame[],
  timeMs: number,
  ready: ReadyCheck,
): DisplayPair | null {
  const pair = framePairAt(frames, timeMs);
  if (ready.isReady(pair.a) && ready.isReady(pair.b)) return { ...pair, exact: true };
  const nearest = ready.nearestReady(pair.mix < 0.5 ? pair.a : pair.b);
  if (nearest === undefined) return null;
  return { a: nearest, b: nearest, mix: 0, exact: false };
}

/**
 * Advance playback by real time. Holds position when the frames ahead aren't loaded,
 * and stops at the end of the range.
 */
export function advance(
  frames: TimedFrame[],
  timeMs: number,
  realSeconds: number,
  speed: number,
  ready: ReadyCheck,
): { timeMs: number; buffering: boolean; ended: boolean } {
  const end = frames[frames.length - 1].timeMs;
  const { a, b } = framePairAt(frames, timeMs);
  if (!ready.isReady(a) || !ready.isReady(b)) {
    return { timeMs, buffering: true, ended: false };
  }
  const next = Math.min(timeMs + realSeconds * MODEL_MS_PER_SECOND * speed, end);
  return { timeMs: next, buffering: false, ended: next >= end };
}
