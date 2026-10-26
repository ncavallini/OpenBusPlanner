# Roadmap

## Coverage (highest impact)

1. Import the national feeds already registered with implemented adapters: STA South Tyrol (CC0),
   opentransportdata.swiss, ÖBB (after accepting terms), then gtfs.de regional feeds. Measure
   import time and memory, and add streaming COPY for stop_times > 10 M rows.
2. NeTEx (EPIP) adapter: Swiss NeTEx and the Swiss long-distance-bus NeTEx (FlixBus/BlaBlaCar).
3. Contact operators without open data (RegioJet, Itabus, MarinoBus, Autostradale, Arriva, Alsa,
   regional cross-border lines) for licensed feeds or affiliate APIs. Implement their adapters
   against the documented API once access is granted.
4. More national access points: Italy (once licences are stated), Spain (ALSA, needs an API key),
   Mobilitätsverbünde Österreich (needs registration).

## Prices and booking

5. Licensed fare / availability APIs writing `price_observation(kind = 'live')` and an
   availability status per leg, with explicit TTLs.
6. Departure-specific deep links where operators or affiliate programmes document them.

## Routing quality

7. Collect GTFS-RT history into `delay_stat` (p50/p90 per service and station) to drive empirical
   connection risk.
8. Exact handling of the maximum-wait corner case: carry a "latest useful arrival" interval in
   labels, or run a bounded second pass.
9. OSRM foot router in Compose (Europe extract) for OSM-based walking transfers; optional
   first/last-mile street routing (e.g. OTP2 as a sidecar for local legs).
10. Through-ticket knowledge per operator (same-operator connections that are protected).

## Product

11. Languages beyond English (i18n catalogue), 12-hour clock option.
12. Price/arrival alerts, saved searches, share links (itinerary page exists).
13. Load testing, horizontal scaling guide, Prometheus metrics.
