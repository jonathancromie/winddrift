import { describe, expect, it } from "vitest";
import { prepareFrames } from "../data/manifest";
import {
  advance,
  framesToRequest,
  MODEL_MS_PER_SECOND,
  pairToDisplay,
  phaseAt,
  timelineFraction,
  type ReadyCheck,
} from "./playback";

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
    nearestReady: (i) => [...set].sort((x, y) => Math.abs(x - i) - Math.abs(y - i))[0],
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
  const end = start + 12 * HOUR;

  it("moves at the requested speed", () => {
    const result = advance(start, end, 1, 5, true);
    expect(result).toEqual({ timeMs: start + 5 * MODEL_MS_PER_SECOND, ended: false });
  });

  it("holds position while frames are missing", () => {
    expect(advance(start + HOUR, end, 1, 1, false)).toEqual({ timeMs: start + HOUR, ended: false });
  });

  it("stops exactly at the end", () => {
    expect(advance(start + 11.9 * HOUR, end, 60, 1, true)).toEqual({ timeMs: end, ended: true });
  });
});

describe("phaseAt", () => {
  const now = start + 6 * HOUR;

  it.each([
    [now - 2 * HOUR, "Past"],
    [now - 0.25 * HOUR, "Now"],
    [now, "Now"],
    [now + 0.25 * HOUR, "Now"],
    [now + 2 * HOUR, "Forecast"],
  ])("labels time %d as %s", (time, phase) => {
    expect(phaseAt(time, now)).toBe(phase);
  });
});

describe("timelineFraction", () => {
  it("maps times along the range and clamps outside it", () => {
    expect(timelineFraction(5, 0, 10)).toBe(0.5);
    expect(timelineFraction(-5, 0, 10)).toBe(0);
    expect(timelineFraction(15, 0, 10)).toBe(1);
  });
});
