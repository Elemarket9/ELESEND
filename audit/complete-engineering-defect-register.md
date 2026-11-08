# ELESEND independent defect register

Audit date: 2026-11-08. Base: main @ 612b44101b6581e4a1d2774eca067658462178e8. Working branch: audit/2026-11-08-independent-verification. Verification must be based on GitHub Actions at this branch head, not on a green main. No physical Android device, Ghana routing engine, live PSP, production workload or disaster recovery environment was accessed in this review.

## EC-001 — High — suspended rider cannot finish parcel custody or record cash
Affected module: `services/api/http.mjs` (CUSTODY_ROUTES, CUSTODY_SHIPMENT_ROUTE). Reproduction: with a parcel in custody, suspend rider, call `POST /api/v1/shipments/{id}/handover` or `POST /api/v1/rider/cash-report`. HTTP actor.custodyOnly prefilter denies both with 403, prior to app-level shipment/payment guards. Existing adversarial CI branch `audit/complete-custody` produced 403 where cash-collection guard's 409 was expected (Actions run 42516144881, test line 201). Root cause: stale endpoint allowlist after removal of SMS handover. Repair: allow only the handover and cash-report endpoints through suspended-custody HTTP filter; per-shipment assignment/financial checks remain in platform and finance modules. Fix commit: df584efeeec4c2bb5436a4835f954691a09a158a. Regression: `tests/audit-custody.test.mjs`, suspended carrier scenario; verification pending branch CI. Remaining risk: independent device and full workflow verification required.

## EC-002 — Test-blocker — custody regression fixture left MOMO administratively disabled
Affected module: `tests/audit-custody.test.mjs`. Reproduction: custody branch Actions run 42516144881 reports HTTP 503 `Payment method is not active` during booking, before many custody assertions. Root cause: migration 017 intentionally initializes MOMO disabled; test forgot to activate simulated method in its isolated test database. Fix: explicitly enable MOMO only after migrating isolated test database, consistent with other payment integration test setup. Commit: 40ef8669714538007fe5b7ec9bf7925c131fe935. Verification: pending new branch CI. This does not indicate that live MOMO is configured or working.

## EC-003 — Policy inconsistency — immediate digital withdrawal vs payout hold
Affected module: `services/api/modules/payments/payout-settings.mjs`. Source defaults `WITHDRAWAL_EARNINGS_HOLD_HOURS` and `WITHDRAWAL_SECURITY_HOLD_HOURS` both to 24, while owner's intended policy is on-demand rider digital earnings after completed paid delivery and debt recovery. Actual configured production value not inspected. No change made, because altering payout terms without validating the full withdrawal ledger and risk rules is unsafe. Severity: policy decision / release review. Reproduction: inspect default settings and follow through wallet availability computations. Fix: none. Regression: not yet added. Verification: source read only. Remaining risk: incorrect customer-facing earnings availability.

## EC-004 — Evidence gap — comprehensive adversarial tests incomplete
The newly imported custody suite has additional checks beyond the existing green main CI. Not all are known to pass. No 5,000-client benchmark, real APK device run, live MoMo transfer, restoration drill or Ghana road ETA ground truth has been established by this audit. No defect claim is made without evidence.

## EC-005 — High — stale GPS falsely attached to handover events
Reproduction: Actions 42516692866, tests/audit-custody.test.mjs stale GPS subtest supplied rider position timestamp ten minutes old; resulting handover event included geography and timestamp. Root cause: services/api/platform.mjs copied rider position without checking freshness and fabricated pickup tracking time with COALESCE(position_at,now()). Fix commit 4a4d31048be6e9e16b2d2f586fe10a490b8a1ce0 uses dispatch_policy.fresh_seconds and max_accuracy_m; unavailable/stale GPS remains null. Regression: existing custody suite. Independent post-fix CI status must be checked.

## EC-006 — High — post-pickup recipient/rider identity could be changed through DB session
Reproduction: original custody CI 42516692866 post-pickup rider UPDATE failed via unrelated pickup proof guard rather than explicitly locking custody; legacy transaction setting might permit recipient redirect. Root cause: migration 072 guard_shipment did not explicitly prohibit rider_id, company_id or recipient_phone updates after pickup proof and allowed recipient correction session setting without checking pickup custody. New migration 074_lock_postpickup_custody.sql preserves prior transition guards, explicitly disallows changes to rider/company after pickup, disallows recipient change after pickup even when session flag is set. Commit db0d0f5f66bc2c63dd36573c00f9c62635451b90. Regression: custody suite. Authorized exception transfer not implemented: manual intervention required, documented operational gap.

## EC-007 — High — SMS-free pickups ignored by overdue custody incident monitor
Reproduction: original custody CI 42516692866 overdue pickup test failed. Root cause: custody-incidents.mjs searches only consumed legacy challenge and supplies old challenge-only picked_up_at. Repair commit 8dd9d29b6b18ee955f31dc86a313b383e3dffe52 includes immutable shipment_handover_events pickup rows and incident evidence timestamp. Regression pending.

## EC-008 — Medium — suspended courier allowed attempted pickup on uncollected assignment
Reproduction: custody Actions 42516692866 returned HTTP 409 manifest error rather than 403 when suspended rider tried to pick up waiting parcel. Root cause: custodyOnly rider path bypasses approval check to finish held parcel, without differentiating new pickup. Fix 0696f295dec976caf104ca55f72af2488f27490c denies custodyOnly pickup. Finance cash report further protects sender-paid unpicked shipments (commit 1a1c5d8228622461bb0079b9a09102fb324ce970). Regression pending.

## EC-009 — High — customer missing-parcel dispute refused because of legacy SMS policy
Reproduction: custody Actions 42516692866 lost parcel report returned 409 'Parcels confirmed by SMS...'; rider-declared receipt is not independent customer proof. Fix platform customer dispute intake: allow lost parcel report on COMPLETED parcel without triggering automatic refund (0696f295dec...). Keep existing admin payout/refund restrictions and approvals in money-operations (a4fb894...). Additional dispute approval policy remains review item. Regression pending.

## EC-010 — High — cash sender pickup missing from rider Android
Reproduction: static adversarial test in Actions 42516692866 failed because apps/mobile/src/rider/handover-logic.mjs absent; RiderApp confirmed pickups without sender cash report even though backend requires full sender cash first. Fix new testable cashToCollect helper commit 603b7c5a35f00e870eebcc45d802092b8538c4cb, RiderApp flow commit 71efaa82361d02d236bc396707d703aad2777c4a. No physical device result; test pending.

## EC-011 — Medium — user-visible and developer-facing obsolete SMS claims
Reproduction: adversarial static test Actions 42516692866 found RecipientPhoneModal 'handover code sent', and repo search identified CustomerApp, restaurant portal, README, docs, platform and finance strings. Updated instructions/UI while retaining historical OTP records. Commits include 81e16c38, 246105185, 6609c960, 0c5b203, 2e4e8f79, 3e0c80df, a4fb894. CI pending.

## EC-012 — Moderate engineering boundary defect — new DB tables not claimed by module
Reproduction: Actions 42516692866 database ownership test found shipment_handover_events and shipment_receipt_confirmations unowned in config/modules.json. Fixed in 944c95965c8220092b1c97092abdbc41494ebf06. Test pending.
