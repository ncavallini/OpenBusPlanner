import {
  classifyTransfer,
  explainTransfer,
  haversineMeters,
  localSecondsOfDay,
  nightOverlapSeconds,
  type TransferPolicy,
} from '@openbus/core';
import { drainAsync, drainSync, engineSteps, type EngineQuery, type Label, type YIELD } from './raptor';
import type { Timetable } from './timetable';
import type {
  Journey,
  JourneyConnection,
  JourneyLeg,
  JourneyWalk,
  RouterRequest,
  RouterResult,
} from './types';

interface Step {
  kind: 'ride' | 'walk';
  trip?: number;
  boardIndex?: number;
  alightIndex?: number;
  from: number;
  to: number;
  walkSec?: number;
  walkMeters?: number;
  walkMethod?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

export function searchJourneys(tt: Timetable, req: RouterRequest): RouterResult {
  return drainSync(searchSteps(tt, req));
}

/** Same as searchJourneys, but yields to the event loop so `req.signal` can cancel it. */
export function searchJourneysAsync(tt: Timetable, req: RouterRequest): Promise<RouterResult> {
  return drainAsync(searchSteps(tt, req));
}

function* searchSteps(tt: Timetable, req: RouterRequest): Generator<typeof YIELD, RouterResult, void> {
  const started = Date.now();
  const deadline = started + (req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const policy: TransferPolicy = {
    minTransferSeconds: req.minTransferSeconds,
    maxWaitSeconds: req.maxTransferWaitSeconds,
    riskPreference: req.riskPreference,
  };
  const origins = resolveStops(tt, req.originStopIds);
  const destinations = resolveStops(tt, req.destinationStopIds);
  const stats = { rounds: 0, labelsCreated: 0, searchesRun: 0, truncated: false, durationMs: 0 };
  if (origins.length === 0 || destinations.length === 0) {
    return { journeys: [], stats: { ...stats, durationMs: Date.now() - started } };
  }
  const destSet = new Set(destinations);
  const originSet = new Set(origins);

  const tripAllowed = new Uint8Array(tt.trips.length);
  const modes = new Set(req.modes ?? ['bus']);
  const include = req.includeOperators?.length ? new Set(req.includeOperators) : null;
  const exclude = new Set(req.excludeOperators ?? []);
  tt.trips.forEach((t, i) => {
    tripAllowed[i] =
      modes.has(t.mode) && (!include || include.has(t.operatorId)) && !exclude.has(t.operatorId) ? 1 : 0;
  });

  const reversed = req.mode === 'arrive';
  const view = reversed ? tt.reverse : tt.forward;
  const earliestDeparture = req.earliestDeparture ?? req.windowStart - req.maxDurationSeconds;
  const latestArrival = req.latestArrival ?? req.windowEnd + req.maxDurationSeconds;
  const sources = reversed ? destinations : origins;
  const targets = reversed ? originSet : destSet;
  const lowerBound = computeLowerBound(tt, [...targets]);

  const baseQuery: EngineQuery = {
    sources,
    targets,
    startMin: reversed ? -req.windowEnd : req.windowStart,
    startMax: reversed ? -req.windowStart : req.windowEnd,
    bound: reversed ? -earliestDeparture : latestArrival,
    maxRounds: req.maxTransfers + 1,
    policy,
    maxWalkMeters: req.maxWalkMeters,
    maxDurationSeconds: req.maxDurationSeconds,
    maxQuality: req.excludeRiskyTransfers ? 1 : 2,
    maxBudgetEur: req.maxBudgetEur ?? Number.POSITIVE_INFINITY,
    tripAllowed,
    bannedStops: null,
    lowerBound,
    deadline,
    signal: req.signal,
  };

  const initialBans = new Set((req.bannedTransferStopIds ?? []).map((id) => tt.stopIndex.get(id)).filter(isNum));
  const runOnce = function* (banned: Set<number>, alternativeTo: string[]): Generator<typeof YIELD, Journey[], void> {
    const bannedStops = banned.size ? new Uint8Array(tt.stops.length) : null;
    if (bannedStops) for (const s of banned) if (!originSet.has(s) && !destSet.has(s)) bannedStops[s] = 1;
    const res = yield* engineSteps(tt, view, { ...baseQuery, bannedStops });
    stats.searchesRun++;
    stats.rounds = Math.max(stats.rounds, res.rounds);
    stats.labelsCreated += res.labelsCreated;
    stats.truncated ||= res.truncated;
    return res.targetLabels.map((l) => buildJourney(tt, l, reversed, policy, alternativeTo));
  };

  let all = yield* runOnce(initialBans, []);
  if (req.alternatives !== false && !stats.truncated) {
    const banned = new Set(initialBans);
    const bannedNames = new Set<string>();
    const maxRounds = req.maxAlternativeRounds ?? 3;
    for (let iter = 0; iter < maxRounds && Date.now() < deadline; iter++) {
      const hubs = new Map<string, number[]>();
      for (const j of all) for (const [key, stopsAt] of transferHubs(tt, j)) hubs.set(key, stopsAt);
      let added = false;
      for (const [key, stopsAt] of hubs) {
        if (bannedNames.has(key)) continue;
        bannedNames.add(key);
        for (const s of stopsAt) banned.add(s);
        added = true;
      }
      if (!added) break;
      const found = yield* runOnce(banned, [...bannedNames]);
      if (found.length === 0) break;
      all = all.concat(found);
    }
  }

  let journeys = dedupe(all);
  journeys = markPareto(journeys);
  stats.durationMs = Date.now() - started;
  return { journeys, stats };
}

function isNum(x: number | undefined): x is number {
  return x !== undefined;
}

function resolveStops(tt: Timetable, ids: string[]): number[] {
  const out = new Set<number>();
  for (const id of ids) {
    const i = tt.stopIndex.get(id);
    if (i !== undefined) out.add(i);
  }
  return [...out];
}

/** Admissible lower bound (seconds) from every stop to the nearest target. */
function computeLowerBound(tt: Timetable, targets: number[]): Float64Array | null {
  if (!Number.isFinite(tt.maxSpeed) || tt.maxSpeed <= 0 || tt.maxSpeed > 400) return null;
  const lb = new Float64Array(tt.stops.length);
  const tStops = targets.map((t) => tt.stops[t]!);
  for (let i = 0; i < tt.stops.length; i++) {
    let d = Number.POSITIVE_INFINITY;
    for (const t of tStops) d = Math.min(d, haversineMeters(tt.stops[i]!, t));
    lb[i] = d / tt.maxSpeed;
  }
  return lb;
}

/** Transfer points of a journey keyed by city (falls back to the stop itself). */
function transferHubs(tt: Timetable, j: Journey): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const c of j.connections) {
    for (const stopId of [c.atStopId, c.toStopId]) {
      const s = tt.stop(stopId);
      if (!s) continue;
      const key = s.cityId ? `city:${s.cityId}` : `stop:${s.id}`;
      const stopsAt = s.cityId ? tt.stopsOfCity(s.cityId) : [tt.stopIndex.get(s.id)!];
      out.set(key, stopsAt);
    }
  }
  return out;
}

