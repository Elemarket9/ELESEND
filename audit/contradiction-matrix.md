# Backend/mobile/finance contradiction matrix

Audit date: 2026-11-08. Base: main @ 612b44101b6581e4a1d2774eca067658462178e8. Working branch: audit/2026-11-08-independent-verification. Verification must be based on GitHub Actions at this branch head, not on a green main. No physical Android device, Ghana routing engine, live PSP, production workload or disaster recovery environment was accessed in this review.

| Topic | Source A | Source B | Assessment | Action |
|---|---|---|---|---|
| Suspended courier may finish carrying parcel | HTTP error says courier may finish held parcel | `services/api/http.mjs` previously excluded `handover` and `cash-report` from custody allowlist | Confirmed endpoint contradiction | Narrow fix df584ef; full regression pending |
| Simulated digital checkout | `tests/audit-custody.test.mjs` expects MOMO quotes | `database/migrations/017_checkout_cash_momo_card_qr.sql` creates MOMO disabled | Confirmed test fixture contradiction, not production defect | Isolated fixture activation 40ef866 |
| Rider instant earnings | Owner's current immediate-withdrawal requirement | `services/api/modules/payments/payout-settings.mjs` defaults earnings/security holds to 24h | Policy conflict requiring complete money-flow review | No unsafe silent change |
| Legacy OTP state | `database/migrations/001_core.sql` and `072_sms_free_handover_evidence.sql` retain AWAITING_DELIVERY_OTP and consumed OTP alternative | SMS-free `shipment_handover_events` alternative in 072 | Historical compatibility may be intentional; effective function must be tested | Do not delete history; test final DB guards |
| Rider declaration vs recipient proof | `shipment_handover_events` records rider event | Customer receipt separately optional | Keep evidence terminology precise | Require independent API + mobile validation |

Further file-by-file contradiction scans and runtime contract tests remain incomplete; no claims are made for uninspected contracts.

## Additional contradictions verified against PostgreSQL-backed CI
| Source | Contradiction | Evidence | Status |
|---|---|---|---|
| services/api/platform.mjs | Stale GPS stored as if handover position | Run 42516692866, GPS fixture 10 min stale | Code repaired 4a4d310; pending CI |
| services/api/custody-incidents.mjs | Overdue incidents require legacy SMS challenge and miss rider-declared pickups | Run 42516692866 | Fixed 8dd9d29; pending CI |
| services/api/platform.mjs and database/migrations/072_* | Postpickup identity/recipient changes need DB-level custody prohibition | Run 42516692866 and trigger review | Migration 074; pending CI |
| apps/mobile/src/rider/RiderApp.js vs finance cash handover guard | Sender cash at pickup not collected in UI | Run 42516692866 static test + source | Helper + RiderApp fix; pending CI/device |
| services/api/platform.mjs | Lost-parcel reports rejected on rider declaration due to obsolete SMS policy | Run 42516692866 | Fix 0696f295; pending CI |
| apps/mobile/src/customer/RecipientPhoneModal.js; CustomerApp; restaurant HTML | Delivery SMS code promised though handover is rider-declared | Run 42516692866 + code search | Text repaired; pending CI/device |
| config/modules.json and migrations/072,073 | Custody and receipt tables not declared owned | Run 42516692866 | Fixed 944c959; pending CI |
