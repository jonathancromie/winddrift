import { framePairAt, type FramePair, type TimedFrame } from "../data/manifest";

/** Model time per real second at normal speed: one model hour every five seconds. */
export const MODEL_MS_PER_SECOND = (60 * 60 * 1000) / 5;
export const HOUR_MS = 60 * 60 * 1000;

export interface PlaybackSpeed {
  label: string;
  multiplier: number;
  /** Hours between the frames used while playing, to limit downloads at high speed. */
  strideHours: number;
  /** Frames to load ahead, enough for about two seconds of playback at this speed. */
  lookahead: number;
}

export const SPEEDS: PlaybackSpeed[] = [
  { label: "1×", multiplier: 1, strideHours: 1, lookahead: 2 },
  { label: "5×", multiplier: 5, strideHours: 1, lookahead: 3 },
  { label: "24×", multiplier: 24, strideHours: 3, lookahead: 4 },
];

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

/**
 * Frames to keep loaded for a time: the current pair first, then what comes next.
 * `frames` may be a coarser list, and the result is always full-list positions.
 */
export function framesToRequest(frames: TimedFrame[], timeMs: number, lookahead = 2): number[] {
  const { a, b } = framePairAt(frames, timeMs);
  const positions = [a];
  if (b !== a) positions.push(b);
  for (let i = 1; i <= lookahead; i++) {
    if (b + i < frames.length) positions.push(b + i);
  }
  return positions.map((position) => frames[position].index);
}

/**
 * The best pair to draw now: the exact pair if loaded, otherwise the nearest frame held
 * still. `frames` may be a coarser list, and the result is always full-list positions.
 */
export function pairToDisplay(
  frames: TimedFrame[],
  timeMs: number,
  ready: ReadyCheck,
): DisplayPair | null {
  const pair = framePairAt(frames, timeMs);
  const a = frames[pair.a].index;
  const b = frames[pair.b].index;
  if (ready.isReady(a) && ready.isReady(b)) return { a, b, mix: pair.mix, exact: true };
  const nearest = ready.nearestReady(pair.mix < 0.5 ? a : b);
  if (nearest === undefined) return null;
  return { a: nearest, b: nearest, mix: 0, exact: false };
}

/** The next whole multiple of a step in a direction, so stepping lands on tidy times. */
export function stepTime(
  timeMs: number,
  direction: 1 | -1,
  stepMs: number,
  startMs: number,
  endMs: number,
): number {
  const next =
    direction > 0
      ? (Math.floor(timeMs / stepMs) + 1) * stepMs
      : (Math.ceil(timeMs / stepMs) - 1) * stepMs;
  return Math.min(endMs, Math.max(startMs, next));
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
