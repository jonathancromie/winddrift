import { describe, expect, it } from "vitest";
import { coarsen, prepareFrames } from "../data/manifest";
import {
  advance,
  dataAgeText,
  framesToRequest,
  HOUR_MS as HOUR,
  isNewerData,
  loadPlan,
  MODEL_MS_PER_SECOND,
  newDataAction,
  pairToDisplay,
  phaseAt,
  SPEEDS,
  stepTime,
  timelineFraction,
  type ReadyCheck,
} from "./playback";

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

describe("coarse frame lists", () => {
  const hourly = prepareFrames(
    Array.from({ length: 13 }, (_, h) => ({
      time: `2026-11-05T${String(h).padStart(2, "0")}:00:00Z`,
      url: `f${h}`,
      bytes: 1,
    })),
  );
  const coarse = coarsen(hourly, 3);
  const base = hourly[0].timeMs;

  it("requests full-list positions, skipping the frames in between", () => {
    expect(framesToRequest(coarse, base + HOUR, 2)).toEqual([0, 3, 6, 9]);
  });

  it("loads further ahead when asked", () => {
    expect(framesToRequest(hourly, base, 4)).toEqual([0, 1, 2, 3, 4]);
    expect(framesToRequest(hourly, base + 0.5 * HOUR, 3)).toEqual([0, 1, 2, 3, 4]);
  });

  it("interpolates across the wider gap using full-list positions", () => {
    expect(pairToDisplay(coarse, base + 4.5 * HOUR, readySet(3, 6))).toEqual({
      a: 3,
      b: 6,
      mix: 0.5,
      exact: true,
    });
  });

  it("doesn't need the skipped frames to be loaded", () => {
    expect(pairToDisplay(coarse, base + 4 * HOUR, readySet(3, 6))?.exact).toBe(true);
    expect(pairToDisplay(hourly, base + 4.5 * HOUR, readySet(3, 6))?.exact).toBe(false);
  });
});

describe("loadPlan", () => {
  const hourly = prepareFrames(
    Array.from({ length: 13 }, (_, h) => ({
      time: `2026-11-05T${String(h).padStart(2, "0")}:00:00Z`,
      url: `h${h}`,
      bytes: 1,
    })),
  );
  const t = start + 1.5 * HOUR;
  const paused = { playing: false, lookahead: 2, nestActive: true };
  const has = (...loaded: number[]) => (i: number) => loaded.includes(i);

  it("starts with only the global pair, so wind appears as soon as possible", () => {
    expect(loadPlan(frames, hourly, t, paused, has(), has())).toEqual({ base: [0, 1], nest: [] });
  });

  it("moves on to the regional pair once the global pair is in", () => {
    expect(loadPlan(frames, hourly, t, paused, has(0, 1), has())).toEqual({ base: [0, 1], nest: [1, 2] });
  });

  it("loads ahead only after everything needed now is in", () => {
    expect(loadPlan(frames, hourly, t, paused, has(0, 1), has(1, 2))).toEqual({
      base: [0, 1, 2, 3],
      nest: [1, 2, 3, 4],
    });
  });

  it("skips the regional stage when the regional model is off", () => {
    const options = { ...paused, nestActive: false };
    expect(loadPlan(frames, hourly, t, options, has(), has())).toEqual({ base: [0, 1], nest: [] });
    expect(loadPlan(frames, hourly, t, options, has(0, 1), has())).toEqual({ base: [0, 1, 2, 3], nest: [] });
  });

  it("requests everything at once during playback, to avoid cancelling part-way downloads", () => {
    const playing = { playing: true, lookahead: 2, nestActive: true };
    expect(loadPlan(frames, hourly, t, playing, has(), has())).toEqual({
      base: [0, 1, 2, 3],
      nest: [1, 2, 3, 4],
    });
  });
});

