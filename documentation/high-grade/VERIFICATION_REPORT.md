# ELESEND — Engineering verification report (18 October 2026, UTC)

**RELEASE DECISION: HOLD.** This artifact contains executable source-code changes and repeatable tests, but is **not** production certified. Do not use for public cash/MoMo handling, unrestricted multi-parcel services or global country activation yet.

**Input archive:** `ELESEND_DEEP_AUDITED_PROVIDER_NEUTRAL_UPGRADE.zip`

**Input SHA-256:** `43a96a5a42e8af0d34e13631a6685222aa3f53773d511623bf4b261e58eecdc7`

The original input archive was not modified. The new package was built from an extracted copy of that input. No production credentials or private customer records have been injected.

## Implemented changes and code pointers

1. **12 core algorithms:** existing PostGIS discovery, Google/OSRM route ETAs, movement classification, rank/eligibility filtering, stop-insertion optimizer, cost-based pricing, cash credit exposure, and immutable accounting; added distinct reusable `algorithms/{gps,eta,fraud,ranking}.mjs` and gated connections to live code. Exact statuses in `ALGORITHM_AND_ADMIN_OPERATIONS.md`.
2. **Dynamic road corridor matching:** `algorithms/corridor.mjs`, `dispatch.mjs`, migration 011. Google encoded polyline/OSRM road geometry converted to geography LineString. A PostGIS indexed future corridor search joins routes close to *future road segments* not only current rider location, followed by actual road ETA and deadline/capacity checks. No straight-line route is fabricated if geometry unavailable. Optimistic revision invalidation and periodic conservative corridor refresh added.
3. **Broadcast to every detected eligible rider:** `dispatch.mjs` + migration 011. Multiple expiring offered states per shipment; distinct rider-targeted outbox event per eligible driver. One accepted-offer partial uniqueness index preserved, loser offers invalidated under same locked transaction. Discovery candidate limit adjustable to 200; routing matrix batched to 30 per call. **Foreground-native polling works by source design; background pushes are NOT operational without a push adapter.**
4. **3% commission on EVERY completed order:** `platform.mjs`, migration 014, `pricing.mjs` existing. Admin-created policies default to 300 bps. Existing active policies are versioned to a new 3% policy without rewriting old quotes or historical financial records. One completed parcel generates one independent financial obligation/entry, not one commission per trip. Cash receivable remains distinct from confirmed platform cash.
5. **Admin on/off controls:** migration 011 + `algorithms/features.mjs`, `dispatch.mjs`, `http.mjs`, React Native `apps/mobile/App.js`. Fifteen feature switches cover the twelve algorithms plus corridor, broadcast and batch advisory, with authorization and audit records. Core mandatory safety algorithms cannot be disabled. Multi-stop control atomically activates prerequisite algorithm switches and supports admin-configurable 1–10 parcels.
6. **Fraud signals and investigation:** `algorithms/fraud.mjs`, `finance.mjs`, `platform.mjs`, migration 013; reversible review status with immutable evidence and audited admin decisions. Flags are review hints only, never proof or automatic rider punishment.
7. **Batch dispatch optimization preview:** `algorithms/batch.mjs` and `dispatch.previewFleetBatch()`. Bounded 4-job/20-rider exact bipartite cost recommendation (read-only; does not silently assign or hold money).
8. **Worldwide rollout staging:** `markets.mjs`, migration 011, admin native screen. Register ISO country/currency market records, inspect, and safely pause Ghana bookings. **Foreign market activation is blocked** (409) until real localization, payment/currency, phone, geographic coverage and regulatory capabilities exist. It is intentionally NOT a worldwide production system yet.
9. **Hosting portability:** generic `deploy/vps` configuration retained; no hardcoded Hostinger logic in the backend.
10. **New/reproducible tests:** `tests/advanced-algorithms.test.mjs`, `tests/architecture-static.test.mjs` (executed), `tests/broadcast-db.test.mjs` (written, but not executed due missing PostgreSQL/PostGIS and `pg` package).

## Actual test evidence (this working environment)

