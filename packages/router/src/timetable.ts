import { haversineMeters } from '@openbus/core';
import type { RouterFootpath, RouterStop, RouterTrip, TimetableInput } from './types';

/**
 * A RAPTOR route: trips sharing one stop sequence and one pickup/drop-off pattern, ordered
 * so that no trip overtakes another (FIFO). Times are stored row-major per trip.
 */
export interface Route {
  index: number;
  stops: Int32Array;
  nStops: number;
  nTrips: number;
  /** Global trip index for each route-local trip. */
  trips: Int32Array;
  arr: Float64Array;
  dep: Float64Array;
  pickup: Uint8Array;
  dropoff: Uint8Array;
  hasFares: boolean;
}

export interface Footpath {
  to: number;
  durationSeconds: number;
  distanceMeters: number;
  method: RouterFootpath['method'];
}

/** One search direction. The reverse view mirrors time (t -> -t) and stop order. */
export interface DirectedTimetable {
  reversed: boolean;
  routes: Route[];
  /** stopRoutes[s] = flat [route, position, route, position, ...]. */
  stopRoutes: Int32Array[];
  footpaths: Footpath[][];
}

export interface TimetableStats {
  stops: number;
  tripsInput: number;
  trips: number;
  routes: number;
  footpaths: number;
  droppedInvalidTrips: number;
  droppedDuplicateTrips: number;
  maxObservedSpeed: number;
}

export class Timetable {
  readonly stops: RouterStop[];
  readonly stopIndex = new Map<string, number>();
  readonly trips: RouterTrip[];
  readonly tripInternational: Uint8Array;
  /** Other sources that contained a trip equivalent to trips[i] (deduplicated away). */
  readonly tripAlsoIn: string[][];
  readonly forward: DirectedTimetable;
  private reverseView: DirectedTimetable | undefined;
  readonly fxToEur: Record<string, number>;
  readonly stats: TimetableStats;
  /** Upper bound on any scheduled hop speed (m/s) — makes the geographic lower bound admissible. */
  readonly maxSpeed: number;
  private readonly rawFootpaths: RouterFootpath[];
  /** Fare lookup per global trip: key fromIndex * 4096 + toIndex (real positions). */
  readonly fares: Array<Map<number, { amount: number; currency: string; kind: 'indicative' | 'live' }> | null>;

  constructor(input: TimetableInput) {
    this.stops = input.stops;
    input.stops.forEach((s, i) => this.stopIndex.set(s.id, i));
    this.fxToEur = { EUR: 1, ...(input.fxToEur ?? {}) };
    const { trips, invalid, duplicates, alsoIn } = cleanTrips(input, this.stopIndex);
    this.trips = trips;
    this.tripAlsoIn = alsoIn;
    this.tripInternational = new Uint8Array(trips.length);
    this.fares = trips.map((t) => {
      if (!t.fares?.length) return null;
      const m = new Map<number, { amount: number; currency: string; kind: 'indicative' | 'live' }>();
      for (const f of t.fares) m.set(f.fromIndex * 4096 + f.toIndex, f);
      return m;
    });
    let maxSpeed = 0;
    trips.forEach((t, ti) => {
      const countries = new Set<string>();
      for (let i = 0; i < t.stops.length; i++) {
        const s = this.stops[this.stopIndex.get(t.stops[i]!)!]!;
        if (s.countryCode) countries.add(s.countryCode);
        if (i > 0) {
          const prev = this.stops[this.stopIndex.get(t.stops[i - 1]!)!]!;
          const dt = t.arrivals[i]! - t.departures[i - 1]!;
          const d = haversineMeters(prev, s);
          if (d > 0) maxSpeed = Math.max(maxSpeed, dt > 0 ? d / dt : Infinity);
        }
      }
      this.tripInternational[ti] = countries.size > 1 ? 1 : 0;
    });
    this.rawFootpaths = input.footpaths.filter(
      (f) => this.stopIndex.has(f.from) && this.stopIndex.has(f.to) && f.from !== f.to,
    );
    for (const f of this.rawFootpaths) {
      const a = this.stops[this.stopIndex.get(f.from)!]!;
      const b = this.stops[this.stopIndex.get(f.to)!]!;
      const d = haversineMeters(a, b);
      if (d > 0) maxSpeed = Math.max(maxSpeed, f.durationSeconds > 0 ? d / f.durationSeconds : Infinity);
    }
    this.maxSpeed = maxSpeed;
    this.forward = buildDirected(this, false, this.rawFootpaths);
    this.stats = {
      stops: this.stops.length,
      tripsInput: input.trips.length,
      trips: trips.length,
      routes: this.forward.routes.length,
      footpaths: this.rawFootpaths.length,
      droppedInvalidTrips: invalid,
      droppedDuplicateTrips: duplicates,
      maxObservedSpeed: maxSpeed,
    };
  }

