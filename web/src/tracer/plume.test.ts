import { describe, expect, it } from "vitest";
import { EARTH_RADIUS_M } from "../render/geo";
import { centerPath, createRandom, headPositions, plumeHours, PRESETS, rk4Step, runPlume, type WindSample } from "./plume";

const HOUR = 3600 * 1000;
const DEG = Math.PI / 180;
const METERS_PER_DEGREE = EARTH_RADIUS_M * DEG;

const still: WindSample = () => [0, 0];
const steady = (u: number, v: number): WindSample => () => [u, v];
const source = (sample: WindSample) => ({ prepare: async () => {}, sample });

const calm = { diffusivity: 0, settlingHours: 1e12, seed: 1 };
const window72 = { startMs: 0, endMs: 72 * HOUR };

function toVector(lon: number, lat: number): [number, number, number] {
  return [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG)];
}

/** Solid rotation about an axis through the equator at lon 0, which crosses both wind components. */
function solidRotation(omega: number): WindSample {
  return (lon, lat) => {
    const [, y, z] = toVector(lon, lat);
    // Velocity is omega x r with the axis along x, so it has no x component.
    const vy = -omega * z * EARTH_RADIUS_M;
    const vz = omega * y * EARTH_RADIUS_M;
    const u = vy * Math.cos(lon * DEG);
    const v = -vy * Math.sin(lat * DEG) * Math.sin(lon * DEG) + vz * Math.cos(lat * DEG);
    return [u, v];
  };
}

function greatCircleMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const a = toVector(lon1, lat1);
  const b = toVector(lon2, lat2);
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.min(1, dot)) * EARTH_RADIUS_M;
}

describe("rk4Step", () => {
  it("returns to the start after a full solid rotation", () => {
    const period = 5 * 24 * 3600;
    const omega = (2 * Math.PI) / period;
    const steps = 720;
    const seconds = period / steps;
    const wind = solidRotation(omega);
    let [lon, lat] = [20, 30];
    for (let i = 0; i < steps; i++) [lon, lat] = rk4Step(lon, lat, 0, seconds, wind);
    expect(greatCircleMeters(lon, lat, 20, 30)).toBeLessThan(100);
  });

  it("is far more accurate than a simple Euler step on the same rotation", () => {
    const period = 5 * 24 * 3600;
    const omega = (2 * Math.PI) / period;
    const steps = 720;
    const seconds = period / steps;
    const wind = solidRotation(omega);
    let [lon, lat] = [20, 30];
    for (let i = 0; i < steps; i++) {
      const [u, v] = wind(lon, lat, 0);
      lon += ((u * seconds) / (EARTH_RADIUS_M * Math.cos(lat * DEG))) / DEG;
      lat += ((v * seconds) / EARTH_RADIUS_M) / DEG;
    }
    expect(greatCircleMeters(lon, lat, 20, 30)).toBeGreaterThan(100_000);
  });

  it("crosses the antimeridian", () => {
    const [lon] = rk4Step(179.9, 0, 0, 3600, steady(10, 0));
    expect(lon).toBeLessThan(-179);
  });

  it("follows wind that changes during the step", () => {
    const accelerating: WindSample = (_, __, t) => [0, t / 1000];
    const [, lat] = rk4Step(0, 0, 0, 1000, accelerating);
    // Distance is the integral of t, 1000^2 / 2 metres.
    expect(lat * METERS_PER_DEGREE).toBeCloseTo(500_000, 0);
  });
});

describe("runPlume", () => {
  const run = (sample: WindSample, options = {}) =>
    runPlume({ lon: 0, lat: 0, ...window72, ...calm, members: 20, ...options }, source(sample));

  it("carries every member the expected distance in steady wind", async () => {
    const plume = await run(steady(0, 10));
    const expected = (10 * 72 * 3600) / METERS_PER_DEGREE;
    expect(plume!.points).toBe(145);
    for (let m = 0; m < 20; m++) {
      expect(plume!.positions[(m * plume!.capacity + 144) * 2 + 1]).toBeCloseTo(expected, 3);
    }
  });

  it("spreads as mixing theory predicts in still air", async () => {
    const hours = 72;
    const k = 2000;
    const plume = await run(still, { members: 2000, diffusivity: k, endMs: hours * HOUR, seed: 7 });
    let sumSquares = 0;
    for (let m = 0; m < 2000; m++) {
      const lat = plume!.positions[(m * plume!.capacity + plume!.points - 1) * 2 + 1];
      sumSquares += (lat * METERS_PER_DEGREE) ** 2;
    }
    const variance = sumSquares / 2000;
    expect(variance / (2 * k * hours * 3600)).toBeGreaterThan(0.9);
    expect(variance / (2 * k * hours * 3600)).toBeLessThan(1.1);
  });

  it("settles parcels at the expected rate, and they stop moving", async () => {
    const plume = await run(steady(5, 0), { members: 2000, settlingHours: 12, endMs: 24 * HOUR, seed: 3 });
    const settled = [...plume!.settledAt].filter((p) => p >= 0).length;
    expect(settled / 2000).toBeGreaterThan(0.84);
    expect(settled / 2000).toBeLessThan(0.89); // 1 - e^-2 is 0.865
    const m = plume!.settledAt.findIndex((p) => p > 0 && p < plume!.points - 2);
    const at = (point: number) => plume!.positions[(m * plume!.capacity + point) * 2];
    expect(at(plume!.points - 1)).toBe(at(plume!.settledAt[m] + 1));
  });

  it("gives the same plume for the same seed and a different one otherwise", async () => {
    const options = { diffusivity: 2000, members: 10, endMs: 6 * HOUR };
    const a = await run(steady(3, 1), { ...options, seed: 42 });
    const b = await run(steady(3, 1), { ...options, seed: 42 });
    const c = await run(steady(3, 1), { ...options, seed: 43 });
    expect(a!.positions).toEqual(b!.positions);
    expect(a!.positions).not.toEqual(c!.positions);
  });

  it("stops without a result when cancelled", async () => {
    let updates = 0;
    const result = await runPlume(
      { lon: 0, lat: 0, ...window72, ...calm, members: 5 },
      source(still),
      () => updates++,
      () => true,
    );
    expect(result).toBeNull();
    expect(updates).toBe(0);
  });

  it("reports progress, then a final update", async () => {
    const done: boolean[] = [];
    const points: number[] = [];
    await runPlume({ lon: 0, lat: 0, ...window72, ...calm, members: 2 }, source(still), (p, d) => {
      done.push(d);
      points.push(p.points);
    });
    expect(done.at(-1)).toBe(true);
    expect(done.filter((d) => d)).toHaveLength(1);
    expect(points[0]).toBe(13);
    expect(points.at(-1)).toBe(145);
  });

  it("asks for the wind span of every step", async () => {
    const spans: [number, number][] = [];
    await runPlume(
      { lon: 0, lat: 0, startMs: 0, endMs: HOUR, ...calm, members: 1 },
      { prepare: async (a, b) => void spans.push([a, b]), sample: still },
    );
    expect(spans[0]).toEqual([0, 600_000]);
    expect(spans.at(-1)).toEqual([HOUR - 600_000, HOUR]);
    expect(spans).toHaveLength(6);
  });

  it("handles a span shorter than one recording interval", async () => {
    const plume = await run(steady(10, 0), { endMs: 1000 });
    expect(plume!.points).toBe(2);
  });
});

