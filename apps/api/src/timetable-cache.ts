import { dataVersion, loadTimetable, type DataScope, type LoadedTimetable, type Sql } from '@openbus/db';
import { Timetable } from '@openbus/router';

export interface CachedTimetable {
  loaded: LoadedTimetable;
  timetable: Timetable;
  buildMs: number;
  lastUsed: number;
}

/**
 * LRU cache of routing timetables keyed by (date range, scope, data version). Only the
 * service dates a query needs are loaded; concurrent requests for the same key share one
 * load (single flight). A new import or realtime update changes the data version, so stale
 * entries are never served and age out of the LRU.
 */
export class TimetableCache {
  private entries = new Map<string, CachedTimetable>();
  private inflight = new Map<string, Promise<CachedTimetable>>();
  private versionCache: { value: string; at: number } | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly maxEntries = 6,
    /** How long the data version is trusted before re-checking the database. */
    private readonly versionTtlMs = 5000,
  ) {}

  async currentVersion(): Promise<string> {
    const now = Date.now();
    if (this.versionCache && now - this.versionCache.at < this.versionTtlMs) return this.versionCache.value;
    const value = await dataVersion(this.sql);
    this.versionCache = { value, at: now };
    return value;
  }

  invalidateVersion(): void {
    this.versionCache = null;
  }

  async get(fromDate: string, toDate: string, scope: DataScope): Promise<CachedTimetable & { cached: boolean }> {
    const version = await this.currentVersion();
    const key = `${fromDate}|${toDate}|${scope}|${version}`;
    const hit = this.entries.get(key);
    if (hit) {
      hit.lastUsed = Date.now();
      return { ...hit, cached: true };
    }
    let p = this.inflight.get(key);
    if (!p) {
      p = (async () => {
        const started = Date.now();
        const loaded = await loadTimetable(this.sql, { fromDate, toDate, scope });
        const timetable = new Timetable(loaded.input);
        const entry: CachedTimetable = { loaded, timetable, buildMs: Date.now() - started, lastUsed: Date.now() };
        this.entries.set(key, entry);
        this.evict();
        return entry;
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return { ...(await p), cached: false };
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      let oldest: string | null = null;
      let t = Infinity;
      for (const [k, v] of this.entries) {
        if (v.lastUsed < t) {
          t = v.lastUsed;
          oldest = k;
        }
      }
      if (oldest) this.entries.delete(oldest);
    }
  }

  stats() {
    return [...this.entries.entries()].map(([key, e]) => ({
      key,
      trips: e.timetable.stats.trips,
      stops: e.timetable.stats.stops,
      routes: e.timetable.stats.routes,
      duplicatesRemoved: e.timetable.stats.droppedDuplicateTrips,
      invalidTripsDropped: e.timetable.stats.droppedInvalidTrips,
      buildMs: e.buildMs,
      lastUsed: new Date(e.lastUsed).toISOString(),
    }));
  }
}
