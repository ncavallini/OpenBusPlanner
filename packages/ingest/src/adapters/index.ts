/**
 * Provider adapters. Every data source goes through the same interface; the adapter only
 * decides how to *obtain* a dataset. Parsing, validation, entity resolution and routing are
 * shared. "Implemented" means the code handles the documented format; whether a source is a
 * *verified, working live source* is decided only by an actual successful run (import_run).
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GtfsFeed, TripUpdate } from '@openbus/gtfs';
import { decodeTripUpdates } from '@openbus/gtfs';
import { manualToGtfsFeed } from '../manual-json';
import { resolveRepoPath, type SourceDefinition } from '../registry';

export type ScheduleDataset =
  | { type: 'gtfs'; path: string; contentHash: string; fetchedFrom: string }
  | { type: 'feed'; feed: GtfsFeed; contentHash: string; fetchedFrom: string };

export interface HealthResult {
  ok: boolean;
  latencyMs: number | null;
  message: string;
}

export interface ProviderAdapter {
  readonly id: SourceDefinition['adapter'];
  readonly capabilities: { schedule: boolean; realtime: boolean; prices: boolean; availability: boolean; deepLinks: boolean };
  healthCheck(source: SourceDefinition): Promise<HealthResult>;
  fetchSchedule?(source: SourceDefinition, opts?: { signal?: AbortSignal }): Promise<ScheduleDataset>;
  fetchRealtime?(source: SourceDefinition, opts?: { signal?: AbortSignal }): Promise<{ feedTimestamp: number | null; updates: TripUpdate[] }>;
}

export class AdapterUnavailableError extends Error {}

const DOWNLOAD_DIR = () => resolveRepoPath(process.env.DOWNLOAD_DIR ?? 'data/downloads');
const USER_AGENT = 'OpenBusPlanner/0.1 (+https://github.com/; timetable importer)';

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

function hashDirectory(path: string): string {
  const h = createHash('sha256');
  for (const f of readdirSync(path).sort()) {
    const p = join(path, f);
    if (statSync(p).isFile()) h.update(f).update(readFileSync(p));
  }
  return h.digest('hex');
}

const gtfsFile: ProviderAdapter = {
  id: 'gtfs-file',
  capabilities: { schedule: true, realtime: false, prices: false, availability: false, deepLinks: false },
  async healthCheck(source) {
    const p = resolveRepoPath(source.config.path ?? '');
    return existsSync(p) ? { ok: true, latencyMs: 0, message: 'Local dataset present' } : { ok: false, latencyMs: null, message: `Missing ${p}` };
  },
  async fetchSchedule(source) {
    const p = resolveRepoPath(source.config.path ?? '');
    if (!existsSync(p)) throw new AdapterUnavailableError(`Dataset not found: ${p}`);
    const hash = statSync(p).isDirectory() ? hashDirectory(p) : await hashFile(p);
    return { type: 'gtfs', path: p, contentHash: hash, fetchedFrom: p };
  },
};

/** HTTP download with conditional requests (ETag / Last-Modified) and atomic file replace. */
const gtfsUrl: ProviderAdapter = {
  id: 'gtfs-url',
  capabilities: { schedule: true, realtime: false, prices: false, availability: false, deepLinks: false },
  async healthCheck(source) {
    const started = Date.now();
    try {
      const res = await fetch(source.config.url!, {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT, ...(source.config.headers ?? {}) },
        signal: AbortSignal.timeout(15_000),
      });
      return { ok: res.ok, latencyMs: Date.now() - started, message: `HTTP ${res.status}${res.headers.get('last-modified') ? `, last modified ${res.headers.get('last-modified')}` : ''}` };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, message: e instanceof Error ? e.message : String(e) };
    }
  },
  async fetchSchedule(source, opts) {
    const url = source.config.url;
    if (!url) throw new AdapterUnavailableError('No URL configured');
    const dir = DOWNLOAD_DIR();
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${source.id}.zip`);
    const metaPath = `${target}.meta.json`;
    const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, 'utf8')) as { etag?: string; lastModified?: string }) : {};
    const headers: Record<string, string> = { 'user-agent': USER_AGENT, ...(source.config.headers ?? {}) };
    if (existsSync(target)) {
      if (meta.etag) headers['if-none-match'] = meta.etag;
      if (meta.lastModified) headers['if-modified-since'] = meta.lastModified;
    }
    const res = await fetch(url, { redirect: 'follow', headers, signal: opts?.signal ?? AbortSignal.timeout(15 * 60_000) });
    if (res.status === 304 && existsSync(target)) {
      return { type: 'gtfs', path: target, contentHash: await hashFile(target), fetchedFrom: url };
    }
    if (!res.ok || !res.body) throw new AdapterUnavailableError(`Download failed: HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/html')) throw new AdapterUnavailableError('Server returned an HTML page instead of a GTFS zip (login or consent page?)');
    const tmp = `${target}.part`;
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    const head = readFileSync(tmp).subarray(0, 2).toString('latin1');
    if (head !== 'PK') throw new AdapterUnavailableError('Downloaded file is not a zip archive');
    renameSync(tmp, target);
    writeFileSync(metaPath, JSON.stringify({ etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), fetchedAt: new Date().toISOString(), url }));
    return { type: 'gtfs', path: target, contentHash: await hashFile(target), fetchedFrom: url };
  },
};

