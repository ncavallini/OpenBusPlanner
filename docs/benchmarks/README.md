# Router benchmarks

Command: `pnpm bench` (`packages/bench/src/run-benchmark.ts`). Raw results:
[`results-2026-10-26.json`](results-2026-10-26.json). All numbers below come from that file.
Re-run the benchmark on your own hardware rather than relying on them.

## Setup

| | |
|---|---|
| CPU | Intel Core i9-10900 @ 2.80 GHz (20 logical cores; the router is single-threaded) |
| Memory | 34 GB |
| OS / runtime | Windows 11 (10.0.26300), Node.js v24.11.0 |
| Queries per scenario | 200 |
| Query mix | Random city pairs 150–1600 km apart. 50% departure searches (8 h window), 50% arrival searches (4 h window). Max 3 transfers, 10 min minimum transfer, 8 h max wait, max duration 30 h. Measured in-process (excludes HTTP and DB loading). |

## Datasets

| Scenario | Stations | Dated trips | RAPTOR routes | Build (forward + mirrored) |
|---|---|---|---|---|
| Generated "medium" (FlixBus-EU-like size, 4 days) | 1,828 | 24,072 | 1,200 | 169 ms |
| Generated "large" (≈5× medium, 4 days) | 7,506 | 119,861 | 6,000 | 773 ms |
| **Real FlixBus EU GTFS** (2–4 Nov 2026 + 2 lead-in days) | 2,116 | 17,544 | 2,956 | 125 ms |

## Query latency (ms)

| Scenario | Mode | p50 | p90 | p99 | max | mean results | mean labels |
|---|---|---|---|---|---|---|---|
| Generated medium | Pareto | 1.0 | 2.9 | 10.2 | 11.4 | 0.6 | 952 |
| Generated medium | + alternatives | 1.0 | 2.8 | 7.6 | 8.0 | 0.7 | 1,544 |
| Generated large | Pareto | 11.0 | 15.5 | 23.6 | 27.1 | 0.6 | 2,990 |
| Generated large | + alternatives | 8.3 | 18.2 | 39.3 | 43.5 | 0.7 | 5,447 |
| **Real FlixBus** | Pareto | 10.2 | 18.4 | 28.5 | 30.4 | 3.5 | 11,902 |
| **Real FlixBus** | + alternatives | 23.9 | 48.9 | 73.9 | 76.5 | 8.0 | 34,140 |

No query hit the 10 s time budget.

## Interpretation and caveats

- The generated networks are random walks between cities and are **less connected than real
  networks** (0.6 results per query on average). Their latencies understate real-world bag sizes.
  The real FlixBus numbers are the more representative ones.
- End-to-end API latency also includes loading the window from PostgreSQL on a cache miss: about 1.0–1.3 s
  for FlixBus + BlaBlaCar + gtfs.de on this machine, once per (date range, data version). Cached
  windows add about 1 ms.
- Not measured yet: concurrent load, the full Swiss / German feeds, or memory per cached window.
