import { classifyTransfer, localSecondsOfDay, localTimeToEpoch, type TransferPolicy } from '@openbus/core';
import { Timetable } from '../src/timetable';
import type { RouterFootpath, RouterRequest, RouterStop, RouterTrip, SegmentFare } from '../src/types';

export const TZ = 'Europe/Zurich';

/** Epoch seconds for local wall time on a date ("2026-11-07", "20:30"). "+1 02:00" adds a day. */
export function at(date: string, hhmm: string, tz = TZ): number {
  const m = /^\+(\d+)\s+(\d\d:\d\d)$/.exec(hhmm);
  if (m) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + Number(m[1]));
    return localTimeToEpoch(d.toISOString().slice(0, 10), m[2]!, tz);
  }
  return localTimeToEpoch(date, hhmm, tz);
}

export class NetBuilder {
  stops: RouterStop[] = [];
  trips: RouterTrip[] = [];
  footpaths: RouterFootpath[] = [];
  constructor(public date: string) {}

  stop(
    id: string,
    o: Partial<Omit<RouterStop, 'id'>> & { lat: number; lon: number },
  ): this {
    this.stops.push({
      id,
      name: o.name ?? id,
      lat: o.lat,
      lon: o.lon,
      timezone: o.timezone ?? TZ,
      countryCode: o.countryCode ?? 'CH',
      cityId: o.cityId ?? id,
      minTransferSeconds: o.minTransferSeconds ?? 0,
    });
    return this;
  }

  /** stops: [stopId, arrival, departure?] with times like "20:00" or "+1 02:10". */
  trip(
    id: string,
    operatorId: string,
    calls: Array<[string, string, string?]>,
    o: { mode?: RouterTrip['mode']; fares?: SegmentFare[]; pickup?: boolean[]; dropoff?: boolean[]; sourceId?: string; date?: string } = {},
  ): this {
    const date = o.date ?? this.date;
    this.trips.push({
      id: `${id}@${date}`,
      tripId: id,
      serviceDate: date,
      operatorId,
      routeId: `${operatorId}-${id}`,
      mode: o.mode ?? 'bus',
      sourceId: o.sourceId ?? 'test',
      synthetic: true,
      stops: calls.map((c) => c[0]),
      arrivals: calls.map((c) => at(date, c[1])),
      departures: calls.map((c) => at(date, c[2] ?? c[1])),
      ...(o.fares ? { fares: o.fares } : {}),
      ...(o.pickup ? { pickup: o.pickup } : {}),
      ...(o.dropoff ? { dropoff: o.dropoff } : {}),
    });
    return this;
  }

  walk(from: string, to: string, seconds: number, meters: number, both = true): this {
    this.footpaths.push({ from, to, durationSeconds: seconds, distanceMeters: meters, method: 'estimated' });
    if (both) this.footpaths.push({ from: to, to: from, durationSeconds: seconds, distanceMeters: meters, method: 'estimated' });
    return this;
  }

  build(fxToEur?: Record<string, number>): Timetable {
    return new Timetable({ stops: this.stops, trips: this.trips, footpaths: this.footpaths, ...(fxToEur ? { fxToEur } : {}) });
  }
}

export const defaultRequest = (o: Partial<RouterRequest> & Pick<RouterRequest, 'originStopIds' | 'destinationStopIds' | 'windowStart' | 'windowEnd'>): RouterRequest => ({
  mode: 'depart',
  maxTransfers: 3,
  minTransferSeconds: 10 * 60,
  maxTransferWaitSeconds: 8 * 3600,
  maxDurationSeconds: 30 * 3600,
  maxWalkMeters: 1500,
  riskPreference: 'balanced',
  alternatives: false,
  ...o,
});

export interface BruteJourney {
  dep: number;
  arr: number;
  legs: number;
  walk: number;
  quality: number;
  price: number;
  desc: string;
}

/**
 * Exhaustive reference enumerator: every feasible journey under the same rules as the
 * engine (transfer classification, waits, windows, walking, no transfers at origin or
 * destination stops, no repeated trip). Exponential — only for small random networks.
 */
