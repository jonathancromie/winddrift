import { framePairAt, type FramePair, type TimedFrame } from "../data/manifest";

/** Model time per real second at normal speed: one model hour every five seconds. */
export const MODEL_MS_PER_SECOND = (60 * 60 * 1000) / 5;
const LOOKAHEAD_FRAMES = 2;
/** Within this of the present, the timeline says "Now" rather than past or forecast. */
const NOW_WINDOW_MS = 30 * 60 * 1000;

export type TimelinePhase = "Past" | "Now" | "Forecast";

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
 * Advance playback by real time. Holds position until the frames for the current time
 * are loaded, and stops at the end of the range.
 */
export function advance(
  timeMs: number,
  endMs: number,
  realSeconds: number,
  speed: number,
  framesReady: boolean,
): { timeMs: number; ended: boolean } {
  if (!framesReady) return { timeMs, ended: false };
  const next = Math.min(timeMs + realSeconds * MODEL_MS_PER_SECOND * speed, endMs);
  return { timeMs: next, ended: next >= endMs };
}

export function phaseAt(timeMs: number, nowMs: number): TimelinePhase {
  if (Math.abs(timeMs - nowMs) <= NOW_WINDOW_MS) return "Now";
  return timeMs < nowMs ? "Past" : "Forecast";
}

/** Position of a time along the timeline, from 0 to 1. */
export function timelineFraction(timeMs: number, startMs: number, endMs: number): number {
  return Math.min(1, Math.max(0, (timeMs - startMs) / (endMs - startMs)));
}
