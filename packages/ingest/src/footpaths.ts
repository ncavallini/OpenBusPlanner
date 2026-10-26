/**
 * Precomputed walking transfers between distinct nearby stations.
 *
 * Default: PostGIS straight-line distance x detour factor at 4.5 km/h, labelled
 * "estimated". If PEDESTRIAN_ROUTER_URL points at an OSRM instance with a foot profile
 * (OpenStreetMap-derived), edges are refined with real walking distances and labelled
 * "pedestrian_router". Feed-provided transfers (transfers.txt) win over both.
 */
import { WALKING } from '@openbus/core';
import type { Sql } from '@openbus/db';

export const WALK_RADIUS_METERS = Number(process.env.WALK_RADIUS_METERS ?? 1000);

export async function refreshFootpaths(
  sql: Sql,
  stationIds: string[],
  feedTransfers: Array<{ from: string; to: string; seconds: number | null }> = [],
): Promise<number> {
  if (stationIds.length === 0) return 0;
  const inserted = await sql<{ n: number }[]>`
    WITH pairs AS (
      SELECT a.id AS from_station, b.id AS to_station, ST_Distance(a.geom, b.geom) AS d
      FROM station a JOIN station b ON a.id <> b.id AND ST_DWithin(a.geom, b.geom, ${WALK_RADIUS_METERS})
      WHERE a.id = ANY(${stationIds}) OR b.id = ANY(${stationIds})
    ), ins AS (
      INSERT INTO transfer_edge (from_station, to_station, distance_m, duration_s, method)
      SELECT from_station, to_station, round(d * ${WALKING.detourFactor})::int,
             round(d * ${WALKING.detourFactor} / ${WALKING.speedMetersPerSecond} + ${WALKING.orientationSeconds})::int, 'estimated'
      FROM pairs
      ON CONFLICT (from_station, to_station) DO UPDATE SET distance_m = EXCLUDED.distance_m, duration_s = EXCLUDED.duration_s,
        computed_at = now()
      WHERE transfer_edge.method = 'estimated'
      RETURNING 1
    ) SELECT count(*)::int AS n FROM ins`;
  for (const t of feedTransfers) {
    await sql`
      INSERT INTO transfer_edge (from_station, to_station, distance_m, duration_s, method)
      SELECT ${t.from}, ${t.to}, round(ST_Distance(a.geom, b.geom) * ${WALKING.detourFactor})::int,
             coalesce(${t.seconds}::int, round(ST_Distance(a.geom, b.geom) * ${WALKING.detourFactor} / ${WALKING.speedMetersPerSecond})::int), 'feed'
      FROM station a, station b WHERE a.id = ${t.from} AND b.id = ${t.to}
      ON CONFLICT (from_station, to_station) DO UPDATE SET duration_s = EXCLUDED.duration_s, method = 'feed', computed_at = now()`;
  }
  if (process.env.PEDESTRIAN_ROUTER_URL) await refineWithPedestrianRouter(sql, stationIds, process.env.PEDESTRIAN_ROUTER_URL);
  return inserted[0]?.n ?? 0;
}

/** Refines estimated edges with an OSRM foot-profile router. Failures keep the estimate. */
export async function refineWithPedestrianRouter(sql: Sql, stationIds: string[], baseUrl: string): Promise<number> {
  const edges = await sql<{ from_station: string; to_station: string; alat: number; alon: number; blat: number; blon: number }[]>`
    SELECT e.from_station, e.to_station, a.lat AS alat, a.lon AS alon, b.lat AS blat, b.lon AS blon
    FROM transfer_edge e JOIN station a ON a.id = e.from_station JOIN station b ON b.id = e.to_station
    WHERE e.method = 'estimated' AND (e.from_station = ANY(${stationIds}) OR e.to_station = ANY(${stationIds}))`;
  let refined = 0;
  for (const e of edges) {
    try {
      const url = `${baseUrl.replace(/\/$/, '')}/route/v1/foot/${e.alon},${e.alat};${e.blon},${e.blat}?overview=false`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const body = (await res.json()) as { code: string; routes?: Array<{ distance: number; duration: number }> };
      const r = body.routes?.[0];
      if (body.code !== 'Ok' || !r) continue;
      await sql`UPDATE transfer_edge SET distance_m = ${Math.round(r.distance)},
                  duration_s = ${Math.round(r.distance / WALKING.speedMetersPerSecond + WALKING.orientationSeconds)},
                  method = 'pedestrian_router', computed_at = now()
                WHERE from_station = ${e.from_station} AND to_station = ${e.to_station}`;
      refined++;
    } catch {
      // Keep the straight-line estimate; the method label stays "estimated".
    }
  }
  return refined;
}
