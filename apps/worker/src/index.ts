/**
 * Background worker: timetable ingestion, scheduled refreshes, realtime polling and source
 * health checks. Jobs run one at a time per worker so imports never compete for the DB.
 * A failing provider only fails its own job (failure isolation); the API keeps serving the
 * last successful import.
 */
import { createSql, migrate } from '@openbus/db';
import { adapterFor, loadRegistry, recordHealth, seed, syncRealtime, syncSchedule } from '@openbus/ingest';
import { Queue, Worker } from 'bullmq';

const log = (msg: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level: 'info', service: 'worker', msg, ...data }));

const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:56379');
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), maxRetriesPerRequest: null };
const sql = createSql(undefined, { max: 4 });
await migrate(sql, log);

if (process.env.SEED_ON_START !== '0') {
  log('seeding enabled sources', { enabled: process.env.ENABLED_SOURCES ?? 'default' });
  const res = await seed(sql, { log });
  log('seed finished', res);
}

type Job = { type: 'schedule' | 'realtime' | 'health'; sourceId?: string; force?: boolean };
const queue = new Queue<Job>('ingest', { connection });

// Repeatable jobs derived from the registry.
const registry = loadRegistry();
const realtimeEvery = Number(process.env.REALTIME_INTERVAL_SECONDS ?? 60) * 1000;
for (const def of registry.filter((s) => s.enabled)) {
  if (def.kind === 'gtfs-realtime') {
    await queue.upsertJobScheduler(`rt:${def.id}`, { every: realtimeEvery }, { name: `realtime:${def.id}`, data: { type: 'realtime', sourceId: def.id } });
  } else if (def.refreshHours) {
    await queue.upsertJobScheduler(`refresh:${def.id}`, { every: def.refreshHours * 3_600_000 }, { name: `schedule:${def.id}`, data: { type: 'schedule', sourceId: def.id } });
  }
}
await queue.upsertJobScheduler('health', { every: 15 * 60_000 }, { name: 'health', data: { type: 'health' } });

const worker = new Worker<Job>(
  'ingest',
  async (job) => {
    const defs = loadRegistry({ enabled: 'all' });
    if (job.data.type === 'health') {
      for (const def of loadRegistry().filter((s) => s.enabled)) {
        await recordHealth(sql, def.id, await adapterFor(def).healthCheck(def));
      }
      return { ok: true };
    }
    const def = defs.find((s) => s.id === job.data.sourceId);
    if (!def) throw new Error(`Unknown source ${job.data.sourceId}`);
    if (job.data.type === 'schedule') {
      const r = await syncSchedule(sql, { ...def, enabled: true }, { log, ...(job.data.force ? { force: true } : {}) });
      if (r.status === 'failed') throw new Error(r.message ?? 'import failed');
      return r;
    }
    return syncRealtime(sql, { ...def, enabled: true }, log);
  },
  { connection, concurrency: 1 },
);
worker.on('failed', (job, err) => log('job failed', { job: job?.name, error: err.message }));
worker.on('completed', (job) => log('job completed', { job: job.name }));
log('worker ready');

const shutdown = async () => {
  await worker.close();
  await queue.close();
  await sql.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
