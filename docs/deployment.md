# Deployment guide

## Docker Compose (single host)

```bash
cp .env.example .env            # optional: choose sources, ports, tokens
docker compose --profile app up --build -d
open http://localhost:3000      # web; API on :4080, docs at :4080/api/docs
```

Services:

| Service | Image target | Role |
|---|---|---|
| `postgres` | `postgis/postgis:16-3.4` | System of record (volume `pgdata`) |
| `redis` | `redis:7.4-alpine` | BullMQ job queue + search result cache (optional for the API) |
| `worker` | `Dockerfile` target `worker` | Migrates, seeds `ENABLED_SOURCES` on start, schedules refreshes per source (`refreshHours`), polls GTFS-RT (recording coach delay samples), recomputes `delay_stat` every 30 min, runs health checks every 15 min |
| `api` | target `api` | Fastify API on 4080; migrates on start |
| `web` | target `web` | Next.js standalone server on 3000; proxies `/api/*` to `api` |

### Enabling real data

```bash
ENABLED_SOURCES=default,flixbus-eu-gtfs,blablacar-bus-gtfs,flixbus-eu-gtfs-rt docker compose --profile app up -d
# or import once by hand (also works outside Docker):
pnpm ingest import flixbus-eu-gtfs
```

Before enabling a source, read its licence and attribution in `docs/data-sources.md`. ÖBB data
requires accepting their terms; the Open Data Hub API requires an agreement for production use.

To run without any synthetic data in production (public demo), set `DISABLE_FIXTURES=1`. The
worker then skips the fixtures, and the API searches only real sources whatever `dataScope` a
request asks for, and leaves synthetic operators and sources out of `/operators` and `/sources`.
On a database that already contains fixtures, start from an empty volume so autocomplete does
not suggest fixture stations.

## Configuration

| Variable | Default | Used by |
|---|---|---|
| `DATABASE_URL` | `postgres://openbus:openbus@localhost:55432/openbus` | api, worker, CLI |
| `REDIS_URL` | — (API runs without cache/queue) | api, worker |
| `ENABLED_SOURCES` | `default` | worker / CLI seed |
| `DISABLE_FIXTURES` | — | registry, api (forces scope `real`) |
| `DEFAULT_DATA_SCOPE` | `all` | api |
| `SEARCH_TIMEOUT_MS` | `10000` | api (routing time budget) |
| `RATE_LIMIT_PER_MINUTE` | `120` | api |
| `INTERNAL_API_TOKEN` | — (internal API disabled) | api |
| `CORS_ORIGINS` | any | api |
| `TIMETABLE_CACHE_ENTRIES` | `6` | api (LRU of date windows) |
| `DATA_VERSION_TTL_MS` | `5000` | api |
| `FX_RATES_TO_EUR` | — | api (price comparison only) |
| `PEDESTRIAN_ROUTER_URL` | — | worker (OSRM foot profile for walking transfers) |
| `WALK_RADIUS_METERS` | `1000` | worker |
| `REALTIME_INTERVAL_SECONDS` | `60` | worker |
| `API_URL` | `http://127.0.0.1:4080` | web (server side and build-time rewrite) |
| `NEXT_PUBLIC_MAP_STYLE_URL` | OpenFreeMap "liberty" | web |

## Operations

- **Health**: `GET /health` on the API. Per-source state: `/api/v1/data-sources/status` and `/sources`.
- **Logs**: structured JSON (pino in the API, JSON lines in the worker).
- **Manual import / diagnostics**: `POST /internal/v1/sources/{id}/import` and `GET /internal/v1/diagnostics`, with header `x-internal-token`.
- **Failure isolation**: a failing source records a failed `import_run` and health entry. The previous import stays in service and is reported as such in search coverage.
- **Scaling**: the API is stateless apart from its in-memory timetable cache. Run several replicas behind a load balancer; each warms its own cache. Imports should run in a single worker (`concurrency: 1`).
- **Backups**: `pg_dump` the database. All imported data can be rebuilt from the registry.

## Security notes

- Request validation everywhere (zod), body limit 64 KB, rate limiting, CORS allow-list,
  `X-Frame-Options: DENY`, `nosniff`, a referrer policy, and secrets redacted from logs.
- The internal API is off unless a token is configured.
- External booking links open with `rel="noopener noreferrer nofollow"`.
