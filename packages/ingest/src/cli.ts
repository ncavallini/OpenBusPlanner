/**
 * Ingestion CLI.
 *   seed [--sources=a,b|default|all] [--force]   migrate + reference data + import enabled sources
 *   import <sourceId> [--force]                   import one schedule source
 *   realtime <sourceId>                           pull GTFS-RT once
 *   delay-stats                                   recompute p50/p90 delay stats from collected samples
 *   health                                        health-check every registered source
 *   list                                          print the registry
 */
import { createSql } from '@openbus/db';
import { adapterFor } from './adapters/index';
import { refreshDelayStats } from './delay-history';
import { recordHealth, seed, syncRealtime, syncSchedule } from './jobs';
import { loadRegistry } from './registry';

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Map(
  rest
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k!, v ?? 'true'] as const;
    }),
);
const args = rest.filter((a) => !a.startsWith('--'));
const log = (msg: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...data }));

function find(id: string | undefined) {
  const def = loadRegistry({ enabled: 'all' }).find((s) => s.id === id);
  if (!def) throw new Error(`Unknown source ${id}`);
  return { ...def, enabled: true };
}

const sql = createSql(undefined, { max: 4 });
try {
  switch (cmd) {
    case 'seed': {
      const sources = flags.get('sources');
      const res = await seed(sql, { log, force: flags.has('force'), ...(sources ? { enabled: sources } : {}) });
      console.table(res);
      if (Object.values(res).includes('failed')) process.exitCode = 1;
      break;
    }
    case 'import': {
      const res = await syncSchedule(sql, find(args[0]), { log, force: flags.has('force') });
      console.log(JSON.stringify(res, null, 2));
      if (res.status === 'failed') process.exitCode = 1;
      break;
    }
    case 'realtime': {
      console.log(await syncRealtime(sql, find(args[0]), log));
      break;
    }
    case 'delay-stats': {
      console.log(await refreshDelayStats(sql));
      break;
    }
    case 'health': {
      for (const def of loadRegistry()) {
        const h = await adapterFor(def).healthCheck(def);
        await recordHealth(sql, def.id, h).catch(() => {});
        console.log(`${h.ok ? 'OK  ' : 'FAIL'} ${def.id.padEnd(28)} ${h.message}`);
      }
      break;
    }
    case 'list': {
      for (const s of loadRegistry()) {
        console.log(
          `${s.enabled ? '[on] ' : '[off]'} ${s.id.padEnd(28)} ${s.adapter.padEnd(12)} ${s.adapterStatus.padEnd(15)} ${s.synthetic ? 'SYNTHETIC' : ''}`,
        );
      }
      break;
    }
    default:
      console.log('Usage: cli <seed|import|realtime|delay-stats|health|list> [...]');
      process.exitCode = 1;
  }
} finally {
  await sql.end();
}
