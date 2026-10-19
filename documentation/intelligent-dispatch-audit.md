# ELESEND intelligent dispatch — implementation & evidence

Assembled 17 October 2026 from supplied `ELESEND_STANDALONE_LOGISTICS_PLATFORM.zip`. Status **HOLD**. Baseline remains in `reference/` and preexisting documentation. There is no claim of successful real provider or PostGIS execution.

## Implemented architecture (code evidence)

| Requirement / control | Assessment | Files and evidence / limitation |
|---|---|---|
| Independent ELESEND deployment | PARTIAL | Existing standalone `services/api`, separate DB; operating without ELEMARKET, external fulfilment contract untested. |
| PostGIS spatial discovery, configurable rings | PARTIAL | `003_intelligent_dispatch.sql` + `005_vehicle_eligibility.sql`; GiST + `ST_DWithin`, verified/online/recent/weight/company/vehicle/category/size/coverage filters; **DB integration not run here**. |
| GPS auth, timestamp/accuracy/speed filters | PARTIAL | `dispatch.mjs riderPosition`, authenticated route in `http.mjs`, `rider_location_samples` + retention worker; device GPS spoofing possible without attestation. |
| Adaptive tracking/upload schedule | PARTIAL | policy moving/idle seconds; browser throttles by reported speed, never guarantees OS background location. |
| Provider-neutral network routing | PARTIAL | `dispatch-routing.mjs`, `providers.ts`; OSRM road route/table adapter implemented, static OSRM fixture unit tested. No real connected Ghana routing tested. |
| Actual road ETA ranking | PARTIAL | `dispatch.mjs evaluate`: OSRM matrix ETA dominates crow-flies distance; actual provider not tested. |
| Direction-aware movement | PARTIAL | two timestamped samples, change in network ETA, stationary/unknown, never heading-only; no map matching, no calibrated thresholds/accuracy study. |
| Same-route/corridor multi-stop | PARTIAL | `dispatch-geometry.mjs assessDetour` pure capacity/detour/deadline foundation with passing unit tests; **no on-road path insertion implementation**; `multi_stop_enabled=false` enforced at DB and API. |
| Vehicle and operational eligibility | PARTIAL | separate admin `vehicle_capabilities` rules for category/size and weight, company approval, coverage, active custody exclusion. No third-party vehicle certifications or insurance validation. |
| Offer/expire/decline/retry | PARTIAL | `dispatch_offers`, `dispatchShipment`, 3-second polling worker, `decline`, `tick`; push delivery/availability operational SLA not verified. |
| Atomic assignment/concurrency | PARTIAL | DB transaction, rider+shipment row locks, unique offer indexes, active rider assignment uniqueness including FAILED/return custody; tests written, not executed against Postgres here. |
| Rider pay transparency | PARTIAL | amount_minor/commission_minor/entitlement_minor from immutable shipment price; rider portal displays before accepting; no live payout/refund provider. |
| Customer availability before money | PARTIAL | quote includes nearby count/potential only. Payment **disabled**; paid-vs-availability orchestration for future provider not certified. |
| Rider location/offer UI | PARTIAL | `apps/portal/app.js` GPS consent, poll offers, accept/decline, safe driving notice. **Not a native mobile application**. |
| Logistics company riders and tenant isolation | PARTIAL | existing company+rider approval and invitation, DB query checks company status. Company-mediated dispatch/API offers not implemented. |
| Pickup/delivery OTP | PARTIAL | existing assigned-rider-only `challenge/verify`, mandatory DB `guard_shipment`; pre-pickup release invalidates challenges; **real SMS disabled**. |
| ELEMARKET OTP cross-platform authority | NOT IMPLEMENTED | External verification deliberately blocks completion. Do not make a generic status callback authoritative. |
| Failure/retry/release/reassignment | PARTIAL | no route/eligible rider -> retry/manual review; pre-pickup explicit release; after custody blocked; refund/recovery policy and support workflows incomplete. |
| Location fraud/security assessment | PARTIAL | location replay and speed checks; fabricated slow-moving GPS, rooted devices, network attacks and risk scoring remain. |
| Redis and durable outbox worker | PARTIAL | PostgreSQL durable outbox and polling dispatch; no message delivery worker, dead-letter queue or Redis performance cache (conservative no-cache route freshness). |
| Road-route / geocoder abstraction | PARTIAL | OSRM route+matrix working API adapter, geocoder/map-matching interface definitions only; Geoapify not implemented. |
| Real routing/traffic/GPS field accuracy | BLOCKED | No credentials, no provider road data or real device supplied; cannot claim validated. |
| Actual PostGIS integration and concurrency tests | BLOCKED | Test sources supplied; environment has no PG/PostGIS server, `pg` and `zod` not installable from offline npm cache. |
| Unit tests and synthetic sorting | PASS | 6 pure Node tests executed locally and passed in `tests/dispatch-unit.test.mjs`; includes mock OSRM URL validation, routing failure, direction, fixture and detour. |
| Real infra latency/throughput and ETA cost | BLOCKED | No live database or routing service available; deterministic sorting time is **not** a throughput benchmark. |
| Full public real-money launch | FAIL | SMS/payment/refund/push, real network testing, security/operations and end-to-end reconciliation missing. |

## Test evidence from this run

`node --test tests/dispatch-unit.test.mjs` -> **6 passed, 0 failed**. Deterministic synthetic sort: 40 x 3,000 candidate records took ~15 ms in one observed Node 22 run; **this excludes database, geospatial search, routing requests, transactions, event consumers, networks and browser UI**. This is *not* a dispatch SLO result.

`node --check` executed for all modified backend modules, portal app and integration test files: syntactically valid. **Not equivalent to runtime validation**.

`npm ci --offline --ignore-scripts` -> **BLOCKED**, npm cache lacked `zod` archive. A separate `npm ci` attempt could not fetch dependencies within the available network interval. `psql`, `postgres`, and `docker` executables were not present. Therefore `npm test`, migrations and E2E routing-provider sandbox tests did not execute. GitHub CI and local `npm test` remain required acceptance gates.

## Operating measures to collect before launch (targets not verified)

Record P50/P95/P99 from real Ghana network/devices for PostGIS shortlist query, matrix request, offer creation, authenticated acceptance transaction and GPS freshness. Measure acceptance %, no-candidate %, retry exhausted %, distance/ETA error against realized arrival, cost per successful dispatch, SMS challenge send/verify, incident and refund rates. Set pilot SLOs *after measuring baseline*. Performance budgets must include routing provider rate limits and 3-second worker poll interval.

## High-risk restrictions

* The applicant is a *potential* rider until actual `accept` succeeds. Never promise availability or collect irreversible funds based only on PostGIS distance.
* Multi-stop is **disabled and cannot be enabled by admin**, because the backend's one-active-shipment DB index cannot safely custody two active jobs yet. Detour function is only a foundation.
* Missing/unsupported route profile cannot fall back to straight-line time. OSRM does **not** assert real-time traffic, motorcycles and trucks require vehicle-specific routing validation.
* Rider/company sessions and financial outcomes remain ELESEND-specific. The external ELEMARKET OTP authority flow is blocked rather than bypassed.
* Admin policies still require independent audit: food disabled by default, no capacity override from proximity, sensitive geolocation purged hourly after its configured retention period.
* A native background GPS worker, map SDK, geocoding UX, advanced road-map matching, application reliability and actual carrier connectivity still need engineering and certification.
