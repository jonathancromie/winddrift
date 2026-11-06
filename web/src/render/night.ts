const DEGREES = 180 / Math.PI;
const MAP_LIMIT_LAT = 85;

/** Where the sun is directly overhead, using the standard low-precision solar equations. */
export function subsolarPoint(timeMs: number): { lat: number; lon: number } {
  const days = timeMs / 86400000 + 2440587.5 - 2451545.0;
  const meanLongitude = 280.46 + 0.9856474 * days;
  const meanAnomaly = (357.528 + 0.9856003 * days) / DEGREES;
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) / DEGREES;
  const obliquity = (23.439 - 0.0000004 * days) / DEGREES;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));
  const siderealDegrees = 280.46061837 + 360.98564736629 * days;
  const lon = ((rightAscension * DEGREES - siderealDegrees + 540) % 360 + 360) % 360 - 180;
  return { lat: declination * DEGREES, lon };
}

/** The sun's height above the horizon in degrees, at a place and time. */
export function sunAltitude(lon: number, lat: number, timeMs: number): number {
  const sun = subsolarPoint(timeMs);
  const sine =
    Math.sin(lat / DEGREES) * Math.sin(sun.lat / DEGREES) +
    Math.cos(lat / DEGREES) * Math.cos(sun.lat / DEGREES) * Math.cos((lon - sun.lon) / DEGREES);
  return Math.asin(Math.max(-1, Math.min(1, sine))) * DEGREES;
}

/** The outline of the night side of the Earth, as a closed ring of lon, lat points. */
export function nightRing(timeMs: number): [number, number][] {
  const sun = subsolarPoint(timeMs);
  // Close to the equinox the terminator's formula would divide by nearly zero.
  const declination = (Math.abs(sun.lat) < 0.01 ? 0.01 : sun.lat) / DEGREES;
  const ring: [number, number][] = [];
  for (let lon = -180; lon <= 180; lon += 2) {
    const hourAngle = (lon - sun.lon) / DEGREES;
    const lat = Math.atan(-Math.cos(hourAngle) / Math.tan(declination)) * DEGREES;
    ring.push([lon, Math.max(-MAP_LIMIT_LAT, Math.min(MAP_LIMIT_LAT, lat))]);
  }
  // When the sun is north of the equator, the polar darkness is in the south.
  const darkPole = sun.lat >= 0 ? -MAP_LIMIT_LAT : MAP_LIMIT_LAT;
  ring.push([180, darkPole], [-180, darkPole], ring[0]);
  return ring;
}
