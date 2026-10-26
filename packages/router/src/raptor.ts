/**
 * Multi-criteria RAPTOR (McRAPTOR) over dated vehicle journeys.
 *
 * Criteria (all Pareto-compared, see `dominates`):
 *   arr      — engine arrival time            (minimise)
 *   dep      — engine departure time          (maximise; makes this a range/profile query)
 *   legs     — vehicle legs = transfers + 1   (minimise; implied by the RAPTOR round)
 *   walk     — metres walked                  (minimise)
 *   quality  — worst transfer class so far    (minimise; 0 comfortable, 1 reasonable, 2 risky)
 *   price    — known price in EUR             (minimise; unknown is only comparable to unknown)
 *
 * The same engine runs forward (departure search) and on a time-mirrored timetable
 * (arrival search): mirroring maps t -> -t and reverses stop order, so "latest departure
 * that still arrives in the window" becomes an ordinary earliest-arrival problem. Every
 * time-dependent rule that is not symmetric (which leg is the *inbound* one, local time
 * of day) is evaluated in real time via `realInbound*` helpers, so both directions return
 * the same Pareto set (asserted by tests).
 */
import { classifyTransfer, localSecondsOfDay, type TransferPolicy } from '@openbus/core';
import type { DirectedTimetable, Route, Timetable } from './timetable';

export interface Label {
  arr: number;
  dep: number;
  legs: number;
  walk: number;
  quality: number;
  price: number;
  stop: number;
  parent: Label | null;
  /** 0 = start, 1 = ride, 2 = walk. */
  kind: 0 | 1 | 2;
  trip: number;
  route: number;
  boardPos: number;
  alightPos: number;
  /** Global index of the last vehicle trip ridden, -1 before boarding. */
  lastTrip: number;
  /** Duration and method of the walk that produced this label (kind 2). */
  walkSec: number;
  walkMeters: number;
  walkMethod: string;
  dead: boolean;
}

interface Ride {
  parent: Label;
  t: number;
  boardPos: number;
  dep: number;
  legs: number;
  walk: number;
  quality: number;
  price: number;
}

export interface EngineQuery {
  sources: number[];
  targets: Set<number>;
  /** First boarding (minus access walk) must lie in [startMin, startMax] (engine time). */
  startMin: number;
  startMax: number;
  /** Maximum engine arrival time at a target. */
  bound: number;
  maxRounds: number;
  policy: TransferPolicy;
  maxWalkMeters: number;
  maxDurationSeconds: number;
  maxQuality: number;
  maxBudgetEur: number;
  tripAllowed: Uint8Array;
  bannedStops: Uint8Array | null;
  /** Lower bound of engine travel time from each stop to the nearest target (seconds). */
  lowerBound: Float64Array | null;
  deadline: number;
  signal?: AbortSignal | undefined;
}

export interface EngineResult {
  targetLabels: Label[];
  rounds: number;
  labelsCreated: number;
  truncated: boolean;
}

const INF = Number.POSITIVE_INFINITY;

function priceLE(a: number, b: number): boolean {
  const an = Number.isNaN(a);
  const bn = Number.isNaN(b);
  if (an || bn) return an && bn;
  return a <= b;
}

function priceLT(a: number, b: number): boolean {
  return !Number.isNaN(a) && !Number.isNaN(b) && a < b;
}

/** a dominates b: no worse in every criterion and better in one (or an equivalent duplicate). */
export function dominates(a: Label, b: Label): boolean {
  if (a.arr > b.arr || a.dep < b.dep || a.legs > b.legs || a.walk > b.walk || a.quality > b.quality) return false;
  if (!priceLE(a.price, b.price)) return false;
  if (a.arr < b.arr || a.dep > b.dep || a.legs < b.legs || a.walk < b.walk || a.quality < b.quality) return true;
  if (priceLT(a.price, b.price)) return true;
  // Identical criteria: duplicates only if they end with the same vehicle trip.
  return a.lastTrip === b.lastTrip;
}

function sameCriteria(a: Label, b: Label): boolean {
  return (
    a.arr === b.arr &&
    a.dep === b.dep &&
    a.legs === b.legs &&
    a.walk === b.walk &&
    a.quality === b.quality &&
    (Number.isNaN(a.price) ? Number.isNaN(b.price) : a.price === b.price)
  );
}

