# OpenBus Planner: data source research

Accessed: 2026-10-26. Machine-readable registry: [`data/research/sources.research.json`](../../data/research/sources.research.json).
Every non-"unknown" claim in the registry has an evidence URL.

Field values used in this report:

- **Confidence.** `verified`: seen on an official or primary page, or confirmed by an HTTP check, in this session. `reported`: seen only in secondary sources or search excerpts. `unverified`: nothing usable was found.
- **Reuse.** `yes`: no conditions (CC0). `conditional`: allowed, subject to licence obligations such as attribution or share-alike. `unknown`: no licence found.
- **Downloads.** These were checked with HEAD, or with a 1-byte range GET where HEAD is blocked. Nothing large was downloaded. Some file contents (agency.txt, stops.txt) were checked by reading single files out of the ZIPs with HTTP range requests.

## Summary table

| Source | GTFS | RT | NeTEx | Access | Licence / reuse | Prices | Deep links | Confidence |
|---|---|---|---|---|---|---|---|---|
| FlixBus EU GTFS (`flixbus-gtfs-eu`) | yes | yes (GTFS-RT TU) | no | public | ODbL + PAN conditions / conditional | no | generic-only | verified |
| FlixBus partner API (`flixbus-partner-api`) | ? | ? | ? | restricted | commercial agreement / unknown | unknown | unknown | reported |
| FlixBus NeTEx on Italian NAP (`flixbus-netex-it-nap`) | no | no | yes | public | not stated / unknown | no | no | verified |
| Swiss "(Beta) Long distance bus" NeTEx (`otd-swiss-fernbus-netex-beta`) | no | no | yes | public | opentransportdata.swiss ToU / conditional | no | no | verified |
| BlaBlaCar Bus GTFS (`blablacar-bus-gtfs`) | yes | SIRI Lite (not GTFS-RT) | no | public | ODbL + PAN conditions / conditional | no | generic-only | verified |
| RegioJet (`regiojet`) | ? | ? | ? | unknown | unknown | unknown | unknown | unverified |
| Itabus (`itabus`) | ? | ? | ? | unknown | unknown | unknown | unknown | unverified |
| MarinoBus (`marinobus`) | ? | ? | ? | unknown | unknown | unknown | unknown | unverified |
| Autostradale (`autostradale`) | ? | ? | ? | unknown | unknown | unknown | unknown | unverified |
| STA South Tyrol via Open Data Hub (`sta-opendatahub-gtfs`) | yes | yes | ? | public | CC0 / yes | no | no | verified |
| STA via BusOne proxy (`sta-busone-proxy`) | yes | yes | no | public | non-commercial only / conditional | no | no | verified |
| Swiss GTFS 2026 (`otd-swiss-gtfs`) | yes | yes (API key) | separate | public (RT: registration) | opentransportdata.swiss ToU / conditional | no | no | verified |
| Swiss NeTEx 2026 (`otd-swiss-netex`) | no | no | yes | public | opentransportdata.swiss ToU / conditional | no | no | verified |
| ÖBB GTFS 2026 (`oebb-gtfs`) | yes | no | ? | public (accept ToU) | CC BY 4.0 / conditional | no | no | verified |
| Mobilitätsverbünde Österreich (`mobilitaetsverbuende-at`) | yes | ? | ? | registration | MVO licence (CC BY-derived, use restriction) / conditional | no | no | reported |
| GTFS.DE (`gtfs-de`: fv/rv/nv/full) | yes | no | no | public | CC BY 4.0 (stated) / conditional | no | no | verified |
| DELFI national data (`delfi-de-nap`) | yes | ? | yes | registration | unknown (CC BY 4.0 reported) | no | no | reported |
| Italian NAP CCISS (`it-nap-cciss`) | no | no (SIRI, access not checked) | yes | public | not stated / unknown | no | no | verified |
| French NAP (`fr-nap-transport-data-gouv`) | yes | yes | yes | public | per dataset (ODbL / Etalab) / conditional | no | no | verified |
| ALSA via Spanish NAP (`alsa-es-nap`) | yes | ? | ? | registration (401) | MITRAMS LDA / conditional | no | no | verified |
| Vy Express via Entur, Norway (`vy-express-entur`) | yes | yes | yes | public | NLOD / conditional | no | no | verified |
| Lux Express, Estonia domestic (`lux-express-estonia`) | yes | ? | ? | public | unknown | no | no | reported |
| Czech CIS JŘ (`cz-cis-jr`) | no (JDF) | no | yes | public | unknown | no | no | verified |

