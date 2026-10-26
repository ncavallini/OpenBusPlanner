# PROJECT: OpenBus Planner — Universal Multi-Operator Long-Distance Bus Journey Planner

You are Claude Code Opus acting as a principal software architect, senior full-stack engineer, transportation routing specialist, and product designer.

Your task is to DESIGN AND IMPLEMENT a production-oriented web platform that discovers long-distance bus journeys across Europe, including complex itineraries involving multiple independent bus companies, separate tickets, and connections that existing aggregators fail to discover.

**Do not stop at architecture diagrams, documentation, or pseudocode. Build an executable application with a working routing engine, data ingestion pipeline, APIs, frontend, automated tests, and development environment.**

## 1. The core problem

Existing journey aggregators such as Omio, CheckMyBus, Busbud, and Rome2Rio provide incomplete coverage of bus companies and do not reliably discover all possible multi-operator connections.

Example:

A user wants to travel from Zurich, Switzerland to Bolzano, Italy, arriving early Sunday morning.

The optimal route might consist of:

- Bus company A: Zurich → Milan, Saturday evening.
- Bus company B: Milan → Bolzano, Sunday early morning.

These companies may have no commercial relationship and may not sell connecting tickets.

Nevertheless, our platform must discover the combination automatically, validate the timetable connection, and present it as a complete itinerary with two independently bookable tickets.

Other valid possibilities might involve Munich, Innsbruck, or smaller intermediate cities.

The system must NOT depend on predefined transfer cities.

It must discover suitable transfer locations algorithmically.

## 2. Key differentiator

Build a truly operator-independent, schedule-aware journey planner.

The key design principle is:

**Separate journey discovery, timetable routing, ticket availability, and booking.**

The routing engine must be capable of combining journeys from unrelated transport operators, regardless of whether they share ticketing agreements.

Support:

- Direct journeys.
- One transfer.
- Two transfers.
- Three or more transfers, configurable.
- Different operators on consecutive legs.
- Separate tickets.
- Cross-border journeys.
- Overnight journeys.
- Transfers between nearby bus stations.
- Walking transfers between distinct stops.
- Arrivals on the following calendar day.
- Different local time zones.
- Irregular and weekly operating schedules.

A journey must never be discarded simply because the operators are unrelated.

## 3. Technology architecture

Use a TypeScript-first monorepo where practical.

Suggested stack:

Frontend:

- Next.js with App Router.
- React and TypeScript.
- Tailwind CSS.
- shadcn/ui.
- MapLibre GL JS for maps.
- Responsive mobile-first design.

Backend:

- Node.js with TypeScript.
- Fastify or NestJS.
- PostgreSQL with PostGIS.
- Redis for caching and jobs.
- Background workers for timetable ingestion.

Data and routing:

- GTFS Schedule import.
- GTFS Realtime where available.
- NeTEx support through adapters if feasible.
- Normalized internal timetable model.
- Custom time-dependent routing engine.

Development:

- pnpm workspaces.
- Docker Compose.
- Database migrations.
- Seed data.
- OpenAPI documentation.
- Unit and integration tests.
- Playwright end-to-end tests.

You may propose better alternatives if you can justify them.

Evaluate OpenTripPlanner 2 and RAPTOR/CSA implementations before deciding whether to build the routing engine from scratch.

Prefer proven open-source components where suitable, but do not let third-party engines prevent support for independent operator combinations.

Document architectural tradeoffs.

## 4. Data acquisition — critical requirement

A route planner is only as useful as its timetable coverage.

Design a modular data acquisition system supporting:

1. Official operator APIs.
2. Licensed commercial timetable feeds.
3. Public GTFS datasets.
4. GTFS Realtime.
5. NeTEx datasets.
6. Public transport open-data portals.
7. Operator-provided timetable files.
8. CSV/JSON imports.
9. Manually maintained timetable records.
10. Permitted web extraction where legally and technically authorized.

Start with research into data availability for:

- FlixBus.
- RegioJet.
- BlaBlaCar Bus.
- Itabus.
- MarinoBus.
- Autostradale.
- Südtirolmobil.
- Swiss and Austrian cross-border operators.
- Regional bus operators relevant to international connections.

Investigate other European long-distance operators.

For every source, determine:

- Whether a timetable API exists.
- Whether access is public, restricted, or commercial.
- Whether GTFS or NeTEx is available.
- Geographic coverage.
- Licensing and reuse permissions.
- Reliability.
- Refresh frequency.
- Whether ticket prices and live availability can be retrieved.
- Whether booking deep links are supported.

Create a machine-readable source registry and documentation showing these findings.

Never invent API endpoints, access credentials, real-time availability, or licensing permissions.

Do not circumvent authentication, CAPTCHA, rate limits, or access restrictions.

When an integration is unavailable, implement the provider adapter interface and a clearly labeled fixture-based integration for development.

**Distinguish between an implemented adapter and a verified, functioning live data source.**

## 5. Data normalization

Different operators may use different names for the same city or station.

Example:

- Zürich.
- Zurich.
- Zürich HB.
- Zürich Bus Station.
- Bozen.
- Bolzano.
- Bolzano/Bozen.

Implement entity resolution and station normalization.

The database should represent:

- Countries.
- Cities.
- Geographic aliases.
- Stations.
- Station entrances or platforms where available.
- Operators.
- Services.
- Scheduled trip instances.
- Stop sequences.
- Service calendars.
- Timetable exceptions.
- Transfer connections.
- Walking transfer distances.
- Prices and currencies when available.
- Source provenance.
- Data freshness.
- Booking links.
- Real-time updates.
- Data confidence.

Use stable internal identifiers.

Do not merge physically distinct stops simply because they share a city name.

Create transfer edges between nearby stops when walking is feasible.

Use PostGIS for geographic searches.

Where available, calculate pedestrian paths using OpenStreetMap-derived routing rather than relying exclusively on straight-line distance.

## 6. Routing engine — highest priority

Implement a time-dependent multi-operator routing algorithm.

Evaluate algorithms such as:

- Connection Scan Algorithm (CSA).
- RAPTOR and McRAPTOR.
- Time-dependent Dijkstra.
- Multi-criteria label-setting algorithms.

Choose the best approach for realistic European intercity transport networks.

The graph must be based on actual dated vehicle departures and arrivals, not simply city connectivity.

A route such as:

Zurich → Milan → Bolzano

is valid only if:

- Both services operate on the requested dates.
- The first vehicle arrives before the second departs.
- Minimum transfer time is respected.
- Station transfer time is included.
- Time zones are correctly handled.
- The connection meets the user's constraints.

Support journeys crossing midnight, daylight-saving changes, and international borders.

### Search constraints

Support:

- Departure after a specified time.
- Arrival before a specified time.
- Arrival during a specified time window.
- Exact arrival date.
- Earliest arrival.
- Latest departure.
- Maximum number of transfers.
- Minimum transfer time.
- Maximum transfer waiting time.
- Maximum journey duration.
- Walking distance.
- Allow or exclude specific operators.
- Bus-only mode.
- Optional bus + train mode.
- Maximum budget when reliable fares are available.

**Arrival-based search is a first-class feature.**

Example:

Origin: Zurich
Destination: Bolzano
Arrival day: Sunday
Arrival window: 04:00–08:00
Departure may occur Saturday evening.

The search must work backward from the desired arrival window or use an equivalent correct algorithm.

Do not approximate arrival-based routing by querying only the arrival date for departures.

### Multi-criteria optimization

Support ranking by:

1. Arrival time.
2. Total journey duration.
3. Number of transfers.
4. Transfer reliability.
5. Total known ticket price.
6. Walking required.
7. Overnight waiting time.

Implement Pareto-optimal itinerary selection.

Do not collapse distinct viable solutions into a single arbitrary result.

Use carefully designed dominance rules and bounded pruning to balance completeness and performance.

Implement deduplication of equivalent journeys from different data sources.

## 7. Connection reliability

Separate a theoretically valid connection from a practically sensible connection.

For example:

Bus A reaches Milan at 02:10.
Bus B leaves Milan at 02:15.

Even if both stop at the same station, this may be too risky.

Build a transfer feasibility model.

Consider:

- Minimum transfer duration.
- Same-station versus different-station transfers.
- Walking time.
- Nighttime walking.
- Border crossing or traffic uncertainty.
- Historical delay statistics when available.
- Buffer time.
- Individual user risk preferences.

