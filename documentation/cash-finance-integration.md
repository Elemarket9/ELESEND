# Cash-first transaction and immutable-commission engineering notes
**17 October 2026 — Source implementation, not a live money-collection service.**

## Cash transaction boundaries

1. Customer creates a quote (`POST /api/v1/quotes`) specifying `paymentMethod: "CASH"`, `cashPayer: "sender" | "recipient"`. Price and commission are snapshotted in integer **pesewas** at booking. A booked cash shipment is `AWAITING_ASSIGNMENT`, `paid=false` — not provider-paid.
2. An eligible GPS-current/verified rider gets an expiring road-based offer. `CASH` does not require digital payment capture. Before rider acceptance, `cashEligible` obtains the `commission_accounts` row lock, computes ledger receivable + existing cash assignments + new job commission - prepaid credits, and applies a configurable credit limit and maximum unpaid job count. A provider quote cannot bypass vehicle/operating restrictions.
3. The assigned rider reports delivery charge cash at **sender pickup** (if sender pays) or **recipient handover** (if recipient pays). The rider's report is a once-only immutable record in `cash_collections`: `reported_full`, `reported_partial` or `uncollected`. It is *not* a bank/PSP confirmation, nor does it imply the customer agrees. Repeated reports with the same payer/amount return a duplicate status; conflicting reports require a dispute.
4. Assigned rider obtains and verifies sender pickup OTP; once in custody the job cannot be casually reassigned. To complete, the currently assigned rider must manually request the recipient challenge at handover, submit the locked recipient's code and have an appropriate cash collection report. Successful OTP advances `COMPLETED` and inserts `financial_entries` and `finance_journals` **in the same PostgreSQL transaction**. A cash record's `payout_status` is `cash_rider_reported`, not `held`.
5. Commission journal: `DR rider_receivable GH₵3 / CR platform_revenue GH₵3`; both are earned ledger entries, not bank-account settlements. `commission_obligations` with policy-driven due dates and unique shipment ownership record individual debt. Verified prepaid credits may be applied exactly once; `commission_allocations` prevent overapplication.
6. Rider's `GET /api/v1/rider/finance` shows separate `dueMinor`, `creditMinor`, `cashReportedMinor`, unpaid count, due date and journal evidence. It does not claim ELESEND holds the rider's cash.
7. `POST /api/v1/rider/finance/settle` creates a stable idempotent `settlement_intent` **only when an authorized adapter exists**. External checkout responses remain pending. A verified PSP webhook (`POST /api/v1/payments/commission-webhook`) must pass the adapter's signature/verification code, matching intent/reference/amount/currency; the server's `confirmed` action is never directly exposed to an unverified public client. Posting: `DR provider_clearing / CR rider_receivable`; FIFO allocation to debts. Duplicates do not post twice. **No live adapter is installed**.
8. Prepaid credits use `DR provider_clearing / CR prepaid_liability` after verified payment; application `DR prepaid_liability / CR rider_receivable`. Controlled by `ENABLE_PREPAID_CREDITS=false` and separate legal/provider review. This is NOT an authorized electronic wallet or cash custody claim.
9. Finance adjustments require a `finance:adjust` creator, a separate human with `finance:approve`, reason/evidence, row-locked balance, contra double-entry journal and FIFO allocation; original journal lines cannot be edited/deleted.

## Non-negotiable accounting example

| Transaction | Cash rider physically holds | Earned platform commission | Platform commission verified collected | Rider commission receivable |
| --- | ---: | ---: | ---: | ---: |
| GH₵30 cash delivery, 10% fee, rider reports full receipt | GH₵30 | GH₵3 | GH₵0 | GH₵3 |
| PSP verifies GH₵1 commission repayment | GH₵30 less funds rider actually remitted | GH₵3 | GH₵1 | GH₵2 |
| PSP verifies remaining GH₵2 | Depends on real cash/remittance method | GH₵3 | GH₵3 | GH₵0 |

Gross and net earnings are economic entitlements, **not confirmation that anyone has physically received them**. Outstanding commission can remain when customer cash is unpaid/disputed; financial reconciliation requires operational review.

## Interfaces and gaps

- Cash evidence: `POST /api/v1/rider/cash-report` body `{shipmentId,reportedMinor,cashPayer,idempotencyKey}`; scoped to the authenticated currently assigned rider.
- Native rider finance: refresh receivable/credit history and initiate PSP settlement (safely disabled without PSP).
- Admin role permissions: `finance:read`, `finance:configure`, `finance:adjust`, `finance:approve` for aged commission listing, debt policy, two-person adjustment queue. Every write is audited, but role MFA and evidence attachment remain outstanding.
- **NOT IMPLEMENTED:** merchant **merchandise COD** value/remittance ledger, merchant-facing reconciliation, bank-statement reconciliation service, refunds, financial dispute resolution and reversible payment underpayment treatment, automated reminders, editable approved credit limits by risk tier, exportable PDF/CSV statements, provider adapter for MTN/Telecel/AT Money, provider credit purchase authorizations, provider payout/transfers.
- **Important edge case:** if a PSP settles an intent after a rider's debt was waived or independently settled, the webhook currently refuses journal posting and flags a reconciliation exception. This prevents falsely reducing debt below zero, but requires a staffed clearing/reversal and refunds workflow. Do not enable production capture until this exception is implemented and tested.
- No artificial provider verification or public endpoint can be used to spoof a real repayment. The synthetic DB integration test defines an IN-TEST fixture adapter only, distinct from production.

### Accounting tables / migration

`database/migrations/009_cash_finance.sql` adds `commission_accounts`, `cash_collections`, `finance_journals`, `finance_lines`, `commission_obligations`, `commission_allocations`, `settlement_intents`, `settlement_provider_events` and `finance_adjustment_requests`. They contain foreign keys, idempotency uniqueness, immutable journal and allocated-liability protections, balanced-at-commit finance trigger. Existing shipments default to DIGITAL and all old migrations are untouched. Actual apply/replay/rollback safety is **unverified without PostgreSQL**. The cash collection evidence row and the report event do not replace recipient OTP or independent proof of funds.
