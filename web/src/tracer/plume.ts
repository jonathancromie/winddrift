import { EARTH_RADIUS_M, wrapLon } from "../render/geo";

export type WindSample = (lon: number, lat: number, timeMs: number) => [number, number];

export type PresetName = "smoke" | "pollen";

export interface TracerPreset {
  label: string;
  /** Horizontal mixing in m²/s. These are illustrative values, not measurements. */
  diffusivity: number;
  /** Average airborne time in hours before a parcel settles out. Also illustrative. */
  settlingHours: number;
  /** Colour on the map as linear 0-1 RGB. */
  color: [number, number, number];
}

export const PRESETS: Record<PresetName, TracerPreset> = {
  smoke: { label: "Smoke", diffusivity: 2000, settlingHours: 120, color: [0.96, 0.93, 0.88] },
  pollen: { label: "Pollen", diffusivity: 800, settlingHours: 12, color: [0.78, 0.95, 0.25] },
};

const MEMBERS = 200;
const STEP_SECONDS = 600;
const STEPS_PER_RECORD = 3;
const POSTS_EVERY_RECORDS = 12;
const DEGREES = 180 / Math.PI;
const MAX_LAT = 89.9;

export interface PlumeOptions {
  lon: number;
  lat: number;
  startMs: number;
  endMs: number;
  diffusivity: number;
  settlingHours: number;
  seed: number;
  members?: number;
  stepSeconds?: number;
  stepsPerRecord?: number;
}

export interface Plume {
  members: number;
  /** Number of time points recorded so far. */
  points: number;
  startMs: number;
  recordMs: number;
  /** Member paths as lon, lat pairs: [member 0 point 0, member 0 point 1, ...]. */
  positions: Float32Array;
  /** The point at which each member settled, or -1 while it's still airborne. */
  settledAt: Int16Array;
  capacity: number;
}

/** Small seeded generator, so the same release always gives the same plume. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

function velocityDegrees(wind: [number, number], lat: number): [number, number] {
  const cosLat = Math.max(Math.cos(lat / DEGREES), 0.01);
  return [(wind[0] / (EARTH_RADIUS_M * cosLat)) * DEGREES, (wind[1] / EARTH_RADIUS_M) * DEGREES];
}

/** One fourth-order Runge-Kutta step through wind that varies in space and time. */
export function rk4Step(
  lon: number,
  lat: number,
  timeMs: number,
  seconds: number,
  sample: WindSample,
): [number, number] {
  const deriv = (x: number, y: number, t: number) => velocityDegrees(sample(wrapLon(x), y, t), y);
  const half = seconds / 2;
  const k1 = deriv(lon, lat, timeMs);
  const k2 = deriv(lon + k1[0] * half, lat + k1[1] * half, timeMs + half * 1000);
  const k3 = deriv(lon + k2[0] * half, lat + k2[1] * half, timeMs + half * 1000);
  const k4 = deriv(lon + k3[0] * seconds, lat + k3[1] * seconds, timeMs + seconds * 1000);
  return [
    wrapLon(lon + (seconds / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0])),
    Math.max(-MAX_LAT, Math.min(MAX_LAT, lat + (seconds / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]))),
  ];
}

export interface PlumeSource {
  prepare(startMs: number, endMs: number): Promise<void>;
  sample: WindSample;
}

/**
 * Carry an ensemble of parcels through the wind. Each moves with the wind, gets a random
 * nudge standing in for mixing the wind data can't resolve, and may settle out.
 */
