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