| Check | Result | Evidence |
|---|---|---|
| `npm run test:unit` | **PASS: 41 tests, 0 failed** | `unit-test-results.txt` |
| Node syntax, `node --check` for backend/scripts/tests | **PASS: all checked files syntactically valid** | `backend-syntax-check.txt` (empty because no errors) |
| Mobile React Native JSX syntax parser / transpile | **PASS: zero syntax diagnostics** | `mobile-jsx-parse.txt` |
| `npm test` combined suite | **BLOCKED: 41 passed, 5 module-load failures** | `full-test-attempt.txt` |
| Dependency install `npm ci` | **BLOCKED: external npm registry DNS unavailable** (`EAI_AGAIN`) | Session evidence; install was attempted online and offline |
| PostgreSQL/PostGIS migrations 011–014 | **NOT EXECUTED** | No usable PostgreSQL binary/server and no `pg` dependency in this environment |
| Real database concurrency/OTP/cash end-to-end | **NOT VERIFIED** | New `broadcast-db.test.mjs` provided for dedicated staging DB |
| Live road provider/traffic/map matching | **BLOCKED** | No provider keys / permitted routing API access |
| Real MoMo PSP reconciliation and SMS OTP delivery | **BLOCKED** | Authenticated production adapters/credentials absent; previous code intentionally fails closed |
| Native Android APK / iOS IPA build & device testing | **BLOCKED** | Mobile dependencies and toolchain unavailable; JSX transpilation is not an APK build |
| Mobile push delivery on background app | **NOT IMPLEMENTED** | Rider-addressed outbox and foreground polling are NOT equivalent to push delivery |
| Backend performance / VPS / backup restoration | **NOT VERIFIED** | No VPS/DB load test environment |

**Important interpretation:** 5 full-suite failures are module import failures (`pg` unavailable), not test assertions showing a failed transaction. This does not imply the unexecuted database behavior works. Existing `platform` tests also require missing `zod`. Unit tests and synthetic routing fixtures do not certify real road ETA or GPS accuracy.

## Remaining release-critical blockers

- Run `npm ci` in a connected staging environment, then start a dedicated PostgreSQL/PostGIS instance, set `TEST_DATABASE_URL` pointing to **a disposable database whose name begins with `elesend_test`**, and run migrations, DB tests, and new broadcast race test.
- Verify migrations 011–014 against a copy of a previous schema, run `pg` concurrency acceptance races and full 10-parcel capacity/insertion tests, and confirm rollback on failures.
- Configure validated routing profiles for motorcycle/car; separately verify road geometry on representative Kasoa → Tema, Weija → Kwashiman, Mallam → Madina trips; measure route API costs and arrival errors. No unverified route is guaranteed compatible.
- Supply licensed/contracted MoMo payment-provider adapter, signed webhooks, idempotency/reconciliation testing, SMS OTP provider and live controlled device tests. Do not bypass these requirements for a green release.
- Build reliable mobile background notifications: secure push token binding, push provider adapters, retry/expiry worker, mobile app permissions, user notification preferences and device tests. Rider app currently polls offers in the foreground.
- Review onboarding/KYC, car legal documents, vehicle requirements and the sufficiency of rider fraud safeguards before enabling public delivery fleet service.
- Complete worldwide work: ISO currencies per quote/ledger, international phone formats, country-zone geometry, localization, international provider registration, payment & tax/legal country enablement. Non-GH rollout remains explicitly blocked.
- Run production-like resource, network interruption, recovery, backup-restore and observability tests on a generic Linux VPS; validate ~20GB operating storage target against measured use.
- Run OWASP and mobile security testing and commission/OTP fraud adversarial cases. Existing tested invariants alone are not a production security certification.

## Reproduction quick start (on a machine with prerequisites)

```bash
npm ci
npm run test:unit
npm run db:migrate   # Use a dedicated, backed-up staging database; NEVER production without migration review.
export TEST_DATABASE_URL='postgresql://.../elesend_test_dev'
npm run test:db
node --test tests/broadcast-db.test.mjs
npm test
```

To build the Android app, install compatible Expo dependencies under `apps/mobile`, Android SDK, and follow `apps/mobile/README.md`. Test real GPS, foreground/background restrictions, network reconnection, rider offer notifications and secure OTP flows on representative physical devices. No executable APK/IPA is shipped in this release-candidate ZIP.

### Release status by subsystem

| Subsystem | Status |
|---|---|
| Reusable source modules for 12 algorithms | PARTIAL — mostly implemented; runtime DB/provider dependencies unverified |
| Road corridor spatial search & provider geometry | PARTIAL — source implemented, spatial DB test missing |
| Multi-rider broadcast & first valid acceptance | PARTIAL — source + DB uniqueness, concurrency not executed |
| Per-order standard 3% policy & integer price math | PARTIAL — unit-tested, 014 migration not executed |
| Rider cash commission ledger / recovery | PARTIAL — existing implementation, real DB and PSP unverified |
| Car and multi-parcel registration / routing | PARTIAL — existing source + flags, not production validated |
| Admin switchboard (native UI) | PARTIAL — server source and JSX parse only |
| Native Android/iOS builds | BLOCKED |
| Real SMS and PSP payments | BLOCKED |
| Worldwide operational activation | NOT IMPLEMENTED — Ghana pilot only; staged countries blocked |
| Full real-money public launch | **HOLD** |

The package intentionally reports incomplete verification, rather than claiming world-class commercial readiness from source edits and mock tests alone.
