/**
 * Station entity resolution.
 *
 * Feeds name the same place differently ("Zürich Sihlquai", "Zurich Sihlquai Bus Terminal")
 * and give slightly different coordinates. We match an incoming stop to an existing station
 * using geography first and names second:
 *
 *   1. an existing (source, stop id) mapping is reused — ids stay stable across re-imports;
 *   2. a station within SAME_PLACE_M metres is the same place;
 *   3. a station within NEARBY_M metres with a similar name is the same place;
 *   4. otherwise a new station is created.
 *
 * Two different stops of the *same* feed are never merged (the publisher considers them
 * distinct), and stops are never merged because they share a city name: "Milano Lampugnano"
 * and "Milano San Donato" stay separate stations of the city Milan.
 */
import { haversineMeters, nameSimilarity } from '@openbus/core';

export const SAME_PLACE_M = 40;
export const NEARBY_M = 250;
export const NAME_SIMILARITY_MIN = 0.4;

export interface KnownStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Sources that already map at least one stop onto this station. */
  sources: Set<string>;
}

export interface IncomingStop {
  sourceStopId: string;
  name: string;
  lat: number;
  lon: number;
}

export type MatchMethod = 'existing_mapping' | 'proximity' | 'proximity_name' | 'new';

export interface MatchResult {
  stationId: string | null;
  method: MatchMethod;
  confidence: number;
  distanceMeters: number | null;
}

export class StationIndex {
  private grid = new Map<string, KnownStation[]>();
  private byId = new Map<string, KnownStation>();
  private readonly cell = 0.005; // ~550 m in latitude

  constructor(stations: KnownStation[] = []) {
    for (const s of stations) this.add(s);
  }

  private key(lat: number, lon: number) {
    return `${Math.floor(lat / this.cell)}:${Math.floor(lon / this.cell)}`;
  }

  get(id: string): KnownStation | undefined {
    return this.byId.get(id);
  }

  add(s: KnownStation): void {
    this.byId.set(s.id, s);
    const k = this.key(s.lat, s.lon);
    let l = this.grid.get(k);
    if (!l) this.grid.set(k, (l = []));
    l.push(s);
  }

  near(lat: number, lon: number, radius: number): Array<{ station: KnownStation; distance: number }> {
    const ci = Math.floor(lat / this.cell);
    const cj = Math.floor(lon / this.cell);
    const out: Array<{ station: KnownStation; distance: number }> = [];
    for (let di = -1; di <= 1; di++) {
      for (let dj = -2; dj <= 2; dj++) {
        for (const s of this.grid.get(`${ci + di}:${cj + dj}`) ?? []) {
          const d = haversineMeters({ lat, lon }, s);
          if (d <= radius) out.push({ station: s, distance: d });
        }
      }
    }
    return out.sort((a, b) => a.distance - b.distance);
  }
}

export function matchStop(index: StationIndex, sourceId: string, stop: IncomingStop): MatchResult {
  const candidates = index
    .near(stop.lat, stop.lon, NEARBY_M)
    .filter((c) => !c.station.sources.has(sourceId));
  for (const c of candidates) {
    if (c.distance <= SAME_PLACE_M) {
      const sim = nameSimilarity(stop.name, c.station.name);
      return { stationId: c.station.id, method: 'proximity', confidence: Math.min(1, 0.8 + sim * 0.2), distanceMeters: c.distance };
    }
  }
  let best: { c: (typeof candidates)[number]; sim: number } | null = null;
  for (const c of candidates) {
    const sim = nameSimilarity(stop.name, c.station.name);
    if (sim >= NAME_SIMILARITY_MIN && (!best || sim - c.distance / 1000 > best.sim - best.c.distance / 1000)) best = { c, sim };
  }
  if (best) {
    return {
      stationId: best.c.station.id,
      method: 'proximity_name',
      confidence: Math.round((0.5 + best.sim * 0.4) * 100) / 100,
      distanceMeters: best.c.distance,
    };
  }
  return { stationId: null, method: 'new', confidence: 1, distanceMeters: null };
}

