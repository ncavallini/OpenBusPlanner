import {
  addDays,
  estimateWalk,
  guessCountry,
  haversineMeters,
  matchCity,
  serviceDayReference,
  type IsoDate,
} from '@openbus/core';
import type { RouterFootpath, RouterStop, RouterTrip, SegmentFare, TimetableInput, TransportMode } from '@openbus/router';
import { expandServiceDates } from './calendar';
import type { GtfsFare, GtfsFareRule, GtfsFeed, GtfsStop } from './feed';

/** GTFS route_type (basic + extended Hierarchical Vehicle Types) to our mode. */
export function routeTypeToMode(t: number): TransportMode {
  if (t === 3 || t === 11 || (t >= 200 && t < 300) || (t >= 700 && t < 800) || t === 800) return 'bus';
  if (t === 2 || (t >= 100 && t < 200)) return 'rail';
  return 'other';
}

/**
 * GTFS fares v1 with origin/destination zones, expanded into fares per (board, alight)
 * position of a trip. Rules bound to the route win over route-less rules. Fares are
 * *indicative*: they come from a static file, not from a live booking system.
 */
export function segmentFares(
  fares: GtfsFare[],
  rules: GtfsFareRule[],
  routeId: string,
  stopZones: Array<string | null>,
): SegmentFare[] {
  if (rules.length === 0) return [];
  const fareById = new Map(fares.map((f) => [f.id, f]));
  const relevant = rules.filter((r) => (r.routeId === null || r.routeId === routeId) && r.originZone && r.destinationZone);
  if (relevant.length === 0) return [];
  const out: SegmentFare[] = [];
  for (let i = 0; i < stopZones.length; i++) {
    const zi = stopZones[i];
    if (!zi) continue;
    for (let j = i + 1; j < stopZones.length; j++) {
      const zj = stopZones[j];
      if (!zj) continue;
      const matches = relevant.filter((r) => r.originZone === zi && r.destinationZone === zj);
      const rule = matches.find((r) => r.routeId === routeId) ?? matches[0];
      const fare = rule ? fareById.get(rule.fareId) : undefined;
      if (fare) out.push({ fromIndex: i, toIndex: j, amount: fare.price, currency: fare.currency, kind: 'indicative' });
    }
  }
  return out;
}

export interface ConvertOptions {
  from: IsoDate;
  to: IsoDate;
  sourceId: string;
  synthetic: boolean;
  walkRadiusMeters?: number;
  defaultMinTransferSeconds?: number;
}

/** Map stops to stations: platforms collapse into their parent station. */
export function stationOf(feed: GtfsFeed): Map<string, GtfsStop> {
  const byId = new Map(feed.stops.map((s) => [s.id, s]));
  const out = new Map<string, GtfsStop>();
  for (const s of feed.stops) {
    const parent = s.parentStation ? byId.get(s.parentStation) : undefined;
    out.set(s.id, parent && parent.locationType === 1 ? parent : s);
  }
  return out;
}

/**
 * In-memory conversion of one GTFS feed to router input, without a database. Used by
 * tests, benchmarks and the CLI. The database path (ingest + loader) applies the same
 * rules plus cross-source entity resolution.
 */
