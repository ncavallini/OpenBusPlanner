import { addDays, serviceDayReference, type IsoDate } from '@openbus/core';
import { applyTripUpdates, segmentFares, type StopTimeUpdate, type TripUpdate } from '@openbus/gtfs';
import type { RouterFootpath, RouterStop, RouterTrip, SegmentFare, TimetableInput, TransportMode } from '@openbus/router';
import type { Sql } from './client';

export type DataScope = 'all' | 'real' | 'synthetic';

export interface TripMeta {
  dbTripId: string;
  sourceTripId: string;
  serviceId: string;
  routeName: string | null;
  headsign: string | null;
  bookingUrl: string | null;
  realtime: boolean;
}

export interface StationInfo {
  id: string;
  name: string;
  cityId: string | null;
  cityName: string | null;
  countryCode: string | null;
  lat: number;
  lon: number;
  timezone: string;
}

export interface SourceInfo {
  id: string;
  name: string;
  synthetic: boolean;
  enabled: boolean;
  license: string | null;
  attribution: string | null;
  priority: number;
  refreshHours: number | null;
  homepage: string | null;
  lastSuccess: { finishedAt: string; feedVersion: string | null; validFrom: string | null; validTo: string | null } | null;
  lastStatus: string | null;
  lastMessage: string | null;
}

export interface OperatorInfo {
  id: string;
  name: string;
  website: string | null;
  synthetic: boolean;
  bookingUrlTemplate: string | null;
  bookingLinkKind: 'departure_specific' | 'route_search' | 'operator_homepage' | 'none';
}

export interface LoadedTimetable {
  input: TimetableInput;
  fromDate: IsoDate;
  toDate: IsoDate;
  scope: DataScope;
  dataVersion: string;
  tripMeta: Map<string, TripMeta>;
  stations: Map<string, StationInfo>;
  sources: Map<string, SourceInfo>;
  operators: Map<string, OperatorInfo>;
  tripsPerSource: Map<string, number>;
  loadMs: number;
}

/** Identifies the current timetable contents; changes after every import or realtime update. */
export async function dataVersion(sql: Sql): Promise<string> {
  const [r] = await sql<{ v: string | null; rt: string | null }[]>`
    SELECT (SELECT max(id)::text FROM import_run WHERE status = 'success') AS v,
           (SELECT extract(epoch FROM max(observed_at))::bigint::text FROM realtime_update) AS rt`;
  return `${r?.v ?? '0'}:${r?.rt ?? '0'}`;
}

export async function loadSources(sql: Sql): Promise<Map<string, SourceInfo>> {
  const rows = await sql<
    {
      id: string;
      name: string;
      synthetic: boolean;
      enabled: boolean;
      license: string | null;
      attribution: string | null;
      priority: number;
      refresh_hours: number | null;
      homepage: string | null;
      finished_at: Date | null;
      feed_version: string | null;
      valid_from: string | null;
      valid_to: string | null;
      last_status: string | null;
      last_message: string | null;
    }[]
  >`
    SELECT ds.id, ds.name, ds.synthetic, ds.enabled, ds.license, ds.attribution, ds.priority, ds.refresh_hours, ds.homepage,
           ok.finished_at, ok.feed_version, ok.valid_from, ok.valid_to,
           lr.status AS last_status, lr.message AS last_message
    FROM data_source ds
    LEFT JOIN LATERAL (
      SELECT finished_at, feed_version, valid_from, valid_to FROM import_run
      WHERE source_id = ds.id AND status IN ('success', 'skipped_unchanged') AND valid_from IS NOT NULL
      ORDER BY started_at DESC LIMIT 1) ok ON true
    LEFT JOIN LATERAL (
      SELECT status, message FROM import_run WHERE source_id = ds.id ORDER BY started_at DESC LIMIT 1) lr ON true`;
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        synthetic: r.synthetic,
        enabled: r.enabled,
        license: r.license,
        attribution: r.attribution,
        priority: r.priority,
        refreshHours: r.refresh_hours,
        homepage: r.homepage,
        lastSuccess: r.finished_at
          ? { finishedAt: r.finished_at.toISOString(), feedVersion: r.feed_version, validFrom: r.valid_from, validTo: r.valid_to }
          : null,
        lastStatus: r.last_status,
        lastMessage: r.last_message,
      },
    ]),
  );
}

