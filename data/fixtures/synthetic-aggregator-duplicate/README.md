# SYNTHETIC TEST FIXTURE — not real departures

A second generated feed that re-publishes one trip of `synthetic-zurich-bolzano`
(`A_DIRECT_N`), as an aggregator would. It uses different stop ids, alias spellings
("Zurich Sihlquai", "Chur Post", "Bozen Busbahnhof") and coordinates shifted by a few metres.
Entity resolution should map these stops onto the same stations, and the router should
deduplicate the trip and record both sources as provenance.
