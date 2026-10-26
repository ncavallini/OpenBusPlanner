/**
 * Router benchmark. Measures timetable build and query latency on
 *   1. generated networks of realistic size (deterministic PRNG), and
 *   2. the real FlixBus EU GTFS feed, when data/downloads/flixbus-eu-gtfs.zip exists.
 * Results (with hardware and dataset description) are written to docs/benchmarks/.
 *
 *   pnpm bench                      # all scenarios
 *   pnpm bench -- --queries=100     # fewer queries
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { haversineMeters, localTimeToEpoch } from '@openbus/core';
import { Timetable } from '@openbus/router';
import { searchJourneys } from '@openbus/router';
import type { RouterRequest, RouterStop, RouterTrip, TimetableInput } from '@openbus/router';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const arg = (name: string, def: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def);
const QUERIES = arg('queries', 200);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GenSpec {
  name: string;
  cities: number;
  stationsPerCity: number;
  lines: number;
  tripsPerLinePerDay: [number, number];
  days: number;
}

/** Generates a coach network over Europe: cities with 1–N stations, lines visiting 3–12 cities. */
function generate(spec: GenSpec, seed = 42): { input: TimetableInput; cities: string[][] } {
  const r = rng(seed);
  const stops: RouterStop[] = [];
  const cities: string[][] = [];
  for (let c = 0; c < spec.cities; c++) {
    const lat = 37 + r() * 18;
    const lon = -8 + r() * 32;
    const ids: string[] = [];
    const n = 1 + Math.floor(r() * spec.stationsPerCity);
    for (let k = 0; k < n; k++) {
      const id = `c${c}s${k}`;
      ids.push(id);
      stops.push({ id, name: id, lat: lat + (r() - 0.5) * 0.08, lon: lon + (r() - 0.5) * 0.12, timezone: 'Europe/Berlin', countryCode: `X${Math.floor(lon / 6)}`, cityId: `c${c}`, minTransferSeconds: 0 });
    }
    cities.push(ids);
  }
  const byId = new Map(stops.map((s) => [s.id, s]));
  const trips: RouterTrip[] = [];
  const base = localTimeToEpoch('2026-11-02', '00:00', 'Europe/Berlin');
  for (let l = 0; l < spec.lines; l++) {
    // A line: random walk through nearby cities.
    const len = 3 + Math.floor(r() * 10);
    let cur = Math.floor(r() * spec.cities);
    const seq: string[] = [];
    const used = new Set<number>();
    for (let i = 0; i < len; i++) {
      used.add(cur);
      const ids = cities[cur]!;
      seq.push(ids[Math.floor(r() * ids.length)]!);
      const here = byId.get(seq[seq.length - 1]!)!;
      let best = -1;
      let bestD = Infinity;
      for (let t = 0; t < 12; t++) {
        const cand = Math.floor(r() * spec.cities);
        if (used.has(cand)) continue;
        const d = haversineMeters(here, byId.get(cities[cand]![0]!)!);
        if (d > 80_000 && d < bestD) {
          bestD = d;
          best = cand;
        }
      }
      if (best < 0) break;
      cur = best;
    }
    if (seq.length < 2) continue;
    const perDay = spec.tripsPerLinePerDay[0] + Math.floor(r() * (spec.tripsPerLinePerDay[1] - spec.tripsPerLinePerDay[0] + 1));
    for (let day = 0; day < spec.days; day++) {
      for (let k = 0; k < perDay; k++) {
        let t = base + day * 86400 + Math.floor(r() * 24 * 12) * 300;
        const arrivals: number[] = [];
        const departures: number[] = [];
        for (let i = 0; i < seq.length; i++) {
          if (i > 0) {
            const d = haversineMeters(byId.get(seq[i - 1]!)!, byId.get(seq[i]!)!);
            t += Math.round((d * 1.25) / (70 / 3.6) / 300) * 300; // 70 km/h on roads 25% longer than straight
          }
          arrivals.push(t);
          if (i > 0 && i < seq.length - 1) t += 300;
          departures.push(t);
        }
        trips.push({ id: `L${l}-${day}-${k}`, tripId: `L${l}-${k}`, serviceDate: `d${day}`, operatorId: `op${l % 40}`, routeId: `L${l}`, mode: 'bus', sourceId: 'gen', synthetic: true, stops: seq, arrivals, departures });
      }
    }
  }
  return { input: { stops, trips, footpaths: [] }, cities };
}