  get reverse(): DirectedTimetable {
    if (!this.reverseView) this.reverseView = buildDirected(this, true, this.rawFootpaths);
    return this.reverseView;
  }

  private cityStops: Map<string, number[]> | undefined;

  /** Stop indices grouped under a city id. */
  stopsOfCity(cityId: string): number[] {
    if (!this.cityStops) {
      this.cityStops = new Map();
      this.stops.forEach((s, i) => {
        if (!s.cityId) return;
        let a = this.cityStops!.get(s.cityId);
        if (!a) this.cityStops!.set(s.cityId, (a = []));
        a.push(i);
      });
    }
    return this.cityStops.get(cityId) ?? [];
  }

  stop(id: string): RouterStop | undefined {
    const i = this.stopIndex.get(id);
    return i === undefined ? undefined : this.stops[i];
  }

  /** Canonical EUR value of a fare, NaN if not convertible. */
  toEur(amount: number, currency: string): number {
    const fx = this.fxToEur[currency.toUpperCase()];
    return fx === undefined ? Number.NaN : amount * fx;
  }

  fareFor(tripIndex: number, fromIndex: number, toIndex: number) {
    return this.fares[tripIndex]?.get(fromIndex * 4096 + toIndex) ?? null;
  }
}

function tripKey(t: RouterTrip): string {
  // Equivalent services from different feeds: same operator, same stops, same times.
  return `${t.operatorId}|${t.stops.join(',')}|${t.departures.join(',')}|${t.arrivals.join(',')}`;
}

function cleanTrips(input: TimetableInput, stopIndex: Map<string, number>) {
  const priority = input.sourcePriority ?? {};
  let invalid = 0;
  let duplicates = 0;
  const byKey = new Map<string, number>();
  const trips: RouterTrip[] = [];
  const alsoIn: string[][] = [];
  for (const t of input.trips) {
    if (!isValidTrip(t, stopIndex)) {
      invalid++;
      continue;
    }
    const key = tripKey(t);
    const existing = byKey.get(key);
    if (existing !== undefined) {
      duplicates++;
      const cur = trips[existing]!;
      const better =
        (cur.synthetic && !t.synthetic) ||
        (cur.synthetic === t.synthetic && (priority[t.sourceId] ?? 0) > (priority[cur.sourceId] ?? 0));
      if (better) {
        alsoIn[existing] = [...new Set([...(alsoIn[existing] ?? []), cur.sourceId])].filter((s) => s !== t.sourceId);
        trips[existing] = t;
      } else if (t.sourceId !== cur.sourceId && !alsoIn[existing]!.includes(t.sourceId)) {
        alsoIn[existing]!.push(t.sourceId);
      }
      continue;
    }
    byKey.set(key, trips.length);
    trips.push(t);
    alsoIn.push([]);
  }
  return { trips, invalid, duplicates, alsoIn };
}

function isValidTrip(t: RouterTrip, stopIndex: Map<string, number>): boolean {
  const n = t.stops.length;
  if (n < 2 || t.arrivals.length !== n || t.departures.length !== n) return false;
  for (let i = 0; i < n; i++) {
    if (!stopIndex.has(t.stops[i]!)) return false;
    const a = t.arrivals[i]!;
    const d = t.departures[i]!;
    if (!Number.isFinite(a) || !Number.isFinite(d) || d < a) return false;
    if (i > 0 && a < t.departures[i - 1]!) return false;
  }
  return true;
}

