import { createHash } from 'node:crypto';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  API_VERSION,
  ApiError,
  DataSourcesResponse,
  Itinerary,
  JourneySearchRequest,
  JourneySearchResponse,
  OperatorsResponse,
  PlaceSearchResponse,
  type DataSourceStatus,
} from '@openbus/core/api';
import { dataSourceStatus, listOperators, searchPlaces, type Sql } from '@openbus/db';
import { adapterFor, loadRegistry, syncRealtime, syncSchedule } from '@openbus/ingest';
import type { ApiConfig } from './config';
import type { ResultCache } from './result-cache';
import { runJourneySearch, SearchError, toPlace } from './search-service';
import { TimetableCache } from './timetable-cache';

export interface ServerDeps {
  sql: Sql;
  config: ApiConfig;
  cache: ResultCache;
  /** Enqueue an ingestion job; falls back to inline execution when no queue is configured. */
  enqueue?: (job: { type: 'schedule' | 'realtime'; sourceId: string; force?: boolean }) => Promise<string>;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { sql, config } = deps;
  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            // Client IPs are never logged (see the web /privacy page); the rate limiter keeps them in memory only.
            redact: { paths: ['req.headers.authorization', 'req.headers["x-internal-token"]', 'req.remoteAddress', 'req.remotePort'], remove: true },
          },
    // Unversioned /api/... paths are aliases of the current version.
    rewriteUrl: (req) => {
      const url = req.url ?? '/';
      return url.startsWith('/api/') && !url.startsWith('/api/v1/') && !url.startsWith('/api/docs') ? `/api/v1/${url.slice(5)}` : url;
    },
    bodyLimit: 64 * 1024,
    requestTimeout: 30_000,
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: config.corsOrigins });
  await app.register(rateLimit, { max: config.rateLimitPerMinute, timeWindow: '1 minute', allowList: (req) => req.url.startsWith('/health') });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'OpenBus Planner API',
        version: API_VERSION,
        description:
          'Operator-independent long-distance bus journey planner. Journeys are computed from dated timetable data; prices are indicative and seat availability is never verified.',
      },
      tags: [
        { name: 'places', description: 'City and station autocomplete' },
        { name: 'journeys', description: 'Multi-operator journey search' },
        { name: 'catalogue', description: 'Operators and data sources' },
        { name: 'internal', description: 'Ingestion and diagnostics (token protected)' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  const timetables = new TimetableCache(sql, config.timetableCacheEntries, config.dataVersionTtlMs);

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; validation?: unknown; code?: string };
    if (err instanceof SearchError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if (e.validation) return reply.status(400).send({ error: { code: 'invalid_request', message: e.message, details: e.validation } });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: { code: e.code ?? 'error', message: e.message } });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  // ---------------------------------------------------------------- health
  app.get('/health', { schema: { hide: true } }, async () => {
    await sql`SELECT 1`;
    return { ok: true, cache: deps.cache.available ? 'redis' : 'none' };
  });

  // ---------------------------------------------------------------- places
  app.get(
    '/api/v1/places/search',
    {
      schema: {
        tags: ['places'],
        summary: 'Autocomplete cities and stations (multilingual aliases)',
        querystring: z.object({ q: z.string().min(1).max(100), limit: z.coerce.number().int().min(1).max(25).default(10) }),
        response: { 200: PlaceSearchResponse, 400: ApiError },
      },
    },
    async (req) => {
      const rows = await searchPlaces(sql, req.query.q, req.query.limit);
      return { apiVersion: API_VERSION, places: rows.map(toPlace) };
    },
  );

  // ---------------------------------------------------------------- journeys
  app.post(
    '/api/v1/journeys/search',
    {
      schema: {
        tags: ['journeys'],
        summary: 'Search multi-operator journeys (departure or arrival based)',
        body: JourneySearchRequest,
        response: { 200: JourneySearchResponse, 400: ApiError, 404: ApiError },
      },
    },
    async (req, reply) => {
      const controller = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) controller.abort();
      });
      const version = await timetables.currentVersion();
      const cacheKey = `search:${version}:${createHash('sha256').update(JSON.stringify(req.body)).digest('hex')}`;
      const cached = await deps.cache.get<z.infer<typeof JourneySearchResponse>>(cacheKey);
      if (cached) return { ...cached, diagnostics: { ...cached.diagnostics, cached: true } };
      const res = await runJourneySearch(
        { sql, timetables, defaultScope: config.defaultDataScope, realDataOnly: config.realDataOnly, timeoutMs: config.searchTimeoutMs },
        req.body,
        { signal: controller.signal },
      );
      await persistSearch(sql, req.body, res).catch((err) => req.log.warn({ err }, 'could not persist search log'));
      if (!res.diagnostics.truncated) await deps.cache.set(cacheKey, res, 300);
      req.log.info({ searchId: res.searchId, outcome: res.outcome, results: res.itineraries.length, ms: res.diagnostics.durationMs }, 'journey search');
      return res;
    },
  );

  app.get(
    '/api/v1/journeys/:id',
    {
      schema: {
        tags: ['journeys'],
        summary: 'Fetch an itinerary returned by a recent search (kept 7 days)',
        params: z.object({ id: z.string().min(3).max(80) }),
        response: { 200: z.object({ apiVersion: z.literal(API_VERSION), searchId: z.string(), itinerary: Itinerary }), 404: ApiError },
      },
    },
    async (req, reply) => {
      const [row] = await sql<{ search_id: string; payload: z.infer<typeof Itinerary> }[]>`
        SELECT search_id, payload FROM itinerary_snapshot WHERE id = ${req.params.id} AND created_at > now() - interval '7 days'`;
      if (!row) return reply.status(404).send({ error: { code: 'not_found', message: 'Itinerary not found or expired' } });
      return { apiVersion: API_VERSION, searchId: row.search_id, itinerary: row.payload };
    },
  );

  // ---------------------------------------------------------------- catalogue
  app.get(
    '/api/v1/operators',
    { schema: { tags: ['catalogue'], summary: 'Operators present in imported data', response: { 200: OperatorsResponse } } },
    async () => {
      const rows = (await listOperators(sql)).filter((o) => !(config.realDataOnly && o.synthetic));
      return {
        apiVersion: API_VERSION,
        operators: rows.map((o) => ({
          id: o.id,
          name: o.name,
          website: o.website,
          countryCode: o.country_code?.trim() ?? null,
          synthetic: o.synthetic,
          sources: o.sources,
        })),
      };
    },
  );

  app.get(
    '/api/v1/data-sources/status',
    {
      schema: {
        tags: ['catalogue'],
        summary: 'Registered timetable sources, adapter status and verified live status',
        response: { 200: DataSourcesResponse },
      },
    },
    async () => ({ apiVersion: API_VERSION, sources: (await sourceStatuses(sql)).filter((s) => !(config.realDataOnly && s.synthetic)) }),
  );

  // ---------------------------------------------------------------- internal
  const internalAuth = async (req: { headers: Record<string, unknown> }, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!config.internalToken) return reply.status(403).send({ error: { code: 'disabled', message: 'Internal API disabled: set INTERNAL_API_TOKEN' } });
    if (req.headers['x-internal-token'] !== config.internalToken) return reply.status(401).send({ error: { code: 'unauthorized', message: 'Invalid token' } });
    return undefined;
  };

  app.post(
    '/internal/v1/sources/:id/:job',
    {
      preHandler: internalAuth,
      schema: {
        tags: ['internal'],
        summary: 'Trigger a schedule import or realtime pull for a source',
        params: z.object({ id: z.string(), job: z.enum(['import', 'realtime']) }),
        querystring: z.object({ force: z.coerce.boolean().default(false) }),
      },
    },
    async (req, reply) => {
      const def = loadRegistry().find((s) => s.id === req.params.id);
      if (!def) return reply.status(404).send({ error: { code: 'not_found', message: 'Unknown source' } });
      const type = req.params.job === 'import' ? 'schedule' : 'realtime';
      if (deps.enqueue) {
        const jobId = await deps.enqueue({ type, sourceId: def.id, force: req.query.force });
        return reply.status(202).send({ queued: true, jobId });
      }
      const result =
        type === 'schedule'
          ? await syncSchedule(sql, { ...def, enabled: true }, { force: req.query.force, log: (m, d) => req.log.info(d, m) })
          : await syncRealtime(sql, { ...def, enabled: true }, (m, d) => req.log.info(d, m));
      timetables.invalidateVersion();
      return { queued: false, result };
    },
  );

  app.get(
    '/internal/v1/diagnostics',
    { preHandler: internalAuth, schema: { tags: ['internal'], summary: 'Timetable cache, counts and recent searches' } },
    async () => {
      const [counts] = await sql`
        SELECT (SELECT count(*)::int FROM station) AS stations, (SELECT count(*)::int FROM trip) AS trips,
               (SELECT count(*)::int FROM trip_stop_time) AS stop_times, (SELECT count(*)::int FROM operator) AS operators,
               (SELECT count(*)::int FROM transfer_edge) AS footpaths, (SELECT count(*)::int FROM realtime_update) AS realtime_updates`;
      const recent = await sql`SELECT id, created_at, outcome, result_count, duration_ms FROM search_log ORDER BY created_at DESC LIMIT 20`;
      const health = await Promise.all(
        loadRegistry()
          .filter((s) => s.enabled)
          .map(async (s) => ({ id: s.id, ...(await adapterFor(s).healthCheck(s)) })),
      );
      return { dataVersion: await timetables.currentVersion(), counts, timetableCache: timetables.stats(), recentSearches: recent, health };
    },
  );

  app.addHook('onClose', async () => {
    await deps.cache.close();
  });
  return app;
}