function stepsOf(label: Label, reversed: boolean, tt: Timetable): Step[] {
  const chain: Label[] = [];
  for (let l: Label | null = label; l; l = l.parent) chain.push(l);
  chain.reverse(); // engine order: start .. end
  const steps: Step[] = [];
  for (let k = 1; k < chain.length; k++) {
    const l = chain[k]!;
    const prev = chain[k - 1]!;
    if (l.kind === 1) {
      const n = tt.trips[l.trip]!.stops.length;
      const board = reversed ? n - 1 - l.alightPos : l.boardPos;
      const alight = reversed ? n - 1 - l.boardPos : l.alightPos;
      const t = tt.trips[l.trip]!;
      steps.push({
        kind: 'ride',
        trip: l.trip,
        boardIndex: board,
        alightIndex: alight,
        from: tt.stopIndex.get(t.stops[board]!)!,
        to: tt.stopIndex.get(t.stops[alight]!)!,
      });
    } else if (l.kind === 2) {
      steps.push({
        kind: 'walk',
        from: reversed ? l.stop : prev.stop,
        to: reversed ? prev.stop : l.stop,
        walkSec: l.walkSec,
        walkMeters: l.walkMeters,
        walkMethod: l.walkMethod,
      });
    }
  }
  return reversed ? steps.reverse() : steps;
}

