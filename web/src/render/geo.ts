export const EARTH_RADIUS_M = 6371229;
export const MAX_MERCATOR_LAT = 85.051129;

/** Longitude in degrees to Mercator X, where the world spans 0 to 1. */
export function mercatorX(lon: number): number {
  return (lon + 180) / 360;
}

/** Latitude in degrees to Mercator Y, where the world spans 0 (north) to 1 (south). */
export function mercatorY(lat: number): number {
  const phi = (lat * Math.PI) / 180;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI);
}

/**
 * Advance a position by one explicit step of wind on a sphere.
 * The same equations run in the particle shader. Near the poles, the east-west
 * step is limited to avoid dividing by a vanishing circle of latitude.
 */
export function advect(
  lon: number,
  lat: number,
  u: number,
  v: number,
  seconds: number,
): [number, number] {
  const phi = (lat * Math.PI) / 180;
  const cosLat = Math.max(Math.cos(phi), 0.01);
  const dLon = ((u * seconds) / (EARTH_RADIUS_M * cosLat)) * (180 / Math.PI);
  const dLat = ((v * seconds) / EARTH_RADIUS_M) * (180 / Math.PI);
  return [wrapLon(lon + dLon), lat + dLat];
}

export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Seconds of wind to apply per real second, chosen so a 1 m/s wind crosses a fixed
 * number of CSS pixels per second at the equator, whatever the zoom level.
 */
export function timeCompression(zoom: number, pixelsPerSecondPerMs: number): number {
  const worldPixels = 512 * 2 ** zoom;
  return (pixelsPerSecondPerMs * 2 * Math.PI * EARTH_RADIUS_M) / worldPixels;
}