interface TripRow {
  id: string;
  source_id: string;
  service_id: string;
  source_trip_id: string;
  headsign: string | null;
  agency_timezone: string;
  booking_url: string | null;
  operator_id: string;
  mode: TransportMode;
  short_name: string | null;
  long_name: string | null;
  source_route_id: string;
  date: string;
}

interface StopTimeRow {
  trip_id: string;
  seq: number;
  source_sequence: number;
  station_id: string;
  source_stop_id: string;
  arr_offset: number;
  dep_offset: number;
  pickup: boolean;
  dropoff: boolean;
}

/**
 * Loads all dated trips whose service date lies in [fromDate - 2 days, toDate] (overnight
 * trips can belong to an earlier service day), for enabled sources in the given scope.
 * Only stations touched by those trips are loaded: the full European network is never
 * materialised for a query.
 */
export async function loadTimetable(
  sql: Sql,
  opts: { fromDate: IsoDate; toDate: IsoDate; scope: DataScope },
): Promise<LoadedTimetable> {
  const started = Date.now();
  const serviceFrom = addDays(opts.fromDate, -2);
  const synth = opts.scope === 'all' ? null : opts.scope === 'synthetic';
  const version = await dataVersion(sql);
  const sources = await loadSources(sql);

  const tripRows = await sql<TripRow[]>`
    SELECT t.id, t.source_id, t.service_id, t.source_trip_id, t.headsign, t.agency_timezone, t.booking_url,
           s.operator_id, s.mode, s.short_name, s.long_name, s.source_route_id, cad.date::text AS date
    FROM calendar_active_date cad
    JOIN trip t ON t.calendar_id = cad.calendar_id
    JOIN service s ON s.id = t.service_id
    JOIN data_source ds ON ds.id = t.source_id
    WHERE cad.date BETWEEN ${serviceFrom} AND ${opts.toDate}
      AND ds.enabled
      AND (${synth}::boolean IS NULL OR ds.synthetic = ${synth}::boolean)`;

  const tripIds = [...new Set(tripRows.map((r) => r.id))];
  const stopTimes = new Map<string, StopTimeRow[]>();
  for (let i = 0; i < tripIds.length; i += 5000) {
    const chunk = tripIds.slice(i, i + 5000);
    const rows = await sql<StopTimeRow[]>`
      SELECT trip_id, seq, source_sequence, station_id, source_stop_id, arr_offset, dep_offset, pickup, dropoff
      FROM trip_stop_time WHERE trip_id = ANY(${chunk}) ORDER BY trip_id, seq`;
    for (const r of rows) {
      let l = stopTimes.get(r.trip_id);
      if (!l) stopTimes.set(r.trip_id, (l = []));
      l.push(r);
    }
  }

  const stationIds = new Set<string>();
  for (const l of stopTimes.values()) for (const st of l) stationIds.add(st.station_id);
  const stationRows = await sql<
    (StationInfo & { min_transfer_seconds: number; city_name: string | null; city_id: string | null; country_code: string | null })[]
  >`
    SELECT st.id, st.name, st.city_id, c.name AS city_name, st.country_code, st.lat, st.lon, st.timezone, st.min_transfer_seconds
    FROM station st LEFT JOIN city c ON c.id = st.city_id
    WHERE st.id = ANY(${[...stationIds]})`;
  const stations = new Map<string, StationInfo>();
  const routerStops: RouterStop[] = [];
  for (const r of stationRows) {
    stations.set(r.id, {
      id: r.id,
      name: r.name,
      cityId: r.city_id,
      cityName: r.city_name,
      countryCode: r.country_code,
      lat: r.lat,
      lon: r.lon,
      timezone: r.timezone,
    });
    routerStops.push({
      id: r.id,
      name: r.name,
      lat: r.lat,
      lon: r.lon,
      timezone: r.timezone,
      countryCode: r.country_code,
      cityId: r.city_id,
      minTransferSeconds: r.min_transfer_seconds,
    });
  }

  const footpathRows = await sql<{ from_station: string; to_station: string; distance_m: number; duration_s: number; method: RouterFootpath['method'] }[]>`
    SELECT from_station, to_station, distance_m, duration_s, method FROM transfer_edge
    WHERE from_station = ANY(${[...stationIds]}) AND to_station = ANY(${[...stationIds]})`;
  const footpaths: RouterFootpath[] = footpathRows.map((f) => ({
    from: f.from_station,
    to: f.to_station,
    distanceMeters: f.distance_m,
    durationSeconds: f.duration_s,
    method: f.method,
  }));

  // Fares: GTFS zone fares per source, plus explicit price observations per dated leg.
  const sourceIds = [...new Set(tripRows.map((r) => r.source_id))];
  const fareRows = await sql<{ source_id: string; fare_id: string; price: string; currency: string }[]>`
    SELECT source_id, fare_id, price::text, currency FROM fare_product WHERE source_id = ANY(${sourceIds})`;
  const ruleRows = await sql<{ source_id: string; fare_id: string; source_route_id: string | null; origin_zone: string | null; destination_zone: string | null }[]>`
    SELECT source_id, fare_id, source_route_id, origin_zone, destination_zone FROM fare_rule WHERE source_id = ANY(${sourceIds})`;
  const zoneRows = await sql<{ source_id: string; source_stop_id: string; zone_id: string }[]>`
    SELECT source_id, source_stop_id, zone_id FROM source_stop WHERE zone_id IS NOT NULL AND source_id = ANY(${sourceIds})`;
  const zones = new Map(zoneRows.map((z) => [`${z.source_id}|${z.source_stop_id}`, z.zone_id]));
  const faresBySource = new Map<string, { fares: Parameters<typeof segmentFares>[0]; rules: Parameters<typeof segmentFares>[1] }>();
  for (const f of fareRows) {
    let e = faresBySource.get(f.source_id);
    if (!e) faresBySource.set(f.source_id, (e = { fares: [], rules: [] }));
    e.fares.push({ id: f.fare_id, price: Number(f.price), currency: f.currency.trim(), agencyId: null });
  }
  for (const r of ruleRows) {
    faresBySource.get(r.source_id)?.rules.push({ fareId: r.fare_id, routeId: r.source_route_id, originZone: r.origin_zone, destinationZone: r.destination_zone });
  }
  type PriceRow = { trip_id: string; service_date: string; from_station: string; to_station: string; amount: string; currency: string; kind: 'indicative' | 'live' };
  const priceRows = await sql<PriceRow[]>`
    SELECT DISTINCT ON (trip_id, service_date, from_station, to_station)
           trip_id, service_date::text, from_station, to_station, amount::text, currency, kind
    FROM price_observation
    WHERE service_date BETWEEN ${serviceFrom} AND ${opts.toDate} AND trip_id = ANY(${tripIds})
    ORDER BY trip_id, service_date, from_station, to_station, observed_at DESC`;
  const observed = new Map<string, PriceRow[]>();
  for (const p of priceRows) {
    const k = `${p.trip_id}@${p.service_date}`;
    let l = observed.get(k);
    if (!l) observed.set(k, (l = []));
    l.push(p);
  }

  const routeFareCache = new Map<string, SegmentFare[]>();
  const trips: RouterTrip[] = [];
  const tripMeta = new Map<string, TripMeta>();
  const tripsPerSource = new Map<string, number>();
  for (const r of tripRows) {
    const sts = stopTimes.get(r.id);
    if (!sts || sts.length < 2) continue;
    const ref = serviceDayReference(r.date, r.agency_timezone);
    const key = `${r.id}@${r.date}`;
    let fares = routeFareCache.get(r.id);
    if (!fares) {
      const fs = faresBySource.get(r.source_id);
      fares = fs
        ? segmentFares(fs.fares, fs.rules, r.source_route_id, sts.map((s) => zones.get(`${r.source_id}|${s.source_stop_id}`) ?? null))
        : [];
      routeFareCache.set(r.id, fares);
    }
    const obs = observed.get(key);
    let tripFares = fares;
    if (obs?.length) {
      const pos = new Map(sts.map((s, i) => [s.station_id, i]));
      const extra: SegmentFare[] = [];
      for (const o of obs) {
        const a = pos.get(o.from_station);
        const b = pos.get(o.to_station);
        if (a !== undefined && b !== undefined && a < b)
          extra.push({ fromIndex: a, toIndex: b, amount: Number(o.amount), currency: o.currency.trim(), kind: o.kind });
      }
      const covered = new Set(extra.map((e) => `${e.fromIndex}:${e.toIndex}`));
      tripFares = [...extra, ...fares.filter((f) => !covered.has(`${f.fromIndex}:${f.toIndex}`))];
    }
    trips.push({
      id: key,
      tripId: r.id,
      serviceDate: r.date,
      operatorId: r.operator_id,
      routeId: r.service_id,
      mode: r.mode,
      sourceId: r.source_id,
      synthetic: sources.get(r.source_id)?.synthetic ?? false,
      stops: sts.map((s) => s.station_id),
      arrivals: sts.map((s) => ref + s.arr_offset),
      departures: sts.map((s) => ref + s.dep_offset),
      pickup: sts.map((s) => s.pickup),
      dropoff: sts.map((s) => s.dropoff),
      ...(tripFares.length ? { fares: tripFares } : {}),
    });
    tripMeta.set(key, {
      dbTripId: r.id,
      sourceTripId: r.source_trip_id,
      serviceId: r.service_id,
      routeName: [r.short_name, r.long_name].filter(Boolean).join(' · ') || null,
      headsign: r.headsign,
      bookingUrl: r.booking_url,
      realtime: false,
    });
    tripsPerSource.set(r.source_id, (tripsPerSource.get(r.source_id) ?? 0) + 1);
  }

  // Realtime: apply the latest TripUpdates for the window.
  const rtRows = await sql<{ trip_id: string; service_date: string; canceled: boolean; stop_updates: StopTimeUpdate[] }[]>`
    SELECT trip_id, service_date::text, canceled, stop_updates FROM realtime_update
    WHERE service_date BETWEEN ${serviceFrom} AND ${opts.toDate} AND trip_id = ANY(${tripIds})`;
  let finalTrips = trips;
  if (rtRows.length) {
    const updates: TripUpdate[] = rtRows.map((r) => ({
      tripId: r.trip_id,
      serviceDate: r.service_date,
      canceled: r.canceled,
      stopTimeUpdates: r.stop_updates,
      timestamp: null,
    }));
    const seqByTrip = new Map<string, number[]>();
    for (const [id, l] of stopTimes) seqByTrip.set(id, l.map((s) => s.source_sequence));
    const res = applyTripUpdates(trips, updates, (t, u) =>
      u.stopSequence !== null ? (seqByTrip.get(t.tripId)?.indexOf(u.stopSequence) ?? -1) : -1,
    );
    finalTrips = res.trips;
    const touched = new Set(rtRows.map((r) => `${r.trip_id}@${r.service_date}`));
    for (const k of touched) {
      const m = tripMeta.get(k);
      if (m) m.realtime = true;
    }
  }

  const operatorRows = await sql<{ id: string; name: string; website: string | null; synthetic: boolean; booking_url_template: string | null; booking_link_kind: OperatorInfo['bookingLinkKind'] }[]>`
    SELECT id, name, website, synthetic, booking_url_template, booking_link_kind FROM operator
    WHERE id = ANY(${[...new Set(tripRows.map((r) => r.operator_id))]})`;
  const operators = new Map(
    operatorRows.map((o) => [
      o.id,
      { id: o.id, name: o.name, website: o.website, synthetic: o.synthetic, bookingUrlTemplate: o.booking_url_template, bookingLinkKind: o.booking_link_kind },
    ]),
  );

  const priority: Record<string, number> = {};
  for (const s of sources.values()) priority[s.id] = s.priority;
  return {
    input: { stops: routerStops, trips: finalTrips, footpaths, sourcePriority: priority, fxToEur: fxRates() },
    fromDate: opts.fromDate,
    toDate: opts.toDate,
    scope: opts.scope,
    dataVersion: version,
    tripMeta,
    stations,
    sources,
    operators,
    tripsPerSource,
    loadMs: Date.now() - started,
  };
}

/**
 * Currency factors used only to *compare* prices during routing. No rates are shipped:
 * a deployer can provide FX_RATES_TO_EUR='{"CHF":1.05}' from a source they trust.
 */
export function fxRates(): Record<string, number> {
  const raw = process.env.FX_RATES_TO_EUR;
  if (!raw) return { EUR: 1 };
  try {
    const parsed = JSON.parse(raw) as Record<string, number>;
    return { EUR: 1, ...parsed };
  } catch {
    return { EUR: 1 };
  }
}