export async function runPlume(
  options: PlumeOptions,
  source: PlumeSource,
  onUpdate: (plume: Plume, done: boolean) => void = () => {},
  isCancelled: () => boolean = () => false,
): Promise<Plume | null> {
  const members = options.members ?? MEMBERS;
  const stepSeconds = options.stepSeconds ?? STEP_SECONDS;
  const stepsPerRecord = options.stepsPerRecord ?? STEPS_PER_RECORD;
  const recordMs = stepSeconds * stepsPerRecord * 1000;
  const records = Math.max(1, Math.floor((options.endMs - options.startMs) / recordMs));
  const capacity = records + 1;
  const random = createRandom(options.seed);

  const plume: Plume = {
    members,
    points: 1,
    startMs: options.startMs,
    recordMs,
    positions: new Float32Array(members * capacity * 2),
    settledAt: new Int16Array(members).fill(-1),
    capacity,
  };
  const lons = new Float64Array(members).fill(options.lon);
  const lats = new Float64Array(members).fill(options.lat);
  for (let m = 0; m < members; m++) {
    plume.positions[m * capacity * 2] = options.lon;
    plume.positions[m * capacity * 2 + 1] = options.lat;
  }

  const spread = Math.sqrt(2 * options.diffusivity * stepSeconds);
  const settleChance = 1 - Math.exp(-stepSeconds / (options.settlingHours * 3600));
  const sample: WindSample = (x, y, t) => source.sample(x, y, t);

  for (let record = 1; record <= records; record++) {
    for (let step = 0; step < stepsPerRecord; step++) {
      const timeMs = options.startMs + ((record - 1) * stepsPerRecord + step) * stepSeconds * 1000;
      await source.prepare(timeMs, timeMs + stepSeconds * 1000);
      if (isCancelled()) return null;
      for (let m = 0; m < members; m++) {
        if (plume.settledAt[m] >= 0) continue;
        const [lon, lat] = rk4Step(lons[m], lats[m], timeMs, stepSeconds, sample);
        const cosLat = Math.max(Math.cos(lat / DEGREES), 0.01);
        const eastMeters = gaussian(random) * spread;
        const northMeters = gaussian(random) * spread;
        lons[m] = wrapLon(lon + (eastMeters / (EARTH_RADIUS_M * cosLat)) * DEGREES);
        lats[m] = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat + (northMeters / EARTH_RADIUS_M) * DEGREES));
        if (random() < settleChance) plume.settledAt[m] = record;
      }
    }
    for (let m = 0; m < members; m++) {
      const offset = (m * capacity + record) * 2;
      plume.positions[offset] = lons[m];
      plume.positions[offset + 1] = lats[m];
    }
    plume.points = record + 1;
    if (record < records && record % POSTS_EVERY_RECORDS === 0) onUpdate(plume, false);
  }
  onUpdate(plume, true);
  return plume;
}

/** The hours along a plume for a time, limited to what has been computed. */
export function plumeHours(plume: Plume, timeMs: number): number {
  const last = (plume.points - 1) * plume.recordMs;
  return Math.min(Math.max(timeMs - plume.startMs, 0), last) / 3600000;
}

function interpolateLon(a: number, b: number, f: number): number {
  const delta = ((b - a + 540) % 360) - 180;
  return wrapLon(a + delta * f);
}

/**
 * Where each member is at a time, written to `out` as lon, lat pairs for the airborne
 * members only. Returns how many are airborne.
 */
export function headPositions(plume: Plume, timeMs: number, out: Float32Array): number {
  if (timeMs < plume.startMs) return 0;
  const exact = (Math.min(timeMs, plume.startMs + (plume.points - 1) * plume.recordMs) - plume.startMs) / plume.recordMs;
  const point = Math.min(Math.floor(exact), plume.points - 2);
  const f = plume.points < 2 ? 0 : exact - point;
  let count = 0;
  for (let m = 0; m < plume.members; m++) {
    const settled = plume.settledAt[m];
    if (settled >= 0 && exact >= settled) continue;
    const offset = (m * plume.capacity + Math.max(point, 0)) * 2;
    if (plume.points < 2) {
      out[count * 2] = plume.positions[offset];
      out[count * 2 + 1] = plume.positions[offset + 1];
    } else {
      out[count * 2] = interpolateLon(plume.positions[offset], plume.positions[offset + 2], f);
      out[count * 2 + 1] = plume.positions[offset + 1] + (plume.positions[offset + 3] - plume.positions[offset + 1]) * f;
    }
    count++;
  }
  return count;
}

/** The middle of the airborne members at each point, safe across the antimeridian. */
export function centerPath(plume: Plume): [number, number][] {
  const path: [number, number][] = [];
  for (let point = 0; point < plume.points; point++) {
    let x = 0;
    let y = 0;
    let lat = 0;
    let count = 0;
    for (let m = 0; m < plume.members; m++) {
      const settled = plume.settledAt[m];
      if (settled >= 0 && point >= settled) continue;
      const offset = (m * plume.capacity + point) * 2;
      const lonRadians = plume.positions[offset] / DEGREES;
      x += Math.cos(lonRadians);
      y += Math.sin(lonRadians);
      lat += plume.positions[offset + 1];
      count++;
    }
    if (count === 0) break;
    path.push([Math.atan2(y, x) * DEGREES, lat / count]);
  }
  return path;
}
