import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  addDays,
  cityPartOfStopName,
  guessCountry,
  matchCity,
  normalizeName,
  type IsoDate,
} from '@openbus/core';
import { randomId, stableId } from '@openbus/core/ids';
import type { Sql, Tx } from '@openbus/db';
import {
  calendarCoverage,
  expandServiceDates,
  loadGtfsFeed,
  routeTypeToMode,
  stationOf,
  type GtfsFeed,
  type GtfsSource,
} from '@openbus/gtfs';
import { matchStop, StationIndex, type KnownStation } from './entity-resolution';
import { refreshFootpaths } from './footpaths';
import type { SourceDefinition } from './registry';

export interface ImportOptions {
  force?: boolean;
  /** Range of operating dates to materialise. Defaults to today-30 .. today+365. */
  horizon?: { from: IsoDate; to: IsoDate };
  log?: (msg: string, data?: Record<string, unknown>) => void;
  today?: IsoDate;
}

export interface ImportResult {
  runId: number;
  status: 'success' | 'skipped_unchanged' | 'failed';
  stats: Record<string, number>;
  warnings: string[];
  message: string | null;
}

export async function upsertSource(sql: Sql, def: SourceDefinition): Promise<void> {
  await sql`
    INSERT INTO data_source (id, name, kind, adapter, config, synthetic, enabled, priority, license, license_url,
                             attribution, homepage, refresh_hours, registry, updated_at)
    VALUES (${def.id}, ${def.name}, ${def.kind}, ${def.adapter}, ${sql.json(def.config as never)}, ${def.synthetic},
            ${def.enabled}, ${def.priority}, ${def.license}, ${def.licenseUrl}, ${def.attribution}, ${def.homepage},
            ${def.refreshHours}, ${def.research ? sql.json(def.research as never) : null}, now())
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, adapter = EXCLUDED.adapter,
      config = EXCLUDED.config, synthetic = EXCLUDED.synthetic, enabled = EXCLUDED.enabled, priority = EXCLUDED.priority,
      license = EXCLUDED.license, license_url = EXCLUDED.license_url, attribution = EXCLUDED.attribution,
      homepage = EXCLUDED.homepage, refresh_hours = EXCLUDED.refresh_hours, registry = EXCLUDED.registry,
      updated_at = now()`;
}

export async function startRun(sql: Sql, sourceId: string, contentHash: string | null): Promise<number> {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO import_run (source_id, status, content_hash) VALUES (${sourceId}, 'running', ${contentHash}) RETURNING id`;
  return Number(r!.id);
}

export async function finishRun(
  sql: Sql,
  runId: number,
  fields: { status: ImportResult['status']; stats?: Record<string, number>; warnings?: string[]; message?: string | null; feedVersion?: string | null; validFrom?: string | null; validTo?: string | null },
): Promise<void> {
  await sql`
    UPDATE import_run SET finished_at = now(), status = ${fields.status},
      stats = ${fields.stats ? sql.json(fields.stats) : null}, warnings = ${fields.warnings ? sql.json(fields.warnings) : null},
      message = ${fields.message ?? null}, feed_version = ${fields.feedVersion ?? null},
      valid_from = ${fields.validFrom ?? null}, valid_to = ${fields.validTo ?? null}
    WHERE id = ${runId}`;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Imports one GTFS feed for a source, replacing the source's previous timetable
 * atomically. Unchanged content (same hash as the last successful import) is skipped.
 */
export async function importGtfs(
  sql: Sql,
  def: SourceDefinition,
  src: (GtfsSource | { feed: GtfsFeed }) & { contentHash: string },
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const log = opts.log ?? (() => {});
  await upsertSource(sql, def);
  if (!opts.force) {
    const [last] = await sql<{ content_hash: string; valid_from: string | null; valid_to: string | null; feed_version: string | null }[]>`
      SELECT content_hash, valid_from::text, valid_to::text, feed_version FROM import_run
      WHERE source_id = ${def.id} AND status = 'success' ORDER BY started_at DESC LIMIT 1`;
    const [trips] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM trip WHERE source_id = ${def.id}`;
    if (last && last.content_hash === src.contentHash && (trips?.n ?? 0) > 0) {
      const runId = await startRun(sql, def.id, src.contentHash);
      await finishRun(sql, runId, {
        status: 'skipped_unchanged',
        message: 'Content identical to the last successful import',
        feedVersion: last.feed_version,
        validFrom: last.valid_from,
        validTo: last.valid_to,
      });
      log('import skipped: unchanged', { source: def.id });
      return { runId, status: 'skipped_unchanged', stats: {}, warnings: [], message: 'unchanged' };
    }
  }
  const runId = await startRun(sql, def.id, src.contentHash);
  try {
    const feed = 'feed' in src ? src.feed : await loadGtfsFeed(src);
    log('feed loaded', { source: def.id, ...feed.counts });
    const stats = await writeFeed(sql, def, feed, opts);
    const coverage = calendarCoverage(feed.calendars, feed.calendarDates);
    await finishRun(sql, runId, {
      status: 'success',
      stats: { ...feed.counts, ...stats },
      warnings: feed.warnings,
      feedVersion: feed.feedInfo?.version ?? null,
      validFrom: coverage?.from ?? null,
      validTo: coverage?.to ?? null,
    });
    log('import finished', { source: def.id, ...stats });
    return { runId, status: 'success', stats: { ...feed.counts, ...stats }, warnings: feed.warnings, message: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRun(sql, runId, { status: 'failed', message });
    log('import failed', { source: def.id, error: message });
    return { runId, status: 'failed', stats: {}, warnings: [], message };
  }
}

