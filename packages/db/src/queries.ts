import { CITIES, COUNTRIES, normalizeName } from '@openbus/core';
import type { Sql } from './client';

/** Countries, gazetteer cities and their multilingual aliases. Idempotent. */
export async function seedReferenceData(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    for (const c of COUNTRIES) {
      await tx`INSERT INTO country (code, name, timezone) VALUES (${c.code}, ${c.name}, ${c.timezone})
               ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone`;
    }
    for (const c of CITIES) {
      await tx`INSERT INTO city (id, name, country_code, geom, timezone, size, origin)
               VALUES (${c.id}, ${c.name}, ${c.countryCode}, ST_SetSRID(ST_MakePoint(${c.lon}, ${c.lat}), 4326)::geography,
                       ${c.timezone}, ${c.size}, 'gazetteer')
               ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, geom = EXCLUDED.geom, size = EXCLUDED.size`;
      for (const alias of [c.name, ...c.aliases]) {
        await tx`INSERT INTO place_alias (city_id, alias, normalized, origin)
                 VALUES (${c.id}, ${alias}, ${normalizeName(alias)}, 'gazetteer')
                 ON CONFLICT (city_id, normalized) WHERE city_id IS NOT NULL DO NOTHING`;
      }
    }
  });
}

export interface PlaceRow {
  kind: 'city' | 'station';
  id: string;
  name: string;
  city_name: string | null;
  country_code: string | null;
  lat: number;
  lon: number;
  timezone: string;
  station_count: number;
  matched_alias: string;
  score: number;
}

/**
 * Autocomplete over city and station aliases (exact > prefix > trigram similarity).
 * Cities served by at least one station rank above unserved ones.
 */
export async function searchPlaces(sql: Sql, query: string, limit = 10): Promise<PlaceRow[]> {
  const q = normalizeName(query);
  if (q.length < 2) return [];
  return sql<PlaceRow[]>`
    WITH matches AS (
      SELECT pa.city_id, pa.station_id, pa.alias,
             CASE WHEN pa.normalized = ${q} THEN 1.0
                  WHEN pa.normalized LIKE ${q + '%'} THEN 0.8
                  WHEN pa.normalized LIKE ${'% ' + q + '%'} THEN 0.6
                  ELSE similarity(pa.normalized, ${q}) * 0.6 END AS score
      FROM place_alias pa
      WHERE pa.normalized LIKE ${q + '%'} OR pa.normalized LIKE ${'% ' + q + '%'} OR pa.normalized % ${q}
    ),
    city_hits AS (
      SELECT DISTINCT ON (c.id) 'city'::text AS kind, c.id, c.name, c.name AS city_name, c.country_code,
             ST_Y(c.geom::geometry) AS lat, ST_X(c.geom::geometry) AS lon, c.timezone,
             (SELECT count(*)::int FROM station s WHERE s.city_id = c.id) AS station_count,
             m.alias AS matched_alias, m.score
      FROM matches m JOIN city c ON c.id = m.city_id
      ORDER BY c.id, m.score DESC
    ),
    station_hits AS (
      SELECT DISTINCT ON (s.id) 'station'::text AS kind, s.id, s.name, c.name AS city_name, s.country_code,
             s.lat, s.lon, s.timezone, 1 AS station_count, m.alias AS matched_alias, m.score * 0.95 AS score
      FROM matches m JOIN station s ON s.id = m.station_id LEFT JOIN city c ON c.id = s.city_id
      ORDER BY s.id, m.score DESC
    )
    SELECT * FROM (SELECT * FROM city_hits UNION ALL SELECT * FROM station_hits) x
    ORDER BY (station_count > 0) DESC, score DESC, kind ASC, name ASC
    LIMIT ${limit}`;
}