describe("presets", () => {
  it("makes pollen settle much sooner than smoke, and mix less", () => {
    expect(PRESETS.pollen.settlingHours).toBeLessThan(PRESETS.smoke.settlingHours / 5);
    expect(PRESETS.pollen.diffusivity).toBeLessThan(PRESETS.smoke.diffusivity);
  });
});

describe("headPositions", () => {
  const make = async (sample: WindSample, options = {}) =>
    (await runPlume({ lon: 0, lat: 0, startMs: 0, endMs: 6 * HOUR, ...calm, members: 4, ...options }, source(sample)))!;

  it("shows nothing before the release", async () => {
    const plume = await make(steady(1, 0));
    expect(headPositions(plume, -1, new Float32Array(8))).toBe(0);
  });

  it("interpolates between recorded points", async () => {
    const plume = await make(steady(0, 10));
    const out = new Float32Array(8);
    expect(headPositions(plume, 0.75 * HOUR, out)).toBe(4);
    expect(out[1] * METERS_PER_DEGREE).toBeCloseTo(10 * 2700, -1);
  });

  it("holds at the last computed point when the time is beyond it", async () => {
    const plume = await make(steady(0, 10));
    const out = new Float32Array(8);
    headPositions(plume, 100 * HOUR, out);
    expect(out[1] * METERS_PER_DEGREE).toBeCloseTo(10 * 6 * 3600, -1);
  });

  it("interpolates the short way across the antimeridian", async () => {
    const plume = await make(steady(10, 0), { lon: 179.99, endMs: HOUR, stepSeconds: 600 });
    const out = new Float32Array(8);
    headPositions(plume, 0.25 * HOUR, out);
    expect(Math.abs(out[0])).toBeGreaterThan(179);
  });

  it("leaves out members that have settled", async () => {
    const plume = await make(steady(1, 0), { settlingHours: 0.01 });
    expect(headPositions(plume, 6 * HOUR, new Float32Array(8))).toBe(0);
    expect(headPositions(plume, 0, new Float32Array(8))).toBe(4);
  });
});

describe("plumeHours", () => {
  it("runs from zero and stops at what has been computed", async () => {
    const plume = (await runPlume({ lon: 0, lat: 0, startMs: 1000, endMs: 1000 + 2 * HOUR, ...calm, members: 1 }, source(still)))!;
    expect(plumeHours(plume, 0)).toBe(0);
    expect(plumeHours(plume, 1000 + HOUR)).toBeCloseTo(1);
    expect(plumeHours(plume, 1000 + 9 * HOUR)).toBeCloseTo(2);
  });
});

describe("centerPath", () => {
  it("follows the middle of the plume, including across the antimeridian", async () => {
    const plume = (await runPlume(
      { lon: 179.5, lat: 10, startMs: 0, endMs: 12 * HOUR, ...calm, members: 5 },
      source(steady(10, 0)),
    ))!;
    const path = centerPath(plume);
    expect(path).toHaveLength(plume.points);
    expect(path[0][0]).toBeCloseTo(179.5, 3);
    // 10 m/s for 12 h at 10N is 3.95 degrees, carrying it past 180 to about -176.55.
    expect(path.at(-1)![0]).toBeCloseTo(-176.55, 1);
    expect(path.at(-1)![1]).toBeCloseTo(10, 3);
  });

  it("ends when no members remain airborne", async () => {
    const plume = (await runPlume(
      { lon: 0, lat: 0, startMs: 0, endMs: 24 * HOUR, diffusivity: 0, settlingHours: 0.01, seed: 1, members: 5 },
      source(still),
    ))!;
    expect(centerPath(plume).length).toBeLessThan(plume.points);
  });
});

describe("createRandom", () => {
  it("stays in range and looks uniform", () => {
    const random = createRandom(9);
    let sum = 0;
    for (let i = 0; i < 100_000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      sum += value;
    }
    expect(sum / 100_000).toBeCloseTo(0.5, 2);
  });
});
