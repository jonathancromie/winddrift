/**
 * Decoder for the WDF1 wind frame format. pipeline/winddrift/encode.py defines the
 * format, and a fixture written by that encoder keeps the two in step.
 */

const HEADER_BYTES = 28;
const NODATA = -32768;

export interface FrameGrid {
  nx: number;
  ny: number;
  lon0: number;
  lat0: number;
  dlon: number;
  dlat: number;
}

export interface DecodedFrame {
  grid: FrameGrid;
  scale: number;
  /** Integer U values in rows running south to north. Multiply by scale for m/s. */
  u: Int16Array;
  v: Int16Array;
}

export async function decodeFrame(buffer: ArrayBuffer): Promise<DecodedFrame> {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  if (magic !== "WDF1") throw new Error(`Not a wind frame: ${magic}`);

  const grid: FrameGrid = {
    nx: view.getUint16(4, true),
    ny: view.getUint16(6, true),
    lon0: view.getFloat32(8, true),
    lat0: view.getFloat32(12, true),
    dlon: view.getFloat32(16, true),
    dlat: view.getFloat32(20, true),
  };
  const scale = view.getFloat32(24, true);

  const payload = new Blob([new Uint8Array(buffer, HEADER_BYTES)]);
  const stream = payload.stream().pipeThrough(new DecompressionStream("gzip"));
  const shuffled = new Uint8Array(await new Response(stream).arrayBuffer());

  const count = grid.nx * grid.ny;
  if (shuffled.length !== count * 4) {
    throw new Error(`Frame payload is ${shuffled.length} bytes, expected ${count * 4}`);
  }
  const values = unshuffle(shuffled);
  undeltaRows(values, grid.nx, grid.ny, 0);
  undeltaRows(values, grid.nx, grid.ny, count);
  return { grid, scale, u: values.subarray(0, count), v: values.subarray(count) };
}

function unshuffle(data: Uint8Array): Int16Array {
  const half = data.length / 2;
  const out = new Int16Array(half);
  for (let i = 0; i < half; i++) {
    out[i] = data[i] | (data[half + i] << 8);
  }
  return out;
}

/** Int16Array storage wraps on overflow, which reverses the encoder's wrapping deltas. */
function undeltaRows(values: Int16Array, nx: number, ny: number, offset: number): void {
  for (let row = 0; row < ny; row++) {
    const start = offset + row * nx;
    for (let col = 1; col < nx; col++) {
      values[start + col] += values[start + col - 1];
    }
  }
}

/** Convert a JS number to the IEEE 754 half-float bit pattern, rounding to nearest. */
export function toHalfFloat(value: number): number {
  const floats = new Float32Array(1);
  const bits = new Uint32Array(floats.buffer);
  floats[0] = value;
  const x = bits[0];
  const sign = (x >>> 16) & 0x8000;
  const exponent = ((x >>> 23) & 0xff) - 127 + 15;
  const mantissa = x & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const full = mantissa | 0x800000;
    const shift = 14 - exponent;
    return sign | ((full + (1 << (shift - 1))) >>> shift);
  }
  if (exponent >= 31) return sign | 0x7c00;
  // A rounding carry correctly spills from the mantissa into the exponent.
  return sign + ((exponent << 10) | (mantissa >>> 13)) + ((mantissa >>> 12) & 1);
}

/**
 * Interleave U and V as half floats in m/s, ready for an RG16F texture. Converting
 * here means the GPU upload needs no conversion on the main thread.
 * NODATA cells become calm wind for now.
 */
export function toHalfFloatRG(frame: DecodedFrame): Uint16Array {
  const table = new Uint16Array(65536);
  for (let i = -32768; i < 32768; i++) {
    table[i & 0xffff] = i === NODATA ? 0 : toHalfFloat(i * frame.scale);
  }
  const { u, v } = frame;
  const out = new Uint16Array(u.length * 2);
  for (let i = 0; i < u.length; i++) {
    out[i * 2] = table[u[i] & 0xffff];
    out[i * 2 + 1] = table[v[i] & 0xffff];
  }
  return out;
}
