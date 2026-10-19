# ELESEND Native Multi-Parcel Engineering Evidence

## Scope and preservation

Input was the supplied `ELESEND_INTELLIGENT_DISPATCH_ENGINE.zip`. This package is a derived candidate. No files were written back into or removed from either uploaded source ZIP. Historical ELEMARKET source references were excluded from this derived package and are not used at runtime. The legacy browser portal was removed from this derived candidate. The backend serves only HTTP JSON and `/health`. The mobile client is native React Native source.

## Significant changes

1. `database/migrations/008_mobile_multidrop_car.sql`: new admin configuration boundaries; `rider.multi_stop_opt_in`; separate vehicle verification, revisioned route plans, per-parcel delivery commitments, offer snapshot fields; replacement of the unique-active-rider index with a **PostgreSQL trigger** serializing capacity/rider policy. Policy change defaults OFF and does NOT invalidate existing custody.
2. `services/api/multi-parcel.mjs`: generate legal pickup-before-dropoff insertion schedules, vehicle peak-load calculation including already picked-up parcels, route-time evaluation of each leg and bounded detour/deadline validation. Cached repeated legs within a candidate route search.
3. `services/api/dispatch.mjs`: PostGIS search includes verified car restriction, opt-in and combined weight, rejects failed/return custody, calculates provider road ETA and insertion plans. Offers store immutable proposed stops/manifest version/position anchor; acceptance checks current rider auth, position, vehicle, route revision, active custody count, pricing, policy and capacity. Inserting second shipment and commitment occurs in same DB transaction.
4. `services/api/platform.mjs`: car registration required fields; manual registration review; challenge initiation and verification require the NEXT route stop; accepting more parcels is blocked while active OTP challenge remains; each shipment keeps its own OTP and unique immutable financial allocation.
5. `services/api/vehicle.mjs`: rider-specific car profile submission, re-verification on changes, separate admin review, car cannot go online or enter dispatch until manually approved.
6. `apps/mobile`: Android/iOS app role experiences, secure-token device storage, GPS permission/shift tracking, rider offers and upfront earnings, sequential parcel OTP, native map quote UI, car onboarding, limited company/admin workflows. No public web portal.

## Executed in authoring environment

- `node --check` API modules: passed.
- `npm run test:unit`: **11 passed, 0 failed** (6 inherited dispatch unit tests + 5 new multi-parcel unit tests). All routing data synthetic. Early test assertions incorrectly assumed that cargo must overlap even when a dropoff-first route exists. Tests were corrected to distinguish simultaneous cargo from lawful dropoff-before-pickup; suite rerun passed.
- TypeScript's JSX parser against `apps/mobile/App.js`, `index.js`, `src/api.js`, `src/tracking.js`: all parsed with zero parse diagnostics. **This is not an Expo Metro build or native runtime test.**
- `npm ci --offline`: dependency tarballs not cached; package install unavailable. A separate online `npm ci` attempt timed out; we could not compile the mobile binary or run tests requiring `pg` and `zod`.
- `test:db` is written to require a strictly disposable `elesend_test...` PostgreSQL/PostGIS database. None was available here; no integration PASS is claimed.

## Important limitations / risks

- Integration of payment providers, cancellation/refund processing, live SMS, routing infrastructure, phone verification, device anti-spoof, accurate geocoding, real-world driver tracking, missed mobile background work, test-native APKS, TLS ingress, push notifications, OS kill/restart behavior, secure document storage and continuous telemetry are release blockers.
- PostgreSQL migration/trigger behavior, driver/car restrictions, multi parcel optimistic revision claims, database deadlocks and peak concurrent acceptance require destructive sandbox DB tests and fault injection. Do not enable multi-stop in production until validated.
- Road ETA calculation has no traffic data and OSRM profiles are not evidence of Ghana legal road access. A configured router must represent actual vehicle limitations. Route estimate deadline preservation is conditional on routing data quality.
- Driver route plans do not constitute a GPS anti-spoof guarantee. No operational emergency/forced-reassignment after pickup is automated. Human exception controls must be completed before launch.
- Native passenger capacity or passenger transportation is outside ELESEND's parcel-delivery scope. Car registration means cars carry **parcels**, not passengers.
- Existing browser-app documentation from before this revision is historical, not release evidence for the native candidate.

## Reproduction

`npm run test:unit` (Node 22+); `npm ci` first when dependencies available for DB tests; then `npm run db:migrate` and `npm run test:db` pointed at a disposable PostGIS `elesend_test` database. For mobile, follow `apps/mobile/README.md` and install native dependencies with `npx expo install` before Android/EAS builds. Full release HOLD status in top-level `release-readiness.md`.
