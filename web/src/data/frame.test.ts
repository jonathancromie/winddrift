import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFrame, edgeFadeMask, isGlobal, toHalfFloat, toHalfFloatRG, type DecodedFrame } from "./frame";

function fixture(): ArrayBuffer {
  const bytes = readFileSync(new URL("./__fixtures__/small.wdf", import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Inverse of toHalfFloat, for checking values. */
function fromHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return (sign * mantissa) / 2 ** 24;
  if (exponent === 31) return sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

describe("decodeFrame", () => {
  it("reads a frame written by the Python encoder", async () => {
    const frame = await decodeFrame(fixture());
    expect(frame.grid.nx).toBe(4);
    expect(frame.grid.ny).toBe(3);
    expect(frame.grid.lon0).toBeCloseTo(-10);
    expect(frame.grid.lat0).toBeCloseTo(20);
    expect(frame.grid.dlon).toBeCloseTo(0.5);
    expect(frame.grid.dlat).toBeCloseTo(0.25);
    expect(frame.scale).toBeCloseTo(0.05);

    const toMs = (i: number) => Array.from(frame.u.subarray(i, i + 4), (x) => x * frame.scale);
    const close = (actual: number[], expected: number[]) =>
      actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 3));
    close(toMs(0), [0, 1.5, -1.5, 100]);
    close(toMs(4), [-100, 0.05, -0.05, 3.2]);
    expect(frame.u[8]).toBe(-32768);
    expect(frame.u[9]).toBe(-32768);
    expect(frame.u[10] * frame.scale).toBeCloseTo(7, 3);
    expect(frame.u[11] * frame.scale).toBeCloseTo(-7, 3);
    expect(frame.v[1] * frame.scale).toBeCloseTo(-1.5, 3);
    expect(frame.v[8]).toBe(-32768);
  });

  it("rejects data that is not a frame", async () => {
    await expect(decodeFrame(new ArrayBuffer(40))).rejects.toThrow("Not a wind frame");
  });
});

describe("isGlobal", () => {
  it("separates a global grid from a regional one", () => {
    const base = { lon0: 0, lat0: 0, dlat: 1, ny: 1 };
    expect(isGlobal({ ...base, nx: 1440, dlon: 0.25 })).toBe(true);
    expect(isGlobal({ ...base, nx: 1480, dlon: 0.05 })).toBe(false);
  });
});

describe("edgeFadeMask", () => {
  function frameWith(nx: number, ny: number, isNoData: (row: number, col: number) => boolean): DecodedFrame {
    const u = new Int16Array(nx * ny);
    for (let row = 0; row < ny; row++) {
      for (let col = 0; col < nx; col++) u[row * nx + col] = isNoData(row, col) ? -32768 : 10;
    }
    return { grid: { nx, ny, lon0: 0, lat0: 0, dlon: 1, dlat: 1 }, scale: 0.05, u, v: u };
  }

  it("is zero on the grid border and full strength deep inside", () => {
    const mask = edgeFadeMask(frameWith(41, 41, () => false), 10);
    expect(mask[0]).toBe(0);
    expect(mask[20]).toBe(0); // middle of the bottom row
    expect(mask[20 * 41 + 20]).toBe(255);
  });

  it("rises steadily from the edge to full strength", () => {
    const mask = edgeFadeMask(frameWith(41, 41, () => false), 10);
    const row = Array.from(mask.subarray(20 * 41, 20 * 41 + 21));
    for (let i = 1; i < row.length; i++) expect(row[i]).toBeGreaterThanOrEqual(row[i - 1]);
    expect(row[5]).toBeGreaterThan(0);
    expect(row[5]).toBeLessThan(255);
  });

  it("fades away from missing data inside the grid", () => {
    const mask = edgeFadeMask(frameWith(41, 41, (row, col) => col >= 30 && row >= 0), 5);
    expect(mask[20 * 41 + 35]).toBe(0);
    expect(mask[20 * 41 + 29]).toBe(0);
    expect(mask[20 * 41 + 15]).toBe(255);
  });

  it("measures distance in both sweep directions", () => {
    const mask = edgeFadeMask(frameWith(41, 41, (row, col) => row === 20 && col === 20), 5);
    const distanceFromHole = (r: number, c: number) => mask[r * 41 + c];
    expect(distanceFromHole(20, 21)).toBe(0);
    expect(distanceFromHole(20, 19)).toBe(0);
    expect(distanceFromHole(21, 20)).toBe(0);
    expect(distanceFromHole(19, 20)).toBe(0);
    expect(distanceFromHole(20, 23)).toBe(distanceFromHole(20, 17));
    expect(distanceFromHole(23, 20)).toBe(distanceFromHole(17, 20));
  });
});

describe("toHalfFloat", () => {
  it.each([0, 1, -1, 0.5, 2, -2, 1024])("represents %d exactly", (value) => {
    expect(fromHalf(toHalfFloat(value))).toBe(value);
  });

  it("matches known bit patterns", () => {
    expect(toHalfFloat(1)).toBe(0x3c00);
    expect(toHalfFloat(-2)).toBe(0xc000);
    expect(toHalfFloat(65504)).toBe(0x7bff);
    expect(toHalfFloat(1e6)).toBe(0x7c00);
  });

  it("is precise enough for every wind value in a realistic range", () => {
    for (let ms = -120; ms <= 120; ms += 0.05) {
      const relative = Math.abs(fromHalf(toHalfFloat(ms)) - ms);
      expect(relative).toBeLessThan(0.04);
    }
  });
});

describe("toHalfFloatRG", () => {
  it("interleaves U and V in m/s and turns NODATA into calm wind", async () => {
    const frame = await decodeFrame(fixture());
    const rg = toHalfFloatRG(frame);
    expect(rg.length).toBe(24);
    expect(fromHalf(rg[2])).toBeCloseTo(1.5, 2); // u, column 1
    expect(fromHalf(rg[3])).toBeCloseTo(-1.5, 2); // v, column 1
    expect(rg[16]).toBe(0); // NODATA
    expect(rg[17]).toBe(0);
    expect(fromHalf(rg[20])).toBeCloseTo(7, 2);
  });
});