async function loadKnownStations(sql: Sql): Promise<KnownStation[]> {
  const rows = await sql<{ id: string; name: string; lat: number; lon: number; sources: string[] | null }[]>`
    SELECT s.id, s.name, s.lat, s.lon, array_agg(DISTINCT ss.source_id) FILTER (WHERE ss.source_id IS NOT NULL) AS sources
    FROM station s LEFT JOIN source_stop ss ON ss.station_id = s.id GROUP BY s.id`;
  return rows.map((r) => ({ id: r.id, name: r.name, lat: r.lat, lon: r.lon, sources: new Set(r.sources ?? []) }));
}

/** Gazetteer city, else an existing derived city nearby with the same name, else a new derived city. */
async function resolveCity(
  sql: Sql,
  name: string,
  lat: number,
  lon: number,
  countryCode: string | null,
  timezone: string,
  cache: Map<string, string>,
): Promise<string | null> {
  const g = matchCity(lat, lon, name);
  if (g) return g.id;
  const cityName = cityPartOfStopName(name);
  const key = normalizeName(cityName);
  if (key.length < 2) return null;
  const cacheKey = `${key}|${countryCode}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const [near] = await sql<{ id: string }[]>`
    SELECT c.id FROM city c JOIN place_alias pa ON pa.city_id = c.id AND pa.normalized = ${key}
    WHERE ST_DWithin(c.geom, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography, 15000) LIMIT 1`;
  if (near) {
    cache.set(cacheKey, near.id);
    return near.id;
  }
  const id = stableId('city', key, countryCode ?? '', String(Math.round(lat * 10)), String(Math.round(lon * 10)));
  await sql`
    INSERT INTO city (id, name, country_code, geom, timezone, size, origin)
    VALUES (${id}, ${cityName}, ${countryCode}, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography, ${timezone}, 'small', 'derived')
    ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO place_alias (city_id, alias, normalized, origin) VALUES (${id}, ${cityName}, ${key}, 'derived')
            ON CONFLICT (city_id, normalized) WHERE city_id IS NOT NULL DO NOTHING`;
  cache.set(cacheKey, id);
  return id;
}

async function writeFeed(sql: Sql, def: SourceDefinition, feed: GtfsFeed, opts: ImportOptions): Promise<Record<string, number>> {
  const sid = def.id;
  const feedTz = feed.agencies[0]!.timezone;
  const station = stationOf(feed);
  const knownCountries = new Set((await sql<{ code: string }[]>`SELECT code FROM country`).map((r) => r.code.trim()));

  // ---- 1. Entity resolution: GTFS station-level stops -> stations.
  const existing = new Map(
    (await sql<{ source_stop_id: string; station_id: string }[]>`
      SELECT source_stop_id, station_id FROM source_stop WHERE source_id = ${sid}`).map((r) => [r.source_stop_id, r.station_id]),
  );
  const index = new StationIndex(await loadKnownStations(sql));
  const cityCache = new Map<string, string>();
  const stationIdFor = new Map<string, string>(); // GTFS station-level stop id -> station id
  const methods: Record<string, number> = { existing_mapping: 0, proximity: 0, proximity_name: 0, new: 0 };
  const mappingFor = new Map<string, { method: string; confidence: number }>();
  for (const st of new Set(station.values())) {
    let stationId = existing.get(st.id);
    let method: string = 'existing_mapping';
    let confidence = 1;
    if (!stationId) {
      const m = matchStop(index, sid, { sourceStopId: st.id, name: st.name, lat: st.lat, lon: st.lon });
      method = m.method;
      confidence = m.confidence;
      if (m.stationId) stationId = m.stationId;
    }
    if (!stationId) {
      const gCity = matchCity(st.lat, st.lon, st.name);
      let cc = gCity?.countryCode ?? guessCountry(st.lat, st.lon) ?? null;
      if (cc && !knownCountries.has(cc)) cc = null;
      const tz = st.timezone ?? feedTz;
      const cityId = await resolveCity(sql, st.name, st.lat, st.lon, cc, tz, cityCache);
      stationId = randomId('stn');
      await sql`
        INSERT INTO station (id, name, normalized_name, city_id, country_code, lat, lon, geom, timezone)
        VALUES (${stationId}, ${st.name}, ${normalizeName(st.name)}, ${cityId}, ${cc}, ${st.lat}, ${st.lon},
                ST_SetSRID(ST_MakePoint(${st.lon}, ${st.lat}), 4326)::geography, ${tz})`;
      index.add({ id: stationId, name: st.name, lat: st.lat, lon: st.lon, sources: new Set([sid]) });
    } else {
      // Remember that this source now maps onto the station (prevents merging its other stops into it).
      index.get(stationId)?.sources.add(sid);
    }
    methods[method] = (methods[method] ?? 0) + 1;
    stationIdFor.set(st.id, stationId);
    mappingFor.set(st.id, { method, confidence });
  }

  // source_stop rows for every GTFS stop (platforms map to their parent's station).
  const sourceStops = feed.stops.map((s) => {
    const parent = station.get(s.id)!;
    const m = mappingFor.get(parent.id)!;
    return {
      source_id: sid,
      source_stop_id: s.id,
      station_id: stationIdFor.get(parent.id)!,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      zone_id: s.zoneId,
      match_method: parent.id === s.id ? m.method : 'parent_station',
      match_confidence: m.confidence,
    };
  });

  // ---- 2. Operators, unified across sources by normalised name.
  const operatorFor = new Map<string, string>();
  for (const a of feed.agencies) {
    const norm = normalizeName(a.name);
    const id = stableId('op', norm);
    const override = def.operators?.[norm] ?? def.operators?.['*'];
    await sql`
      INSERT INTO operator (id, name, normalized_name, website, synthetic, booking_url_template, booking_link_kind)
      VALUES (${id}, ${a.name}, ${norm}, ${override?.website ?? a.url}, ${def.synthetic},
              ${override?.bookingUrlTemplate ?? null},
              ${override?.bookingLinkKind ?? (def.synthetic ? 'none' : a.url ? 'operator_homepage' : 'none')})
      ON CONFLICT (normalized_name) DO UPDATE SET
        website = coalesce(operator.website, EXCLUDED.website),
        booking_url_template = coalesce(EXCLUDED.booking_url_template, operator.booking_url_template),
        booking_link_kind = CASE WHEN EXCLUDED.booking_url_template IS NOT NULL THEN EXCLUDED.booking_link_kind ELSE operator.booking_link_kind END,
        synthetic = operator.synthetic AND EXCLUDED.synthetic`;
    const [row] = await sql<{ id: string }[]>`SELECT id FROM operator WHERE normalized_name = ${norm}`;
    operatorFor.set(a.id, row!.id);
  }

  // ---- 3. Calendars and operating dates.
  const horizon = opts.horizon ?? { from: addDays(opts.today ?? today(), -30), to: addDays(opts.today ?? today(), 365) };
  const active = expandServiceDates(feed.calendars, feed.calendarDates, horizon.from, horizon.to);
  const calendarIds = new Set<string>([...feed.calendars.map((c) => c.serviceId), ...feed.calendarDates.map((c) => c.serviceId)]);

  const agencyTz = new Map(feed.agencies.map((a) => [a.id, a.timezone]));
  const routeById = new Map(feed.routes.map((r) => [r.id, r]));
  const services = feed.routes
    .filter((r) => operatorFor.has(r.agencyId) || feed.agencies.length === 1)
    .map((r) => ({
      id: `${sid}:${r.id}`,
      source_id: sid,
      operator_id: operatorFor.get(r.agencyId) ?? operatorFor.get(feed.agencies[0]!.id)!,
      source_route_id: r.id,
      short_name: r.shortName,
      long_name: r.longName,
      route_type: r.type,
      mode: routeTypeToMode(r.type),
      url: r.url,
    }));
  const serviceIds = new Set(services.map((s) => s.id));

  let droppedTrips = 0;
  const trips: Array<Record<string, unknown>> = [];
  const stopTimeRows: Array<Array<string | number | boolean | null>> = [];
  for (const t of feed.trips) {
    const route = routeById.get(t.routeId);
    const sts = feed.stopTimes.get(t.id);
    if (!route || !serviceIds.has(`${sid}:${route.id}`) || !calendarIds.has(t.serviceId) || !sts || sts.length < 2 || sts.some((s) => Number.isNaN(s.arrival))) {
      droppedTrips++;
      continue;
    }
    const tripId = `${sid}:${t.id}`;
    trips.push({
      id: tripId,
      source_id: sid,
      service_id: `${sid}:${route.id}`,
      calendar_id: `${sid}:${t.serviceId}`,
      source_trip_id: t.id,
      headsign: t.headsign,
      agency_timezone: agencyTz.get(route.agencyId) ?? feedTz,
      booking_url: null,
      stop_count: sts.length,
      max_offset: Math.max(...sts.map((s) => s.departure)),
    });
    sts.forEach((s, i) => {
      stopTimeRows.push([tripId, i, s.sequence, stationIdFor.get(station.get(s.stopId)!.id)!, s.stopId, s.arrival, s.departure, s.pickup, s.dropoff]);
    });
  }

  const calendarRows = [...calendarIds].map((serviceId) => {
    const c = feed.calendars.find((x) => x.serviceId === serviceId);
    return {
      id: `${sid}:${serviceId}`,
      source_id: sid,
      source_service_id: serviceId,
      weekdays: c ? c.days.reduce((acc, on, i) => (on ? acc | (1 << i) : acc), 0) : 0,
      start_date: c?.start ?? null,
      end_date: c?.end ?? null,
    };
  });
  const exceptionRows = feed.calendarDates.map((d) => ({ calendar_id: `${sid}:${d.serviceId}`, date: d.date, added: d.added }));
  const uniqueExceptions = [...new Map(exceptionRows.map((r) => [`${r.calendar_id}|${r.date}`, r])).values()];
  const activeRows: Array<[string, string]> = [];
  for (const [serviceId, dates] of active) for (const d of dates) activeRows.push([`${sid}:${serviceId}`, d]);

  // ---- 4. Atomic replacement of the source's timetable.
  await sql.begin(async (tx) => {
    await tx`DELETE FROM trip WHERE source_id = ${sid}`;
    await tx`DELETE FROM service WHERE source_id = ${sid}`;
    await tx`DELETE FROM service_calendar WHERE source_id = ${sid}`;
    await tx`DELETE FROM fare_product WHERE source_id = ${sid}`;
    await tx`DELETE FROM fare_rule WHERE source_id = ${sid}`;
    await tx`DELETE FROM source_operator WHERE source_id = ${sid}`;
    await tx`DELETE FROM source_stop WHERE source_id = ${sid}`;

    await insertMany(tx, 'source_stop', sourceStops);
    await insertMany(
      tx,
      'source_operator',
      [...operatorFor].map(([agencyId, operatorId]) => ({ source_id: sid, source_agency_id: agencyId, operator_id: operatorId })),
    );
    await insertMany(tx, 'service', services);
    await insertMany(tx, 'service_calendar', calendarRows);
    await insertMany(tx, 'calendar_exception', uniqueExceptions);
    await copyRows(tx, 'calendar_active_date', ['calendar_id', 'date'], activeRows);
    await insertMany(tx, 'trip', trips);
    await copyRows(
      tx,
      'trip_stop_time',
      ['trip_id', 'seq', 'source_sequence', 'station_id', 'source_stop_id', 'arr_offset', 'dep_offset', 'pickup', 'dropoff'],
      stopTimeRows,
    );
    await insertMany(
      tx,
      'fare_product',
      [...new Map(feed.fares.map((f) => [f.id, { source_id: sid, fare_id: f.id, price: f.price, currency: f.currency }])).values()],
    );
    await insertMany(
      tx,
      'fare_rule',
      feed.fareRules.map((r) => ({ source_id: sid, fare_id: r.fareId, source_route_id: r.routeId, origin_zone: r.originZone, destination_zone: r.destinationZone })),
    );
  });

  // ---- 5. Station attributes, aliases and walking transfers.
  const stationIds = [...new Set(stationIdFor.values())];
  for (const t of feed.transfers) {
    const a = station.get(t.fromStopId);
    const b = station.get(t.toStopId);
    if (a && b && a.id === b.id && t.type === 2 && t.minTransferSeconds !== null) {
      await sql`UPDATE station SET min_transfer_seconds = greatest(min_transfer_seconds, ${t.minTransferSeconds})
                WHERE id = ${stationIdFor.get(a.id)!}`;
    }
  }
  await sql`
    UPDATE station st SET kind = CASE WHEN EXISTS (
        SELECT 1 FROM trip_stop_time tst JOIN trip t ON t.id = tst.trip_id JOIN service s ON s.id = t.service_id
        WHERE tst.station_id = st.id AND s.mode = 'rail') THEN 'rail_station' ELSE 'bus_station' END
    WHERE st.id = ANY(${stationIds})`;
  const aliasRows = [
    ...new Map(
      sourceStops
        .filter((s) => normalizeName(s.name).length >= 2)
        .map((s) => [`${s.station_id}|${normalizeName(s.name)}`, { station_id: s.station_id, alias: s.name, normalized: normalizeName(s.name), origin: sid }]),
    ).values(),
  ];
  for (const a of aliasRows) {
    await sql`INSERT INTO place_alias (station_id, alias, normalized, origin) VALUES (${a.station_id}, ${a.alias}, ${a.normalized}, ${a.origin})
              ON CONFLICT (station_id, normalized) WHERE station_id IS NOT NULL DO NOTHING`;
  }
  const feedTransfers = feed.transfers
    .map((t) => ({ a: station.get(t.fromStopId), b: station.get(t.toStopId), t }))
    .filter((x) => x.a && x.b && x.a.id !== x.b.id && x.t.type !== 3)
    .map((x) => ({ from: stationIdFor.get(x.a!.id)!, to: stationIdFor.get(x.b!.id)!, seconds: x.t.minTransferSeconds }));
  const footpaths = await refreshFootpaths(sql, stationIds, feedTransfers);

  return {
    stationsMatchedExisting: methods.existing_mapping ?? 0,
    stationsMatchedProximity: methods.proximity ?? 0,
    stationsMatchedProximityName: methods.proximity_name ?? 0,
    stationsCreated: methods.new ?? 0,
    tripsImported: trips.length,
    tripsDropped: droppedTrips,
    stopTimesImported: stopTimeRows.length,
    operatingDates: activeRows.length,
    footpaths,
  };
}

/** Multi-row INSERT in chunks that stay below the 65k bind-parameter limit. */
export async function insertMany(sql: Tx, table: string, rows: Array<Record<string, unknown>>): Promise<void> {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]!);
  const chunk = Math.max(1, Math.floor(60000 / cols.length));
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    await sql`INSERT INTO ${sql(table)} ${sql(part as never, cols as never)}`;
  }
}

function copyValue(v: string | number | boolean | null): string {
  if (v === null || v === undefined) return '\\N';
  if (typeof v === 'boolean') return v ? 't' : 'f';
  return String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/** Bulk load with COPY FROM STDIN (text format). */
export async function copyRows(sql: Tx, table: string, cols: string[], rows: Array<Array<string | number | boolean | null>>): Promise<void> {
  if (rows.length === 0) return;
  const writable = await sql.unsafe(`COPY ${table} (${cols.join(', ')}) FROM STDIN`).writable();
  async function* lines() {
    let buf = '';
    for (const r of rows) {
      buf += r.map(copyValue).join('\t') + '\n';
      if (buf.length > 1 << 16) {
        yield buf;
        buf = '';
      }
    }
    if (buf) yield buf;
  }
  await pipeline(Readable.from(lines()), writable);
}
