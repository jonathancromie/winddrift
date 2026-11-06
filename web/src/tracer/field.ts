import { EDGE_FADE_CELLS, edgeFadeMask, isGlobal, NODATA, type DecodedFrame, type FrameGrid } from "../data/frame";
import { framePairAt, NEST_FADE_MS, nestWeight, type TimedFrame } from "../data/manifest";

export type FrameLoad = (frame: TimedFrame) => Promise<DecodedFrame>;

/** Bilinear lookup that treats grids the way the GPU does: global grids wrap, others clamp. */
function bilinear(
  grid: FrameGrid,
  read: (index: number) => number,
  lon: number,
  lat: number,
): number {
  const x = (lon - grid.lon0) / grid.dlon;
  const y = Math.min(grid.ny - 1, Math.max(0, (lat - grid.lat0) / grid.dlat));
  const x0 = Math.floor(x);
  const y0 = Math.min(Math.floor(y), grid.ny - 2);
  const fx = x - x0;
  const fy = y - y0;
  const wraps = isGlobal(grid);
  const column = (c: number) =>
    wraps ? ((c % grid.nx) + grid.nx) % grid.nx : Math.min(grid.nx - 1, Math.max(0, c));
  const c0 = column(x0);
  const c1 = column(x0 + 1);
  const row0 = y0 * grid.nx;
  const row1 = (y0 + 1) * grid.nx;
  const bottom = read(row0 + c0) * (1 - fx) + read(row0 + c1) * fx;
  const top = read(row1 + c0) * (1 - fx) + read(row1 + c1) * fx;
  return bottom * (1 - fy) + top * fy;
}

function windAt(frame: DecodedFrame, lon: number, lat: number): [number, number] {
  const u = bilinear(frame.grid, (i) => (frame.u[i] === NODATA ? 0 : frame.u[i]), lon, lat);
  const v = bilinear(frame.grid, (i) => (frame.v[i] === NODATA ? 0 : frame.v[i]), lon, lat);
  return [u * frame.scale, v * frame.scale];
}

/**
 * The same blended wind the particle shader draws, available off the GPU. Only the
 * frames around the current time stay in memory, so a long run doesn't hold them all.
 */
export class WindField {
  private readonly frames = new Map<TimedFrame, DecodedFrame>();
  private mask: Uint8Array | null = null;
  /** Total frames fetched, for reporting the cost of a run. */
  loads = 0;

  constructor(
    private readonly base: TimedFrame[],
    private readonly nest: TimedFrame[],
    private readonly load: FrameLoad,
  ) {}

  /** Load what's needed for a span of time, and let go of everything else. */
  async prepare(startMs: number, endMs: number): Promise<void> {
    const needed = new Set<TimedFrame>();
    const addPairs = (list: TimedFrame[]) => {
      for (const time of [startMs, endMs]) {
        const { a, b } = framePairAt(list, time);
        needed.add(list[a]);
        needed.add(list[b]);
      }
    };
    addPairs(this.base);
    const nestStart = this.nest[0].timeMs;
    const nestEnd = this.nest[this.nest.length - 1].timeMs;
    if (startMs < nestEnd && endMs > nestStart) addPairs(this.nest);

    for (const frame of this.frames.keys()) {
      if (!needed.has(frame)) this.frames.delete(frame);
    }
    const missing = [...needed].filter((frame) => !this.frames.has(frame));
    if (missing.length === 0) return;
    const decoded = await Promise.all(missing.map((frame) => this.load(frame)));
    this.loads += missing.length;
    missing.forEach((frame, i) => {
      this.frames.set(frame, decoded[i]);
      if (!this.mask && this.nest.includes(frame)) {
        this.mask = edgeFadeMask(decoded[i], EDGE_FADE_CELLS);
      }
    });
  }

  /** Wind in m/s at a place and time. The time must lie in the last prepared span. */
  sample(lon: number, lat: number, timeMs: number): [number, number] {
    const [baseU, baseV] = this.sampleModel(this.base, lon, lat, timeMs);
    const weight = nestWeight(this.nest, timeMs, NEST_FADE_MS);
    if (weight === 0 || !this.mask) return [baseU, baseV];

    const { a } = framePairAt(this.nest, timeMs);
    const grid = this.frames.get(this.nest[a])!.grid;
    const mask = this.mask;
    const blend = (bilinear(grid, (i) => mask[i], lon, lat) / 255) * weight;
    if (blend === 0) return [baseU, baseV];
    const [nestU, nestV] = this.sampleModel(this.nest, lon, lat, timeMs);
    return [baseU + (nestU - baseU) * blend, baseV + (nestV - baseV) * blend];
  }

  private sampleModel(list: TimedFrame[], lon: number, lat: number, timeMs: number): [number, number] {
    const { a, b, mix } = framePairAt(list, timeMs);
    const frameA = this.frames.get(list[a]);
    const frameB = this.frames.get(list[b]);
    if (!frameA || !frameB) throw new Error("Wind sampled outside the prepared time span");
    const [ua, va] = windAt(frameA, lon, lat);
    if (a === b || mix === 0) return [ua, va];
    const [ub, vb] = windAt(frameB, lon, lat);
    return [ua + (ub - ua) * mix, va + (vb - va) * mix];
  }
}
