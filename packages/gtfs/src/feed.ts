import { gtfsDateToIso, isValidCoordinate, isValidTimeZone, parseGtfsTime, type IsoDate } from '@openbus/core';
import { readAll, readTable, type GtfsSource, type Row } from './reader';

export interface GtfsAgency {
  id: string;
  name: string;
  url: string | null;
  timezone: string;
  lang: string | null;
}

export interface GtfsStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  locationType: number;
  parentStation: string | null;
  zoneId: string | null;
  timezone: string | null;
  platformCode: string | null;
}

export interface GtfsRoute {
  id: string;
  agencyId: string;
  shortName: string | null;
  longName: string | null;
  type: number;
  url: string | null;
}

export interface GtfsTrip {
  id: string;
  routeId: string;
  serviceId: string;
  headsign: string | null;
}

export interface GtfsStopTime {
  stopId: string;
  sequence: number;
  arrival: number;
  departure: number;
  pickup: boolean;
  dropoff: boolean;
}

export interface GtfsCalendar {
  serviceId: string;
  days: boolean[]; // Monday..Sunday
  start: IsoDate;
  end: IsoDate;
}

export interface GtfsCalendarDate {
  serviceId: string;
  date: IsoDate;
  added: boolean;
}

export interface GtfsTransfer {
  fromStopId: string;
  toStopId: string;
  type: number;
  minTransferSeconds: number | null;
}

export interface GtfsFare {
  id: string;
  price: number;
  currency: string;
  agencyId: string | null;
}

export interface GtfsFareRule {
  fareId: string;
  routeId: string | null;
  originZone: string | null;
  destinationZone: string | null;
}

export interface GtfsFeedInfo {
  publisherName: string | null;
  publisherUrl: string | null;
  version: string | null;
  startDate: IsoDate | null;
  endDate: IsoDate | null;
}

export interface GtfsFeed {
  agencies: GtfsAgency[];
  stops: GtfsStop[];
  routes: GtfsRoute[];
  trips: GtfsTrip[];
  /** Ordered by stop_sequence. */
  stopTimes: Map<string, GtfsStopTime[]>;
  calendars: GtfsCalendar[];
  calendarDates: GtfsCalendarDate[];
  transfers: GtfsTransfer[];
  fares: GtfsFare[];
  fareRules: GtfsFareRule[];
  feedInfo: GtfsFeedInfo | null;
  attributions: string[];
  warnings: string[];
  counts: Record<string, number>;
}

const opt = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v);
const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export class GtfsValidationError extends Error {}

/**
 * Loads a GTFS feed into memory with validation. Duplicate primary keys (trip_id,
 * stop_id, trip+stop_sequence) are dropped with a warning instead of failing the import —
 * real-world feeds frequently contain them.
 */
