# Mapping, distance, ETA and pricing evidence — 2026-11-08

## Reviewed executable modules
- services/api/pricing.mjs: integer-pesewa calculation; per-km term uses road distanceMeters / 1000, rounds up to pesewas; commission and fees derived from configurable policy.
- services/api/dispatch-geometry.mjs: haversine is geodesic distance and explicitly not assignment road ETA.
- services/api/eta/stage-eta.mjs: GPS freshness, stage ETA, route projection and confidence logic.
- services/api/eta/eta-service.mjs: road routing provider legs, manifest stops, cached geometry, calibrated/assumed time factors.
- services/api/eta/baseline-factors.mjs: Accra evening assumed factors, configurable by ETA_BASELINE_FACTORS, not measured nationwide.
- benchmarks/ghana-routes.json: benchmark coordinate pairs, but references only present for Kasoa-to-Airport; other results cannot be claimed measured.

## Existing deterministic fixture (not a live measurement)
The tests/pricing-engine.test.mjs tariff fixture is base=1,200 pesewas; per_km=320 pesewas; per_minute=25 pesewas; commission=1,300 basis points. For route input 35,341 metres and 2,361 seconds with 1.4x surge, the test asserts customer fare 18,892 pesewas (GH₵188.92), platform commission 2,456 (GH₵24.56), rider earnings 16,436 (GH₵164.36). The inputs and expected results are test fixtures, not a verified live quotation or GPS/OSRM observation.

## Unverified
No independently connected Ghana OSRM instance, live traffic, physical rider traces, rider Android screenshots, or customer Android screenshots are available in this connector-based audit. Do not claim production ETA or location accuracy.


## Rapid Courier (Accra Airport) → Kasoa New Market: private-map-only test
User explicitly requires ELESEND private-map evidence; external map screenshots and map-derived distances are excluded.

The current GitHub tree contains ELESEND MapLibre/OSRM/Photon-related source, including deploy/maps/motorcycle.lua and deploy/runtime/compose.yaml, but no generated `ghana-motorcycle.osrm` or `ghana.mbtiles` artifact. These are loaded from a separately configured `GHANA_MAP_DATA` directory. Neither an accessible running private OSRM endpoint nor verified exact RAPID Courier / Kasoa New Market entrance pins has been supplied in this audit environment. Code search for RAPID Courier in the current repository yielded no match. Thus the actual private-road distance, road turn instructions, tiles screenshot and ETA are **not yet measurable**.

A strict private-OSRM-only diagnostic was added in `scripts/private-delivery-route-check.mjs` (commit `2c8dc9d5835ba8fb14e7bfe85ccfc62b5f41df60`). It requires a running `ELESEND_PRIVATE_OSRM_URL` and ELESEND-resolved `PICKUP_LAT/PICKUP_LON` and `DROP_LAT/DROP_LON`, retrieves billing-validated motorcycle road geometry and turn steps from ELESEND's `osrmRouting`, computes ETA via ELESEND's `calculateStageEta`, and optionally quotes with an explicit `ELESEND_TARIFF_JSON`. It refuses to fabricate an answer when these are unavailable.

**Verification status:** source committed, not yet executed against private Ghana graph. No actual screenshot produced. Existing separate 9-route fixture-based CI tests are mock road responses, not the above live private-graph diagnostic.