export async function getPlace(sql: Sql, kind: 'city' | 'station', id: string): Promise<PlaceRow | null> {
  const rows =
    kind === 'city'
      ? await sql<PlaceRow[]>`
          SELECT 'city'::text AS kind, c.id, c.name, c.name AS city_name, c.country_code,
                 ST_Y(c.geom::geometry) AS lat, ST_X(c.geom::geometry) AS lon, c.timezone,
                 (SELECT count(*)::int FROM station s WHERE s.city_id = c.id) AS station_count,
                 c.name AS matched_alias, 1 AS score
          FROM city c WHERE c.id = ${id}`
      : await sql<PlaceRow[]>`
          SELECT 'station'::text AS kind, s.id, s.name, c.name AS city_name, s.country_code, s.lat, s.lon, s.timezone,
                 1 AS station_count, s.name AS matched_alias, 1 AS score
          FROM station s LEFT JOIN city c ON c.id = s.city_id WHERE s.id = ${id}`;
  return rows[0] ?? null;
}

/** Station ids that represent a place: all stations of a city, or the station itself. */
export async function stationsForPlace(sql: Sql, kind: 'city' | 'station', id: string): Promise<string[]> {
  const rows =
    kind === 'city'
      ? await sql<{ id: string }[]>`SELECT id FROM station WHERE city_id = ${id}`
      : await sql<{ id: string }[]>`SELECT id FROM station WHERE id = ${id}`;
  return rows.map((r) => r.id);
}

export async function listOperators(sql: Sql) {
  return sql<{ id: string; name: string; website: string | null; country_code: string | null; synthetic: boolean; sources: string[] }[]>`
    SELECT o.id, o.name, o.website, o.country_code, o.synthetic,
           coalesce(array_agg(DISTINCT so.source_id) FILTER (WHERE so.source_id IS NOT NULL), '{}') AS sources
    FROM operator o LEFT JOIN source_operator so ON so.operator_id = o.id
    GROUP BY o.id ORDER BY o.synthetic, o.name`;
}

export async function dataSourceStatus(sql: Sql) {
  return sql<
    {
      id: string;
      name: string;
      kind: string;
      adapter: string;
      synthetic: boolean;
      enabled: boolean;
      license: string | null;
      registry: Record<string, unknown> | null;
      run_started: Date | null;
      run_finished: Date | null;
      run_status: string | null;
      run_message: string | null;
      run_stats: Record<string, number> | null;
      valid_from: string | null;
      valid_to: string | null;
      last_success: Date | null;
      health_checked: Date | null;
      health_ok: boolean | null;
      health_latency: number | null;
      health_message: string | null;
      stations: number;
      trips: number;
      operators: number;
    }[]
  >`
    SELECT ds.id, ds.name, ds.kind, ds.adapter, ds.synthetic, ds.enabled, ds.license, ds.registry,
           ir.started_at AS run_started, ir.finished_at AS run_finished, ir.status AS run_status,
           ir.message AS run_message, ir.stats AS run_stats, ok.valid_from, ok.valid_to, ok.finished_at AS last_success,
           h.checked_at AS health_checked, h.ok AS health_ok, h.latency_ms AS health_latency, h.message AS health_message,
           (SELECT count(DISTINCT station_id)::int FROM source_stop WHERE source_id = ds.id) AS stations,
           (SELECT count(*)::int FROM trip WHERE source_id = ds.id) AS trips,
           (SELECT count(*)::int FROM source_operator WHERE source_id = ds.id) AS operators
    FROM data_source ds
    LEFT JOIN LATERAL (SELECT * FROM import_run WHERE source_id = ds.id ORDER BY started_at DESC LIMIT 1) ir ON true
    LEFT JOIN LATERAL (SELECT valid_from::text, valid_to::text, finished_at FROM import_run
                       WHERE source_id = ds.id AND status IN ('success', 'skipped_unchanged') AND valid_from IS NOT NULL
                       ORDER BY started_at DESC LIMIT 1) ok ON true
    LEFT JOIN LATERAL (SELECT * FROM source_health WHERE source_id = ds.id ORDER BY checked_at DESC LIMIT 1) h ON true
    ORDER BY ds.synthetic, ds.name`;
}