None of the open sources provides **ticket prices** or **live seat availability**. That information is only possible through commercial or partner agreements (FlixBus partner API, RegioJet via Rail Europe B2B and similar), and none of those were verified.
No source offers documented **departure-specific booking deep links**. FlixBus and BlaBlaCar GTFS only carry a generic shop URL (`agency_fare_url` / `agency_url`).

## Per-source notes

**FlixBus EU GTFS.**
- The best single source for the corridor: one pan-European feed for FlixBus and FlixTrain, published by Flixbus France on transport.data.gouv.fr. The file is at `https://gtfs.gis.flix.tech/gtfs_generic_eu.zip` (31.6 MB, Last-Modified 2026-10-25, valid 2026-10-25 to 2027-04-25).
- stops.txt has 2,117 stops, including Zurich Bus Station, Zurich Airport, Chur, Lugano, Bolzano South, Innsbruck, Milan Lampugnano and Munich ZOB/Airport.
- GTFS-RT TripUpdates are open (GET 200, no key) at `global.api.flixbus.com/gis/v1/gtfs-rt/...`.
- The feed has no fares.txt. The agency timezone is UTC.
- Other files on the same host, `gtfs_generic_gb.zip` and `gtfs_generic_turkey.zip`, exist, but no licence was found for them.
- Trafiklab republishes a regional FlixBus feed under CC0, but it requires an API key.

**FlixBus partner API.** The official partner page lists "API / dynamic integration" for aggregators and metasearch, by application. There are no public docs. Prices, availability and deep links are all unknown until FlixBus grants access.

**FlixBus NeTEx (Italian NAP) and Swiss Fernbus NeTEx beta.** Both can be downloaded.
- Italian NAP file: no licence is stated. It is small (490 KB).
- Swiss beta: covered by the opentransportdata.swiss terms (attribution). It is stale (May/June 2026) and labelled test data.
- Use these files to test a NeTEx adapter only.

**BlaBlaCar Bus.**
- Small daily GTFS (234 KB) on transport.data.gouv.fr, ODbL. Valid until 2027-01-06.
- Corridor stops: Zürich, Zurich Airport, Lugano, Innsbruck, Munich, Milan.
- The download is via Google Drive, so redirects must be handled. Real-time is SIRI Lite (open).

**RegioJet, Itabus, MarinoBus, Autostradale.** No API, GTFS, NeTEx or data licence was found on the official sites, in the Mobility Database catalogue, or among the operator datasets on the Italian NAP.
- Itabus has a reseller programme page.
- Autostradale sells tickets via shop.autostradale.it.
- RegioJet is distributed through Rail Europe B2B (trade press).
- All four need direct contact. Fixture-based adapters only for now.

**South Tyrol (STA / Südtirolmobil).**
- The official Open Data Hub GTFS API (`gtfs.api.opendatahub.com`) lists `sta-time-tables` with origin sta.bz.it, licence **CC0**, and GTFS-RT trip updates, vehicle positions and alerts.
- The raw GTFS is 151 MB.
- The Open Data Hub docs describe the APIs as beta and say production use needs an agreement with NOI Techpark.
- The BusOne proxy in the Mobility Database is a third party and **non-commercial only**. Avoid it.

**Swiss open data.**
- The GTFS 2026 permalink gives a 291 MB file, updated twice weekly.
- It contains 475 agencies, including cross-border ÖBB, VVT Tirol, VVV, DB Regio BW and SNCF services. No FlixBus or BlaBlaCar agency is present.
- The terms require citing "opentransportdata.swiss". There is no share-alike and no registration for files.
- GTFS-RT needs an API key and is limited to 2 requests/min.
- The NeTEx 2026 file is 669 MB.
- The presigned download redirects expire after 60 seconds and reject HEAD.

**Austria.**
- ÖBB GTFS 2026 is CC BY 4.0, 174 MB, updated once a year (Last-Modified 2025-12-12). It contains ÖBB-PV, CAT and Montafonerbahn, with foreign stops Zürich HB, München Hbf and Bolzano. The ZIP has a nested folder.
- Postbus is not in the ÖBB file.
- Regional and association data (VVT for Innsbruck) is on the MVO platform, which needs an account. Its licence is reported as CC BY-derived with a field-of-use restriction. The public listing API returned 502.

**Germany.**
- GTFS.DE publishes daily free GTFS feeds converted from DELFI NeTEx under CC BY 4.0 (stated on gtfs.de):
  - `fv_free`: long-distance rail, 400 KB
  - `rv_free`: regional rail, 11.8 MB
  - `nv_free`: local transport, 277 MB
  - `free` (de_full): 289 MB
