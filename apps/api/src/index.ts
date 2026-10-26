import { createSql, migrate } from '@openbus/db';
import { Queue } from 'bullmq';
import { loadConfig } from './config';
import { noCache, redisCache } from './result-cache';
import { buildServer } from './server';

const config = loadConfig();
const sql = createSql(config.databaseUrl, { max: 10 });
await migrate(sql, (m) => console.log(m));

const cache = config.redisUrl ? redisCache(config.redisUrl, (m) => console.warn(m)) : noCache;
let queue: Queue | null = null;
if (config.redisUrl && process.env.USE_JOB_QUEUE !== '0') {
  const u = new URL(config.redisUrl);
  queue = new Queue('ingest', { connection: { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null } });
}

const app = await buildServer({
  sql,
  config,
  cache,
  ...(queue
    ? {
        enqueue: async (job) => {
          const j = await queue!.add(`${job.type}:${job.sourceId}`, job, { removeOnComplete: 100, removeOnFail: 100 });
          return String(j.id);
        },
      }
    : {}),
});

const shutdown = async () => {
  await app.close();
  await queue?.close();
  await sql.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
