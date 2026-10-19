
## Security candidate update (18 October 2026)

See `SECURITY_RELEASE_CANDIDATE_2026-10-18.md`. Admin authentication now requires separately provisioned TOTP MFA; all prior admin sessions are rejected. Run database migrations through `020_verified_mobile_identity.sql` and provision approved SMS transport before a **production** booking can proceed. Existing customers, companies and riders must verify their registered Ghana phone; unverified riders are paused for NEW dispatch offers. The source is **not production verified**, and live payments, SMS arrival, real database concurrency, and mobile APK/IPA builds remain untested here.

Commands: `npm run test:unit`, `npm run test:security`, `npm test` (needs running Postgres/PostGIS and installed dependencies), `npm run admin:mfa:provision` (requires secure operator environment). Do not store `ADMIN_TOTP_SECRET_BASE32` or `ADMIN_MFA_ENCRYPTION_KEY` in mobile `EXPO_PUBLIC_*` variables.

> **18 October 2026 payment upgrade — UNVERIFIED release candidate.** Customer payment
> choices now include CASH, MOMO, CARD, and QR-to-hosted-checkout (NOT national GhQR).
> CASH is available by default; digital methods require an authorized PSP adapter,
> admin activation, verified webhooks, and independent provider reconciliation.
> No APK, DB integration, or live payment verification has been completed for this upgrade.
> See `documentation/FOUR_METHOD_PAYMENT_INTEGRATION.md` and
> `documentation/payment-upgrade/ENGINEERING_REPORT.md` before any deployment.

> **ENGINEERING CANDIDATE (2026-10-18): 12 algorithms implemented and fixture-tested, NOT production verified.**
> Read `documentation/twelve-algorithms/ENGINEERING_DELIVERY.md` before deploying.
> Run `npm run test:algorithms-full` for deterministic tests; `npm test` and migration 015/016 require real dependencies/PostgreSQL.
> Keep multi-stop/global expansion/payment features behind permissioned activation until real-world verification.

# ELESEND — Cash-first Ghana logistics (Android / iOS)

**Engineering source candidate · 17 October 2026 · RELEASE HOLD — NOT READY FOR REAL-MONEY PUBLIC OPERATIONS**

This archive contains an independent **React Native/Expo Android/iOS app** (`apps/mobile`) and a **Node.js modular-monolith JSON API** (`services/api`) to run on a **provider-neutral VPS**. No ELESEND customer web portal is deployed. The API serves native apps and future authorized business clients; it does not depend on ELEMARKET. All monetary integers represent **GH₵ pesewas**; the platform does not claim to hold cash merely because a rider reports receiving it.

## What is implemented in source

- **Cash-first booking:** `CASH` or `DIGITAL` quote/booking; sender/recipient is designated the cash delivery payer; cash can enter dispatch without a PSP-paid flag. **Digital checkout is NOT operational without a verified PSP.** Rider manually submits a once-only cash report at the relevant handover. Recipient/pickup OTP is separate and mandatory. Normal completed cash deliveries now require full rider-reported delivery-fee collection; zero/partial collections must enter the explicitly unresolved dispute/return process (not a false paid delivery).
- **Commission recognition:** after authenticated assigned-rider recipient OTP, in one database transaction with delivery completion, immutable double-entry journal debits rider commission receivable and credits platform earned revenue; it does **not** record cash physically received by ELESEND. Rider's physical cash report remains specifically labeled **unverified**. Per-job obligations/due dates/allocations, exactly-once journal keys, administrative two-person adjustments, postpaid limits and prepaid credits gate.
- **Settlement interface:** rider views outstanding commission vs prepaid credits, can initiate provider-neutral payment, and provider adapter contract requires independently **verified** provider event before journal posting. **No live PSP adapter is installed; commission payments correctly return HTTP 503 until configured.** Prepaid credits OFF by default and need legal/provider approval. Verified PSP repayment over-collections now remain in a distinct reconciliation liability instead of failing accounting or becoming automatic credits.
- **Intelligent dispatch:** PostGIS staged eligible-rider searches, actual road ETA based ranking, direction evidence, request capacity, route stop insertion, expiration/acceptance under row locks, controlled multi-parcel delivery with per-shipment OTP. Multi-parcel default OFF until concurrency and custody test pass.
- **Vehicle onboarding:** motorcycles and cars among typed vehicle categories. Cars need submitted plate/make/model and separate independent manual vehicle approval. Admin controls pilot limits via native operations screen; vehicle proof/document archive remains outstanding.
- **Google integrations:** a backend **Google Routes REST adapter** and native **Google Maps** implementation with separate platform-specific SDK keys; Android/iOS Expo location tracking with permission checks. Other road-routing providers use an isolated adapter. **No live Google API call, device GPS measurement, or traffic accuracy validation was performed in this execution.** Google two-wheeler may have beta limitations.
- **Portable VPS:** example isolated PostGIS 18, Node API, TLS reverse proxy, encrypted remote backups script, disk monitor; not deployed/tested here. Redis is optional and not authoritative; no independent service required for pilot.

