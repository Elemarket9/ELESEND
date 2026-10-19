# ELESEND — Four Payment Methods Engineering Delivery

Date: 18 October 2026 (UTC)

**Release decision: HOLD — UNVERIFIED RELEASE CANDIDATE**

## Inputs and evidence

- Source: `ELESEND_ALL_12_ALGORITHMS_ENGINEERING_CANDIDATE_UNVERIFIED.zip`
- Input archive SHA-256: `b30e4a784ad7ac6447b5fa8912713e07b98d0e1e4d73565a748c0ec0ac6dfc7c`
- Source edits took place in a working copy; earlier ZIP was not rewritten.
- Backend runtime available here: Node `v22.16.0`.
- Unit and static tests in `full-unit-results-2026-10-18.txt`:
  - **65 passed, 0 failed.** Tests include the original twelve-algorithm suite, new payment policy/PSP adapter checks, and two mobile source contract checks.
- Syntax checks in `syntax-check-results.txt`: **53 backend/scripts/tests `.mjs` files parsed.** Backend/mobile package JSON parsed.
- Complete combined suite: **65 passed, 6 errored** because required `pg` / `zod` packages were not installed. See `complete-suite-attempt-2026-10-18.txt`.
- `npm ci --offline`: failed `ENOTCACHED` for `zod`; cannot install dependencies from local cache. See `npm-offline-attempt-2026-10-18.txt`.
- No actual PostgreSQL/PostGIS database, Redis instance, Expo Android build environment, Android/iOS device, Google Maps live routing, or licensed PSP credential supplied here.

## Functional code delivered

### Customer payment acceptance

- Native React Native checkout method selection: `CASH`, `MOMO`, `CARD`, `QR` (only enabled policy methods displayed).
- CASH: existing rider cash report + individual successful-delivery receivable and OTP controls preserved.
- MOMO: server-created hosted mobile-money checkout through optional Paystack adapter; provider verification required.
- CARD: server-created hosted card checkout; no raw PAN/CVV handled in ELESEND app/backend.
- QR: React Native QR of a verified HTTPS provider checkout URL; scans to secure hosted checkout and payer completes via available card/MoMo. **NOT a GhQR/EMV merchant QR rail**. Explicit national merchant QR support remains separately blocked.
- New mobile UI handles checkout launch, QR rendering, payment status refresh and pending/error guidance. New native dependencies are declared, **not installed or compiled**.
- Non-cash bookings stay in `AWAITING_PAYMENT` until authorized verification; payment screen navigation does not count as paid.
- Original legacy `DIGITAL` database/API fallback retained for existing integrations/tests, but intentionally not presented as a new mobile checkout choice and not accepted by the new checkout endpoint.

### Provider-neutral backend

- `checkout.mjs` owns method policy, idempotent payment intents, provider capability gating, customer authorization, settlement transitions, reconciliation and refund-review queue.
- `checkout-policy.mjs` validates verified amount, currency, channel, reference, event and TLS checkout host.
- `paystack-checkout-adapter.mjs` is an optional, isolated adapter; it validates PSP HMAC signature and independently retrieves transaction status from PSP before claiming success. On production boot it rejects a test secret key.
- `checkout-accounting.mjs` creates double-entry, immutable financial events for verified customer funds and completed individual deliveries; never treats PSP receivable as bank cash deposited.
- Partial/short/unexpected/late payments get immutable `checkout_unapplied_payments` evidence and accounting against `customer_refund_liability`; no fraudulent delivery authorization.
- Payment provider configuration is in environment/server composition only. No fixed VPS company is embedded in ELESEND domain logic.
- Optional same provider also exposes commission MoMo hosted checkout and separately authenticated commission payment webhook, preserving rider cash commission due-versus-paid accounting.

### New additive database migrations

- `017_checkout_cash_momo_card_qr.sql`: extend checkout methods and create admin method policies, immutable intent terms, confirmed PSP evidence and unique open-intent guard.
- `018_digital_checkout_accounting.sql`: double-entry customer PSP receivables, delivery liabilities, rider payable, platform commission, refund-review liability; immutable journals and deferred balanced-journal DB trigger.

### New secure HTTP APIs

- `GET /api/v1/payments/methods` — effective payment methods for logged-in users.
- `GET /api/v1/admin/payments/methods` — admin review.
- `POST /api/v1/admin/payments/methods` — permission `payments:configure`, admin can enable/disable available `MOMO`, `CARD`, `QR`; cannot disable financial verification checks.
- `GET /api/v1/admin/payments/exceptions` — inspect verified payments requiring refund investigation.
- `POST /api/v1/shipments/{id}/checkout` — customer-owned, idempotent, server-side PSP checkout creation.
- `GET /api/v1/shipments/{id}/checkout` — view pending/confirmed checkout for its owner.
- `POST /api/v1/payments/checkout-webhook` — signed PSP callback, verified again with PSP API, transactional and idempotent posting.
- Existing `/api/v1/payments/commission-webhook` kept separate.

