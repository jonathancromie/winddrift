import { describe, expect, it } from "vitest";
import { framePairAt, prepareFrames } from "./manifest";

const frames = prepareFrames([
  { time: "2026-11-05T06:00:00Z", url: "c", bytes: 1 },
  { time: "2026-11-05T00:00:00Z", url: "a", bytes: 1 },
  { time: "2026-11-05T03:00:00Z", url: "b", bytes: 1 },
  { time: "2026-11-05T07:00:00Z", url: "d", bytes: 1 },
]);
const at = (time: string) => framePairAt(frames, Date.parse(time));

describe("prepareFrames", () => {
  it("sorts frames by time", () => {
    expect(frames.map((f) => f.url)).toEqual(["a", "b", "c", "d"]);
  });

  it("rejects an empty list", () => {
    expect(() => prepareFrames([])).toThrow();
  });
});

describe("framePairAt", () => {
  it("clamps times before and after the range", () => {
    expect(at("2026-11-04T00:00:00Z")).toEqual({ a: 0, b: 0, mix: 0 });
    expect(at("2026-11-06T00:00:00Z")).toEqual({ a: 3, b: 3, mix: 0 });
  });

  it("interpolates between neighbouring frames", () => {
    expect(at("2026-11-05T01:30:00Z")).toEqual({ a: 0, b: 1, mix: 0.5 });
  });

  it("handles uneven spacing", () => {
    expect(at("2026-11-05T06:15:00Z")).toEqual({ a: 2, b: 3, mix: 0.25 });
  });

  it("lands exactly on an interior frame", () => {
    expect(at("2026-11-05T03:00:00Z")).toEqual({ a: 1, b: 2, mix: 0 });
  });
});
