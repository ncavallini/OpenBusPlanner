# Data sources and provider integrations

Three different questions are kept apart:

1. **Is the data available and legally reusable?** Research with evidence URLs:
   [`docs/research/data-sources.md`](research/data-sources.md) and the machine-readable
   [`data/research/sources.research.json`](../data/research/sources.research.json) (23 sources,
   accessed 2026-10-26).
2. **Is an adapter implemented?** `adapterStatus` in [`data/source-registry.json`](../data/source-registry.json).
3. **Does it actually work right now?** Only an import run or health check can say. It is shown as
   `liveStatus` by `GET /api/v1/data-sources/status` and on the web page `/sources`.

## Status on 2026-10-26 (development machine)

| Registry id | Adapter | Verified working? | Evidence |
|---|---|---|---|
| `flixbus-eu-gtfs` | gtfs-url | **Yes** — imported 2,116 stops, 1,180 routes, 35,958 trips, 253,383 stop times in ~48 s; real multi-city routing demonstrated | import_run success; feed valid 2026-10-25 – 2027-04-25 |
| `blablacar-bus-gtfs` | gtfs-url | **Yes** — 660 stops, 2,026 trips; 290 stops resolved onto existing FlixBus stations | import_run success |
| `gtfs-de-fv` (rail) | gtfs-url | **Yes** — 5,323 trips (13 rail agencies incl. DB, SBB, ÖBB codeshares) | import_run success |
| `flixbus-eu-gtfs-rt` | gtfs-rt-url | Adapter implemented; **not run** in this session | — |
| `sta-south-tyrol-gtfs`, `oebb-gtfs`, `swiss-gtfs` | gtfs-url | Adapter implemented; **not run** (150–290 MB feeds; ÖBB terms must be accepted by the deployer) | research HEAD checks only |
| `swiss-netex`, `flixbus-netex-it-nap` | netex | **Not implemented** (NeTEx parsing is not in v1; the Italian NAP file has no stated licence) | — |
| `regiojet`, `itabus`, `marinobus`, `autostradale` | unavailable | **No accessible data found.** The adapter returns "not integrated"; a clearly labelled *synthetic stand-in* can be enabled for development | research: no API/GTFS/NeTEx/licence found |
| `fixture-*` | gtfs-file / manual-json | Synthetic test data, always labelled | — |

"Verified working" means verified on this machine on this date. Run `pnpm ingest health` or open
`/sources` to see the current state of a deployment.

### Real routing examples (FlixBus + BlaBlaCar + gtfs.de, 2026-10-31/11-01)

These came from real imported data on 2026-10-26. They are timetable *existence*, not proof of ticket
availability.

- Zürich → Bolzano, arrive Sunday 1 Nov 04:00–08:00: 9 itineraries. They go via Munich (Pareto),
  via Milan + Verona (Pareto, one risky connection), and as alternatives via Stuttgart, Innsbruck,
  Karlsruhe, Heidelberg, Bologna/Florence, and Bergamo/Merano.
- Lyon → Venice: BlaBlaCar Bus Lyon → Milan Lampugnano + FlixBus Milan → Venice Mestre (separate tickets).
- Paris → Bolzano: BlaBlaCar Bus (Chessy) → Munich ZOB + FlixBus Munich → Bolzano.
- Zürich → Bolzano with trains: SBB + DB Fernverkehr + FlixBus.

## Adapters

| Adapter | Use |
|---|---|
| `gtfs-file` | Local GTFS directory or zip (fixtures, operator-provided files). |
| `gtfs-url` | HTTP download with ETag / If-Modified-Since, zip validation, atomic replace; unchanged content (SHA-256) is skipped. |
| `manual-json` | `openbus-manual-timetable/v1` for hand-maintained or spreadsheet timetables (see below). |
| `gtfs-rt-url` | GTFS-Realtime TripUpdates (protobuf); delays propagate downstream; cancellations remove the dated trip. |
| `netex` | Interface only; parsing not implemented. |
| `unavailable` | For operators without accessible data; synthetic stand-in only. |

Adding a source = adding an entry to `data/source-registry.json`, plus an adapter only if the
format is new. Never add a source whose licence is unknown (`flixbus-netex-it-nap` is registered
but cannot be enabled).

### Manual timetable format

```json
{
  "format": "openbus-manual-timetable/v1",
  "synthetic": false,
  "publisher": "Operator X (timetable PDF of 2026-10-01)",
  "operators": [{ "id": "x", "name": "Operator X", "url": "https://…", "timezone": "Europe/Rome" }],
  "stops": [{ "id": "a", "name": "…", "lat": 45.0, "lon": 9.0 }],
  "services": [{
    "id": "S1", "operator": "x", "name": "A – B", "mode": "bus",
    "calendar": { "days": "1111100", "from": "2026-01-01", "to": "2026-12-31", "except": ["2026-12-25"], "extra": [] },
    "trips": [{ "id": "0705", "calls": [["a", "07:05"], ["b", "09:40", "09:45"], ["c", "25:10"]] }]
  }],
  "fares": [{ "service": "S1", "from": "a", "to": "c", "amount": 19.9, "currency": "EUR" }]
}
```

The `synthetic` flag must match the registry entry, or the import is refused.

## Licences and attribution

| Source | Licence | Obligations |
|---|---|---|
| FlixBus EU GTFS / GTFS-RT | ODbL 1.0 + transport.data.gouv.fr *Conditions Particulières* | Attribution (shown in leg provenance and on `/sources`). Share-alike applies to *derived databases of the same nature*, which would have to be published on transport.data.gouv.fr. Journey results are a produced work, not a database. |
| BlaBlaCar Bus GTFS | ODbL 1.0 + transport.data.gouv.fr conditions | Same as above |
| GTFS.DE fv_free | CC BY 4.0 (as stated by GTFS.DE) | Attribution: DELFI e.V., GTFS.DE, OpenStreetMap contributors. Mobility Database links a different licence for sibling feeds — confirm before production. |
| STA (Open Data Hub) | CC0 (declared in the dataset listing) | None. The API is beta; production use needs an agreement with NOI Techpark. |
| ÖBB GTFS | CC BY 4.0 + ÖBB terms | Accept the terms on data.oebb.at before enabling |
| opentransportdata.swiss | Terms of use | Cite "opentransportdata.swiss" |

Nothing in this repository circumvents authentication, CAPTCHAs or rate limits, and no web
scraping is implemented.

## Prices, availability and booking links

- None of the open sources provides prices or live seat availability (research, all sources).
- Prices come only from GTFS fare files or `price_observation` rows and are labelled
  *indicative*. A licensed live fare API would write `kind = 'live'` observations.
- Availability is always reported as `not_verified`.
- The real feeds only contain generic operator URLs. Booking links are therefore labelled
  "operator website — not preselected". A `booking_url_template` is set only when an operator
  documents a URL format; none does yet.