export async function loadGtfsFeed(src: GtfsSource, opts: { maxWarnings?: number } = {}): Promise<GtfsFeed> {
  const warnings: string[] = [];
  const maxWarnings = opts.maxWarnings ?? 200;
  let suppressed = 0;
  const warn = (m: string) => {
    if (warnings.length < maxWarnings) warnings.push(m);
    else suppressed++;
  };

  const agencyRows = await readAll(src, 'agency.txt');
  if (agencyRows.length === 0) throw new GtfsValidationError('agency.txt is missing or empty');
  const agencies: GtfsAgency[] = agencyRows.map((r, i) => ({
    id: r.agency_id || (agencyRows.length === 1 ? '__default' : `agency_${i}`),
    name: r.agency_name || 'Unknown operator',
    url: opt(r.agency_url),
    timezone: r.agency_timezone || 'UTC',
    lang: opt(r.agency_lang),
  }));
  for (const a of agencies) {
    if (!isValidTimeZone(a.timezone)) throw new GtfsValidationError(`Invalid agency_timezone "${a.timezone}"`);
  }
  const defaultAgency = agencies[0]!.id;

  const stops: GtfsStop[] = [];
  const stopIds = new Set<string>();
  for (const r of await readAll(src, 'stops.txt')) {
    const id = r.stop_id;
    if (!id) continue;
    if (stopIds.has(id)) {
      warn(`Duplicate stop_id ${id} ignored`);
      continue;
    }
    const lat = num(r.stop_lat, Number.NaN);
    const lon = num(r.stop_lon, Number.NaN);
    const locationType = num(r.location_type, 0);
    if (locationType <= 1 && !isValidCoordinate(lat, lon)) {
      warn(`Stop ${id} has invalid coordinates and was ignored`);
      continue;
    }
    const tz = opt(r.stop_timezone);
    stopIds.add(id);
    stops.push({
      id,
      name: r.stop_name || id,
      lat,
      lon,
      locationType,
      parentStation: opt(r.parent_station),
      zoneId: opt(r.zone_id),
      timezone: tz && isValidTimeZone(tz) ? tz : null,
      platformCode: opt(r.platform_code),
    });
  }

  const routes: GtfsRoute[] = [];
  const routeIds = new Set<string>();
  for (const r of await readAll(src, 'routes.txt')) {
    if (!r.route_id || routeIds.has(r.route_id)) {
      if (r.route_id) warn(`Duplicate route_id ${r.route_id} ignored`);
      continue;
    }
    routeIds.add(r.route_id);
    routes.push({
      id: r.route_id,
      agencyId: r.agency_id || defaultAgency,
      shortName: opt(r.route_short_name),
      longName: opt(r.route_long_name),
      type: num(r.route_type, 3),
      url: opt(r.route_url),
    });
  }

  const trips: GtfsTrip[] = [];
  const tripIds = new Set<string>();
  for (const r of await readAll(src, 'trips.txt')) {
    if (!r.trip_id) continue;
    if (tripIds.has(r.trip_id)) {
      warn(`Duplicate trip_id ${r.trip_id} ignored`);
      continue;
    }
    if (!routeIds.has(r.route_id ?? '')) {
      warn(`Trip ${r.trip_id} references unknown route ${r.route_id}`);
      continue;
    }
    tripIds.add(r.trip_id);
    trips.push({ id: r.trip_id, routeId: r.route_id!, serviceId: r.service_id ?? '', headsign: opt(r.trip_headsign) });
  }

  const stopTimes = new Map<string, GtfsStopTime[]>();
  let stopTimeRows = 0;
  for await (const r of readTable(src, 'stop_times.txt')) {
    stopTimeRows++;
    const tripId = r.trip_id;
    if (!tripId || !tripIds.has(tripId)) continue;
    if (!stopIds.has(r.stop_id ?? '')) {
      warn(`stop_times for trip ${tripId} reference unknown stop ${r.stop_id}`);
      continue;
    }
    const arrS = r.arrival_time || r.departure_time;
    const depS = r.departure_time || r.arrival_time;
    let arrival: number;
    let departure: number;
    if (!arrS || !depS) {
      // Untimed intermediate stop: GTFS allows interpolation; we keep the stop but cannot
      // board/alight there reliably, so interpolate from neighbours later.
      arrival = Number.NaN;
      departure = Number.NaN;
    } else {
      try {
        arrival = parseGtfsTime(arrS);
        departure = parseGtfsTime(depS);
      } catch {
        warn(`Invalid time in stop_times for trip ${tripId}`);
        continue;
      }
    }
    let list = stopTimes.get(tripId);
    if (!list) stopTimes.set(tripId, (list = []));
    list.push({
      stopId: r.stop_id!,
      sequence: num(r.stop_sequence, list.length),
      arrival,
      departure,
      pickup: r.pickup_type !== '1',
      dropoff: r.drop_off_type !== '1',
    });
  }
  for (const [tripId, list] of stopTimes) {
    list.sort((a, b) => a.sequence - b.sequence);
    const dedup: GtfsStopTime[] = [];
    for (const st of list) {
      const prev = dedup[dedup.length - 1];
      if (prev && prev.sequence === st.sequence) {
        warn(`Duplicate stop_sequence ${st.sequence} in trip ${tripId} ignored`);
        continue;
      }
      dedup.push(st);
    }
    interpolate(dedup);
    stopTimes.set(tripId, dedup);
  }

  const calendars: GtfsCalendar[] = (await readAll(src, 'calendar.txt'))
    .filter((r) => r.service_id && r.start_date && r.end_date)
    .map((r) => ({
      serviceId: r.service_id!,
      days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => r[d] === '1'),
      start: gtfsDateToIso(r.start_date!),
      end: gtfsDateToIso(r.end_date!),
    }));
  const calendarDates: GtfsCalendarDate[] = (await readAll(src, 'calendar_dates.txt'))
    .filter((r) => r.service_id && r.date && (r.exception_type === '1' || r.exception_type === '2'))
    .map((r) => ({ serviceId: r.service_id!, date: gtfsDateToIso(r.date!), added: r.exception_type === '1' }));

  const transfers: GtfsTransfer[] = (await readAll(src, 'transfers.txt'))
    .filter((r) => r.from_stop_id && r.to_stop_id)
    .map((r) => ({
      fromStopId: r.from_stop_id!,
      toStopId: r.to_stop_id!,
      type: num(r.transfer_type, 0),
      minTransferSeconds: r.min_transfer_time ? num(r.min_transfer_time, 0) : null,
    }));

  const fares: GtfsFare[] = (await readAll(src, 'fare_attributes.txt'))
    .filter((r) => r.fare_id && r.price && r.currency_type)
    .map((r) => ({ id: r.fare_id!, price: num(r.price, Number.NaN), currency: r.currency_type!.toUpperCase(), agencyId: opt(r.agency_id) }))
    .filter((f) => Number.isFinite(f.price));
  const fareRules: GtfsFareRule[] = (await readAll(src, 'fare_rules.txt'))
    .filter((r) => r.fare_id)
    .map((r) => ({ fareId: r.fare_id!, routeId: opt(r.route_id), originZone: opt(r.origin_id), destinationZone: opt(r.destination_id) }));

  const fi = (await readAll(src, 'feed_info.txt'))[0];
  const feedInfo: GtfsFeedInfo | null = fi
    ? {
        publisherName: opt(fi.feed_publisher_name),
        publisherUrl: opt(fi.feed_publisher_url),
        version: opt(fi.feed_version),
        startDate: fi.feed_start_date ? gtfsDateToIso(fi.feed_start_date) : null,
        endDate: fi.feed_end_date ? gtfsDateToIso(fi.feed_end_date) : null,
      }
    : null;
  const attributions = (await readAll(src, 'attributions.txt'))
    .map((r: Row) => r.organization_name)
    .filter((x): x is string => !!x);

  if (suppressed > 0) warnings.push(`${suppressed} further warnings suppressed`);
  return {
    agencies,
    stops,
    routes,
    trips,
    stopTimes,
    calendars,
    calendarDates,
    transfers,
    fares,
    fareRules,
    feedInfo,
    attributions,
    warnings,
    counts: {
      agencies: agencies.length,
      stops: stops.length,
      routes: routes.length,
      trips: trips.length,
      stopTimes: stopTimeRows,
      calendars: calendars.length,
      calendarDates: calendarDates.length,
    },
  };
}

/** Linear interpolation for untimed intermediate stops (GTFS allows omitted times). */
function interpolate(list: GtfsStopTime[]): void {
  for (let i = 0; i < list.length; i++) {
    if (!Number.isNaN(list[i]!.arrival)) continue;
    let j = i;
    while (j < list.length && Number.isNaN(list[j]!.arrival)) j++;
    const prev = list[i - 1];
    const next = list[j];
    if (!prev || !next) return; // first/last untimed: leave NaN, trip is rejected later
    const span = next.arrival - prev.departure;
    const steps = j - i + 1;
    for (let k = i; k < j; k++) {
      const t = Math.round(prev.departure + (span * (k - i + 1)) / steps);
      list[k]!.arrival = t;
      list[k]!.departure = t;
    }
    i = j;
  }
}