## Get started in a NON-PRODUCTION development environment

Prerequisites: Node.js 22.16+; PostgreSQL with PostGIS for database routes; npm network access; Expo/Android or iOS build tools for apps. The source ZIP **does not contain dependencies, credentials, executable APK/IPA or deployed services**.

```bash
npm ci
cp .env.example .env
# Configure DATABASE_URL, 64-hex OTP_KEY, Google Routes API or controlled OSRM endpoint.
npm run db:migrate
npm run admin:create    # with an authorized ADMIN_PHONE / ADMIN_PASSWORD
npm run test:unit
# CAUTION: TEST_DATABASE_URL must be a disposable DB named elesend_test*; DB tests TRUNCATE tables.
TEST_DATABASE_URL=postgres://.../elesend_test npm test
npm start
```

Native app:

```bash
cd apps/mobile
npm install
cp .env.example .env  # HTTPS backend API and app-restricted native Google Maps SDK keys
npx expo install --check
npx expo run:android     # requires actual native Android toolchain
# iOS requires an eligible Apple/macOS build environment or hosted EAS build.
```

The Expo app is source-level ONLY; compilation, install/signing, permissions and performance remain unverified. Use real-device builds to assess Android background location restrictions, phone battery/thermal load and Google API billing. Do not put the server-side Routes API key in an APK.

### Source layout

| Directory | Purpose |
| --- | --- |
| `database/migrations/001...010` | append-only migrations; `009_cash_finance.sql` adds cash, immutable journals, receivables/allocations |
| `services/api/finance.mjs` | rider cash evidence, commission ledger, credits, settlement and two-person admin adjustments |
| `services/api/pricing.mjs` | exact-integer commission/quote calculations |
| `services/api/google-routing.mjs` | Google Routes/Matrix provider adapter (real HTTP contract, locally mocked) |
| `services/api/dispatch.mjs` | road ETA, tenant/rider eligibility, multicargo stop scheduling, debt exposure checks |
| `services/api/platform.mjs` | bookings, OTP custody, parcel completion and ledger hooks |
| `apps/mobile` | React Native Android/iOS customer, rider and authorized operational screens |
| `deploy/vps` | VPS staging template, HTTPS, off-site backup and storage alerts |
| `tests/` | standalone deterministic unit suite and **unexecuted** PostGIS/OTP/concurrency integration suites |
| `documentation/` | engineering evidence, financial controls, VPS provider deployment, inherited prior-stage design files |

## Safety and feature gates

**Never mark a PSP settlement as paid from screenshots, client responses or unauthenticated webhooks.** The running server currently configures the settlement adapter and SMS adapter as `null`; recipient OTP cannot be sent, and completion fails closed. A cryptographically verified PSP integration with reconciliation, suitable SMS provider, phone and identity evidence checks, appropriate insurance and operational review, production secrets, offsite restore tests, and a physical-device pilot must precede live operations.

COD **merchandise value** (e.g., customer paying GH₵500 for goods plus GH₵30 delivery) is NOT supported; do not treat the app's delivery-charge cash field as a merchant merchandise remittance. Reversals, refunds, manual collection disputes and complete statement exports are NOT ready. Currently riders can see accounting evidence, but the only way to settle is through a future verified PSP adapter; **a posted commission debt is not collection of revenue**.

For instructions, explicit PASS/PARTIAL/BLOCKED classifications and test conditions see [`release-readiness.md`](release-readiness.md), [`documentation/cash-finance-integration.md`](documentation/cash-finance-integration.md), [`documentation/vps-deployment.md`](documentation/vps-deployment.md) and [`documentation/engineering-evidence.md`](documentation/engineering-evidence.md).

## High-grade dispatch/corridor/market engineering candidate (October 18, 2026)

Read `documentation/high-grade/ALGORITHM_AND_ADMIN_OPERATIONS.md` and
`documentation/high-grade/VERIFICATION_REPORT.md` before attempting staging deployment.
Migrations 011–014 introduce rider-addressed concurrent dispatch offers (one
valid assignment still guaranteed by database uniqueness), PostGIS **provider-
route-derived** road corridors, 15 admin dispatch feature switches, bounded
advisory batch matching, verifiable 3%-per-successful-order pricing terms, risk
review, and Ghana-first market activation controls. Mobile admin screens handle
feature rollout; no new customer-facing website has been added.

**HOLD:** no live payment/SMS/routing verification, no real PostgreSQL concurrency
suite run in this environment, no native APK/IPA build, and no background push
provider. Do not deploy for public cash-handling or international operations yet.