## Requirement status

| Requirement | Status | Evidence / limitation |
|---|---|---|
| Cash booking | PARTIAL | Source preserved; prior unit proofs; actual DB tests unavailable |
| MoMo acceptance | PARTIAL | Optional live-provider adapter and unit tests; merchant credentials/live settlement not tested |
| Card acceptance | PARTIAL | Hosted checkout adapter and unit tests; no PSP real payments or chargeback tests |
| QR checkout-link acceptance | PARTIAL | Native QR UI added and source checks; provider-hosted URL integration and native build not verified |
| GhQR/interoperable bank merchant QR | NOT IMPLEMENTED | Different certified payment rail; requires PSP-specific support |
| Admin method activation | PARTIAL | API/policies/permissions wired; no actual DB migration test |
| Idempotent customer payment recording | PARTIAL | Transactions/uniqueness in source and DB migration; live DB concurrency untested |
| Signed payment webhooks + independent PSP confirmation | PARTIAL | Adapter unit tests passed, no live PSP access |
| Cash commission per successfully completed order | PARTIAL | Earlier ledger preserved; needs full DB E2E |
| Digital commission per successfully completed order | PARTIAL | Balanced journal code/migration added; DB E2E untested |
| Rider MoMo commission repayment | PARTIAL | Optional adapter added; payout/regulatory/live reconciliation blocked |
| Late/short PSP payments and refund-review evidence | PARTIAL | Source and schema implemented; refunds NOT executed |
| Actual PSP settlement, refunds, chargebacks, rider payouts | BLOCKED / NOT IMPLEMENTED | Provider accounts and integration work required |
| All twelve algorithms | PARTIAL | Existing modules retained, 65 unit/source tests pass; not proven fully integrated |
| Native Android/iOS build | BLOCKED | Expo dependencies/toolchain unavailable; NOT compiled |
| OTP SMS live sending | BLOCKED | Configured SMS adapter not supplied |
| Multi-country payment operation | NOT IMPLEMENTED | Current operating currency/phone format Ghana-specific; don't enable other markets |
| Full PostgreSQL/PostGIS concurrency and migration tests | BLOCKED | Local DB and `pg` not available |
| Provider-neutral portable VPS deployment | PARTIAL | Env-driven VPS compose updated for optional PSP; not deployed |

## High-priority remaining release blockers

1. Install packages (`npm ci` in backend and `npm install` or Expo-install matching native app dependencies), test native QR rendering on actual Android and iOS builds.
2. Start a dedicated PostgreSQL/PostGIS test database and execute migrations `001` through `018`; run all `npm test` suites including the new `checkout-db.test.mjs`. Verify fresh + prior-version upgrade, rollback and concurrency.
3. Apply real, approved PSP sandbox credentials and configure **both webhook endpoints** behind HTTPS. Run MoMo, card, hosted QR checkout, duplicate/forged signature, canceled shipment, delayed webhook and independent provider verification tests.
4. Build regulated/refund workflows: PSP-authorized refunds, chargeback handling, provider/bank settlement reconciliation and rider payout settlement; verify exceptions don't remain unresolved.
5. Complete live SMS rider-bound OTP delivery testing (including multi-parcel) and native background push notification/service reliability.
6. Ensure administrator permissions are provisioned to existing admin users via reviewed least-privilege migration/operator process; new `admin:create` includes `payments:configure`.
7. Market operations: licensing, courier obligations and payment-processor channel approval in each planned market; do not turn on new countries merely because global architecture exists.
8. Validate production secrets, egress, rate limits, GPS privacy, complete mobile test flows, disaster recovery, encrypted offsite backup restoration.

## Exact reproducible commands

```bash
# Backend (from ELESEND directory)
npm ci --ignore-scripts
npm run test:unit
TEST_DATABASE_URL=postgres://.../elesend_test npm run test:payments:db
TEST_DATABASE_URL=postgres://.../elesend_test npm test
DATABASE_URL=postgres://.../elesend node scripts/migrate.mjs

# Mobile (from ELESEND/apps/mobile directory)
npm install
npx expo-doctor
npx expo run:android
# iOS requires eligible Mac toolchain or build service
```

Provider-specific keys MUST remain on the server, not in mobile `EXPO_PUBLIC_` variables. Keep digital methods disabled until PSP and legal readiness are verified, and do not mistake a green unit suite for a safe production rollout.
