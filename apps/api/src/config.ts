import type { DataScope } from '@openbus/db';

export interface ApiConfig {
  port: number;
  host: string;
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  defaultDataScope: DataScope;
  /** DISABLE_FIXTURES=1: synthetic data is never searched or listed, whatever the request asks. */
  realDataOnly: boolean;
  searchTimeoutMs: number;
  rateLimitPerMinute: number;
  internalToken: string | undefined;
  corsOrigins: string[] | true;
  timetableCacheEntries: number;
  dataVersionTtlMs: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const scope = (env.DEFAULT_DATA_SCOPE ?? 'all') as DataScope;
  const realDataOnly = env.DISABLE_FIXTURES === '1';
  return {
    port: Number(env.PORT ?? 4080),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    defaultDataScope: realDataOnly ? 'real' : ['all', 'real', 'synthetic'].includes(scope) ? scope : 'all',
    realDataOnly,
    searchTimeoutMs: Number(env.SEARCH_TIMEOUT_MS ?? 10_000),
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 120),
    internalToken: env.INTERNAL_API_TOKEN,
    corsOrigins: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map((s) => s.trim()) : true,
    timetableCacheEntries: Number(env.TIMETABLE_CACHE_ENTRIES ?? 6),
    dataVersionTtlMs: Number(env.DATA_VERSION_TTL_MS ?? 5000),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
