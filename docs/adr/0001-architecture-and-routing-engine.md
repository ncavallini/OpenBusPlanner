# ADR 0001 — Architecture and routing engine

- Status: accepted
- Date: 2026-10-26

## Context

OpenBus Planner must combine dated departures from unrelated long-distance coach operators
(separate tickets, no commercial relationship) and find transfer points algorithmically. It
needs to answer *arrival-window* queries ("arrive in Bolzano on Sunday between 04:00 and 08:00")
correctly, return several Pareto-optimal options rather than one best path, classify connection
risk, and be honest about data coverage.

## Decision 1 — TypeScript monorepo

pnpm workspaces. Shared domain types, a zod API schema, the router, GTFS handling, the database
access and ingestion are packages. Thin apps sit on top (Fastify API, BullMQ worker, Next.js web).
One language end to end keeps the API contract (`@openbus/core/api`) type-checked in both the
server and the client.

## Decision 2 — Custom McRAPTOR instead of OpenTripPlanner 2

Options evaluated:

| Option | Pros | Cons for this product |
|---|---|---|
| **OpenTripPlanner 2** (Java; Range-RAPTOR internally) | Mature; GTFS + NeTEx; OSM street routing | Its transfer model is tuned for urban/regional transit. Separate-ticket risk classes, per-connection explanations, operator-agnostic dedup across feeds and custom Pareto criteria (connection quality, known price) would need a fork. It also adds a JVM service and a full graph rebuild per data change. |
| **Connection Scan (CSA / profile CSA)** | Very simple; fast earliest-arrival | Multi-criteria profiles (bags per stop) make it less attractive; transfer limits need extra dimensions. |
| **Time-dependent Dijkstra** | Flexible | Slower on timetable graphs; Pareto sets are harder. |
| **McRAPTOR** (chosen) | Rounds give the transfer count for free; works on dated trips directly; easy to add criteria; no preprocessing | Bag sizes grow with criteria, so pruning must be bounded. |

We implement multi-criteria RAPTOR (`packages/router`) with these criteria: arrival time, departure
time (making it a range/profile query), number of legs, walking distance, worst connection class
and known price. Pruning is bounded: target pruning, an *admissible* geographic lower bound (the
speed bound is derived from the fastest hop actually present in the data), duration and wait
limits, and a cooperative time budget.

**Arrival search** runs the same engine on a **time-mirrored timetable** (t → −t, reversed stop
order, pickup ↔ drop-off). "Latest departure that still arrives in the window" becomes an ordinary
earliest-arrival problem. It is not approximated by querying departures on the arrival date.
Rules that are not symmetric are always evaluated in real time, and both directions are tested
against an exhaustive enumerator: which leg arrives at a transfer, the local time of day for
night walking, station minimum transfer times.

**Alternatives.** A Pareto front alone may hide good corridors through other cities. After the base
search we exclude the transfer cities already used and search again (up to three iterations).
Results are marked `paretoOptimal: false` with the excluded cities, which surfaces Munich /
Innsbruck / Verona options without hardcoding any city.

OTP2 remains a good future *complement* for local first/last-mile legs (see roadmap).

## Decision 3 — PostgreSQL + PostGIS as system of record; in-memory routing per date window

- Timetables are normalised per source (`trip`, `trip_stop_time` with GTFS service-day offsets,
  calendars materialised into `calendar_active_date`).
- Entity resolution maps feed stops onto shared `station`s using geography first (40 m = same
  place; 250 m + similar name = same place), never on city name alone. Stations are grouped into
  `city`s with a seed gazetteer and multilingual aliases.
- The API loads only the service dates a query needs into a compact RAPTOR structure. It caches
  it in an LRU keyed by (date range, data scope, data version); a new import or realtime update
  changes the version. The whole European network is never rebuilt per query.
- Walking transfers are precomputed with PostGIS (`ST_DWithin`, straight line × 1.35 detour at
  4.5 km/h, labelled *estimated*), optionally refined with an OSRM foot router (labelled
  *pedestrian_router*).

## Decision 4 — Honesty constraints are part of the data model

- `data_source.synthetic` flows into every leg (`provenance.synthetic`) and the UI.
- "Adapter implemented" (`registry.adapterStatus`) is separate from "verified working"
  (derived only from actual import runs and health checks).
- Prices are *indicative* (from feed fares) unless a live source writes `price_observation` rows
  with kind `live`. Totals are shown only when every leg is priced, per currency, never converted
  for display. Availability is always `not_verified` in v1.
- Connection quality is rule-based and explainable (comfortable / reasonable / risky). It never
  claims a success probability.
- Coverage messages are generated from the sources the search actually touched.

## Consequences

- Fast, explainable routing (real FlixBus EU feed, 17.5k dated trips: p50 10 ms, p99 29 ms per
  Pareto query on one core; see `docs/benchmarks`).
- The engine is ~700 lines we own and test (brute-force equivalence tests on 120 random
  networks in both search directions).
- Street-level door-to-door routing is out of scope for v1.
- A known theoretical gap: under a hard *maximum transfer wait*, RAPTOR's "earliest trip
  dominates" assumption can drop an option that only works with a *later* inbound trip on the same
  route. Night-walk rules have the same issue. Both are documented in `docs/limitations.md`.