export function gtfsToTimetableInput(feed: GtfsFeed, opts: ConvertOptions): TimetableInput {
  const station = stationOf(feed);
  const agencyById = new Map(feed.agencies.map((a) => [a.id, a]));
  const routeById = new Map(feed.routes.map((r) => [r.id, r]));
  const feedTz = feed.agencies[0]!.timezone;

  const stops = new Map<string, RouterStop>();
  for (const s of new Set(station.values())) {
    const city = matchCity(s.lat, s.lon, s.name);
    stops.set(s.id, {
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      timezone: s.timezone ?? feedTz,
      countryCode: city?.countryCode ?? guessCountry(s.lat, s.lon) ?? null,
      cityId: city?.id ?? null,
      minTransferSeconds: opts.defaultMinTransferSeconds ?? 0,
    });
  }
  const footpaths: RouterFootpath[] = [];
  for (const t of feed.transfers) {
    const a = station.get(t.fromStopId);
    const b = station.get(t.toStopId);
    if (!a || !b) continue;
    if (a.id === b.id && t.type === 2 && t.minTransferSeconds !== null) {
      const st = stops.get(a.id)!;
      st.minTransferSeconds = Math.max(st.minTransferSeconds, t.minTransferSeconds);
    } else if (a.id !== b.id && t.type !== 3) {
      const d = haversineMeters(a, b);
      const est = estimateWalk(d);
      footpaths.push({
        from: a.id,
        to: b.id,
        durationSeconds: t.minTransferSeconds ?? est.durationSeconds,
        distanceMeters: est.distanceMeters,
        method: 'feed',
      });
    }
  }
  footpaths.push(...proximityFootpaths([...stops.values()], opts.walkRadiusMeters ?? 1000, footpaths));

  const serviceDates = expandServiceDates(feed.calendars, feed.calendarDates, addDays(opts.from, -2), opts.to);
  const zoneOf = new Map(feed.stops.map((s) => [s.id, s.zoneId]));
  const trips: RouterTrip[] = [];
  for (const trip of feed.trips) {
    const dates = serviceDates.get(trip.serviceId);
    const sts = feed.stopTimes.get(trip.id);
    const route = routeById.get(trip.routeId);
    if (!dates?.size || !sts || sts.length < 2 || !route) continue;
    if (sts.some((s) => Number.isNaN(s.arrival))) continue;
    const agency = agencyById.get(route.agencyId) ?? feed.agencies[0]!;
    const fares = segmentFares(feed.fares, feed.fareRules, route.id, sts.map((s) => zoneOf.get(s.stopId) ?? null));
    for (const date of dates) {
      const ref = serviceDayReference(date, agency.timezone);
      trips.push({
        id: `${opts.sourceId}:${trip.id}@${date}`,
        tripId: trip.id,
        serviceDate: date,
        operatorId: `${opts.sourceId}:${agency.id}`,
        routeId: route.id,
        mode: routeTypeToMode(route.type),
        sourceId: opts.sourceId,
        synthetic: opts.synthetic,
        stops: sts.map((s) => station.get(s.stopId)!.id),
        arrivals: sts.map((s) => ref + s.arrival),
        departures: sts.map((s) => ref + s.departure),
        pickup: sts.map((s) => s.pickup),
        dropoff: sts.map((s) => s.dropoff),
        ...(fares.length ? { fares } : {}),
      });
    }
  }
  return { stops: [...stops.values()], trips, footpaths };
}

/** Walking links between distinct stops within a radius (straight line × detour factor). */
export function proximityFootpaths(
  stops: Array<{ id: string; lat: number; lon: number }>,
  radiusMeters: number,
  existing: RouterFootpath[] = [],
): RouterFootpath[] {
  const have = new Set(existing.map((f) => `${f.from}>${f.to}`));
  const cell = radiusMeters / 111_000;
  const grid = new Map<string, typeof stops>();
  const key = (lat: number, lon: number) => `${Math.floor(lat / cell)}:${Math.floor(lon / cell)}`;
  for (const s of stops) {
    const k = key(s.lat, s.lon);
    let g = grid.get(k);
    if (!g) grid.set(k, (g = []));
    g.push(s);
  }
  const out: RouterFootpath[] = [];
  for (const a of stops) {
    const ci = Math.floor(a.lat / cell);
    // Longitude cells shrink with latitude; widen the neighbourhood accordingly.
    const span = Math.ceil(1 / Math.max(0.2, Math.cos((a.lat * Math.PI) / 180)));
    const cj = Math.floor(a.lon / cell);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -span; dj <= span; dj++) {
        for (const b of grid.get(`${ci + di}:${cj + dj}`) ?? []) {
          if (a.id === b.id || have.has(`${a.id}>${b.id}`)) continue;
          const d = haversineMeters(a, b);
          if (d > radiusMeters) continue;
          const est = estimateWalk(d);
          out.push({ from: a.id, to: b.id, durationSeconds: est.durationSeconds, distanceMeters: est.distanceMeters, method: 'estimated' });
        }
      }
    }
  }
  return out;
}
