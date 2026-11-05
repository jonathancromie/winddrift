import { describe, expect, it } from "vitest";
import { prepareFrames } from "../data/manifest";
import { advance, framesToRequest, MODEL_MS_PER_SECOND, pairToDisplay, type ReadyCheck } from "./playback";

const HOUR = 3600 * 1000;
const frames = prepareFrames(
  [0, 3, 6, 9, 12].map((h) => ({
    time: `2026-11-05T${String(h).padStart(2, "0")}:00:00Z`,
    url: `f${h}`,
    bytes: 1,
  })),
);
const start = frames[0].timeMs;

function readySet(...loaded: number[]): ReadyCheck {
  const set = new Set(loaded);
  return {
    isReady: (i) => set.has(i),
    nearestReady: (i) =>
      [...set].sort((x, y) => Math.abs(x - i) - Math.abs(y - i))[0],
  };
}

describe("framesToRequest", () => {
  it("asks for the pair first, then the frames ahead", () => {
    expect(framesToRequest(frames, start + HOUR)).toEqual([0, 1, 2, 3]);
  });

  it("doesn't run past the end", () => {
    expect(framesToRequest(frames, start + 11 * HOUR)).toEqual([3, 4]);
    expect(framesToRequest(frames, start + 12 * HOUR)).toEqual([4]);
  });
});

describe("pairToDisplay", () => {
  it("uses the exact pair once both frames are loaded", () => {
    const pair = pairToDisplay(frames, start + 1.5 * HOUR, readySet(0, 1));
    expect(pair).toEqual({ a: 0, b: 1, mix: 0.5, exact: true });
  });

  it("holds the nearest frame still while the pair loads", () => {
    const pair = pairToDisplay(frames, start + 7 * HOUR, readySet(0));
    expect(pair).toEqual({ a: 0, b: 0, mix: 0, exact: false });
  });

  it("returns nothing when no frames have loaded", () => {
    expect(pairToDisplay(frames, start, readySet())).toBeNull();
  });
});

describe("advance", () => {
  it("moves at the requested speed", () => {
    const result = advance(frames, start, 1, 5, readySet(0, 1));
    expect(result.timeMs).toBe(start + 5 * MODEL_MS_PER_SECOND);
    expect(result.buffering).toBe(false);
  });

  it("holds position while the current pair is missing", () => {
    const result = advance(frames, start + HOUR, 1, 1, readySet(0));
    expect(result).toEqual({ timeMs: start + HOUR, buffering: true, ended: false });
  });

  it("stops exactly at the end", () => {
    const result = advance(frames, start + 11.9 * HOUR, 60, 1, readySet(3, 4));
    expect(result.timeMs).toBe(start + 12 * HOUR);
    expect(result.ended).toBe(true);
  });
});
