# Financial integrity: evidence and unresolved tests

Audit date: 2026-11-08. Base: main @ 612b44101b6581e4a1d2774eca067658462178e8. Working branch: audit/2026-11-08-independent-verification. Verification must be based on GitHub Actions at this branch head, not on a green main. No physical Android device, Ghana routing engine, live PSP, production workload or disaster recovery environment was accessed in this review.

Observed code: `services/api/modules/payments/public-queries.mjs` checks `checkout_method_policies` and inserts financial entries. `finance.mjs` cash reporter checks assigned rider, cash payer, amount, shipment state and duplicate cash reports inside a transaction. `payout-settings.mjs` defaults withdrawal holds to 24 hours. Migration 017 begins with MOMO/CARD/QR disabled. This is source evidence, not provider settlement evidence.

Required unresolved matrix: duplicate callbacks, verified payment preceding checkout response, expired/cancelled late payments, duplicate references, refunds, payout-unknown outcomes, crashes during payouts, two simultaneous debt recovery calls, commission idempotency, zero and negative balance, promotion funding shares, 13%/10% policy snapshots, cash GH₵150 threshold, and FIFO recovery. Use isolated PostgreSQL and fake PSP for deterministic integration; separately verify provider sandbox and live settlement with consent. No live payment was made in this audit.

Test branch `audit/complete-custody` failed prematurely because the simulated MOMO method was not activated; fixture repair is in 40ef866. Do not count earlier blocked custody scenarios as payment failures. Cash reporting for a suspended carrier was 403 at the HTTP gate before the cash invariants could be exercised; targeted HTTP repair df584ef.

**Decision still required:** reconcile on-demand withdrawal policy with configurable earnings/security holds; cannot change silently or assume the current production environment variables.

## Additional money-lifecycle observations
Test Actions run 42516692866 passed the concurrent duplicate-delivery handover subtest (6 simultaneous requests, one nonduplicate settlement in isolated PostgreSQL with mocked provider), and manifest sequencing and cancellation/return guards. This is narrow integration evidence, not generalized no-double-charge proof. Tests uncovered that suspended riders could request cash reporting even before custody (finance.mjs fixed 1a1c5d), and cash-from-sender pickup UI was absent (RiderApp 71efaa). Completed parcels now accept missing-parcel dispute report without automatic refund. The separate administrative refund path remains restricted. No verified provider payout/refund executed.
