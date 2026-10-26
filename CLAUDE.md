# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

The spec (`PROJECT OpenBus Planner — Universal Multi-Operator Long-Distance Bus Journey Planner.md`) is
the source of truth for requirements. v1 is implemented; see `README.md`, `docs/` (architecture, ADR,
database, API, data sources, limitations, roadmap) before larger changes.

## Commands

```bash
pnpm install
pnpm services:up                     # PostGIS :55432, Redis :56379 (docker compose)
pnpm db:seed                         # migrate + reference data + enabled sources (default: fixtures)
pnpm ingest import <sourceId> [--force]   # e.g. flixbus-eu-gtfs, blablacar-bus-gtfs, gtfs-de-fv
pnpm ingest list | health | realtime <id>
pnpm --filter @openbus/api dev       # API :4080 (port 4000 is taken on the dev machine)
pnpm --filter @openbus/web dev       # web :3000, proxies /api/* to API_URL
docker compose --profile app up --build   # full stack

pnpm test                            # unit (vitest project "unit"), no services needed
pnpm test:integration                # needs services; creates/drops database openbus_test
pnpm exec vitest run packages/router/test/raptor.test.ts -t "walking"   # single test
pnpm --filter @openbus/web build && pnpm test:e2e   # Playwright; needs seeded DB + API on :4080
pnpm typecheck && pnpm lint
pnpm bench                           # writes docs/benchmarks/results-<date>.json
pnpm --filter @openbus/api openapi   # regenerate docs/openapi.json
```

Use `127.0.0.1` rather than `localhost` for local HTTP checks (IPv6 resolution issue on this machine).

## Architecture (big picture)

- `packages/core` — GTFS time semantics (`serviceDayReference`: offsets are from noon−12h in the
  **agency** time zone), transfer-quality model, gazetteer, name normalisation, and the **zod API schema**
  (`@openbus/core/api`) shared by API validation/OpenAPI and web types. `@openbus/core/ids` uses
  node:crypto — never import it from web code.
- `packages/router` — McRAPTOR over dated trips with absolute epoch times. `Timetable` builds FIFO
  RAPTOR routes for a forward view and a **time-mirrored reverse view** (arrival searches run the same
  engine mirrored). The engine is a generator (`engineSteps`) driven sync (`searchJourneys`) or async
  (`searchJourneysAsync`, cancellable). Anything direction-dependent must be evaluated in *real*
  time — see `realInbound*` in `raptor.ts`. Changes must keep `packages/router/test/raptor.test.ts`
  (brute-force equivalence, both directions) green.
- `packages/gtfs` — streaming GTFS reader, feed validation/dedup, calendars, zone fares, GTFS-RT,
  and `gtfsToTimetableInput` (DB-free path used by fixture tests and benchmarks).
- `packages/db` — SQL migrations (`migrations/*.sql`), `loadTimetable` (loads only the service dates a
  query window needs → router input + metadata), queries.
- `packages/ingest` — `data/source-registry.json` → adapters → `importGtfs` (entity resolution in
  `entity-resolution.ts`, atomic per-source replacement, footpaths via PostGIS).
- `apps/api` — `search-service.ts` turns router journeys into the API response (provenance, prices,
  booking links, warnings, **coverage generated from execution metadata**); `TimetableCache` is an
  LRU keyed by (dates, scope, data version).
- `apps/worker` — BullMQ: seeding, scheduled refresh, GTFS-RT polling, health checks.
- `apps/web` — Next.js App Router; search state lives in URL params (`scope=synthetic` for
  deterministic demos/tests).

## Invariants (do not violate)

- Never hardcode transfer cities; transfers come from the timetable graph. Route on dated trips only.
- Arrival search uses the mirrored engine — never approximate it with departure queries on the arrival date.
- Never merge distinct stops by city name; entity resolution is geography first (40 m / 250 m + name).
- Synthetic data: `data_source.synthetic` must reach every leg and the UI. Fixtures live in
  `data/fixtures/` and are labelled in names and `feed_info`. Never present them as real.
- Never invent endpoints, licences, prices, availability, benchmark numbers or delay probabilities.
  "Adapter implemented" ≠ "verified working" (only import runs/health checks decide the latter).
- Price totals only when every leg is priced; availability stays `not_verified`; generic operator
  links are labelled as such; separate-ticket warnings on multi-leg itineraries.
- Coverage text must be computed from the sources a search touched (`buildCoverage`).
- Don't add a source with an unknown licence; never circumvent auth, CAPTCHA or rate limits.

## Reference scenario

`data/fixtures/synthetic-zurich-bolzano` (see its README) encodes spec §11; exact expectations are
asserted in `packages/gtfs/test/fixture-scenario.test.ts`, `apps/api/test/api.int.test.ts` and
`apps/web/e2e/search.spec.ts`. Update all three if the fixture changes.
