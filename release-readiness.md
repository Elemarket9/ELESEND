# ELESEND — 14-phase cash-first mobile release status

**Date: 17 October 2026 | Decision: RELEASE HOLD.** All PASS claims below are limited to explicitly named source inspection or locally executed standalone tests. Database and provider integrations have NOT been executed. Historical documents in this archive refer to older revisions and are NOT current release verification.

| Phase | Status | Result and gate |
|---|---|---|
| 1. Source audit | PARTIAL | Inspected original extracted API, mobile modules, SQL migrations and dispatch. No live environment, production config or customer data audited. |
| 2. Cash booking/report | PARTIAL | CASH or DIGITAL price/booking, payer selection, rider cash evidence and OTP handover route code; database integration blocked. |
| 3. Immutable commission journal | PARTIAL | Balanced immutable SQL journal, unique earned commission per OTP-verified cash job, obligation/allocations. Transactional DB execution unverified. |
| 4. Commission recovery | PARTIAL | Postpaid threshold, aging/due policies, prepaid ledger code gated OFF. Real commission collection disabled until PSP integration. |
| 5. Provider-neutral payments | BLOCKED | Adapter interface and authenticated webhook contract written; **no live MoMo/PSP adapter** or reconciliation. Safe HTTP 503. |
| 6. Fair pricing | PASS (unit only) | Deterministic integer-pesewa base/km, percentage/fixed/hybrid/cap checks, 5/5 local pricing unit tests. No independent price-market verification. |
| 7. Intelligent dispatch | PARTIAL | PostGIS indexed shortlist; provider-isolated road ETA, direction, availability, settlement eligibility. Google Routes mocked unit tests; live routes blocked. |
| 8. Multi-parcel | PARTIAL | bounded feature-gated route insertion, limits and independent stop custody; 5/5 deterministic units. Real concurrent DB integration unavailable. Default OFF. |
| 9. Motorcycles/cars | PARTIAL | car plate/make/model/cargo and separate manual vehicle approval; Ghana legal/vehicle verification and runtime testing outstanding. |
| 10. Native Android/iOS app | PARTIAL | Expo/React Native booking, riders, GPS, cash UI, finance, operations source. JSX parsed; no actual Android/iOS binary generated or tested. |
| 11. Security hardening | PARTIAL | server-side identity, ledger controls, OTP authority, audit/roles, API input validation. No mobile penetration test/strong attestation/admin MFA. |
| 12. provider-neutral VPS readiness | PARTIAL | compose, Caddy TLS template, backup and storage-monitor scripts; not deployed, benchmarked or restore-tested. |
| 13. Automated tests | PASS (unit only); BLOCKED (integration) | **25/25 locally executed unit tests passed**. PostgreSQL/PostGIS and native-device test execution blocked. |
| 14. Release verification | FAIL readiness gate | No verified real OTP SMS, mobile app build, live PSP settlement, actual PostGIS concurrency, Ghana Routes sandbox data, backup restore or risk/legal approvals. **Do not launch.** |

## Critical gaps: must resolve before any real-world operation

1. Run migrations and regression/concurrency tests on a disposable PostgreSQL 18/PostGIS server. Confirm new cash completion rule, journaling triggers, rider capacity/offer exclusivity, two-person finance adjustments, and bootstrap/replay/migration migration safety.
2. Implement approved OTP SMS transport and test sender/recipient handover, expiry, resend, reassignment, offline fallback, disputed cash and OTP throttling on actual devices. Production server currently supplies `sms=null`, intentionally blocking completion.
3. Install a regulated/contracted MoMo PSP adapter and implement authenticated signed webhooks, identity/reference/amount validation, partial repayments, nightly clearing reconciliation, duplicate/out-of-order provider events, refunds and debt-changed overpayments. **No real money can be claimed settled** today.
4. Build and install Android APK / iOS IPA; verify native Google Maps keys, OS location permissions, route pricing and realistic background GPS, network gaps/charging, mobile ergonomics and battery constraints.
5. Obtain Google Routes quotas and test route matrix/traffic/one-way/motorcycle coverage in actual Ghana environments; verify route source and ETA error per vehicle and district.
6. Implement merchandise COD value isolation, merchant remittance/reversals/disputes and liability/contract review before COD activation. It is **NOT IMPLEMENTED**.
7. Add source-complete retries/notification outbox, ops audit approvals, login MFA for finance admins, GPS anti-spoof controls, secure vehicle/license document verification, monitoring, real backup/restore testing.
8. Validate Ghana delivery operations, data protection, commercial vehicle/insurance rules, PSP/prepaid arrangement regulatory requirements and merchant cash collection contracts before public use.

A cash report is **self-attested** by an authenticated rider, not a PSP transaction. Commission in `rider_receivable` is **earned but uncollected** until verified settlement. Do not label unpaid platform fees as bank balance or customer funds as held by ELESEND. Archive has no production keys and contains NO compiled APK.


## Additive deeper-audit update (17 October 2026)

An evidence-grounded security/remediation report is at [`DEEP_SECURITY_AUDIT_2026-10-17.md`](DEEP_SECURITY_AUDIT_2026-10-17.md). It supersedes any previous PASS assumptions that were not re-executed. **25 standalone unit tests PASS.** Provider-neutral deployment is now under `deploy/vps`. Major cash-underpayment, stale dispatch commitment, confirmed-PSP-overpayment, secrets-in-build-context, and proxy-rate-limit defects have source fixes; each relevant PostgreSQL and end-to-end path remains **PARTIAL/BLOCKED** until a live integration test. Production release decision is still **HOLD**.
