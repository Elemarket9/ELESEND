# ELESEND — Security-hardening release candidate, 18 October 2026

**Decision: HOLD. Not approved for public real-money dispatch.** This is a source-code remediation candidate, NOT a production deployment, a compiled mobile app, or a verified payment integration.

## Source baseline and preservation

- Input: `ELESEND_CASH_MOMO_CARD_QR_RELEASE_CANDIDATE_UNVERIFIED.zip`.
- Prior backend, 12 logistics algorithms, rider broadcast and multi-parcel source retained.
- Prior migration files 001–018 retained as-is. New migration files 019–020 are additive.
- No production payment provider, SMS provider, maps or user secrets bundled.
- No hosting vendor hardcoded; `deploy/vps` is a portable deployment example.

## Fixes implemented (source level)

| Severity | Finding | Repair | Verification scope |
| --- | --- | --- | --- |
| CRITICAL | Administrator password-only sign-in permitted stolen-password privileged access. | TOTP-based second factor added. AES-256-GCM encrypted TOTP seeds bound to admin UUID, independently configured encryption key, replay-protected step under PostgreSQL row lock, prior sessions fail closed. Existing admins must provision/rotate MFA before logging in. | Crypto unit tests executed; real PostgreSQL concurrency not verified. |
| HIGH | Delivery SMS adapter absent, making pickup and recipient OTP workflows unusable without a test stub. | Optional provider-neutral HTTPS JSON SMS gateway contract with fixed allowlisted endpoint, Bearer authentication, timeout, redirect denial, sanitized errors, validated delivery-acceptance response. Missing provider fails closed. | Mock transport tests executed; provider-side delivery unverified. |
| HIGH | OTP challenge SMS acknowledgment could race with reassignment, cancellation or challenge expiry. | Confirm SMS gateway acceptance under a fresh shipment row lock; reject stale or changed authority and expire unused challenge. | Source and unit checks only; DB race test pending. |
| HIGH | Account identity registration did not establish ownership of Ghanaian phone number. | Authenticated phone verification challenge + locked-phone SMS + keyed digest + expiry, attempt limits, replay prevention and audit history. Production customer quotes/bookings and new rider online shifts require verified phone. | SMS mock tests/static contract checks executed; Postgres E2E pending. |
| HIGH | Existing unverified riders might continue receiving assignments after upgrade. | Additive migration marks unverified riders offline and invalidates unaccepted offers, while retaining custody of already accepted parcels. | SQL inspection only; migrations not executed here. |
| HIGH | Production API could accept bookings even if essential OTP messaging/dispatch was disabled. | Production quote creation now fails closed without configured SMS contract and dispatch, and demands phone ownership verification. Production still needs a genuinely approved gateway. | Source checks; live operational proof pending. |
| MEDIUM | Mobile administrator login lacked second factor input. | Native app sign-in accepts admin authenticator code, clears password and OTP fields after login. | JSX source parser passed; APK/iOS builds not executed. |
| MEDIUM | No request-specific IP controls on high-abuse registration and login endpoints. | Add DB-backed ingress IP limits in addition to global and per-phone login limits. | Source checks; carrier-grade NAT operational tuning needed. |
| MEDIUM | Routing fixtures could be treated as legitimate quotes in a production-mode injected environment. | Production refuses synthetic quote routing source; regular tests may still use fixtures. | Source check only; provider routing integration pending. |
| MEDIUM | No startup check preventing use of weak/missing/reused administrator encryption key. | Production boot checks 32-byte MFA key and rejects reusing `OTP_KEY`. | Source check. |

### Accounting remains intentionally conservative

- 3% standard platform commission is per **successfully verified individual delivery**, including separate orders in a multi-parcel trip. Historical quotes keep their original pricing policy.
- Cash physically received by a rider is a **rider-reported collection**, not proof of ELESEND's bank receipt.
- MoMo/card/checkout-link QR stay behind authorized PSP adapter and admin payment policy.
- QR here is **hosted checkout URL QR**, not certified Ghana GhQR / interoperable merchant QR.
- No payment screenshot, app callback, GPS event or unsigned webhook can prove platform settlement.

## Verification performed here

- `npm run test:unit`: **74 PASS, 0 FAIL**, including 9 new security/phone/SMS tests; built-in Node test runner with deterministic mocks and isolated algorithm fixtures.
- `node --check` over **57 backend/script/test `.mjs`**: **57 parsed, 0 syntax errors**.
- TypeScript compiler's parser applied to `apps/mobile/App.js` as JSX: **0 parser errors**. This is **not** a React Native build or runtime verification.
- `npm test` (all discovered tests): **74 passed, 6 failed to load**. These 6 were database integration suites unable to import `pg` (`ERR_MODULE_NOT_FOUND`), not passing PostgreSQL tests.
- `npm ci --offline` blocked (`ENOTCACHED` for `zod`); online installation also blocked by DNS (`EAI_AGAIN` for registry.npmjs.org).
- **No** PostgreSQL/PostGIS/Redis instance, native Android/iOS toolchain, approved SMS gateway, official PSP sandbox credentials or real location APIs available in this execution environment.
- **No** production deployment, live SMS arrival, real MoMo/card/QR payment, real refund, real Ghana route-matrix reading, mobile physical-device tests or financial end-to-end tests performed.

