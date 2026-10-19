# Engineering evidence register — current candidate

Date: 2026-10-17 UTC. Working input was the user-provided `ELESEND_NATIVE_MULTIPARCEL_CAR_DISPATCH.zip`, extracted to an isolated working directory. Original uploaded ZIP remains unchanged. This record is about the new cash-first candidate only.

## Actually executed in this environment

- Runtime: `node --version`: Node 22.16.0.
- `npm run test:unit`: **25 tests / 25 passed / 0 failed**. Direct deterministic tests in `tests/dispatch-unit.test.mjs` (6), `tests/multi-parcel-unit.test.mjs` (5), `tests/google-routing.test.mjs` (5), `tests/pricing.test.mjs` (5). The Google HTTP calls are mocked, not live. Simulated microbenchmark in a unit fixture is **not** evidence of dispatch DB or Google routing performance.
- `node --check` successfully parsed all API modules, scripts, non-JSX mobile support modules, and all tests.
- TypeScript's JSX parser checked `apps/mobile/App.js` successfully: **0 parse diagnostics** after correcting an admin-screen syntax error. Source JSX parsing is **not** Metro/Gradle/Xcode binary compilation.
- Installed Node dependencies: **not installed**. An attempted `npm ci` could not resolve external packages from this sandbox environment. Database-backed tests could not be executed due to unavailable PostgreSQL/PostGIS runtime. Native APK/IPA build could not be executed due to unavailable network/native toolchain.

## Authored, but NOT executed

- `tests/cash-finance-db.test.mjs`: real PostgreSQL suite scaffolding for cash booking/OTP/accounting, rider identity restrictions, partial settlement, duplicate PSP events, postpaid limit, credits and dual-admin compensation. **Sandbox adapter is fake and must never be used in production.** Suite needs `TEST_DATABASE_URL` pointing at dedicated `elesend_test*` with PostGIS; suites may expose bugs that need remediation.
- Existing `tests/platform.test.mjs`, `tests/dispatch-db.test.mjs`, `tests/multi-parcel-db.test.mjs` require real dependencies/DB; original outdated browser-root test was updated to assert the ELESEND backend exposes an **API and no website**.
- `database/migrations/009_cash_finance.sql` plus `010_cash_custody_guards.sql`: PostgreSQL DDL syntax and effects are UNVERIFIED. No real migration, clean rollback or old-dataset preservation test ran.
- `deploy/vps/*`: configuration/scripts are STAGING TEMPLATES. No container build, deployment, HTTPS certificate issuance, backup upload, restore, profiling or 20GB-limit test ran.
- Google Routes API adapter uses a real HTTP protocol and appropriate key boundaries; it was tested against fake `fetch`, not a live Routes provider, no road/corridor accuracy verified.
- Physical-cash collection truthfulness, actual funds settlement, Ghana carrier/courier regulatory status, live provider signatures and iOS/Android location reliability cannot be inferred from deterministic tests.

## Minimum reproducibility sequence

```bash
npm ci
npm run test:unit
for f in services/api/*.mjs scripts/*.mjs tests/*.mjs; do node --check "$f"; done
# DO NOT point at real data. Tests TRUNCATE tables.
export TEST_DATABASE_URL='postgres://.../elesend_test'
npm run test:db
npm test
# Native build requires Expo dependencies and separate Android/iOS toolchain:
cd apps/mobile && npm install && npx expo install --check && npx expo run:android
```

## Scope gaps mapped to directive

- Cash payment: core workflow source partial; genuine customer/rider reconciliation requires disputes, claims and settlement confirmation.
- Ledger: immutable source partial; financial integration tests not performed.
- Settlement: provider-neutral service contract partial, actual licensed PSP, encrypted webhook auth, refund/chargeback reconciliation blocked.
- COD merchandise: NOT IMPLEMENTED. No product-value accounting/merchant remittance.
- Pricing: integer arithmetic unit PASS; configurable commercial matrix limited to base/km/commission, extras surcharge tiers/vehicle/wait time NOT IMPLEMENTED.
- Multi-parcel: deterministic unit PASS; DB and physical concurrency/custody blocked, feature OFF.
- Vehicle signup: implementation partial; verification workflow missing evidence upload.
- Google Maps: adapter/mock PASS only; real provider/location correctness blocked.
- Admin: native policy/finance queue source partial, true MFA/documentation automation outstanding.
- Offline: encrypted read-only cache partial; guaranteed delivery of GPS events/notifications not proven, offline cash submission and OTP completion intentionally unavailable.
- VPS provider deployment: template partial; backups/recovery unverified.

**No verified claim of a completed release or of funds collected by ELESEND.**


## Deep audit supersession notice

The top of this evidence register describes an **earlier revision** and must not be treated as newly executed evidence for these fixes. For this exact ZIP, consult [`../DEEP_SECURITY_AUDIT_2026-10-17.md`](../DEEP_SECURITY_AUDIT_2026-10-17.md) and [`../test-results.md`](../test-results.md). No PostgreSQL, mobile binary or actual provider integration was executed in this deeper-audit pass.