interface DirectedTrip {
  global: number;
  stops: number[];
  arr: number[];
  dep: number[];
  pickup: number[];
  dropoff: number[];
}

function buildDirected(tt: Timetable, reversed: boolean, footpaths: RouterFootpath[]): DirectedTimetable {
  const groups = new Map<string, DirectedTrip[]>();
  tt.trips.forEach((t, gi) => {
    const n = t.stops.length;
    const stops = new Array<number>(n);
    const arr = new Array<number>(n);
    const dep = new Array<number>(n);
    const pickup = new Array<number>(n);
    const dropoff = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const j = reversed ? n - 1 - i : i;
      stops[i] = tt.stopIndex.get(t.stops[j]!)!;
      const p = t.pickup?.[j] === false ? 0 : 1;
      const d = t.dropoff?.[j] === false ? 0 : 1;
      if (reversed) {
        arr[i] = -t.departures[j]!;
        dep[i] = -t.arrivals[j]!;
        pickup[i] = d;
        dropoff[i] = p;
      } else {
        arr[i] = t.arrivals[j]!;
        dep[i] = t.departures[j]!;
        pickup[i] = p;
        dropoff[i] = d;
      }
    }
    const key = `${stops.join(',')}|${pickup.join('')}|${dropoff.join('')}|${tt.fares[gi] ? 'f' : ''}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push({ global: gi, stops, arr, dep, pickup, dropoff });
  });

  const routes: Route[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.dep[0]! - b.dep[0]! || a.arr[a.arr.length - 1]! - b.arr[b.arr.length - 1]!);
    // Split into FIFO sub-routes so that trip order is consistent at every stop.
    const subRoutes: DirectedTrip[][] = [];
    for (const trip of group) {
      const target = subRoutes.find((sr) => {
        const last = sr[sr.length - 1]!;
        for (let i = 0; i < trip.stops.length; i++) {
          if (trip.dep[i]! < last.dep[i]! || trip.arr[i]! < last.arr[i]!) return false;
        }
        return true;
      });
      if (target) target.push(trip);
      else subRoutes.push([trip]);
    }
    for (const sr of subRoutes) routes.push(makeRoute(routes.length, sr, tt));
  }

  const stopRoutesTmp: number[][] = tt.stops.map(() => []);
  for (const r of routes) {
    for (let i = 0; i < r.nStops; i++) stopRoutesTmp[r.stops[i]!]!.push(r.index, i);
  }
  const fp: Footpath[][] = tt.stops.map(() => []);
  for (const f of footpaths) {
    const a = tt.stopIndex.get(f.from)!;
    const b = tt.stopIndex.get(f.to)!;
    const from = reversed ? b : a;
    const to = reversed ? a : b;
    fp[from]!.push({ to, durationSeconds: f.durationSeconds, distanceMeters: f.distanceMeters, method: f.method });
  }
  return {
    reversed,
    routes,
    stopRoutes: stopRoutesTmp.map((x) => Int32Array.from(x)),
    footpaths: fp,
  };
}

function makeRoute(index: number, trips: DirectedTrip[], tt: Timetable): Route {
  const nStops = trips[0]!.stops.length;
  const nTrips = trips.length;
  const arr = new Float64Array(nStops * nTrips);
  const dep = new Float64Array(nStops * nTrips);
  trips.forEach((t, k) => {
    for (let i = 0; i < nStops; i++) {
      arr[k * nStops + i] = t.arr[i]!;
      dep[k * nStops + i] = t.dep[i]!;
    }
  });
  return {
    index,
    stops: Int32Array.from(trips[0]!.stops),
    nStops,
    nTrips,
    trips: Int32Array.from(trips.map((t) => t.global)),
    arr,
    dep,
    pickup: Uint8Array.from(trips[0]!.pickup),
    dropoff: Uint8Array.from(trips[0]!.dropoff),
    hasFares: tt.fares[trips[0]!.global] !== null,
  };
}