## Safe rollout steps (mandatory before public launch)

1. Back up and **restore-test** a representative existing database off-server. Stage this build; do not overwrite the running mobile backend blindly.
2. Ensure compatible PostgreSQL/PostGIS and all dependencies available; execute and verify all migrations 001–020 on fresh and upgrade databases.
3. Generate a dedicated **different** `ADMIN_MFA_ENCRYPTION_KEY` (64 hex chars) and a valid `OTP_KEY`. Keep both server-side and backed up in an approved secure secret manager.
4. For every *existing* administrator, generate a unique 20-byte base32 authenticator seed **offline** and set `ADMIN_PHONE`, `ADMIN_PASSWORD`, `ADMIN_TOTP_SECRET_BASE32`, `ADMIN_MFA_ENCRYPTION_KEY` only within the trusted provisioning environment; execute `npm run admin:mfa:provision`. Confirm 2FA enrollment using a trusted authenticator before revoking the seed from shell/environment history. `admin:create` now also requires MFA provisioned at creation. Existing admin sessions become invalid after migration 019. Losing both the master key and access to admin provisioning can prevent admin login.
5. Configure the approved SMS bridge via `SMS_GATEWAY_ENDPOINT`, `SMS_GATEWAY_ALLOWED_HOST`, `SMS_GATEWAY_TOKEN`. Bridge must accept JSON `{to,message,clientReference}` and return `{accepted:true,messageId:"..."}` only upon provider's durable request acceptance. This is a **contract**, not certification of a specific telecom/SMS provider. Prove SMS arrives on actual Ghana handsets before accepting public orders. Enable high-risk template monitoring and delivery-failure observability.
6. Existing users are **unverified after migration 020**. Communicate and execute a phone re-verification plan; unverified riders are offline for new jobs, but existing custody records are not automatically discarded.
7. On a staging PostgreSQL/PostGIS database, execute all DB integration/concurrency suites and specifically test admin TOTP replay, concurrent OTP consumption, account verification attempt limits and booking before/after verification. Test failed migrations and restoration.
8. Verify PSP sandbox hosted checkout for cash/MoMo/card/QR link, webhook forgery/duplicates, **actual** provider-to-bank settlement, refunds, rider payouts and chargebacks. Never activate approved digital methods based on simulated events.
9. Compile and install signed Android and iOS candidates, test permissions, notifications, navigation, offline sync, cash confirmation, physical OTP, repeated rider broadcasting, 10-parcel route capacity, battery, re-login and mobile app store requirements. iOS signing/build generally requires a Mac or authorized build service.
10. Exercise backup recovery, disk/CPU pressure, worker and Redis crashes, payment-provider outage, SMS-provider outage, road-route outage, concurrent claims and offer expiry on real VPS-equivalent resources.
11. Review courier/vehicle, payment collection, prepaid credits, merchandise COD, insurance, privacy, cross-border operation and local legal requirements before activating countries or financial features. The current end-to-end identity/payment code supports **Ghana only**, despite global-ready registry abstractions.

## Release gates

| Capability | Status |
| --- | --- |
| Admin TOTP cryptographic core | PASS (isolated unit tests) |
| Admin TOTP database/session integration | PARTIAL (source implemented; DB tests blocked) |
| Verified phone enrollment API and native screen | PARTIAL (source implemented; DB/device tests blocked) |
| SMS provider-neutral verified-acceptance transport | PARTIAL (mock tests pass; real delivery BLOCKED) |
| Pickup/delivery OTP with race protection | PARTIAL (source-level repair; PostgreSQL races BLOCKED) |
| Backend syntax | PASS |
| Previously implemented algorithm modules | PARTIAL (isolated tests pass; integrated runtime not proven) |
| Real PostgreSQL concurrency/ledger invariants | BLOCKED |
| MoMo/card and checkout-link QR live settlement | BLOCKED |
| Certified GhQR merchant rail | NOT IMPLEMENTED |
| Actual refunds, chargebacks, PSP bank reconciliation, rider payouts | NOT IMPLEMENTED / BLOCKED |
| Public release cash collection dispute resolution | PARTIAL |
| Android APK and iOS IPA | BLOCKED (not built) |
| Nationwide/worldwide operations | NOT VERIFIED (Ghana only) |

**Final release decision: HOLD.** Source-level changes require database integration, migration and mobile verification before safe public cash or real-money operation.