function buildJourney(
  tt: Timetable,
  label: Label,
  reversed: boolean,
  policy: TransferPolicy,
  alternativeTo: string[],
): Journey {
  const steps = stepsOf(label, reversed, tt);
  const legs: JourneyLeg[] = [];
  const connections: JourneyConnection[] = [];
  let access: JourneyWalk | null = null;
  let egress: JourneyWalk | null = null;
  let pendingWalk: JourneyWalk | null = null;
  let walkMeters = 0;
  let priceEur = 0;
  let worst: 0 | 1 | 2 | null = null;
  let overnight = 0;

  for (const st of steps) {
    if (st.kind === 'walk') {
      const w: JourneyWalk = {
        fromStopId: tt.stops[st.from]!.id,
        toStopId: tt.stops[st.to]!.id,
        durationSeconds: st.walkSec!,
        distanceMeters: st.walkMeters!,
        method: st.walkMethod as JourneyWalk['method'],
      };
      walkMeters += w.distanceMeters;
      if (legs.length === 0) access = w;
      else pendingWalk = w;
      continue;
    }
    const trip = tt.trips[st.trip!]!;
    const fare = tt.fareFor(st.trip!, st.boardIndex!, st.alightIndex!);
    const leg: JourneyLeg = {
      tripIndex: st.trip!,
      trip,
      boardIndex: st.boardIndex!,
      alightIndex: st.alightIndex!,
      departure: trip.departures[st.boardIndex!]!,
      arrival: trip.arrivals[st.alightIndex!]!,
      price: fare ? { amount: fare.amount, currency: fare.currency, kind: fare.kind } : null,
    };
    priceEur += fare ? tt.toEur(fare.amount, fare.currency) : Number.NaN;
    const prevLeg = legs[legs.length - 1];
    if (prevLeg) {
      const atStop = tt.stops[tt.stopIndex.get(prevLeg.trip.stops[prevLeg.alightIndex]!)!]!;
      const walk = pendingWalk;
      const walkSec = walk?.durationSeconds ?? 0;
      const slack = leg.departure - prevLeg.arrival - walkSec;
      const nextStop = tt.stops[tt.stopIndex.get(trip.stops[leg.boardIndex]!)!]!;
      const stationMin = walk
        ? Math.max(atStop.minTransferSeconds, nextStop.minTransferSeconds)
        : atStop.minTransferSeconds;
      const ctx = {
        slackSeconds: slack,
        walked: walk !== null,
        walkSeconds: walkSec,
        inboundInternational: tt.tripInternational[prevLeg.tripIndex] === 1,
        atNight: localSecondsOfDay(atStop.timezone, prevLeg.arrival) < 5 * 3600,
        stationMinTransferSeconds: stationMin,
      };
      const cls = classifyTransfer(policy, { ...ctx, atNight: walk !== null && ctx.atNight });
      const quality = (cls < 0 ? 2 : cls) as 0 | 1 | 2;
      worst = worst === null ? quality : (Math.max(worst, quality) as 0 | 1 | 2);
      const nightSeconds = nightOverlapSeconds(atStop.timezone, prevLeg.arrival, leg.departure);
      overnight += nightSeconds;
      connections.push({
        atStopId: atStop.id,
        toStopId: nextStop.id,
        arrival: prevLeg.arrival,
        departure: leg.departure,
        walk,
        slackSeconds: slack,
        quality,
        reasons: explainTransfer(policy, ctx),
        nightSeconds,
      });
      pendingWalk = null;
    }
    legs.push(leg);
  }
  if (pendingWalk) egress = pendingWalk;
  const first = legs[0]!;
  const last = legs[legs.length - 1]!;
  const departure = first.departure - (access?.durationSeconds ?? 0);
  const arrival = last.arrival + (egress?.durationSeconds ?? 0);
  return {
    legs,
    connections,
    access,
    egress,
    departure,
    arrival,
    transfers: legs.length - 1,
    walkMeters,
    worstQuality: worst,
    priceEur,
    overnightWaitSeconds: overnight,
    paretoOptimal: true,
    alternativeTo,
    signature: legs
      .map((l) => `${l.trip.operatorId}:${l.trip.stops[l.boardIndex]}@${l.departure}>${l.trip.stops[l.alightIndex]}@${l.arrival}`)
      .join('|'),
  };
}

function dedupe(journeys: Journey[]): Journey[] {
  const bySig = new Map<string, Journey>();
  for (const j of journeys) {
    const cur = bySig.get(j.signature);
    // Prefer the version found without exclusions (the Pareto search).
    if (!cur || (cur.alternativeTo.length > 0 && j.alternativeTo.length === 0)) bySig.set(j.signature, j);
  }
  return [...bySig.values()];
}

/** Journey-level Pareto dominance over the user-facing criteria. */
export function journeyDominates(a: Journey, b: Journey): boolean {
  const qa = a.worstQuality ?? -1;
  const qb = b.worstQuality ?? -1;
  const pa = a.priceEur;
  const pb = b.priceEur;
  const priceLE = Number.isNaN(pa) || Number.isNaN(pb) ? Number.isNaN(pa) && Number.isNaN(pb) : pa <= pb;
  if (a.arrival > b.arrival || a.departure < b.departure || a.transfers > b.transfers) return false;
  if (a.walkMeters > b.walkMeters || qa > qb || !priceLE) return false;
  return (
    a.arrival < b.arrival ||
    a.departure > b.departure ||
    a.transfers < b.transfers ||
    a.walkMeters < b.walkMeters ||
    qa < qb ||
    (!Number.isNaN(pa) && !Number.isNaN(pb) && pa < pb)
  );
}

function markPareto(journeys: Journey[]): Journey[] {
  return journeys.map((j) => ({
    ...j,
    paretoOptimal: !journeys.some((o) => o !== j && journeyDominates(o, j)),
  }));
}