export function bruteForce(tt: Timetable, req: RouterRequest): BruteJourney[] {
  const policy: TransferPolicy = {
    minTransferSeconds: req.minTransferSeconds,
    maxWaitSeconds: req.maxTransferWaitSeconds,
    riskPreference: req.riskPreference,
  };
  const origins = new Set(req.originStopIds);
  const dests = new Set(req.destinationStopIds);
  const modes = new Set(req.modes ?? ['bus']);
  const earliestDep = req.earliestDeparture ?? req.windowStart - req.maxDurationSeconds;
  const latestArr = req.latestArrival ?? req.windowEnd + req.maxDurationSeconds;
  const out: BruteJourney[] = [];
  const fp = (from: string) =>
    tt.forward.footpaths[tt.stopIndex.get(from)!]!.filter((f) => f.distanceMeters <= req.maxWalkMeters);

  interface State {
    stop: string;
    time: number; // ready time at stop (after walking)
    dep: number;
    legs: number;
    walk: number;
    quality: number;
    price: number;
    lastTrip: number;
    walkedSec: number;
    walkedFrom: string | null;
    desc: string;
  }

  const finish = (s: State, egressSec: number, egressM: number, desc: string) => {
    const arr = s.time + egressSec;
    const dep = s.dep;
    const ok =
      req.mode === 'depart'
        ? dep >= req.windowStart && dep <= req.windowEnd && arr <= latestArr
        : arr >= req.windowStart && arr <= req.windowEnd && dep >= earliestDep;
    if (!ok || arr - dep > req.maxDurationSeconds) return;
    if (!Number.isNaN(s.price) && s.price > (req.maxBudgetEur ?? Infinity)) return;
    out.push({ dep, arr, legs: s.legs, walk: s.walk + egressM, quality: s.quality, price: s.price, desc });
  };

  const expand = (s: State) => {
    if (s.legs >= req.maxTransfers + 1) return;
    tt.trips.forEach((t, ti) => {
      if (!modes.has(t.mode) || ti === s.lastTrip) return;
      if (req.includeOperators?.length && !req.includeOperators.includes(t.operatorId)) return;
      if (req.excludeOperators?.includes(t.operatorId)) return;
      for (let i = 0; i < t.stops.length - 1; i++) {
        if (t.stops[i] !== s.stop || t.pickup?.[i] === false) continue;
        const d = t.departures[i]!;
        let quality = s.quality;
        let depCrit = s.dep;
        if (s.lastTrip < 0) {
          const access = s.walkedSec;
          if (d < s.time) continue;
          depCrit = d - access;
        } else {
          const slack = d - s.time;
          const here = tt.stop(s.stop)!;
          let stationMin = here.minTransferSeconds;
          if (s.walkedFrom) stationMin = Math.max(stationMin, tt.stop(s.walkedFrom)!.minTransferSeconds);
          const inboundStop = s.walkedFrom ? tt.stop(s.walkedFrom)! : here;
          const realInboundArr = s.time - s.walkedSec;
          const cls = classifyTransfer(policy, {
            slackSeconds: slack,
            walked: s.walkedFrom !== null,
            walkSeconds: s.walkedSec,
            inboundInternational: tt.tripInternational[s.lastTrip] === 1,
            atNight: s.walkedFrom !== null && localSecondsOfDay(inboundStop.timezone, realInboundArr) < 5 * 3600,
            stationMinTransferSeconds: stationMin,
          });
          if (cls < 0 || (req.excludeRiskyTransfers && cls > 1)) continue;
          quality = Math.max(quality, cls);
        }
        for (let j = i + 1; j < t.stops.length; j++) {
          if (t.dropoff?.[j] === false) continue;
          const stopJ = t.stops[j]!;
          const fare = tt.fareFor(ti, i, j);
          const price = fare ? s.price + tt.toEur(fare.amount, fare.currency) : Number.NaN;
          const base: State = {
            stop: stopJ,
            time: t.arrivals[j]!,
            dep: depCrit,
            legs: s.legs + 1,
            walk: s.walk,
            quality,
            price,
            lastTrip: ti,
            walkedSec: 0,
            walkedFrom: null,
            desc: `${s.desc} ${t.tripId}(${t.stops[i]}>${stopJ})`,
          };
          if (dests.has(stopJ)) {
            finish(base, 0, 0, base.desc);
            continue; // never transfer at a destination stop
          }
          if (origins.has(stopJ)) continue;
          expand(base);
          for (const f of fp(stopJ)) {
            const to = tt.stops[f.to]!.id;
            if (origins.has(to)) continue;
            if (dests.has(to)) {
              finish(base, f.durationSeconds, f.distanceMeters, `${base.desc} walk>${to}`);
              continue;
            }
            expand({
              ...base,
              stop: to,
              time: base.time + f.durationSeconds,
              walk: base.walk + f.distanceMeters,
              walkedSec: f.durationSeconds,
              walkedFrom: stopJ,
              desc: `${base.desc} walk>${to}`,
            });
          }
        }
      }
    });
  };

  const startTime = req.mode === 'depart' ? req.windowStart : earliestDep;
  for (const o of origins) {
    const s0: State = {
      stop: o,
      time: startTime,
      dep: Infinity,
      legs: 0,
      walk: 0,
      quality: 0,
      price: 0,
      lastTrip: -1,
      walkedSec: 0,
      walkedFrom: null,
      desc: o,
    };
    expand(s0);
    for (const f of fp(o)) {
      const to = tt.stops[f.to]!.id;
      if (dests.has(to) || origins.has(to)) continue;
      expand({ ...s0, stop: to, time: startTime + f.durationSeconds, walk: f.distanceMeters, walkedSec: f.durationSeconds, desc: `${o} walk>${to}` });
    }
  }
  return out;
}

function priceLE(a: number, b: number) {
  return Number.isNaN(a) || Number.isNaN(b) ? Number.isNaN(a) && Number.isNaN(b) : a <= b;
}

export function paretoVectors(js: BruteJourney[]): string[] {
  const dom = (a: BruteJourney, b: BruteJourney) =>
    a.arr <= b.arr &&
    a.dep >= b.dep &&
    a.legs <= b.legs &&
    a.walk <= b.walk &&
    a.quality <= b.quality &&
    priceLE(a.price, b.price) &&
    (a.arr < b.arr || a.dep > b.dep || a.legs < b.legs || a.walk < b.walk || a.quality < b.quality ||
      (!Number.isNaN(a.price) && !Number.isNaN(b.price) && a.price < b.price));
  const front = js.filter((j) => !js.some((o) => dom(o, j)));
  return [...new Set(front.map(vectorKey))].sort();
}

export function vectorKey(j: { dep: number; arr: number; legs: number; walk: number; quality: number; price: number }): string {
  return `${j.dep}|${j.arr}|${j.legs}|${j.walk}|${j.quality}|${Number.isNaN(j.price) ? 'NaN' : j.price.toFixed(2)}`;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
