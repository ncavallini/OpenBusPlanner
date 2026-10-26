import {
  API_VERSION,
  JourneySearchRequest,
  type Connection,
  type Coverage,
  type Itinerary,
  type JourneySearchQuery,
  type JourneySearchResponse,
  type Place,
  type SearchOutcome,
  type SourceCoverage,
  type StopRef,
  type TimePoint,
  type VehicleLeg,
  type Warning,
} from '@openbus/core/api';
import {
  addDays,
  epochToLocalDate,
  epochToLocalIso,
  localDayDifference,
  localTimeToEpoch,
  QUALITY_NAMES,
} from '@openbus/core';
import { parsePlaceId, randomId, stableId } from '@openbus/core/ids';
import { getPlace, stationsForPlace, type DataScope, type LoadedTimetable, type PlaceRow, type SourceInfo, type Sql } from '@openbus/db';
import { searchJourneysAsync, type Journey, type JourneyLeg, type RouterRequest } from '@openbus/router';
import type { CachedTimetable, TimetableCache } from './timetable-cache';

export class SearchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export function toPlace(r: PlaceRow): Place {
  return {
    id: `${r.kind}:${r.id}`,
    kind: r.kind,
    name: r.name,
    cityName: r.city_name,
    countryCode: r.country_code?.trim() ?? null,
    lat: r.lat,
    lon: r.lon,
    timezone: r.timezone,
    stationCount: r.station_count,
    matchedAlias: r.matched_alias ?? null,
  };
}

const tp = (epoch: number, timezone: string): TimePoint => ({ epoch, local: epochToLocalIso(epoch, timezone), timezone });

export function freshness(src: SourceInfo, now = Date.now()): SourceCoverage['freshness'] {
  if (src.synthetic || !src.lastSuccess) return 'unknown';
  const ageH = (now - Date.parse(src.lastSuccess.finishedAt)) / 3_600_000;
  const refresh = src.refreshHours ?? 24;
  if (ageH <= refresh * 2) return 'fresh';
  if (ageH <= Math.max(refresh * 7, 24 * 7)) return 'aging';
  return 'stale';
}

export interface SearchDeps {
  sql: Sql;
  timetables: TimetableCache;
  defaultScope: DataScope;
  timeoutMs: number;
}