async function persistSearch(sql: Sql, request: unknown, res: z.infer<typeof JourneySearchResponse>): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO search_log (id, request, outcome, result_count, duration_ms, coverage)
             VALUES (${res.searchId}, ${tx.json(request as never)}, ${res.outcome}, ${res.itineraries.length},
                     ${Math.round(res.diagnostics.durationMs)}, ${tx.json(res.coverage as never)})`;
    for (const it of res.itineraries) {
      await tx`INSERT INTO itinerary_snapshot (id, search_id, payload) VALUES (${it.id}, ${res.searchId}, ${tx.json(it as never)})
               ON CONFLICT (id) DO NOTHING`;
    }
    await tx`DELETE FROM itinerary_snapshot WHERE created_at < now() - interval '7 days'`;
  });
}

async function sourceStatuses(sql: Sql): Promise<DataSourceStatus[]> {
  const rows = await dataSourceStatus(sql);
  const registry = new Map(loadRegistry().map((s) => [s.id, s]));
  return rows.map((r) => {
    const reg = registry.get(r.id);
    const adapterStatus = reg?.adapterStatus ?? 'implemented';
    // "Verified working" requires an actual successful fetch of a *real* source.
    const liveStatus: DataSourceStatus['liveStatus'] = r.synthetic
      ? 'not_applicable'
      : !r.last_success && !r.health_checked
        ? 'never_run'
        : r.run_status === 'failed' || r.health_ok === false
          ? 'failing'
          : r.last_success || r.health_ok
            ? 'verified_working'
            : 'never_run';
    const ageH = r.last_success ? (Date.now() - r.last_success.getTime()) / 3_600_000 : null;
    const refresh = reg?.refreshHours ?? 24;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      synthetic: r.synthetic,
      adapterStatus,
      liveStatus,
      enabled: r.enabled,
      license: r.license,
      lastImport: r.run_started
        ? {
            startedAt: r.run_started.toISOString(),
            finishedAt: r.run_finished?.toISOString() ?? null,
            status: r.run_status as 'running' | 'success' | 'skipped_unchanged' | 'failed',
            message: r.run_message,
            stats: r.run_stats,
            validFrom: r.valid_from,
            validTo: r.valid_to,
          }
        : null,
      health: r.health_checked
        ? { checkedAt: r.health_checked.toISOString(), ok: r.health_ok ?? false, latencyMs: r.health_latency, message: r.health_message }
        : null,
      freshness: r.synthetic || ageH === null ? 'unknown' : ageH <= refresh * 2 ? 'fresh' : ageH <= Math.max(refresh * 7, 168) ? 'aging' : 'stale',
      counts: { stations: r.stations, trips: r.trips, operators: r.operators },
    };
  });
}