const manualJson: ProviderAdapter = {
  id: 'manual-json',
  capabilities: { schedule: true, realtime: false, prices: true, availability: false, deepLinks: false },
  async healthCheck(source) {
    return gtfsFile.healthCheck(source);
  },
  async fetchSchedule(source) {
    const p = resolveRepoPath(source.config.path ?? '');
    const text = readFileSync(p, 'utf8');
    const json = JSON.parse(text) as { synthetic?: boolean };
    if (json.synthetic !== source.synthetic) throw new Error(`Synthetic flag of ${p} does not match the registry entry`);
    return { type: 'feed', feed: manualToGtfsFeed(json), contentHash: createHash('sha256').update(text).digest('hex'), fetchedFrom: p };
  },
};

const gtfsRtUrl: ProviderAdapter = {
  id: 'gtfs-rt-url',
  capabilities: { schedule: false, realtime: true, prices: false, availability: false, deepLinks: false },
  async healthCheck(source) {
    const started = Date.now();
    try {
      const r = await this.fetchRealtime!(source);
      return { ok: true, latencyMs: Date.now() - started, message: `${r.updates.length} trip updates` };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, message: e instanceof Error ? e.message : String(e) };
    }
  },
  async fetchRealtime(source, opts) {
    const res = await fetch(source.config.url!, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/x-protobuf', ...(source.config.headers ?? {}) },
      signal: opts?.signal ?? AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new AdapterUnavailableError(`HTTP ${res.status}`);
    return decodeTripUpdates(new Uint8Array(await res.arrayBuffer()));
  },
};

const netex: ProviderAdapter = {
  id: 'netex',
  capabilities: { schedule: true, realtime: false, prices: false, availability: false, deepLinks: false },
  async healthCheck() {
    return { ok: false, latencyMs: null, message: 'NeTEx parsing is not implemented in this version' };
  },
  async fetchSchedule() {
    throw new AdapterUnavailableError('NeTEx parsing is not implemented in this version');
  },
};

/**
 * For operators without any accessible timetable data. Health always reports "not
 * integrated"; for development it can import a synthetic stand-in fixture, which the
 * registry marks synthetic so it can never be shown as real.
 */
const unavailable: ProviderAdapter = {
  id: 'unavailable',
  capabilities: { schedule: false, realtime: false, prices: false, availability: false, deepLinks: false },
  async healthCheck() {
    return { ok: false, latencyMs: null, message: 'No accessible timetable source; only a synthetic stand-in is available' };
  },
  async fetchSchedule(source) {
    if (!source.synthetic || !source.config.fixture) throw new AdapterUnavailableError('No accessible timetable source');
    return manualJson.fetchSchedule!({ ...source, config: { ...source.config, path: source.config.fixture } });
  },
};

export const ADAPTERS: Record<SourceDefinition['adapter'], ProviderAdapter> = {
  'gtfs-file': gtfsFile,
  'gtfs-url': gtfsUrl,
  'manual-json': manualJson,
  'gtfs-rt-url': gtfsRtUrl,
  netex,
  unavailable,
};

export function adapterFor(source: SourceDefinition): ProviderAdapter {
  return ADAPTERS[source.adapter];
}