export async function runJourneySearch(
  deps: SearchDeps,
  input: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<JourneySearchResponse> {
  const started = Date.now();
  const parsed = JourneySearchRequest.safeParse(input);
  if (!parsed.success) throw new SearchError('invalid_request', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const q: JourneySearchQuery = parsed.data;
  const scope = q.dataScope ?? deps.defaultScope;

  const [origin, destination] = await Promise.all([resolvePlace(deps.sql, q.origin), resolvePlace(deps.sql, q.destination)]);
  if (origin.place.id === destination.place.id) throw new SearchError('same_place', 'Origin and destination are the same place');

  // ---- Time window in the local time of the relevant end of the journey.
  const windowTz = q.mode === 'depart' ? origin.place.timezone : destination.place.timezone;
  const windowStart = localTimeToEpoch(q.date, q.timeWindow.from, windowTz);
  let windowEnd = localTimeToEpoch(q.date, q.timeWindow.to, windowTz);
  if (windowEnd <= windowStart) windowEnd = localTimeToEpoch(addDays(q.date, 1), q.timeWindow.to, windowTz);
  const maxDuration = Math.round(q.maxDurationHours * 3600);
  const earliestDeparture =
    q.mode === 'arrive'
      ? q.departureNotBefore
        ? localTimeToEpoch(q.departureNotBefore.date, q.departureNotBefore.time, origin.place.timezone)
        : windowStart - maxDuration
      : windowStart;
  const latestArrival =
    q.mode === 'depart'
      ? q.arrivalNotAfter
        ? localTimeToEpoch(q.arrivalNotAfter.date, q.arrivalNotAfter.time, destination.place.timezone)
        : windowEnd + maxDuration
      : windowEnd;
  if (latestArrival <= earliestDeparture) throw new SearchError('empty_window', 'The latest arrival is before the earliest departure');

  const query = {
    origin: origin.place,
    destination: destination.place,
    mode: q.mode,
    windowStart: tp(windowStart, windowTz),
    windowEnd: tp(windowEnd, windowTz),
    earliestDeparture: tp(earliestDeparture, origin.place.timezone),
    latestArrival: tp(latestArrival, destination.place.timezone),
  };
  const searchId = randomId('srch');

  // ---- Timetable for the dates the window touches (UTC dates, widened by a day).
  const fromDate = addDays(epochToLocalDate(earliestDeparture, 'UTC'), -1);
  const toDate = addDays(epochToLocalDate(latestArrival, 'UTC'), 1);
  const tt = await deps.timetables.get(fromDate, toDate, scope);
  const coverage = buildCoverage(tt, scope, earliestDeparture, latestArrival, fromDate, toDate);

  const emptyResponse = (outcome: SearchOutcome, outcomeMessage: string): JourneySearchResponse => ({
    apiVersion: API_VERSION,
    searchId,
    outcome,
    outcomeMessage,
    query,
    itineraries: [],
    coverage,
    diagnostics: { durationMs: Date.now() - started, timetableBuildMs: tt.buildMs, routingMs: 0, rounds: 0, labelsCreated: 0, searchesRun: 0, truncated: false, cached: tt.cached },
  });

  const originStations = origin.stations.filter((s) => tt.timetable.stopIndex.has(s));
  const destStations = destination.stations.filter((s) => tt.timetable.stopIndex.has(s));
  if (origin.stations.length === 0 || destination.stations.length === 0) {
    const which = origin.stations.length === 0 ? origin.place.name : destination.place.name;
    return emptyResponse('place_not_served', `No station with timetable data is known for ${which}.`);
  }
  const inScope = coverage.sources.filter((s) => s.status !== 'excluded_by_scope');
  if (inScope.length > 0 && inScope.every((s) => s.status === 'unavailable')) {
    return emptyResponse('sources_unavailable', 'All timetable sources for this search are currently unavailable.');
  }
  const validForDates = inScope.some((s) => s.validFrom && s.validTo && s.validFrom <= toDate && s.validTo >= fromDate);
  if (coverage.sourcesWithServiceInWindow === 0 && !validForDates) {
    return emptyResponse('no_timetable_data_for_dates', 'None of the available timetable sources covers the requested dates.');
  }
  if (originStations.length === 0 || destStations.length === 0) {
    const which = originStations.length === 0 ? origin.place.name : destination.place.name;
    return emptyResponse('no_journey_in_available_data', `No service calls at ${which} in the requested period in the available data.`);
  }

  // ---- Route.
  const rreq: RouterRequest = {
    originStopIds: originStations,
    destinationStopIds: destStations,
    mode: q.mode,
    windowStart,
    windowEnd,
    earliestDeparture,
    latestArrival,
    maxTransfers: q.maxTransfers,
    minTransferSeconds: q.minTransferMinutes * 60,
    maxTransferWaitSeconds: q.maxTransferWaitMinutes * 60,
    maxDurationSeconds: maxDuration,
    maxWalkMeters: q.maxWalkMeters,
    riskPreference: q.riskPreference,
    excludeRiskyTransfers: q.excludeRiskyTransfers,
    modes: q.transportModes,
    ...(q.includeOperators?.length ? { includeOperators: q.includeOperators } : {}),
    ...(q.excludeOperators?.length ? { excludeOperators: q.excludeOperators } : {}),
    ...(q.maxBudget ? { maxBudgetEur: tt.timetable.toEur(q.maxBudget.amount, q.maxBudget.currency) } : {}),
    alternatives: q.alternatives,
    timeoutMs: deps.timeoutMs,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  if (q.maxBudget && Number.isNaN(rreq.maxBudgetEur!)) delete rreq.maxBudgetEur;
  const routingStarted = Date.now();
  const result = await searchJourneysAsync(tt.timetable, rreq);
  const routingMs = Date.now() - routingStarted;

  let itineraries = result.journeys.map((j) => toItinerary(tt, j, searchId));
  itineraries = sortItineraries(itineraries, q.sort).slice(0, q.limit);
  const outcome: SearchOutcome = itineraries.length ? 'results' : 'no_journey_in_available_data';
  const outcomeMessage = itineraries.length
    ? `${itineraries.length} itinerar${itineraries.length === 1 ? 'y' : 'ies'} found in the available timetable data.`
    : 'No journey matching your constraints exists in the available timetable data. Operators missing from our sources may still offer one.';

  return {
    apiVersion: API_VERSION,
    searchId,
    outcome,
    outcomeMessage,
    query,
    itineraries,
    coverage,
    diagnostics: {
      durationMs: Date.now() - started,
      timetableBuildMs: tt.buildMs,
      routingMs,
      rounds: result.stats.rounds,
      labelsCreated: result.stats.labelsCreated,
      searchesRun: result.stats.searchesRun,
      truncated: result.stats.truncated,
      cached: tt.cached,
    },
  };
}

async function resolvePlace(sql: Sql, id: string): Promise<{ place: Place; stations: string[] }> {
  const ref = parsePlaceId(id);
  if (!ref) throw new SearchError('invalid_place', `Invalid place id "${id}"; use an id returned by /api/v1/places/search`);
  const row = await getPlace(sql, ref.kind, ref.id);
  if (!row) throw new SearchError('unknown_place', `Unknown place "${id}"`, 404);
  return { place: toPlace(row), stations: await stationsForPlace(sql, ref.kind, ref.id) };
}

function buildCoverage(tt: CachedTimetable, scope: DataScope, from: number, to: number, fromDate: string, toDate: string): Coverage {
  const { loaded, timetable } = tt;
  const tripsInWindow = new Map<string, number>();
  const operators = new Set<string>();
  timetable.trips.forEach((t, i) => {
    if (t.departures[0]! > to || t.arrivals[t.arrivals.length - 1]! < from) return;
    tripsInWindow.set(t.sourceId, (tripsInWindow.get(t.sourceId) ?? 0) + 1);
    operators.add(t.operatorId);
    for (const s of timetable.tripAlsoIn[i] ?? []) tripsInWindow.set(s, (tripsInWindow.get(s) ?? 0) + 1);
  });
  const sources: SourceCoverage[] = [];
  for (const s of loaded.sources.values()) {
    if (!s.enabled) continue;
    const inScope = scope === 'all' || (scope === 'synthetic') === s.synthetic;
    const n = tripsInWindow.get(s.id) ?? 0;
    const fresh = freshness(s);
    let status: SourceCoverage['status'];
    let reason: string | null = null;
    if (!inScope) {
      status = 'excluded_by_scope';
      reason = s.synthetic ? 'Synthetic test data excluded' : 'Real data excluded';
    } else if (!s.lastSuccess) {
      status = 'unavailable';
      reason = s.lastMessage ?? 'Never imported successfully';
    } else if (n > 0) {
      status = fresh === 'stale' ? 'stale' : 'used';
      if (s.lastStatus === 'failed') reason = `Last refresh failed (${s.lastMessage ?? 'unknown error'}); using previous import`;
    } else {
      status = 'no_service_in_window';
      const vf = s.lastSuccess.validFrom;
      const vt = s.lastSuccess.validTo;
      reason = vf && vt && (toDate < vf || fromDate > vt) ? `Timetable valid ${vf} – ${vt} only` : null;
    }
    sources.push({
      id: s.id,
      name: s.name,
      synthetic: s.synthetic,
      status,
      reason,
      validFrom: s.lastSuccess?.validFrom ?? null,
      validTo: s.lastSuccess?.validTo ?? null,
      importedAt: s.lastSuccess?.finishedAt ?? null,
      freshness: fresh,
      tripsInWindow: n,
    });
  }
  const consulted = sources.filter((s) => s.status !== 'excluded_by_scope' && s.status !== 'unavailable');
  const withService = sources.filter((s) => s.tripsInWindow > 0 && s.status !== 'excluded_by_scope');
  const synthetic = withService.some((s) => s.synthetic);
  const unavailable = sources.filter((s) => s.status === 'unavailable').length;
  const real = withService.filter((s) => !s.synthetic).length;
  const parts = [
    `Results based on ${consulted.length} available timetable source${consulted.length === 1 ? '' : 's'}`,
    `${withService.length} with services in this period`,
  ];
  if (synthetic) parts.push(`${withService.length - real} of them synthetic test data`);
  let message = `${parts.join(', ')}. Some operators may not be represented.`;
  if (unavailable) message += ` ${unavailable} source${unavailable === 1 ? ' is' : 's are'} currently unavailable.`;
  message += ' Prices are not queried live and seat availability is not verified.';
  const dated = consulted.filter((s) => s.validFrom && s.validTo);
  return {
    sourcesConsulted: consulted.length,
    sourcesWithServiceInWindow: withService.length,
    sources,
    operatorsRepresented: [...operators].map((id) => loaded.operators.get(id)?.name ?? id).sort(),
    dateCoverage: {
      from: fromDate,
      to: toDate,
      fullyCovered: dated.some((s) => s.validFrom! <= fromDate && s.validTo! >= toDate),
    },
    livePricesQueried: false,
    availabilityVerified: false,
    syntheticDataIncluded: synthetic,
    message,
  };
}

function stopRef(tt: LoadedTimetable, id: string): StopRef {
  const s = tt.stations.get(id);
  if (!s) return { stationId: id, name: id, cityId: null, cityName: null, countryCode: null, lat: 0, lon: 0, timezone: 'UTC' };
  return {
    stationId: s.id,
    name: s.name,
    cityId: s.cityId,
    cityName: s.cityName,
    countryCode: s.countryCode?.trim() ?? null,
    lat: s.lat,
    lon: s.lon,
    timezone: s.timezone,
  };
}

function bookingFor(tt: LoadedTimetable, leg: JourneyLeg, synthetic: boolean, from: StopRef, to: StopRef, date: string): VehicleLeg['booking'] {
  if (synthetic) return { kind: 'none', url: null, label: 'Synthetic test data — not bookable' };
  const meta = tt.tripMeta.get(leg.trip.id);
  if (meta?.bookingUrl) return { kind: 'departure_specific', url: meta.bookingUrl, label: 'Book this departure with the operator' };
  const op = tt.operators.get(leg.trip.operatorId);
  if (op?.bookingUrlTemplate) {
    const url = op.bookingUrlTemplate
      .replace('{from}', encodeURIComponent(from.cityName ?? from.name))
      .replace('{to}', encodeURIComponent(to.cityName ?? to.name))
      .replace('{date}', date);
    return {
      kind: op.bookingLinkKind === 'departure_specific' ? 'departure_specific' : 'route_search',
      url,
      label: op.bookingLinkKind === 'departure_specific' ? 'Book this departure with the operator' : `Search this route on ${op.name}`,
    };
  }
  if (op?.website) return { kind: 'operator_homepage', url: op.website, label: `${op.name} website — not preselected; search for this departure there` };
  return { kind: 'none', url: null, label: 'No booking link known' };
}

function toLeg(tt: CachedTimetable, leg: JourneyLeg): VehicleLeg {
  const { loaded, timetable } = tt;
  const trip = leg.trip;
  const from = stopRef(loaded, trip.stops[leg.boardIndex]!);
  const to = stopRef(loaded, trip.stops[leg.alightIndex]!);
  const src = loaded.sources.get(trip.sourceId);
  const op = loaded.operators.get(trip.operatorId);
  const meta = loaded.tripMeta.get(trip.id);
  const intermediate = [];
  for (let i = leg.boardIndex + 1; i < leg.alightIndex; i++) {
    const s = stopRef(loaded, trip.stops[i]!);
    intermediate.push({
      stationId: s.stationId,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      arrival: tp(trip.arrivals[i]!, s.timezone),
      departure: tp(trip.departures[i]!, s.timezone),
    });
  }
  const countries = new Set([from.countryCode, ...intermediate.map((s) => loaded.stations.get(s.stationId)?.countryCode ?? null), to.countryCode].filter(Boolean));
  const synthetic = trip.synthetic;
  return {
    type: 'vehicle',
    tripId: meta?.sourceTripId ?? trip.tripId,
    serviceDate: trip.serviceDate,
    mode: trip.mode,
    operator: { id: trip.operatorId, name: op?.name ?? trip.operatorId, website: op?.website ?? null, synthetic: op?.synthetic ?? synthetic },
    routeName: meta?.routeName ?? null,
    headsign: meta?.headsign ?? null,
    from,
    to,
    departure: tp(leg.departure, from.timezone),
    arrival: tp(leg.arrival, to.timezone),
    durationSeconds: leg.arrival - leg.departure,
    intermediateStops: intermediate,
    crossesBorder: countries.size > 1,
    price: leg.price
      ? { status: 'known', amount: leg.price.amount, currency: leg.price.currency, kind: leg.price.kind, observedAt: src?.lastSuccess?.finishedAt ?? null, source: src?.name ?? null }
      : { status: 'unknown', amount: null, currency: null, kind: null, observedAt: null, source: null },
    availability: 'not_verified',
    booking: bookingFor(loaded, leg, synthetic, from, to, epochToLocalDate(leg.departure, from.timezone)),
    provenance: {
      sourceId: trip.sourceId,
      sourceName: src?.name ?? trip.sourceId,
      synthetic,
      license: src?.license ?? null,
      attribution: src?.attribution ?? null,
      importedAt: src?.lastSuccess?.finishedAt ?? null,
      feedVersion: src?.lastSuccess?.feedVersion ?? null,
      freshness: src ? freshness(src) : 'unknown',
      realtimeApplied: meta?.realtime ?? false,
      alsoFoundIn: (timetable.tripAlsoIn[leg.tripIndex] ?? []).map((id) => loaded.sources.get(id)?.name ?? id),
    },
  };
}

function toItinerary(tt: CachedTimetable, j: Journey, searchId: string): Itinerary {
  const legs = j.legs.map((l) => toLeg(tt, l));
  const connections: Connection[] = j.connections.map((c) => {
    const fromStop = stopRef(tt.loaded, c.atStopId);
    const toStop = stopRef(tt.loaded, c.toStopId);
    return {
      fromStop,
      toStop,
      arrival: tp(c.arrival, fromStop.timezone),
      departure: tp(c.departure, toStop.timezone),
      walk: c.walk ? { meters: c.walk.distanceMeters, seconds: c.walk.durationSeconds, method: c.walk.method } : null,
      waitSeconds: c.departure - c.arrival,
      slackSeconds: c.slackSeconds,
      quality: QUALITY_NAMES[c.quality]!,
      reasons: c.reasons,
      separateTickets: legs.length > 1,
      nightSeconds: c.nightSeconds,
    };
  });
  const first = legs[0]!;
  const last = legs[legs.length - 1]!;
  const operators = [...new Map(legs.map((l) => [l.operator.id, { id: l.operator.id, name: l.operator.name }])).values()];
  const known = legs.filter((l) => l.price.status === 'known');
  const totals = new Map<string, number>();
  for (const l of known) totals.set(l.price.currency!, Math.round(((totals.get(l.price.currency!) ?? 0) + l.price.amount!) * 100) / 100);
  const kinds = new Set(known.map((l) => l.price.kind));
  const synthetic = legs.some((l) => l.provenance.synthetic);
  const worst = j.worstQuality === null ? null : QUALITY_NAMES[j.worstQuality]!;

  const warnings: Warning[] = [];
  if (synthetic) warnings.push({ code: 'synthetic_data', message: 'Contains synthetic test data. These departures do not exist.' });
  if (legs.length > 1) {
    warnings.push({
      code: 'separate_tickets',
      message:
        operators.length > 1
          ? 'Legs are operated by different companies and must be booked separately. A delay on one leg does not entitle you to a later connection on the next.'
          : 'These legs are separate trips. The operator may sell them as one protected booking — check when booking; otherwise a missed connection is not protected.',
    });
  }
  if (worst === 'risky') warnings.push({ code: 'risky_connection', message: 'At least one connection leaves little buffer for delays.' });
  if (connections.some((c) => c.walk)) warnings.push({ code: 'walking_transfer', message: 'Includes a walk between different stops.' });
  if (connections.some((c) => c.nightSeconds > 0)) warnings.push({ code: 'night_transfer', message: 'Includes waiting at a station during the night (00:00–05:00).' });
  if (j.overnightWaitSeconds >= 2 * 3600) warnings.push({ code: 'overnight_wait', message: 'Includes a long overnight wait.' });
  if (legs.some((l) => l.crossesBorder)) warnings.push({ code: 'cross_border', message: 'Crosses a national border: carry a valid ID; border checks can cause delays.' });
  if (legs.some((l) => l.provenance.freshness === 'stale')) warnings.push({ code: 'stale_data', message: 'Some timetable data has not been refreshed recently.' });
  if (known.length < legs.length) warnings.push({ code: 'price_unknown', message: 'Price unknown for at least one leg.' });
  if (!synthetic && legs.some((l) => l.booking.kind === 'operator_homepage'))
    warnings.push({ code: 'generic_booking_link', message: 'Booking links lead to the operator website, not to a preselected departure.' });
  warnings.push({ code: 'availability_not_verified', message: 'Seat availability has not been checked. A timetabled departure may be sold out.' });

  const durationSeconds = j.arrival - j.departure;
  const score =
    durationSeconds / 60 +
    25 * j.transfers +
    (worst === 'risky' ? 60 : worst === 'reasonable' ? 15 : 0) +
    j.walkMeters / 100 +
    (j.overnightWaitSeconds / 60) * 0.25 +
    (j.paretoOptimal ? 0 : 30);
  return {
    id: stableId('itn', searchId, j.signature),
    departure: tp(j.departure, first.from.timezone),
    arrival: tp(j.arrival, last.to.timezone),
    durationSeconds,
    arrivalDayOffset: localDayDifference(j.departure, first.from.timezone, j.arrival, last.to.timezone),
    transfers: j.transfers,
    legs,
    connections,
    operators,
    separateTickets: legs.length > 1,
    worstConnection: worst,
    walkingMeters: j.walkMeters,
    overnightWaitSeconds: j.overnightWaitSeconds,
    price: {
      status: known.length === legs.length ? 'complete' : known.length > 0 ? 'partial' : 'unknown',
      totals: known.length === legs.length ? [...totals].map(([currency, amount]) => ({ amount, currency })) : [],
      kind: known.length === 0 ? null : kinds.size > 1 ? 'mixed' : ([...kinds][0] as 'indicative' | 'live'),
      knownLegs: known.length,
      totalLegs: legs.length,
    },
    warnings,
    paretoOptimal: j.paretoOptimal,
    alternativeTo: j.alternativeTo.map((k) => {
      const id = k.replace(/^(city|stop):/, '');
      for (const s of tt.loaded.stations.values()) if (s.cityId === id || s.id === id) return s.cityName ?? s.name;
      return id;
    }),
    synthetic,
    score: Math.round(score * 10) / 10,
  };
}

const qualityRank = (q: Itinerary['worstConnection']) => (q === null ? 0 : QUALITY_NAMES.indexOf(q));
const priceOf = (i: Itinerary) =>
  i.price.status === 'complete' && i.price.totals.length === 1 ? i.price.totals[0]!.amount : Number.POSITIVE_INFINITY;

export function sortItineraries(list: Itinerary[], key: JourneySearchQuery['sort']): Itinerary[] {
  const by: Record<JourneySearchQuery['sort'], (a: Itinerary, b: Itinerary) => number> = {
    recommended: (a, b) => a.score - b.score,
    arrival: (a, b) => a.arrival.epoch - b.arrival.epoch,
    departure: (a, b) => a.departure.epoch - b.departure.epoch,
    duration: (a, b) => a.durationSeconds - b.durationSeconds,
    transfers: (a, b) => a.transfers - b.transfers,
    price: (a, b) => priceOf(a) - priceOf(b),
    reliability: (a, b) => qualityRank(a.worstConnection) - qualityRank(b.worstConnection),
    walking: (a, b) => a.walkingMeters - b.walkingMeters,
  };
  const cmp = by[key];
  return [...list].sort((a, b) => cmp(a, b) || a.score - b.score || a.departure.epoch - b.departure.epoch);
}
