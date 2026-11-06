import { describe, expect, it } from "vitest";
import { buildShare, isValidViewId, parseShare, type ShareState } from "./share";

const T = Date.parse("2025-01-07T18:30:00Z");

describe("share links", () => {
  it("round-trips a full state", () => {
    const state: ShareState = {
      view: "la-fires",
      timeMs: T,
      camera: { lon: -118.5, lat: 34, zoom: 6.5 },
      tracer: { lon: -118.54, lat: 34.07, timeMs: T, preset: "pollen" },
    };
    expect(parseShare(buildShare(state))).toEqual(state);
  });

  it("builds a readable link", () => {
    expect(buildShare({ view: "helene", timeMs: T })).toBe("?view=helene&t=2025-01-07T18:30Z");
  });

  it("is empty for the default state", () => {
    expect(buildShare({})).toBe("");
    expect(parseShare("")).toEqual({});
  });

  it("keeps debug settings already in the address", () => {
    expect(buildShare({ view: "helene" }, "?debug&particles=100000&view=old")).toBe(
      "?debug=&particles=100000&view=helene",
    );
  });

  it.each([
    ["?view=../../secret", "view"],
    ["?view=UPPER", "view"],
    ["?view=" + "x".repeat(41), "view"],
    ["?t=never", "timeMs"],
    ["?at=999,0,3", "camera"],
    ["?at=0,95,3", "camera"],
    ["?at=0,0,99", "camera"],
    ["?at=0,0", "camera"],
    ["?at=a,b,c", "camera"],
    ["?at=,,", "camera"],
    ["?tracer=0,0", "tracer"],
    ["?tracer=999,0&released=2025-01-07T18:30Z", "tracer"],
    ["?tracer=0,0&released=nope", "tracer"],
  ])("ignores the invalid %s", (search, field) => {
    expect(parseShare(search)).not.toHaveProperty(field);
  });

  it("defaults an unknown tracer kind to smoke", () => {
    expect(parseShare("?tracer=1,2&released=2025-01-07T18:30Z&kind=lava").tracer?.preset).toBe("smoke");
  });

  it("validates view ids", () => {
    expect(isValidViewId("sea-breeze-la")).toBe(true);
    expect(isValidViewId("a/b")).toBe(false);
  });
});
