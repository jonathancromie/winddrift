import { describe, expect, it } from "vitest";
import {
  defaultUnit,
  formatTemperature,
  scaleColor,
  scaleCss,
  scaleGlsl,
  SCALE_MAX_C,
  SCALE_MIN_C,
  SCALE_STOPS,
  toUnit,
} from "./temperatureScale";

/** Approximate perceived lightness, using the standard luma weights. */
const lightness = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe("scale", () => {
  it("runs in order across its full range", () => {
    const degrees = SCALE_STOPS.map((stop) => stop.celsius);
    expect(degrees).toEqual([...degrees].sort((a, b) => a - b));
    expect(degrees[0]).toBe(SCALE_MIN_C);
    expect(degrees.at(-1)).toBe(SCALE_MAX_C);
  });

  it("has a neutral midpoint, without a hue of its own", () => {
    const [r, g, b] = scaleColor(10);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(0.08);
  });

  it("is blue on the cold side and warm on the hot side", () => {
    const cold = scaleColor(-10);
    const hot = scaleColor(30);
    expect(cold[2]).toBeGreaterThan(cold[0]);
    expect(hot[0]).toBeGreaterThan(hot[2]);
  });

  it("gets steadily brighter moving away from the midpoint on the cold side", () => {
    let previous = lightness(scaleColor(10));
    for (let c = 5; c >= SCALE_MIN_C; c -= 5) {
      const current = lightness(scaleColor(c));
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it("clamps beyond both ends", () => {
    expect(scaleColor(-90)).toEqual(SCALE_STOPS[0].rgb);
    expect(scaleColor(70)).toEqual(SCALE_STOPS.at(-1)!.rgb);
  });

  it("interpolates between stops", () => {
    const low = scaleColor(10);
    const high = scaleColor(20);
    scaleColor(15).forEach((channel, i) => expect(channel).toBeCloseTo((low[i] + high[i]) / 2));
  });

  it("generates matching shader and legend code from one definition", () => {
    const glsl = scaleGlsl();
    expect(glsl).toContain("vec3 scale(float celsius)");
    expect(glsl.match(/mix\(/g)).toHaveLength(SCALE_STOPS.length - 1);
    const css = scaleCss();
    expect(css.startsWith("linear-gradient(to right, ")).toBe(true);
    expect(css).toContain("0.0%");
    expect(css).toContain("100.0%");
  });
});

describe("units", () => {
  it.each([
    [0, 32],
    [100, 212],
    [-40, -40],
  ])("converts %d C to %d F", (celsius, fahrenheit) => {
    expect(toUnit(celsius, "F")).toBeCloseTo(fahrenheit);
  });

  it("formats rounded values with their unit", () => {
    expect(formatTemperature(21.6, "C")).toBe("22°C");
    expect(formatTemperature(21.6, "F")).toBe("71°F");
  });

  it.each([
    ["en-US", "F"],
    ["es-US", "F"],
    ["en-AU", "C"],
    ["en-GB", "C"],
    ["fr-CA", "C"],
    ["en", "C"],
  ])("defaults %s to %s", (locale, unit) => {
    expect(defaultUnit(locale)).toBe(unit);
  });
});
