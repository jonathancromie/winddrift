import { describe, expect, it } from "vitest";
import { nightRing, subsolarPoint, sunAltitude } from "./night";

/** Standard ray casting, to compare the night outline against the sun's actual height. */
function insideRing(lon: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

describe("subsolarPoint", () => {
  it("is near the tropic of Cancer at the June solstice", () => {
    const sun = subsolarPoint(Date.parse("2026-06-21T12:00:00Z"));
    expect(sun.lat).toBeCloseTo(23.44, 0);
    // At 12:00 UTC the sun is close to the prime meridian.
    expect(Math.abs(sun.lon)).toBeLessThan(2);
  });

  it("is near the tropic of Capricorn at the December solstice", () => {
    expect(subsolarPoint(Date.parse("2026-12-21T12:00:00Z")).lat).toBeCloseTo(-23.44, 0);
  });

  it("is near the equator at an equinox", () => {
    expect(Math.abs(subsolarPoint(Date.parse("2026-03-20T15:00:00Z")).lat)).toBeLessThan(0.5);
  });

  it("moves about 15 degrees west each hour", () => {
    const a = subsolarPoint(Date.parse("2026-07-16T10:00:00Z")).lon;
    const b = subsolarPoint(Date.parse("2026-07-16T11:00:00Z")).lon;
    expect(a - b).toBeCloseTo(15, 0);
  });
});

describe("sunAltitude", () => {
  it("puts Los Angeles in full sun at local noon and darkness at local midnight", () => {
    expect(sunAltitude(-118.25, 34.05, Date.parse("2026-07-16T20:00:00Z"))).toBeGreaterThan(70);
    expect(sunAltitude(-118.25, 34.05, Date.parse("2026-07-17T08:00:00Z"))).toBeLessThan(-20);
  });

  it("matches a Los Angeles sunrise close to 6 a.m. in mid July", () => {
    const altitude = sunAltitude(-118.25, 34.05, Date.parse("2026-07-16T12:58:00Z"));
    expect(Math.abs(altitude)).toBeLessThan(2);
  });
});

describe("nightRing", () => {
  const times = ["2026-07-16T12:00:00Z", "2026-07-16T23:00:00Z", "2026-12-21T05:00:00Z", "2026-03-20T15:00:00Z"];

  it("is closed", () => {
    const ring = nightRing(Date.parse(times[0]));
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it.each(times)("agrees with the sun's height everywhere at %s", (time) => {
    const t = Date.parse(time);
    const ring = nightRing(t);
    for (let lon = -175; lon <= 175; lon += 10) {
      for (let lat = -80; lat <= 80; lat += 10) {
        const altitude = sunAltitude(lon, lat, t);
        // Right at the terminator, the outline's 2-degree steps make the answer uncertain.
        if (Math.abs(altitude) > 2) expect(insideRing(lon, lat, ring)).toBe(altitude < 0);
      }
    }
  });
});
