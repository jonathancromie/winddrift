import { describe, expect, it } from "vitest";
import { toHalfFloat, type FrameGrid } from "./frame";
import { sampleBlended, sampleFrame, type SampledFrame } from "./sample";

const GLOBAL: FrameGrid = { nx: 8, ny: 5, lon0: -180, lat0: -90, dlon: 45, dlat: 45 };
const NEST: FrameGrid = { nx: 11, ny: 11, lon0: -5, lat0: -5, dlon: 1, dlat: 1 };

function frame(grid: FrameGrid, value: (row: number, col: number) => number): SampledFrame {
  const data = new Uint16Array(grid.nx * grid.ny);
  for (let row = 0; row < grid.ny; row++) {
    for (let col = 0; col < grid.nx; col++) data[row * grid.nx + col] = toHalfFloat(value(row, col));
  }
  return { grid, data };
}

const flat = (grid: FrameGrid, value: number) => frame(grid, () => value);
const fullMask = new Uint8Array(NEST.nx * NEST.ny).fill(255);

describe("sampleFrame", () => {
  it("interpolates between neighbouring cells", () => {
    const ramp = frame(GLOBAL, (_, col) => col * 8);
    expect(sampleFrame(ramp, -157.5, 0)).toBeCloseTo(4, 2);
  });

  it("wraps a global grid across the antimeridian", () => {
    const ramp = frame(GLOBAL, (_, col) => (col === 7 ? 10 : col === 0 ? 20 : 0));
    expect(sampleFrame(ramp, 157.5, 0)).toBeCloseTo(15, 2);
  });

  it("clamps at the poles", () => {
    const ramp = frame(GLOBAL, (row) => row * 4);
    expect(sampleFrame(ramp, 0, 90)).toBeCloseTo(16, 2);
    expect(sampleFrame(ramp, 0, -90)).toBeCloseTo(0, 2);
  });
});

describe("sampleBlended", () => {
  const baseA = flat(GLOBAL, 10);
  const baseB = flat(GLOBAL, 20);
  const nest = (mask = fullMask, weight = 1) => ({
    a: flat(NEST, 30),
    b: flat(NEST, 40),
    mix: 0.5,
    weight,
    mask,
  });

  it("uses the global model alone when there's no regional frame", () => {
    expect(sampleBlended({ baseA, baseB, baseMix: 0.5 }, 0, 0)).toBeCloseTo(15, 2);
  });

  it("uses the regional model at full strength inside it", () => {
    expect(sampleBlended({ baseA, baseB, baseMix: 0.5, nest: nest() }, 0, 0)).toBeCloseTo(35, 2);
  });

  it("uses the global model outside the regional grid", () => {
    expect(sampleBlended({ baseA, baseB, baseMix: 0.5, nest: nest() }, 90, 0)).toBeCloseTo(15, 2);
  });

  it("blends by the mask and the time weight together", () => {
    const halfMask = new Uint8Array(NEST.nx * NEST.ny).fill(128);
    const value = sampleBlended({ baseA, baseB, baseMix: 0.5, nest: nest(halfMask, 0.5) }, 0, 0);
    expect(value).toBeCloseTo(15 + 20 * (128 / 255) * 0.5, 1);
  });
});
