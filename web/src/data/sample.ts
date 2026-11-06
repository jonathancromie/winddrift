import { fromHalfFloat, isGlobal, type FrameGrid } from "./frame";

export interface SampledFrame {
  grid: FrameGrid;
  /** One half-float value per cell, rows running south to north. */
  data: Uint16Array;
}

/** Bilinear lookup that treats a grid the way the GPU does: global grids wrap, others clamp. */
export function sampleBilinear(grid: FrameGrid, read: (index: number) => number, lon: number, lat: number): number {
  const x = (lon - grid.lon0) / grid.dlon;
  const y = Math.min(grid.ny - 1, Math.max(0, (lat - grid.lat0) / grid.dlat));
  const x0 = Math.floor(x);
  const y0 = Math.min(Math.floor(y), Math.max(grid.ny - 2, 0));
  const fx = x - x0;
  const fy = y - y0;
  const wraps = isGlobal(grid);
  const column = (c: number) => (wraps ? ((c % grid.nx) + grid.nx) % grid.nx : Math.min(grid.nx - 1, Math.max(0, c)));
  const c0 = column(x0);
  const c1 = column(x0 + 1);
  const row0 = y0 * grid.nx;
  const row1 = Math.min(y0 + 1, grid.ny - 1) * grid.nx;
  const bottom = read(row0 + c0) * (1 - fx) + read(row0 + c1) * fx;
  const top = read(row1 + c0) * (1 - fx) + read(row1 + c1) * fx;
  return bottom * (1 - fy) + top * fy;
}

export function sampleFrame(frame: SampledFrame, lon: number, lat: number): number {
  return sampleBilinear(frame.grid, (i) => fromHalfFloat(frame.data[i]), lon, lat);
}

export interface BlendInput {
  baseA: SampledFrame;
  baseB: SampledFrame;
  baseMix: number;
  nest?: {
    a: SampledFrame;
    b: SampledFrame;
    mix: number;
    weight: number;
    mask: Uint8Array;
  };
}

/** The value the shader draws at a place: global blended with regional through the edge mask. */
export function sampleBlended(input: BlendInput, lon: number, lat: number): number {
  const a = sampleFrame(input.baseA, lon, lat);
  const b = sampleFrame(input.baseB, lon, lat);
  const base = a + (b - a) * input.baseMix;
  const { nest } = input;
  if (!nest) return base;

  const grid = nest.a.grid;
  const inside =
    lon >= grid.lon0 &&
    lon <= grid.lon0 + (grid.nx - 1) * grid.dlon &&
    lat >= grid.lat0 &&
    lat <= grid.lat0 + (grid.ny - 1) * grid.dlat;
  if (!inside) return base;
  const blend = (sampleBilinear(grid, (i) => nest.mask[i], lon, lat) / 255) * nest.weight;
  if (blend <= 0) return base;
  const na = sampleFrame(nest.a, lon, lat);
  const nb = sampleFrame(nest.b, lon, lat);
  return base + (na + (nb - na) * nest.mix - base) * blend;
}
