import { describe, expect, it } from "vitest";
import { advect, EARTH_RADIUS_M, MAX_MERCATOR_LAT, mercatorX, mercatorY, timeCompression, wrapLon } from "./geo";

describe("mercator", () => {
  it("maps the world corners to 0 and 1", () => {
    expect(mercatorX(-180)).toBeCloseTo(0);
    expect(mercatorX(180)).toBeCloseTo(1);
    expect(mercatorY(0)).toBeCloseTo(0.5);
    expect(mercatorY(MAX_MERCATOR_LAT)).toBeCloseTo(0, 5);
    expect(mercatorY(-MAX_MERCATOR_LAT)).toBeCloseTo(1, 5);
  });
});

describe("advect", () => {
  const metersPerDegree = (2 * Math.PI * EARTH_RADIUS_M) / 360;

  it("moves north at the same rate everywhere", () => {
    const [, lat] = advect(0, 60, 0, 10, metersPerDegree / 10);
    expect(lat).toBeCloseTo(61, 6);
  });

  it("moves twice as many degrees east at 60N as at the equator", () => {
    const seconds = metersPerDegree / 10;
    expect(advect(0, 0, 10, 0, seconds)[0]).toBeCloseTo(1, 6);
    expect(advect(0, 60, 10, 0, seconds)[0]).toBeCloseTo(2, 6);
  });

  it("wraps across the antimeridian in both directions", () => {
    const seconds = metersPerDegree / 10;
    expect(advect(179.5, 0, 10, 0, seconds)[0]).toBeCloseTo(-179.5, 6);
    expect(advect(-179.5, 0, -10, 0, seconds)[0]).toBeCloseTo(179.5, 6);
  });

  it("stays finite at the pole", () => {
    const [lon, lat] = advect(10, 90, 30, 0, 3600);
    expect(Number.isFinite(lon)).toBe(true);
    expect(lat).toBe(90);
  });
});

describe("wrapLon", () => {
  it.each([
    [0, 0],
    [190, -170],
    [-190, 170],
    [540, -180],
    [-180, -180],
  ])("wraps %d to %d", (input, expected) => {
    expect(wrapLon(input)).toBeCloseTo(expected);
  });
});

describe("timeCompression", () => {
  it("halves with each zoom level, keeping on-screen speed constant", () => {
    expect(timeCompression(4, 2)).toBeCloseTo(timeCompression(3, 2) / 2);
  });

  it("produces the requested on-screen speed at the equator", () => {
    const zoom = 3;
    const seconds = timeCompression(zoom, 2);
    const [lon] = advect(0, 0, 10, 0, seconds);
    const pixels = (lon / 360) * 512 * 2 ** zoom;
    expect(pixels).toBeCloseTo(20, 6);
  });
});
