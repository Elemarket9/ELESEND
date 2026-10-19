# ELESEND: 12 executable logistics algorithms — engineering delivery
Date: 2026-10-18 UTC | Release classification: **UNVERIFIED CANDIDATE — HOLD**

## What changed since previous 115-file candidate

This package **contains runnable algorithms and new regression tests**, not merely 12 feature flags. Existing Node/PostGIS modular monolith and React Native/Expo Android/iOS source remain. No new customer-facing website or hardcoded VPS operator. Critical financial and road safety controls remain non-disablable. Safety-sensitive optional features remain off until verified by a qualified operator.

| # | Algorithm | Real source | Runtime integration | Reproducible test | Verification |
|---|---|---|---|---|---|
| 1 | Geospatial expanding candidate search | `services/api/algorithms/discovery.mjs` | `dispatch.nearby()` uses parameterized, index-eligible PostGIS candidate query | `twelve-algorithms-implementation.test.mjs` #1 | Unit PASS; PostgreSQL BLOCKED |
| 2 | Directed road-network ETA calculation / matrix batching | `algorithms/roads.mjs`, `dispatch-routing.mjs`, `google-routing.mjs` | `dispatch.evaluate()` uses batched provider matrix; request-scoped memo for road legs | #2 | Fixture PASS; real Google Maps BLOCKED |
| 3 | Direction-aware movement analysis | `dispatch-geometry.mjs`, `algorithms/corridor.mjs` | `dispatch.evaluate()` compares successive real road ETAs; never trusts bearing alone | #3 | Fixture PASS; road/GPS BLOCKED |
| 4 | Eligibility-first ETA rider ranking | `algorithms/ranking.mjs` | `dispatch.evaluate()` hard gates route/vehicle/availability and sorts ETA | #4 | Unit PASS; DB BLOCKED |
| 5 | Bounded multi-parcel VRP | `algorithms/vrp.mjs`, `multi-parcel.mjs` | Dispatch uses feasibility-constrained pickup/dropoff insertion; standalone multi-job route optimizer is callable but not wired into automatic nationwide batching | #5 | Unit PASS; multi-job production activation BLOCKED |
| 6 | Dynamic pickup/drop-off insertion / route corridor | `multi-parcel.mjs`, `algorithms/corridor.mjs` | `dispatch.planForCandidate()` searches ordered insertions, preserves rider's accepted stops | #6 | Fixture PASS; DB/route BLOCKED |
| 7 | Exact-money cost pricing and 3%-per-delivery commission | `pricing.mjs`, migrations 014, 016 | `platform.quote()` uses integer pesewas; separate locked quote/commission per delivery | #7 and pricing suite | Unit PASS; external live settlement BLOCKED |
| 8 | Cash commission exposure / prepayment limits | `algorithms/exposure.mjs`, `finance.mjs` | `finance.cashEligible()` locks rider account and includes reserved active-job commission | #8 | Unit PASS; DB concurrency BLOCKED |
| 9 | Immutable ledger + payment reconciliation / idempotency | `algorithms/reconciliation.mjs`, `finance.mjs` | `finance.journal()` validates balanced entries before PostgreSQL posting | #9 | Unit PASS; DB and PSP BLOCKED |
| 10 | GPS noise and replay filtering | `algorithms/gps.mjs` | `dispatch.riderPosition()` checks authenticated rider + GPS movement when admin flag enabled | #10 | Unit PASS; real device BLOCKED |
| 11 | Historical ETA calibration | `algorithms/eta.mjs` | `dispatch.evaluate()` calibrates from verified accepted-offer/pickup samples when flag enabled | #11 | Unit PASS; accuracy/real-trip data BLOCKED |
| 12 | Explainable fraud anomaly detection | `algorithms/fraud.mjs` | Rider cash shortfall and OTP failures produce stored risk signals; GPS implausibility detection callable | #12 and new regression | Unit PASS; detector quality/ops review BLOCKED |

## Specific defects addressed

