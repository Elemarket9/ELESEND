# ELESEND high-grade dispatch — what actually exists

Mobile client: React Native/Expo Android and iOS source, **not** a web storefront. Backend: modular Node/PostgreSQL/PostGIS service, generic-VPS deploy configuration. API and mobile integration depend on applied migrations 001–014 and provider credentials.

## Twelve core algorithms and validation status

| Algorithm | Implementation | Current evidence and caveat |
|---|---|---|
| 1. PostGIS nearby discovery | `dispatch.mjs` geospatial candidate query with expanding configured radii | Existing source implementation; live DB/index measurements pending |
| 2. Road-network routing | `dispatch-routing.mjs` OSRM and `google-routing.mjs` Google adapters | Mock/fixture tests only; live connectivity and Ghana road accuracy pending |
| 3. Direction-aware matching | `dispatch-geometry.mjs` movement using earlier/current road ETA | Unit tested; depends on authenticated and reliable positions |
| 4. Constrained dispatch ranking | `dispatch.mjs` eligibility + ETA; `algorithms/ranking.mjs` reusable core | Unit tests for hard eligibility; DB ranking pending |
| 5. Multi-parcel routing/VRP | `multi-parcel.mjs` stop permutations with capacity and deadlines | Unit tested, DB/scale testing required; flag + admin multi-stop control |
| 6. Dynamic pickup-delivery insertion | `multi-parcel.mjs` cost bounded feasible insertion | Unit tested; 10 simultaneous parcels need scale and concurrency tests |
| 7. Transparent cost-based pricing | `pricing.mjs` integer minor-unit fixed/percentage/hybrid | Unit tested; fresh pricing policy version enables **3% per individual delivery** |
| 8. Commission exposure control | `finance.mjs` outstanding+active reservations under rider/account locks | Backend source; real PostgreSQL concurrency unverified |
| 9. Ledger/reconciliation/idempotency | `finance.mjs`/schema journals and payment-event references | Backend source; actual PSP webhook and DB reconciliation blocked |
| 10. GPS filtering | `algorithms/gps.mjs`, gated in rider position API | Unit tested; physical GPS fraud protection not verified |
| 11. ETA calibration | `algorithms/eta.mjs`, gated by historical verified pickup OTPs | Unit tested on fixtures; needs operational data and validation |
| 12. Fraud/anomaly rules | `algorithms/fraud.mjs`, gated cash shortfall/OTP signals and admin review | Unit tested; no automatic punishments; not a proven fraud classifier |

**Further optional modules:** `algorithms/corridor.mjs` (road-derived remaining route), `algorithms/batch.mjs` (small-batch exact cost minimization for *advisory* fleet preview), multi-rider offer broadcasting.

## Road corridor example: Kasoa → Tema via Lapaz

1. For a route-compatible vehicle, the routing adapter computes genuine road geometry of the driver's remaining accepted stop itinerary. This becomes a time-limited PostGIS indexed corridor. Google encoded polylines and OSRM GeoJSON are supported; if provider supplies no road geometry, no corridor is fabricated.
2. New Weija → Kwashiman and Mallam Junction → Madina shipments **may** discover a route-matched rider even when their current GPS position is far from pickup. PostGIS tests corridor proximity *ahead of the rider*, not just past road segments. A static nearby search is still available.
3. The full pickup and drop-off insertion must pass the vehicle-capacity, available weight, promised deadline, max detour, and road ETA checks before offering. An order's pickup proximity to Lapaz road alone NEVER suffices.
4. Corridor revision changes invalidate old route geometries; the periodic worker re-routes remaining stops. Only accepted, verified road provider routes can establish a corridor; no traffic/map matching precision is invented.
5. Road ETA ranking and rider availability still apply. Multiple parcels require both feature flags and the policy toggle, per-rider opt-in and final transaction-safe acceptance.

## Broadcast each eligible rider, not only the first candidate

The new `multi_rider_broadcast` flag changes dispatch from one rider to **every eligible rider in the configured discovery shortlist**. All passing candidates receive their own expiring `dispatch_offers` row, plus one rider-addressed transactional outbox event. The native rider app polls for offers every ~10 seconds in the foreground. A delivery is atomically awarded to the FIRST **valid** acceptance; all other open offers are invalidated in the SAME shipment transaction. The existing unique index on `dispatch_offers(shipment_id) WHERE status='accepted'` is retained. This is NOT a guarantee that every registered driver nationwide gets an offer. Routing matrix batches are capped to 30 origins per provider request; administrator candidate_limit may be raised to 200 subject to cost and latency testing.

**Missing for reliable background notifications:** an operational push-token registry plus authorized push provider/outbox delivery worker, Expo/FCM/APNs credential setup, Android/iOS physical device verification. Unconsumed outbox events are **not** proof a remote device saw an offer.

## Per-order commission: default 3% (300 bps)

A new versioned pricing policy in migration 014 replaces a previous active policy's commission terms with 300 bps while preserving earlier accepted quotes and historic policies. When no prior active policy exists, administrators must configure the actual base and per-km fares; rates are not invented. For **each successfully completed delivery order** (not per batch), the locked shipment quote's commission is posted exactly once by the financial engine. Ten independent GH₵30 completions generate ten GH₵0.90 commission entries, totaling GH₵9.00. Physical cash in a rider's hand is NOT collected platform funds; record the commission receivable until provider-verified repayment. Cancelled/unverified orders do not generate normal success commissions.

## Mobile-only administrator rollout sequence

1. Install/migrate on staging with PostGIS and PostgreSQL (do not alter 001–010 migration checksums). Run all tests and measure DB concurrency first.
2. Sign into the native app using an **authorized** administrator with `dispatch:configure`. Open the administration area and load the verification queue / algorithm controls.
3. Verify rider/car onboarding and approved logistics company membership. Feature flags are audited and role-checked on the server, not decided by mobile display.
4. First enable `multi_parcel_vrp` and `dynamic_pickup_insertion`; then configure `multi_stop_enabled` and max active parcels (1–10). Default stays conservative. Feature activation must NOT interrupt existing custody duties.
5. After route-geometry validation, enable `road_corridor_discovery`; subsequently enable `multi_rider_broadcast`. Monitor route-provider costs, latency and offer acceptance contention.
6. Enable `gps_filtering`, `eta_calibration`, `fraud_signals`, or advisory `fleet_batch_optimization` only with controlled pilot measurements. The mobile admin app can list and change flags, stage country records, read manual risk reviews and inspect a limited fleet recommendation preview.
7. **Worldwide:** service_markets stores staged ISO country+currency settings, but non-Ghana activation intentionally returns HTTP 409. Ghana-only phone validation, fare currency, local providers, country coverage, tax and regulatory review must be made fully international BEFORE foreign launches. Neither a UI toggle nor a country row implies legal/safe operations worldwide.

## Architecture invariants

- Hostinger is NOT part of the business domain; portable VPS configuration is maintained under `deploy/vps/`.
- Preserve DB transaction locks, OTP actor/shipment binding and finance journal immutability.
- Preserve company/rider tenant boundaries and actual assigned rider identity; never infer delivery completion from GPS alone.
- Exact money arithmetic, not floating point; cash settlement is a receivable until confirmed.
- City/country scope, dispatch eligibility, maximum detour and pricing all require authoritative per-market rollout before a global business is declared active.

**Operational note:** In the mobile app, switching on `multiStopEnabled` automatically enables `multi_parcel_vrp` and `dynamic_pickup_insertion` in the SAME audited server transaction. Their underlying feature switches may also be staged individually, but a new pooled assignment requires the overarching multi-stop policy and rider opt-in.