- The window is a rolling ~30 days.
- attributions.txt lists DELFI, GTFS.de and OSM contributors.
- The Mobility Database links nv_free to an NVBW licence instead, so confirm with GTFS.DE.
- Whether FlixBus is included is unknown.
- The raw DELFI NeTEx/GTFS requires registration, and its licence is only reported.

**Italian NAP (CCISS).**
- NeTEx Italian profile from operators (FlixBus, Italo, Trenitalia) and regions. Files download without login.
- No licence is stated anywhere checked, so it cannot be imported until the terms are clarified.

**French NAP.** Catalogue API at `/api/datasets`, with daily quality checks and history archives. The licence varies per dataset (ODbL with narrowed share-alike, or Licence Ouverte Etalab).

**Other operators.**
- ALSA (Spanish NAP): API key required. MITRAMS LDA licence with "Powered by MITRAMS" attribution and same-licence redistribution.
- Vy Express (Entur, NLOD): open national GTFS, NeTEx and GTFS-RT.
- Lux Express: in the Estonian domestic long-distance GTFS; licence not verified.
- Czech CIS JŘ: public JDF and NeTEx; licence unknown.
- None of these serve the Zurich corridor.

## Best candidates for a first legally reusable real import

The ranking covers openly downloadable feeds with a confirmed reuse licence and services relevant to Zurich → Bolzano / Milan / Munich / Innsbruck.

1. **FlixBus EU GTFS.** `https://gtfs.gis.flix.tech/gtfs_generic_eu.zip` (stable alias `https://www.data.gouv.fr/api/1/datasets/r/30d94e83-48a4-4c44-8a96-c082377f5221`).
   - 31.6 MB zipped. Long-distance buses Zurich ↔ Milan / Munich / Innsbruck / Bolzano (stops confirmed).
   - **ODbL 1.0 + PAN conditions:** attribute "FlixBus / transport.data.gouv.fr, ODbL" (a "data sources" page is enough).
   - Share-alike applies only to a derived database of the same nature, granularity and extent, which must then be republished on transport.data.gouv.fr. Planner results and other produced works are not subject to it.
   - Optional open GTFS-RT TripUpdates.
2. **BlaBlaCar Bus GTFS.** Google Drive URL from the transport.data.gouv.fr dataset (234 KB). Zurich, Lugano, Innsbruck, Munich and Milan stops. **ODbL + PAN conditions**, same obligations as #1. Daily refresh.
3. **ÖBB GTFS 2026.** `https://static.web.oebb.at/open-data/soll-fahrplan-gtfs/GTFS_Fahrplan_2026.zip`.
   - 174 MB. Cross-border rail Zurich – Innsbruck – Vienna and Munich – Innsbruck – Brenner – Bolzano.
   - **CC BY 4.0:** attribution to ÖBB-Personenverkehr AG and indication of changes; ÖBB trademarks are not licensed.
   - Annual file: no mid-year changes.
4. **GTFS.DE `fv_free`.** `https://download.gtfs.de/germany/fv_free/latest.zip`.
   - 400 KB. Long-distance rail including SBB and ÖBB trains to Zürich HB and Innsbruck.
   - **CC BY 4.0** per gtfs.de. Attribute DELFI e.V. and GTFS.de, plus OSM contributors for OSM-derived parts. Confirm the licence because of the NVBW link in the Mobility Database.
   - The rolling ~30-day window needs a daily refresh.
5. **STA South Tyrol via Open Data Hub.** `https://gtfs.api.opendatahub.com/v1/dataset/sta-time-tables/raw`.
   - 151 MB. Regional buses and trains around Bolzano/Bozen for the last-mile legs.
   - **CC0** as declared by the API, so no obligations. The API is beta; contact NOI Techpark for production SLA terms.
6. **Swiss GTFS 2026.** `https://data.opentransportdata.swiss/dataset/timetable-2026-gtfs2020/permalink`.
   - 291 MB zipped (stop_times ~3.7 GB unzipped). Swiss legs plus ÖBB, VVT and VVV cross-border services.
   - **opentransportdata.swiss ToU:** cite "opentransportdata.swiss", publish processed data under your own name, keep it updated. No share-alike.
   - Size makes it a second-phase import. The 2027 timetable-year dataset is expected in December 2026.

Not recommended yet:
- Italian NAP NeTEx: no licence.
- MVO Austria: registration, plus a use restriction to review.
- BusOne: non-commercial only.
- Swiss Fernbus beta: stale.
- RegioJet, Itabus, MarinoBus, Autostradale: no data found.
