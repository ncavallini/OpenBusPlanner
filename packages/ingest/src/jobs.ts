import type { Sql } from '@openbus/db';
import { migrate, seedReferenceData } from '@openbus/db';
import { adapterFor, type HealthResult } from './adapters/index';
import { importGtfs, upsertSource, type ImportResult } from './import-gtfs';
import { loadRegistry, type SourceDefinition } from './registry';

export type Logger = (msg: string, data?: Record<string, unknown>) => void;

export async function recordHealth(sql: Sql, sourceId: string, h: HealthResult): Promise<void> {
  await sql`INSERT INTO source_health (source_id, ok, latency_ms, message) VALUES (${sourceId}, ${h.ok}, ${h.latencyMs}, ${h.message})`;
}

/** Fetches and imports one schedule source. Provider failures are isolated and recorded. */
export async function syncSchedule(
  sql: Sql,
  def: SourceDefinition,
  opts: { force?: boolean; log?: Logger } = {},
): Promise<ImportResult> {
  const adapter = adapterFor(def);
  const log = opts.log ?? (() => {});
  await upsertSource(sql, def);
  if (!adapter.fetchSchedule) throw new Error(`Adapter ${def.adapter} does not provide schedules`);
  const started = Date.now();
  try {
    const ds = await adapter.fetchSchedule(def);
    await recordHealth(sql, def.id, { ok: true, latencyMs: Date.now() - started, message: `Fetched from ${ds.fetchedFrom}` });
    const horizon = def.config.horizon;
    const src = ds.type === 'gtfs' ? { path: ds.path, contentHash: ds.contentHash } : { feed: ds.feed, contentHash: ds.contentHash };
    return await importGtfs(sql, def, src, {
      ...(opts.force ? { force: true } : {}),
      ...(horizon ? { horizon } : {}),
      log,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await recordHealth(sql, def.id, { ok: false, latencyMs: Date.now() - started, message });
    const [r] = await sql<{ id: number }[]>`
      INSERT INTO import_run (source_id, status, finished_at, message) VALUES (${def.id}, 'failed', now(), ${message}) RETURNING id`;
    log('source fetch failed', { source: def.id, error: message });
    return { runId: Number(r!.id), status: 'failed', stats: {}, warnings: [], message };
  }
}

/** Pulls GTFS-RT TripUpdates and stores them against the schedule source's trips. */
export async function syncRealtime(
  sql: Sql,
  def: SourceDefinition,
  log: Logger = () => {},
): Promise<{ stored: number; unmatched: number }> {
  const adapter = adapterFor(def);
  await upsertSource(sql, def);
  const scheduleId = def.config.scheduleSourceId;
  if (!adapter.fetchRealtime || !scheduleId) throw new Error(`${def.id} is not a realtime source`);
  const started = Date.now();
  try {
    const { feedTimestamp, updates } = await adapter.fetchRealtime(def);
    const observedAt = new Date((feedTimestamp ?? Date.now() / 1000) * 1000);
    const ids = updates.map((u) => `${scheduleId}:${u.tripId}`);
    const known = new Set((await sql<{ id: string }[]>`SELECT id FROM trip WHERE id = ANY(${ids})`).map((r) => r.id));
    let stored = 0;
    for (const u of updates) {
      const tripId = `${scheduleId}:${u.tripId}`;
      if (!known.has(tripId) || !u.serviceDate) continue;
      await sql`
        INSERT INTO realtime_update (source_id, trip_id, service_date, canceled, stop_updates, observed_at)
        VALUES (${def.id}, ${tripId}, ${u.serviceDate}, ${u.canceled}, ${sql.json(u.stopTimeUpdates as never)}, ${observedAt})
        ON CONFLICT (trip_id, service_date) DO UPDATE SET canceled = EXCLUDED.canceled,
          stop_updates = EXCLUDED.stop_updates, observed_at = EXCLUDED.observed_at`;
      stored++;
    }
    await sql`DELETE FROM realtime_update WHERE source_id = ${def.id} AND observed_at < now() - interval '6 hours'`;
    await recordHealth(sql, def.id, { ok: true, latencyMs: Date.now() - started, message: `${updates.length} updates, ${stored} matched` });
    log('realtime synced', { source: def.id, updates: updates.length, stored });
    return { stored, unmatched: updates.length - stored };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await recordHealth(sql, def.id, { ok: false, latencyMs: Date.now() - started, message });
    log('realtime failed', { source: def.id, error: message });
    return { stored: 0, unmatched: 0 };
  }
}

/** Migrates, seeds reference data, registers all sources and imports the enabled ones. */
export async function seed(
  sql: Sql,
  opts: { enabled?: string; force?: boolean; log?: Logger } = {},
): Promise<Record<string, ImportResult['status']>> {
  const log = opts.log ?? (() => {});
  await migrate(sql, log);
  await seedReferenceData(sql);
  const registry = loadRegistry({ enabled: opts.enabled });
  for (const def of registry) await upsertSource(sql, def);
  const out: Record<string, ImportResult['status']> = {};
  for (const def of registry) {
    if (!def.enabled || def.kind === 'gtfs-realtime') continue;
    log('importing source', { source: def.id });
    const r = await syncSchedule(sql, def, { log, ...(opts.force ? { force: true } : {}) });
    out[def.id] = r.status;
  }
  for (const def of registry) {
    if (def.enabled && def.kind === 'gtfs-realtime') await syncRealtime(sql, def, log);
  }
  return out;
}
