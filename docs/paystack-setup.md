# Paystack setup for ELESEND (Ghana)

The adapter has only been tested against simulated Paystack responses. Complete every step below, including the live tests, before opening payments to the public.

## Account
1. Register a Paystack business. Transfers are only for registered businesses, not starter accounts.
2. Ask Paystack support to switch your payouts to manual ("Settled to Balance"). Rider and restaurant payouts are paid from your Paystack balance, so without this it can be empty when a payout runs.
3. In Preferences, turn off "Confirm transfers before sending". While it is on, each payout stops for a code and appears in the admin portal as needing review.
4. Set the webhook URL to `https://<API host>/api/v1/payments/webhook`.

## Configuration
```
PAYMENT_PROVIDER=paystack
PAYSTACK_SECRET_KEY=sk_live_...
PAYSTACK_ENABLED_METHODS=MOMO,CARD
```
Production refuses test keys. Enable each method in the admin portal after this.

## How it works
- **Webhooks:** verified with the signature header, and every result is confirmed by asking Paystack directly.
- **Payouts:** each payout uses a stable reference, so an unclear result is checked rather than sent again.
- **Payout recipients:** created only for the user's SMS-verified phone. Paystack returns no account name for mobile money, so the name on the wallet is not checked.
- **Refunds:** checked by the reconciliation job about every 30 seconds.

## Fees and withdrawals
- **Customer fee:** digital payments add `PAYSTACK_CUSTOMER_FEE_BPS` (default 195, Paystack's listed 1.95%) on top of the order total. Set it to 0 if your agreed terms or legal advice rule it out. Cancelled orders refund the fee to the customer.
- **Rider withdrawals:** a rider withdraws their whole available balance as one transfer, and pays no fee. ELESEND pays Paystack's transfer fee.
- **Limits:** `WITHDRAWAL_MIN_MINOR` (default GH₵5) and `WITHDRAWAL_AUTO_LIMIT_MINOR` (default GH₵500 per rider per 24 hours). Above the limit, a finance administrator approves through `POST /api/v1/admin/payments/withdrawals/:id/decide`.
- **Ledger gap:** transfer fees, and processing fees Paystack keeps on refunded orders, are not recorded. Reconcile against your Paystack statements.

## What needs staff action
- **A refund in `needs-attention`:** stays pending in ELESEND. Supply the customer's account details in the Paystack dashboard.
- **A reversed transfer after payment:** written to the audit log as `payment.payout_reversal_reported`. Finance must review it, because ledgers are not rewritten automatically.
- **Chargebacks and disputes:** not imported. Check the Paystack dashboard, and connect this before high volume.

## Live tests before launch
Use small real amounts, on each of MTN, Telecel and AT:
- [ ] Customer pays by mobile money and by card, and the order is confirmed.
- [ ] Full and partial refunds reach the customer.
- [ ] A rider withdrawal reaches the wallet and clears the rider's available balance.
- [ ] Paystack's fee on a real payment matches the customer fee, and whether it returns that fee on refunds is confirmed.
- [ ] A failed payout, using an invalid number, shows as failed and can be retried safely.
- [ ] Commission repayment reduces the rider's debt.
- [ ] Webhook retries and duplicates cause no double effects.
- [ ] Confirm with Paystack that the `VOD` code is still right for Telecel, and whether account names can be checked for mobile money.