1. Prior module flags were not proof of implemented algorithms. Added five executable, independent algorithm modules (`discovery`, `roads`, `vrp`, `exposure`, `reconciliation`) and real implementation tests; connected discovery, road-matrix computation, ranking, exposure and double-entry checks to existing backend execution paths.
2. Nearby rider discovery and assignment used **sum of weights across all booked parcels** as a capacity gate, incorrectly rejecting staggered pickups that never exceed capacity on board. The live code now tests each ordered route's capacity and verifies every active shipment stop. New **additive migration 015** replaces the blunt sum-only DB trigger with count/individual parcel checks and a DEFERRABLE manifest-capacity constraint that validates the final route at transaction commit. **This migration is UNTESTED against PostgreSQL; multi-stop must remain OFF pending real migration/concurrency tests.**
3. Added fail-closed validation of road routing legs, per-request memo and provider matrix batching so invalid/missing road times cannot count as real road ETA.
4. Financial journals now use double-entry balance validation before posting and the rider credit-admission decision has a reusable integer-money algorithm with tests.
5. Added conditional time, waiting, stop, discount and surcharge computation. The backend quote API now passes verified road travel time; administrator pricing API and additive migration 016 allow time-based charges. Waiting and additional-stop billing still require independently verified post-service events before activation and are currently only pure pricing functions.
6. Added explainable implausible-travel risk detection, never automatic rider sanctions.

## Multi-rider broadcast requirement

Prior executable `dispatch.dispatchShipment()` uses configured broadcasting to create an independent, expiring offer for every road-feasible shortlisted rider, and `dispatch.accept()` locks rider and shipment rows so only the first *valid* acceptance wins. The native app currently polls foreground offers. **Background push delivery is not yet live-verified; outbox is NOT evidence an offer reached an offline handset.** A corridor being nearby never substitutes for real vehicle/capacity/road ETA feasibility.

## 3% per successful order

Pricing is per independent delivery quote/order (300 basis points as initial versioned policy in migration 014). Ten independently completed GH₵30 deliveries each accrue GH₵0.90, total GH₵9.00. A pending offer or mere pickup does not accrue successful delivery commission. Cash receivables are not settlement cash received by ELESEND. If a delivery is cancelled, its normal successful-delivery commission is not posted. Prepaid credits remain compliance-gated.

## Commands executed (this environment)

- `node --version`: v22.16.0
- `npm run test:algorithms-full`: **56 passed; 0 failed** (node:test with deterministic mocks/fixtures)
- `node --test tests/twelve-algorithms-implementation.test.mjs`: **14 passed; 0 failed**
- `node --check` on all 51 `*.mjs` and `*.js` source/test files: **51 passed; 0 failed**
- `npm test`: **56 passed; 5 failed**; all five failures were missing `zod`/`pg` modules; database tests never executed; required `zod` and `pg` modules unavailable, so DB tests never ran. Do not mistake these for proven application defects OR a green full suite.
- `npm ci --offline`: FAILED (zod tarball missing from npm cache).
- `npm ci --fetch-retries=0`: FAILED (network DNS EAI_AGAIN to npm registry).
- No PostgreSQL/PostGIS server, Redis instance, official routing sandbox, MoMo/SMS provider credentials, or native build toolchain was present. No physical GPS test, Android APK, iOS IPA, PostgreSQL migration execution or real financial settlement was performed.

The unit-tests results are evidence of isolated algorithm behavior ONLY; they are not a real road-traffic benchmark, fraud validation, production dispatch latency or financial reconciliation guarantee.

## Blocking release gates (retain HOLD)

- [ ] Install npm dependencies, run clean full suite and fix any actual failures.
- [ ] Apply migration 015 to disposable *real PostgreSQL/PostGIS* and validate deferred manifest trigger. Run existing migrations from empty + preserved upgraded snapshot, include rollback plan, concurrent 10-parcel accept tests, and restore test.
- [ ] Validate real road matrices, route geometry and Ghana/other-market traffic against authorized routing provider credentials. Distinguish two-wheeler beta/supported profiles.
- [ ] Configure and cryptographically verify SMS/OTP, push notifications and MoMo settlement with official provider/test accounts; verify webhook authorization and idempotent partial repayments.
- [ ] Build/install native Android APK/AAB, test GPS/background permissions and notification handling on real phones; build/verify iOS when Apple toolchain is available.
- [ ] Validate financial reports/reconciliation and pending/in-flight delivery migrations under restart/crash; configure offsite backups and recovery.
- [ ] Activate foreign markets only after local legal, currency, payments, phone, road and vehicle requirements are verified. Global-ready architecture is not global operations.

## Deployment and operator controls

Use `deploy/vps/` for portable Linux VPS configuration; no Hostinger dependency in domain logic. Before multi-stop activation, manually verify cars/riders, fund/payments and custody/OTP flows; run DB transaction tests. `dispatch_algorithm_features` and `dispatch_policy` are admin permissioned. Never disable authoritative authorization, recipient OTP, idempotency or durable journal constraints through feature switches. Keep unused experimental features disabled and document all changes via audit logs.

### Engineering release decision: HOLD

This ZIP is an executable, reproducible **engineering candidate** with 12 tested algorithm implementations and a portion of them wired to the business services. Do NOT call it production verified or use it for real-money public deliveries before completing the release gates above.