describe("SPEEDS", () => {
  it("offers the three speeds in order", () => {
    expect(SPEEDS.map((s) => s.multiplier)).toEqual([1, 5, 24]);
  });

  it("looks ahead by at least about two seconds at each speed on hourly frames or its stride", () => {
    for (const speed of SPEEDS) {
      const framesPerSecond = (speed.multiplier * MODEL_MS_PER_SECOND) / (speed.strideHours * HOUR);
      expect(speed.lookahead / framesPerSecond).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("stepTime", () => {
  const range = [start, start + 12 * HOUR] as const;

  it("moves one step from a whole hour", () => {
    expect(stepTime(start + 3 * HOUR, 1, HOUR, ...range)).toBe(start + 4 * HOUR);
    expect(stepTime(start + 3 * HOUR, -1, HOUR, ...range)).toBe(start + 2 * HOUR);
  });

  it("snaps to the next whole hour from part way through one", () => {
    expect(stepTime(start + 3.4 * HOUR, 1, HOUR, ...range)).toBe(start + 4 * HOUR);
    expect(stepTime(start + 3.4 * HOUR, -1, HOUR, ...range)).toBe(start + 3 * HOUR);
  });

  it("uses clock multiples of a three-hour step", () => {
    expect(stepTime(start + 4 * HOUR, 1, 3 * HOUR, ...range)).toBe(start + 6 * HOUR);
    expect(stepTime(start + 4 * HOUR, -1, 3 * HOUR, ...range)).toBe(start + 3 * HOUR);
  });

  it("stops at both ends", () => {
    expect(stepTime(start, -1, HOUR, ...range)).toBe(start);
    expect(stepTime(start + 12 * HOUR, 1, HOUR, ...range)).toBe(start + 12 * HOUR);
  });
});

describe("dataAgeText", () => {
  it.each([
    [0, "Updated just now"],
    [0.5, "Updated just now"],
    [1, "Updated 1 h ago"],
    [47.9, "Updated 47 h ago"],
    [48, "Updated 2 days ago"],
    [24 * 9, "Updated 9 days ago"],
  ])("describes %d hours", (hours, text) => {
    expect(dataAgeText(0, hours * HOUR)).toBe(text);
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

describe("isNewerData", () => {
  const current = "2026-11-06T12:00:00Z";

  it("accepts only a later time", () => {
    expect(isNewerData(current, "2026-11-06T18:00:00Z")).toBe(true);
    expect(isNewerData(current, current)).toBe(false);
    expect(isNewerData(current, "2026-11-06T06:00:00Z")).toBe(false);
  });

  it.each([[undefined], [null], [42], ["not a date"]])("ignores a malformed value: %s", (value) => {
    expect(isNewerData(current, value)).toBe(false);
  });
});

describe("newDataAction", () => {
  const live = { following: true, hidden: false, failed: false, hasTracer: false };

  it("does nothing without newer data, even if frames are failing", () => {
    expect(newDataAction(false, { ...live, hidden: true, failed: true })).toBe("none");
  });

  it("offers the update to someone watching live", () => {
    expect(newDataAction(true, live)).toBe("offer");
  });

  it("reloads a live page in a background tab", () => {
    expect(newDataAction(true, { ...live, hidden: true })).toBe("reload");
  });

  it("reloads a live page whose frames have stopped loading", () => {
    expect(newDataAction(true, { ...live, failed: true })).toBe("reload");
  });

  it.each([
    ["a chosen time", { following: false }],
    ["a tracer", { hasTracer: true }],
  ])("never reloads over %s", (_, change) => {
    expect(newDataAction(true, { ...live, hidden: true, failed: true, ...change })).toBe("offer");
  });
});

describe("timelineFraction", () => {
  it("maps times along the range and clamps outside it", () => {
    expect(timelineFraction(5, 0, 10)).toBe(0.5);
    expect(timelineFraction(-5, 0, 10)).toBe(0);
    expect(timelineFraction(15, 0, 10)).toBe(1);
  });
});