Classify connections as:

- Comfortable.
- Reasonable.
- Risky.

Do not fabricate a numerical probability of success without empirical data.

Clearly warn users when separate-ticket connections are not protected.

## 8. Ticket pricing and booking

The platform should initially be a discovery and referral platform, not a ticket seller.

For each itinerary, display individual legs.

Example:

Leg 1:

- Zurich → Milan.
- Operator A.
- Departure.
- Arrival.
- Price if verified.
- Booking link.

Leg 2:

- Milan → Bolzano.
- Operator B.
- Departure.
- Arrival.
- Price if verified.
- Booking link.

Show the combined total only when all relevant prices are known, and distinguish indicative from live prices.

If ticket availability has not been verified, label it explicitly.

Implement booking links to official operators or authorized partners.

Do not present schedule existence as proof that tickets are available.

Where only generic operator links exist, label them accordingly rather than pretending they lead to a preselected departure.

## 9. User interface

Build a modern interface inspired by the usability of Google Flights, with the simplicity of a dedicated bus search engine.

The homepage should prominently feature:

- Origin autocomplete.
- Destination autocomplete.
- Departure or arrival date.
- Departure/arrival search toggle.
- Time-window selector.
- Maximum transfers.
- Search button.

The central experience must emphasize finding connections that conventional websites overlook.

### Results

Show each journey as a timeline.

For example:

Saturday 20:30 — Zurich
Operator A
Sunday 02:00 — Milan

Transfer: 55 minutes

Sunday 02:55 — Milan
Operator B
Sunday 06:15 — Bolzano

For each journey display:

- Departure date and time.
- Arrival date and time.
- Total duration.
- Companies involved.
- Transfer locations.
- Transfer duration.
- Transfer quality.
- Prices when known.
- Booking links.
- Data source and freshness.
- An explicit separate-ticket warning when relevant.

Implement:

- Result sorting.
- Filters.
- Detailed itinerary expansion.
- Map visualization.
- Operator details.
- Comparison between itineraries.
- Clear empty states.
- Mobile responsiveness.
- Accessible interaction.

Support English first, then we'll add other languages

Use actual calendar dates and explicit +1 day indicators when appropriate.

## 10. Search completeness and transparency

A critical product requirement is explaining what the platform searched.

For each query, internally track:

- Data sources consulted.
- Data sources unavailable.
- Operators represented.
- Date coverage.
- Source freshness.
- Whether live prices were queried.
- Whether availability was verified.

Do not claim that all European buses were searched.

Provide a user-facing coverage indicator.

For example:

"Results based on 14 available timetable sources. Some operators may not be represented."

The count must come from actual search execution metadata, not hardcoded text.

Users should understand the difference between:

- No possible journey found.
- No journey found in the available data.
- Source temporarily unavailable.
- Timetable available but price unknown.

## 11. Concrete test scenario: Zurich → Bolzano

Build an end-to-end demonstration for this case.

Parameters:

- Origin: Zurich, Switzerland.
- Destination: Bolzano/Bozen, Italy.
- Arrival day: Sunday.
- Arrival window: 04:00–08:00.
- Departure allowed from Saturday afternoon onward.
- Mode: long-distance bus.
- Maximum transfers: 3.

The system should discover all feasible combinations within the imported data.

Test via cities such as:

- Milan.
- Munich.
- Innsbruck.
- Other intermediate stations discovered by the graph.

Do not hardcode these cities into routing logic.

Build deterministic synthetic test fixtures containing:

- A direct overnight journey.
- A valid one-transfer journey involving two operators.
- A valid two-transfer journey.
- A missed connection.
- A connection that is too short.
- A transfer between nearby bus stations.
- A journey crossing midnight.
- A service that does not operate on Sunday.
- An itinerary whose two tickets must be purchased separately.

Assert exact expected search results.

Synthetic timetables must be visibly labeled as test fixtures.

Additionally, attempt to import at least one genuine, legally reusable European timetable dataset and demonstrate real routing over that dataset.

Never present fixture-generated journeys as current real-world departures.

## 12. System design and performance

Design for an initial European network and eventual expansion.

Include:

- Efficient timetable indexing.
- Precomputed transfer footpaths.
- Incremental GTFS imports.
- Background refresh jobs.
- Caching.
- Provider failure isolation.
- Search cancellation.
- Query timeouts.
- Source health monitoring.
- Rate limiting.
- Structured logging.
- Basic observability.
- API input validation.
- Security protections.

Avoid loading the complete European transport graph into memory for each query.

Benchmark the search algorithm on realistically sized generated data and document the hardware, dataset size, query mix, and results.

Do not invent benchmark numbers.

## 13. API design

Implement endpoints equivalent to:

GET /api/places/search
POST /api/journeys/search
GET /api/journeys/
GET /api/operators
GET /api/data-sources/status

Create an internal API for timetable ingestion and diagnostics.

The journey search API should accept:

- Origin.
- Destination.
- Date.
- Arrival/departure mode.
- Time window.
- Transport modes.
- Maximum transfers.
- Transfer preferences.

Return structured itinerary data including:

- Legs.
- Transfers.
- Operators.
- Exact timestamps.
- Time zone identifiers.
- Source provenance.
- Pricing metadata.
- Booking links.
- Connection warnings.
- Coverage metadata.

Use a documented, versioned API schema.

## 14. Testing requirements

Implement automated tests for:

- Cross-midnight journeys.
- DST transitions.
- Station aliases.
- Distinct stations in the same city.
- GTFS calendar exceptions.
- Invalid transfer durations.
- Different operators.
- Independent ticketing.
- Reverse arrival searches.
- Multiple transfer paths.
- Duplicate feed records.
- Missing fares.
- Stale data.
- API errors.
- Provider outages.
- Pareto dominance.
- Maximum transfer limits.

Include integration tests with PostgreSQL/PostGIS and realistic fixture imports.

Add browser tests for the search interface.

All principal search and routing functionality must be tested.

## 15. Implementation phases

Execute the work incrementally.

### Phase 1 — Repository and research

Inspect the existing repository.

If empty, initialize the project.

Research appropriate open-source routing libraries and timetable formats.

Produce a brief architecture decision record.

### Phase 2 — Working backend

Implement database schema, migrations, ingestion interfaces, station normalization, and timetable representation.

### Phase 3 — Routing engine

Implement the actual time-dependent routing algorithm and prove correctness with automated tests.

Prioritize this phase over cosmetic UI enhancements.

### Phase 4 — Data ingestion

Import fixture datasets and at least one verified, legally reusable real timetable source if accessible.

Document unavailable providers and blockers.

### Phase 5 — Frontend

Implement the search experience, itinerary comparisons, booking referrals, and interactive map.

### Phase 6 — Validation

Run type checks, linting, tests, builds, and end-to-end checks.

Fix errors.

### Phase 7 — Documentation

Provide:

- README.
- Architecture overview.
- Database design.
- API documentation.
- Data provider documentation.
- Deployment guide.
- Known limitations.
- Roadmap.

## 16. Definition of done

The first version is complete only when:

- Docker Compose starts the required services.
- The web interface is functional.
- Users can search by desired arrival time.
- Multiple unrelated bus operators can be combined.
- The routing engine handles overnight services correctly.
- Transfers are computed from schedules rather than hardcoded routes.
- Results include accurate source provenance.
- Booking links are shown where available.
- Tests pass.
- Synthetic data is never mislabeled as real.
- The README contains reproducible startup instructions.

If genuine live operator coverage is limited, report that limitation clearly. Do not substitute fabricated data and claim production readiness.

## 17. Execution instructions

You are working autonomously inside Claude Code.

Do not stop after presenting a plan.

Inspect the environment, choose a justified architecture, initialize or update the repository, and implement the application.

Use subagents where helpful for independent research, UI implementation, and test review, but retain architectural consistency.

Prioritize working software over excessive documentation.

Do not ask routine implementation questions. Make reasonable decisions, record them, and proceed.

At the end, provide:

1. What was implemented.
2. How to start the application.
3. Which data sources actually work.
4. How the multi-operator routing engine works.
5. Which tests were executed and their results.
6. What remains necessary for comprehensive European coverage.

The ultimate product goal is simple:

**Given two European cities and a desired arrival time, discover every feasible long-distance bus itinerary supported by the available timetable data, even when it requires independently booking buses from competing companies.**

Begin implementation now.