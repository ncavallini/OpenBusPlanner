# SYNTHETIC TEST FIXTURE — not real departures

This GTFS feed is **generated test data** for OpenBus Planner. Every operator, trip, time and
fare in it is invented. Stop *locations* approximate real bus stations so that geographic
logic (city grouping, walking transfers) behaves realistically, but **no departure in this
feed exists in reality**. The importer flags the source as `synthetic`, and the API and UI label
every leg from it as test data.

It encodes the Zurich → Bolzano/Bozen scenario from the project spec (§11):

| Case | Trips |
|---|---|
| Direct overnight journey | `A_DIRECT_N` Zürich 23:30 → Bolzano 05:30 (+1) |
| One transfer, two operators, separate tickets | `B_ZRH_MIL_1900` + `C_MIL_BZO_0030` via Milano Lampugnano |
| Two transfers incl. walk between nearby stops | `D_ZRH_MUC_1500` + `E_MUC_INN_2030` + walk Innsbruck Hbf → Sillpark + `F_INN_BZO_0130` |
| Missed connection | `B_ZRH_MIL_2055` arrives 00:40, `C_MIL_BZO_0030` already left at 00:30 |
| Connection too short | `B_ZRH_MIL_2055` arrives 00:40, `G_MIL_BZO_0045` leaves 00:45 (5 min < 10 min minimum) |
| Journey crossing midnight | all overnight trips (GTFS times > 24:00:00) |
| Service not operating on Sunday | `A_EARLY_NOTSUN` (Mon–Sat) |
| Distinct stations in the same city | `D_ZRH_SDO_1800` ends at Milano San Donato, 12 km from Lampugnano — no transfer |
| Alternative corridor | `H_ZRH_VRN_1700` + `C_MIL_BZO_0030` from Verona (dominated, found as alternative) |
| Calendar exceptions | `A_DIRECT_N` removed on 2026-12-24; `X_NYE_SPECIAL` added only on 2026-12-31 |
| Fares | zone fares for Bravo (CHF) and Charlie (EUR); all other fares unknown |
