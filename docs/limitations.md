# Known limitations

## Data coverage (the biggest limitation)

- Only operators that publish open timetables are covered for real: FlixBus/FlixTrain and
  BlaBlaCar Bus (plus German long-distance rail via gtfs.de). **RegioJet, Itabus, MarinoBus and
  Autostradale publish no accessible timetable data** that we could find. Many regional
  cross-border operators are reachable only through national datasets that were not imported in
  the demo (Swiss, ÖBB, STA).
- No source provides **prices** or **seat availability**. Prices are indicative (fixture fares
  only). Availability is never verified.
- No operator documents **departure-specific deep links**, so booking links lead to operator
  homepages and are labelled as such.
- City grouping relies on a seed gazetteer of ~140 cities plus derived cities from stop names.
  Stops of large metropolitan areas outside a gazetteer radius may form their own "city".

## Routing

- **Maximum transfer wait vs. RAPTOR dominance.** When boarding, an earlier trip on the same route
  dominates a later one (it arrives no later everywhere). With a hard *maximum wait* at the *next*
  transfer, the later trip can be the only feasible one. Such options are only found if the later
  trip is a first boarding (the profile search keeps all first boardings), not after a transfer.
  The same applies to the night-walk penalty. Default max wait is 8 h, so this is rare.
  Randomised equivalence tests run with a 24 h wait to compare against the exhaustive enumerator.
- **Equivalent ties** (identical criteria, same final vehicle) are collapsed to one itinerary.
- **Fare-aware search** considers at most four extra later departures per route when looking for
  cheaper trips.
- **Corridor alternatives** come from up to three re-searches that exclude used transfer cities.
  This is a diversity heuristic, not an exhaustive enumeration of all feasible combinations.
- **Through-tickets**: whether consecutive legs of the *same* operator can be booked as one
  protected ticket is unknown. The UI says so instead of guessing.
- Walking is one footpath per transfer, within 1 km by default, between *stations*. There is no
  door-to-door street routing for the first or last mile.
- Connection risk uses rules. `delay_stat` exists, but no historical delays are collected yet, so
  no empirical tightening happens in practice.

## Data handling

- NeTEx is not parsed (interface only).
- Imports replace a source atomically. There is no per-trip diff (unchanged feeds are skipped by hash).
- GTFS `frequencies.txt`, `block_id` stay-seated transfers, GTFS-Flex and fares v2 are not supported.
- GTFS-RT: TripUpdates only (no vehicle positions or alerts); only the latest update per dated trip is kept.
- Walking distances are straight line × 1.35 unless an OSRM foot router is configured.

## Product

- English only. Times are formatted with the 24-hour clock.
- No accounts, alerts, or saved searches.
- The benchmark covers single-query latency on one machine. Concurrency and memory limits are not measured.