function rideDominates(a: Ride, b: Ride, route: Route): boolean {
  if (route.hasFares && (a.t !== b.t || a.boardPos !== b.boardPos)) return false;
  if (a.t > b.t || a.dep < b.dep || a.legs > b.legs || a.walk > b.walk || a.quality > b.quality) return false;
  if (!priceLE(a.price, b.price)) return false;
  return true;
}

/** Inserts into a Pareto bag; returns false if dominated. Dominated members are killed. */
function insertLabel(bag: Label[], l: Label): boolean {
  for (let i = 0; i < bag.length; i++) if (dominates(bag[i]!, l)) return false;
  let w = 0;
  for (let i = 0; i < bag.length; i++) {
    const x = bag[i]!;
    if (dominates(l, x)) x.dead = true;
    else bag[w++] = x;
  }
  bag.length = w;
  bag.push(l);
  return true;
}

function insertRide(bag: Ride[], r: Ride, route: Route): void {
  for (let i = 0; i < bag.length; i++) if (rideDominates(bag[i]!, r, route)) return;
  let w = 0;
  for (let i = 0; i < bag.length; i++) {
    const x = bag[i]!;
    if (!rideDominates(r, x, route)) bag[w++] = x;
  }
  bag.length = w;
  bag.push(r);
}

/** Yield marker: the engine pauses so an async caller can process I/O (e.g. an abort). */
export const YIELD = Symbol('yield');

export function runEngine(tt: Timetable, view: DirectedTimetable, q: EngineQuery): EngineResult {
  return drainSync(engineSteps(tt, view, q));
}

