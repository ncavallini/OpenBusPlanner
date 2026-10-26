# API (v1)

- Interactive docs: `http://localhost:4080/api/docs`. The OpenAPI document is also in [`docs/openapi.json`](openapi.json); regenerate it with `pnpm --filter @openbus/api openapi`.
- All public routes live under `/api/v1/…`. `/api/…` without a version is an alias of the current version.
- The schemas are defined once in `packages/core/src/api.ts` (zod) and are used for request validation, response serialisation, OpenAPI and the web client types.
- Errors: `{ "error": { "code": "...", "message": "...", "details"?: ... } }` with HTTP 400 / 401 / 403 / 404 / 429 / 500.
- Rate limit: `RATE_LIMIT_PER_MINUTE` per IP (default 120).

## `GET /api/v1/places/search?q=bozen&limit=10`

City and station autocomplete over all aliases (gazetteer languages and every feed spelling).

```json
{ "apiVersion": "v1", "places": [
  { "id": "city:it-bolzano", "kind": "city", "name": "Bolzano", "countryCode": "IT", "timezone": "Europe/Rome",
    "stationCount": 2, "matchedAlias": "Bozen", "lat": 46.4983, "lon": 11.3548, "cityName": "Bolzano" } ] }
```

## `POST /api/v1/journeys/search`

```json
{
  "origin": "city:ch-zurich",
  "destination": "city:it-bolzano",
  "mode": "arrive",
  "date": "2026-11-08",
  "timeWindow": { "from": "04:00", "to": "08:00" },
  "departureNotBefore": { "date": "2026-11-07", "time": "12:00" },
  "maxTransfers": 3,
  "minTransferMinutes": 10,
  "maxTransferWaitMinutes": 480,
  "maxDurationHours": 30,
  "maxWalkMeters": 1500,
  "transportModes": ["bus"],
  "includeOperators": [], "excludeOperators": [],
  "riskPreference": "balanced",
  "excludeRiskyTransfers": false,
  "maxBudget": { "amount": 80, "currency": "EUR" },
  "sort": "recommended",
  "alternatives": true,
  "dataScope": "all",
  "limit": 40
}
```

| Field | Meaning |
|---|---|
| `mode` | `depart`: window applies to departure (origin's local time). `arrive`: window applies to arrival (destination's local time); the search runs backwards from the window. |
| `timeWindow` | `HH:mm`. If `to` is earlier than `from`, the window wraps past midnight. |
| `departureNotBefore` / `arrivalNotAfter` | Hard bound at the other end of the journey. Defaults to the window ± `maxDurationHours`. |
| `riskPreference`, `excludeRiskyTransfers` | Tune the connection classification and filter risky connections. |
| `maxBudget` | Drops journeys whose *known* total is above the budget. Unknown prices are kept. Currencies other than EUR need `FX_RATES_TO_EUR`. |
| `dataScope` | `real`, `synthetic` or `all` (server default: `DEFAULT_DATA_SCOPE`). |

Response (abridged):

```json
{
  "apiVersion": "v1",
  "searchId": "srch_…",
  "outcome": "results",
  "outcomeMessage": "4 itineraries found in the available timetable data.",
  "query": { "origin": {…}, "destination": {…}, "windowStart": { "epoch": 1794538800, "local": "2026-11-08T04:00:00+01:00", "timezone": "Europe/Rome" }, … },
  "itineraries": [{
    "id": "itn_…", "departure": {…}, "arrival": {…}, "durationSeconds": 35100, "arrivalDayOffset": 1, "transfers": 1,
    "legs": [{
      "type": "vehicle", "tripId": "B_ZRH_MIL_1900", "serviceDate": "2026-11-07", "mode": "bus",
      "operator": { "id": "op_…", "name": "…", "website": "…", "synthetic": true },
      "from": { "stationId": "stn_…", "name": "…", "timezone": "Europe/Zurich", … }, "to": {…},
      "departure": {…}, "arrival": {…}, "intermediateStops": […], "crossesBorder": true,
      "price": { "status": "known", "amount": 35, "currency": "CHF", "kind": "indicative", … },
      "availability": "not_verified",
      "booking": { "kind": "operator_homepage", "url": "https://…", "label": "… website — not preselected; search for this departure there" },
      "provenance": { "sourceId": "…", "synthetic": true, "license": "…", "importedAt": "…", "freshness": "fresh", "realtimeApplied": false, "alsoFoundIn": [] }
    }],
    "connections": [{ "quality": "comfortable", "slackSeconds": 6300, "walk": null, "reasons": ["…"], "separateTickets": true, "nightSeconds": 1800, … }],
    "separateTickets": true, "worstConnection": "comfortable",
    "price": { "status": "complete", "totals": [{ "amount": 35, "currency": "CHF" }, { "amount": 24.9, "currency": "EUR" }], "kind": "indicative" },
    "warnings": [{ "code": "separate_tickets", "message": "…" }, { "code": "availability_not_verified", "message": "…" }],
    "paretoOptimal": true, "alternativeTo": [], "synthetic": true, "score": 712.5
  }],
  "coverage": {
    "sourcesConsulted": 3, "sourcesWithServiceInWindow": 2,
    "sources": [{ "id": "…", "status": "used", "tripsInWindow": 11, "validFrom": "…", "validTo": "…", "freshness": "…" }],
    "operatorsRepresented": ["…"], "livePricesQueried": false, "availabilityVerified": false,
    "message": "Results based on 3 available timetable sources, 2 with services in this period, …"
  },
  "diagnostics": { "durationMs": 131, "timetableBuildMs": 79, "routingMs": 3, "rounds": 3, "labelsCreated": 31, "searchesRun": 3, "truncated": false, "cached": false }
}
```

`outcome` distinguishes the empty cases:

| outcome | Meaning |
|---|---|
| `results` | At least one itinerary. |
| `no_journey_in_available_data` | Sources cover the dates, but no journey satisfies the constraints *in the imported data*. |
| `no_timetable_data_for_dates` | No source's validity covers the requested dates. |
| `sources_unavailable` | Every in-scope source failed to import. |
| `place_not_served` | No station with timetable data is known for the origin or destination. |

## `GET /api/v1/journeys/{id}`

An itinerary from a search in the last 7 days.

## `GET /api/v1/operators`

Operators from the imported data with their sources and `synthetic` flag.

## `GET /api/v1/data-sources/status`

Every registered source: `adapterStatus` (implemented / fixture_only / not_implemented),
`liveStatus` (verified_working / failing / never_run / not_applicable for synthetic), last
import, validity, health, freshness, counts.

## Internal API (`/internal/v1`, header `x-internal-token: $INTERNAL_API_TOKEN`)

| Route | Purpose |
|---|---|
| `POST /internal/v1/sources/{id}/import?force=true` | Queue (or, without Redis, run) a schedule import |
| `POST /internal/v1/sources/{id}/realtime` | Pull GTFS-RT once |
| `GET /internal/v1/diagnostics` | Data version, table counts, timetable cache entries, recent searches, live health checks |

Disabled (HTTP 403) unless `INTERNAL_API_TOKEN` is set.
