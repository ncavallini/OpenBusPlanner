export interface LatLon {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Walking assumptions used when no pedestrian router is configured (labelled "estimated"). */
export const WALKING = {
  speedMetersPerSecond: 1.25, // 4.5 km/h
  /** Typical urban detour factor of real footpaths over straight-line distance. */
  detourFactor: 1.35,
  /** Extra time to find the stop / platform at the destination of a walk. */
  orientationSeconds: 120,
} as const;

export function estimateWalk(distanceStraightMeters: number): {
  distanceMeters: number;
  durationSeconds: number;
} {
  const distanceMeters = Math.round(distanceStraightMeters * WALKING.detourFactor);
  return {
    distanceMeters,
    durationSeconds: Math.round(
      distanceMeters / WALKING.speedMetersPerSecond + WALKING.orientationSeconds,
    ),
  };
}

export function isValidCoordinate(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}