export function drainSync<T>(gen: Generator<typeof YIELD, T, void>): T {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

export async function drainAsync<T>(gen: Generator<typeof YIELD, T, void>): Promise<T> {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * The engine as a generator: it yields at most every ~20 ms of work so that a caller using
 * drainAsync lets the event loop run (request cancellation, other requests).
 */
export function* engineSteps(tt: Timetable, view: DirectedTimetable, q: EngineQuery): Generator<typeof YIELD, EngineResult, void> {
  let lastYield = Date.now();
  const nStops = tt.stops.length;
  const bags: Label[][] = new Array(nStops);
  for (let i = 0; i < nStops; i++) bags[i] = [];
  const targetBag: Label[] = [];
  const isSource = new Uint8Array(nStops);
  for (const s of q.sources) isSource[s] = 1;
  let labelsCreated = 0;
  let truncated = false;
  let ops = 0;

  const checkBudget = (): boolean => {
    if ((++ops & 1023) === 0) {
      if (Date.now() > q.deadline || q.signal?.aborted) truncated = true;
    }
    return truncated;
  };

  const makeLabel = (
    base: Partial<Label> & Pick<Label, 'arr' | 'dep' | 'legs' | 'walk' | 'quality' | 'price' | 'stop' | 'kind'>,
  ): Label => {
    labelsCreated++;
    return {
      parent: null,
      trip: -1,
      route: -1,
      boardPos: -1,
      alightPos: -1,
      lastTrip: -1,
      walkSec: 0,
      walkMeters: 0,
      walkMethod: '',
      dead: false,
      ...base,
    };
  };

  /** Pruning shared by all new labels. Returns true if the label may be kept. */
  const admissible = (l: Label): boolean => {
    if (l.arr > q.bound) return false;
    if (l.dep !== INF && l.arr - l.dep > q.maxDurationSeconds) return false;
    if (!Number.isNaN(l.price) && l.price > q.maxBudgetEur) return false;
    const isTarget = q.targets.has(l.stop);
    const lb = isTarget || !q.lowerBound ? 0 : q.lowerBound[l.stop]!;
    if (l.arr + lb > q.bound) return false;
    if (l.dep !== INF) {
      if (l.arr + lb - l.dep > q.maxDurationSeconds) return false;
      // Target pruning: criteria only get worse along a journey. An exact tie at a target
      // is kept when it ends with a different vehicle (a distinct, equally good option).
      for (const t of targetBag) {
        if (
          t.arr <= l.arr + lb &&
          t.dep >= l.dep &&
          t.legs <= l.legs &&
          t.walk <= l.walk &&
          t.quality <= l.quality &&
          priceLE(t.price, l.price) &&
          !(isTarget && t.lastTrip !== l.lastTrip && sameCriteria(t, l))
        ) {
          return false;
        }
      }
    }
    return true;
  };

  /** Adds a label at its stop. Returns true if it should be marked for the next round. */
  const place = (l: Label): boolean => {
    if (!admissible(l)) return false;
    if (q.targets.has(l.stop)) {
      if (l.lastTrip >= 0) insertLabel(targetBag, l);
      return false;
    }
    if (l.lastTrip >= 0 && isSource[l.stop]) return false; // never transfer at an origin stop
    if (q.bannedStops && q.bannedStops[l.stop] && l.lastTrip >= 0) return false;
    return insertLabel(bags[l.stop]!, l);
  };

  // ---- Round 0: start labels and access walks.
  let marked: Label[] = [];
  for (const s of q.sources) {
    const l = makeLabel({ arr: q.startMin, dep: INF, legs: 0, walk: 0, quality: 0, price: 0, stop: s, kind: 0 });
    if (insertLabel(bags[s]!, l)) marked.push(l);
  }
  for (const l of [...marked]) {
    for (const f of view.footpaths[l.stop]!) {
      if (f.distanceMeters > q.maxWalkMeters || q.targets.has(f.to)) continue;
      const w = makeLabel({
        arr: l.arr + f.durationSeconds,
        dep: INF,
        legs: 0,
        walk: f.distanceMeters,
        quality: 0,
        price: 0,
        stop: f.to,
        kind: 2,
        parent: l,
        walkSec: f.durationSeconds,
        walkMeters: f.distanceMeters,
        walkMethod: f.method,
      });
      if (place(w)) marked.push(w);
    }
  }

  const policy = q.policy;
  const reversed = view.reversed;
  let round = 0;

  for (round = 1; round <= q.maxRounds && marked.length > 0 && !truncated; round++) {
    // Collect routes through marked stops with their earliest marked position.
    const byStop = new Map<number, Label[]>();
    for (const l of marked) {
      if (l.dead) continue;
      let arr = byStop.get(l.stop);
      if (!arr) byStop.set(l.stop, (arr = []));
      arr.push(l);
    }
    const routeStart = new Map<number, number>();
    const routeLastMarked = new Map<number, number>();
    for (const s of byStop.keys()) {
      const sr = view.stopRoutes[s]!;
      for (let k = 0; k < sr.length; k += 2) {
        const r = sr[k]!;
        const pos = sr[k + 1]!;
        const cur = routeStart.get(r);
        if (cur === undefined || pos < cur) routeStart.set(r, pos);
        const last = routeLastMarked.get(r);
        if (last === undefined || pos > last) routeLastMarked.set(r, pos);
      }
    }

    const newMarked: Label[] = [];
    for (const [ri, startPos] of routeStart) {
      if (checkBudget()) break;
      if ((ops & 63) === 0 && Date.now() - lastYield > 20) {
        yield YIELD;
        lastYield = Date.now();
        if (q.signal?.aborted) truncated = true;
      }
      ops++;
      const route = view.routes[ri]!;
      const ns = route.nStops;
      const lastMarked = routeLastMarked.get(ri)!;
      const rideBag: Ride[] = [];
      for (let i = startPos; i < ns; i++) {
        const stop = route.stops[i]!;
        // (a) Alight riders at this position.
        if (rideBag.length > 0 && route.dropoff[i]) {
          for (const ride of rideBag) {
            const gTrip = route.trips[ride.t]!;
            const arr = route.arr[ride.t * ns + i]!;
            let price = ride.price;
            if (route.hasFares && !Number.isNaN(price)) {
              const n = tt.trips[gTrip]!.stops.length;
              const from = reversed ? n - 1 - i : ride.boardPos;
              const to = reversed ? n - 1 - ride.boardPos : i;
              const f = tt.fareFor(gTrip, from, to);
              price = f ? price + tt.toEur(f.amount, f.currency) : Number.NaN;
            } else if (!route.hasFares) {
              price = Number.NaN;
            }
            const l = makeLabel({
              arr,
              dep: ride.dep,
              legs: ride.legs,
              walk: ride.walk,
              quality: ride.quality,
              price,
              stop,
              kind: 1,
              parent: ride.parent,
              trip: gTrip,
              route: ri,
              boardPos: ride.boardPos,
              alightPos: i,
              lastTrip: gTrip,
            });
            if (place(l)) newMarked.push(l);
          }
        }
        // (b) Board labels from the previous round at this position.
        const waiting = byStop.get(stop);
        if (waiting && route.pickup[i]) {
          for (const L of waiting) {
            if (L.dead) continue;
            boardFrom(L, route, i, rideBag);
          }
        }
        if (rideBag.length === 0 && i >= lastMarked) break;
      }
    }

    // Footpaths from labels that just arrived by vehicle.
    const afterWalk: Label[] = [];
    for (const l of newMarked) {
      if (l.dead || l.kind !== 1) continue;
      for (const f of view.footpaths[l.stop]!) {
        if (f.distanceMeters > q.maxWalkMeters) continue;
        if (q.bannedStops && q.bannedStops[f.to] && !q.targets.has(f.to)) continue;
        const w = makeLabel({
          arr: l.arr + f.durationSeconds,
          dep: l.dep,
          legs: l.legs,
          walk: l.walk + f.distanceMeters,
          quality: l.quality,
          price: l.price,
          stop: f.to,
          kind: 2,
          parent: l,
          lastTrip: l.lastTrip,
          walkSec: f.durationSeconds,
          walkMeters: f.distanceMeters,
          walkMethod: f.method,
        });
        if (place(w)) afterWalk.push(w);
      }
    }
    marked = newMarked.concat(afterWalk).filter((l) => !l.dead);
  }

  return { targetLabels: targetBag, rounds: round - 1, labelsCreated, truncated };

  // ---- helpers (hoisted) ----

  function boardFrom(L: Label, route: Route, i: number, rideBag: Ride[]): void {
    const ns = route.nStops;
    const stop = route.stops[i]!;
    const nT = route.nTrips;
    if (L.lastTrip < 0) {
      // First boarding: every departure in the start window is a distinct profile option.
      const access = L.kind === 2 ? L.walkSec : 0;
      const earliest = Math.max(L.arr, q.startMin + access);
      for (let t = firstDepAtOrAfter(route, i, earliest); t < nT; t++) {
        const d = route.dep[t * ns + i]!;
        if (d - access > q.startMax) break;
        const g = route.trips[t]!;
        if (!q.tripAllowed[g]) continue;
        insertRide(
          rideBag,
          { parent: L, t, boardPos: i, dep: d - access, legs: 1, walk: L.walk, quality: L.quality, price: L.price },
          route,
        );
      }
      return;
    }
    if (L.legs >= q.maxRounds) return;
    const walked = L.kind === 2;
    const stopObj = tt.stops[stop]!;
    let stationMin = stopObj.minTransferSeconds;
    if (walked && L.parent) stationMin = Math.max(stationMin, tt.stops[L.parent.stop]!.minTransferSeconds);
    const floor = Math.max(policy.minTransferSeconds, stationMin);
    let best = 3; // best effective quality boarded so far
    let extraFareOptions = 0;
    for (let t = firstDepAtOrAfter(route, i, L.arr + floor); t < nT; t++) {
      const d = route.dep[t * ns + i]!;
      const slack = d - L.arr;
      if (slack > policy.maxWaitSeconds) break;
      const g = route.trips[t]!;
      if (!q.tripAllowed[g] || g === L.lastTrip) continue;
      // Real-direction facts: which vehicle arrives at the transfer, and when.
      const inboundTrip = reversed ? g : L.lastTrip;
      const realInboundArr = reversed ? -d : L.arr - (walked ? L.walkSec : 0);
      const inboundStop = reversed || !L.parent ? stopObj : tt.stops[L.parent.stop]!;
      const atNight = walked && localSecondsOfDay(inboundStop.timezone, realInboundArr) < 5 * 3600;
      const cls = classifyTransfer(policy, {
        slackSeconds: slack,
        walked,
        walkSeconds: walked ? L.walkSec : 0,
        inboundInternational: tt.tripInternational[inboundTrip] === 1,
        atNight,
        stationMinTransferSeconds: stationMin,
      });
      if (cls < 0 || cls > q.maxQuality) continue;
      const eff = Math.max(L.quality, cls);
      if (eff < best || (route.hasFares && extraFareOptions < 4)) {
        if (eff >= best) extraFareOptions++;
        best = Math.min(best, eff);
        insertRide(
          rideBag,
          { parent: L, t, boardPos: i, dep: L.dep, legs: L.legs + 1, walk: L.walk, quality: eff, price: L.price },
          route,
        );
        if (best <= L.quality && !route.hasFares) break;
      }
    }
  }
}

function firstDepAtOrAfter(route: Route, pos: number, time: number): number {
  let lo = 0;
  let hi = route.nTrips;
  const ns = route.nStops;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (route.dep[mid * ns + pos]! < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