function percentile(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

interface ScenarioResult {
  name: string;
  dataset: Record<string, number | string>;
  buildMs: number;
  queries: Record<string, { n: number; p50: number; p90: number; p99: number; max: number; meanResults: number; meanLabels: number; truncated: number }>;
}

function runQueries(tt: Timetable, cities: string[][], windowBase: number, label: string, alternatives: boolean, seed: number) {
  const r = rng(seed);
  const times: number[] = [];
  let results = 0;
  let labels = 0;
  let truncated = 0;
  for (let q = 0; q < QUERIES; q++) {
    let a = 0;
    let b = 0;
    let d = 0;
    for (let tries = 0; tries < 50; tries++) {
      a = Math.floor(r() * cities.length);
      b = Math.floor(r() * cities.length);
      const sa = tt.stop(cities[a]![0]!);
      const sb = tt.stop(cities[b]![0]!);
      if (!sa || !sb || a === b) continue;
      d = haversineMeters(sa, sb);
      if (d > 150_000 && d < 1_600_000) break;
    }
    const arrive = q % 2 === 1;
    const start = windowBase + 86400 + Math.floor(r() * 16) * 3600; // day 2
    const req: RouterRequest = {
      originStopIds: cities[a]!.filter((s) => tt.stopIndex.has(s)),
      destinationStopIds: cities[b]!.filter((s) => tt.stopIndex.has(s)),
      mode: arrive ? 'arrive' : 'depart',
      windowStart: start,
      windowEnd: start + (arrive ? 4 : 8) * 3600,
      maxTransfers: 3,
      minTransferSeconds: 600,
      maxTransferWaitSeconds: 8 * 3600,
      maxDurationSeconds: 30 * 3600,
      maxWalkMeters: 1500,
      riskPreference: 'balanced',
      alternatives,
      timeoutMs: 10_000,
    };
    const t0 = performance.now();
    const res = searchJourneys(tt, req);
    times.push(performance.now() - t0);
    results += res.journeys.length;
    labels += res.stats.labelsCreated;
    if (res.stats.truncated) truncated++;
  }
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    [label]: {
      n: times.length,
      p50: round(percentile(times, 50)),
      p90: round(percentile(times, 90)),
      p99: round(percentile(times, 99)),
      max: round(Math.max(...times)),
      meanResults: round(results / times.length),
      meanLabels: Math.round(labels / times.length),
      truncated,
    },
  };
}

async function realFlixbus(): Promise<{ input: TimetableInput; cities: string[][] } | null> {
  const path = join(ROOT, 'data', 'downloads', 'flixbus-eu-gtfs.zip');
  if (!existsSync(path)) return null;
  const { loadGtfsFeed, gtfsToTimetableInput } = await import('@openbus/gtfs');
  const feed = await loadGtfsFeed({ path });
  const input = gtfsToTimetableInput(feed, { from: '2026-11-02', to: '2026-11-04', sourceId: 'flix', synthetic: false });
  const byCity = new Map<string, string[]>();
  for (const s of input.stops) {
    if (!s.cityId) continue;
    let l = byCity.get(s.cityId);
    if (!l) byCity.set(s.cityId, (l = []));
    l.push(s.id);
  }
  return { input, cities: [...byCity.values()] };
}

const results: ScenarioResult[] = [];
const specs: GenSpec[] = [
  { name: 'generated-medium (FlixBus-EU-like size)', cities: 900, stationsPerCity: 3, lines: 1200, tripsPerLinePerDay: [2, 8], days: 4 },
  { name: 'generated-large (≈5× medium)', cities: 3000, stationsPerCity: 4, lines: 6000, tripsPerLinePerDay: [2, 8], days: 4 },
];
const windowBase = localTimeToEpoch('2026-11-02', '00:00', 'Europe/Berlin');
for (const spec of specs) {
  const { input, cities } = generate(spec);
  const t0 = performance.now();
  const tt = new Timetable(input);
  void tt.reverse;
  const buildMs = Math.round(performance.now() - t0);
  results.push({
    name: spec.name,
    dataset: { stations: input.stops.length, cities: spec.cities, lines: spec.lines, datedTrips: tt.stats.trips, raptorRoutes: tt.stats.routes, days: spec.days },
    buildMs,
    queries: {
      ...runQueries(tt, cities, windowBase, 'pareto (no alternatives)', false, 7),
      ...runQueries(tt, cities, windowBase, 'with corridor alternatives', true, 7),
    },
  });
  console.log(JSON.stringify(results[results.length - 1]));
}
const flix = await realFlixbus();
if (flix) {
  const t0 = performance.now();
  const tt = new Timetable(flix.input);
  void tt.reverse;
  const buildMs = Math.round(performance.now() - t0);
  results.push({
    name: 'real FlixBus EU GTFS (3 service days + 2 days of overnight lead-in)',
    dataset: { stations: flix.input.stops.length, cities: flix.cities.length, datedTrips: tt.stats.trips, raptorRoutes: tt.stats.routes, footpaths: tt.stats.footpaths },
    buildMs,
    queries: {
      ...runQueries(tt, flix.cities, windowBase, 'pareto (no alternatives)', false, 11),
      ...runQueries(tt, flix.cities, windowBase, 'with corridor alternatives', true, 11),
    },
  });
  console.log(JSON.stringify(results[results.length - 1]));
}

const hardware = {
  cpu: cpus()[0]?.model ?? 'unknown',
  logicalCores: cpus().length,
  memoryGb: Math.round(totalmem() / 1e9),
  os: `${platform()} ${release()}`,
  node: process.version,
  singleThreaded: true,
};
const out = { date: new Date().toISOString(), hardware, queriesPerScenario: QUERIES, queryMix: 'random city pairs 150–1600 km apart; 50% departure search (8 h window), 50% arrival search (4 h window); max 3 transfers; 10 min minimum transfer; 8 h max wait', results };
mkdirSync(join(ROOT, 'docs', 'benchmarks'), { recursive: true });
const file = join(ROOT, 'docs', 'benchmarks', `results-${out.date.slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\nwritten ${file}`);
console.log(JSON.stringify(hardware));
