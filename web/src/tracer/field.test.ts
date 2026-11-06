import { describe, expect, it } from "vitest";
import type { DecodedFrame, FrameGrid } from "../data/frame";
import { prepareFrames, type TimedFrame } from "../data/manifest";
import { WindField } from "./field";

const HOUR = 3600 * 1000;
const NODATA = -32768;
const GLOBAL: FrameGrid = { nx: 8, ny: 5, lon0: -180, lat0: -90, dlon: 45, dlat: 45 };
// A regional grid large enough for its middle to sit beyond the 30-cell edge fade.
const NEST: FrameGrid = { nx: 101, ny: 101, lon0: -50, lat0: -50, dlon: 1, dlat: 1 };

function uniform(grid: FrameGrid, u: number, v: number, hole?: (row: number, col: number) => boolean): DecodedFrame {
  const scale = 0.05;
  const count = grid.nx * grid.ny;
  const us = new Int16Array(count).fill(u / scale);
  const vs = new Int16Array(count).fill(v / scale);
  if (hole) {
    for (let row = 0; row < grid.ny; row++) {
      for (let col = 0; col < grid.nx; col++) {
        if (hole(row, col)) {
          us[row * grid.nx + col] = NODATA;
          vs[row * grid.nx + col] = NODATA;
        }
      }
    }
  }
  return { grid, scale, u: us, v: vs };
}

const times = (hours: number[], prefix: string) =>
  prepareFrames(hours.map((h) => ({ time: new Date(h * HOUR).toISOString(), url: `${prefix}${h}`, bytes: 1 })));

function fieldFor(
  base: [number[], (h: number) => DecodedFrame],
  nest: [number[], (h: number) => DecodedFrame],
) {
  const loaded: string[] = [];
  const hourOf = (frame: TimedFrame) => frame.timeMs / HOUR;
  const field = new WindField(times(base[0], "g"), times(nest[0], "h"), async (frame) => {
    loaded.push(frame.url);
    return frame.url.startsWith("h") ? nest[1](hourOf(frame)) : base[1](hourOf(frame));
  });
  return { field, loaded };
}

const noNestHours = [1000, 1010];
const noNest: [number[], (h: number) => DecodedFrame] = [noNestHours, () => uniform(NEST, 99, 99)];

describe("WindField", () => {
  it("interpolates a model between frames in time", async () => {
    const { field } = fieldFor([[0, 3], (h) => uniform(GLOBAL, h === 0 ? 0 : 9, 3)], noNest);
    await field.prepare(HOUR, HOUR);
    const [u, v] = field.sample(0, 0, HOUR);
    expect(u).toBeCloseTo(3, 2);
    expect(v).toBeCloseTo(3, 2);
  });

  it("wraps the global grid across the antimeridian", async () => {
    const frame = uniform(GLOBAL, 0, 0);
    // Column 7 is lon 135, and column 0 is lon -180.
    for (let row = 0; row < 5; row++) {
      frame.u[row * 8 + 7] = 200;
      frame.u[row * 8] = 400;
    }
    const { field } = fieldFor([[0, 3], () => frame], noNest);
    await field.prepare(0, 0);
    expect(field.sample(157.5, 0, 0)[0]).toBeCloseTo(15, 2); // halfway from 10 to 20 m/s
  });

  it("uses the regional model at full strength inside it, away from both time ends", async () => {
    const { field } = fieldFor(
      [[0, 24], () => uniform(GLOBAL, 1, 1)],
      [[0, 24], () => uniform(NEST, 8, -8)],
    );
    await field.prepare(12 * HOUR, 12 * HOUR);
    const [u, v] = field.sample(0, 0, 12 * HOUR);
    expect(u).toBeCloseTo(8, 2);
    expect(v).toBeCloseTo(-8, 2);
  });

  it("uses only the global model outside the regional grid", async () => {
    const { field } = fieldFor(
      [[0, 24], () => uniform(GLOBAL, 1, 1)],
      [[0, 24], () => uniform(NEST, 8, -8)],
    );
    await field.prepare(12 * HOUR, 12 * HOUR);
    expect(field.sample(120, 45, 12 * HOUR)[0]).toBeCloseTo(1, 2);
  });

  it("blends part way through the regional model's edge fade", async () => {
    const { field } = fieldFor(
      [[0, 24], () => uniform(GLOBAL, 0, 0)],
      [[0, 24], () => uniform(NEST, 10, 0)],
    );
    await field.prepare(12 * HOUR, 12 * HOUR);
    const [u] = field.sample(-35, 0, 12 * HOUR); // 15 cells in from the west edge of a 30-cell fade
    expect(u).toBeGreaterThan(2);
    expect(u).toBeLessThan(8);
  });

  it("treats missing regional data as fully faded out", async () => {
    const { field } = fieldFor(
      [[0, 24], () => uniform(GLOBAL, 2, 2)],
      [[0, 24], () => uniform(NEST, 40, 40, (_, col) => col > 50)],
    );
    await field.prepare(12 * HOUR, 12 * HOUR);
    expect(field.sample(5, 0, 12 * HOUR)[0]).toBeCloseTo(2, 2);
  });

  it("fades the regional model in time toward the end of its range", async () => {
    const { field } = fieldFor(
      [[0, 48], () => uniform(GLOBAL, 0, 0)],
      [[0, 24], () => uniform(NEST, 10, 0)],
    );
    await field.prepare(22.5 * HOUR, 22.5 * HOUR);
    expect(field.sample(0, 0, 22.5 * HOUR)[0]).toBeCloseTo(5, 2);
    await field.prepare(30 * HOUR, 30 * HOUR);
    expect(field.sample(0, 0, 30 * HOUR)[0]).toBeCloseTo(0, 2);
  });

  it("keeps only the frames around the current time", async () => {
    const { field, loaded } = fieldFor(
      [[0, 3, 6, 9], () => uniform(GLOBAL, 1, 1)],
      [[1000, 1010], () => uniform(NEST, 1, 1)],
    );
    await field.prepare(0, HOUR);
    expect(loaded).toEqual(["g0", "g3"]);
    await field.prepare(2 * HOUR, 3 * HOUR + 1);
    expect(loaded).toEqual(["g0", "g3", "g6"]);
    await field.prepare(7 * HOUR, 8 * HOUR);
    expect(() => field.sample(0, 0, HOUR)).toThrow();
    expect(field.loads).toBe(4);
  });

  it("doesn't load regional frames outside the regional range", async () => {
    const { field, loaded } = fieldFor(
      [[0, 3], () => uniform(GLOBAL, 1, 1)],
      [[1000, 1010], () => uniform(NEST, 1, 1)],
    );
    await field.prepare(0, HOUR);
    expect(loaded.some((url) => url.startsWith("h"))).toBe(false);
  });

  it("refuses to answer for a time that wasn't prepared", () => {
    const { field } = fieldFor([[0, 3], () => uniform(GLOBAL, 1, 1)], noNest);
    expect(() => field.sample(0, 0, 0)).toThrow("outside the prepared");
  });
});
