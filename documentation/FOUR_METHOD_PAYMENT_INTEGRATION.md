# ELESEND cash / MoMo / card / scan-to-pay QR

## Payment semantics

- `CASH` is rider-collected physical money; completion generates one commission **receivable** per successfully completed order. Do not mark PSP paid.
- `MOMO` is authorized mobile money through a hosted PSP checkout; customer approves externally. Verified webhook OR independent reconcile-verify changes shipment from `AWAITING_PAYMENT` to `AWAITING_ASSIGNMENT`.
- `CARD` uses a PCI-scope-minimizing hosted PSP checkout. ELESEND never handles raw PAN/CVV.
- `QR` displays a **QR representation of the PSP's HTTPS hosted checkout URL**, where payer selects a supported channel; this is NOT national GhQR, EMV merchant QR or guaranteed interoperable bank scan-to-pay. To support such rails, build a specifically certified `QR` adapter and tests.
- Each shipment has its own fixed original invoice, currency and method. QR is a way of opening checkout, not proof of settlement.
- `DIGITAL` remains accepted only in historical records, not new quotes.

## Optional provider adapter and provider neutrality

The business layer in `checkout.mjs` uses only `provider.createCheckout`, `provider.verifyPayment`, `provider.parseVerifiedWebhook`, supported `methods`, and an allowlist of checkout hosts. The optional example `paystack-checkout-adapter.mjs` is isolated from the domain and server configuration. Other PSPs must implement the same interface. Do not hardcode the hosting company.

A configured PSP alone does not enable payment methods. An authorized administrator granted `payments:configure` must activate `MOMO`, `CARD` and/or `QR` through the secure API. Payment methods default to **OFF**. `CASH` remains available. Provider capabilities are checked again on every checkout.

## API flow

1. Authenticated `GET /api/v1/payments/methods` returns enabled methods.
2. `POST /api/v1/quotes` accepts `paymentMethod`: `CASH`, `MOMO`, `CARD` or `QR` and returns immutable quote.
3. `POST /api/v1/shipments` with `Idempotency-Key`: cash => `AWAITING_ASSIGNMENT`; other => `AWAITING_PAYMENT`.
4. For digital, authenticated payer calls `POST /api/v1/shipments/{id}/checkout` with `{idempotencyKey,email}`. Email is required by the optional initial PSP adapter (not the domain schema). No app-supplied price, payment success flag, or payment provider reference is trusted.
5. Android/iOS app displays hosted HTTPS checkout URL (or, for QR, QR containing that URL), without storing card data. Customers can confirm status through authenticated `GET /api/v1/shipments/{id}/checkout`.
6. Configured PSP posts signed webhooks to `POST /api/v1/payments/checkout-webhook`. Adapter validates signature over unmodified request bytes and **independently calls provider verification API**. Server checks reference, amount, currency, channel, identity, and idempotently posts evidence and shipment payment transition in one PostgreSQL transaction. Public callbacks and mobile app never confirm payment.
7. `checkout.reconcileDue()` retries delayed/missing webhooks against provider verify API; `initiating` failures remain locked until verified/reviewed, not silently retried or double-charged. A verified terminal failure can release the slot for a fresh attempt.
8. Rider platform commission repayment may use the same configured PSP via `POST /api/v1/rider/finance/settle` (email may be needed) and its **separate** verified commission webhook.

## Limits and operating controls

- Production PSP secrets are exclusively in server environment; hardcoded placeholders are prohibited.
- Unverified or missing PSP credentials: digital methods stay disabled. Never substitute a successful mock payment in production.
- QR checkout-link compatibility depends on payer device and payment-provider capabilities; one phone may need to open the URL instead of scanning its own screen.
- PSP collection does not automatically imply successful payout to rider. Refunds, chargebacks, payout reconciliation, market-by-market currency, national GhQR acceptance, and actual merchant onboarding are separate critical release gates.
- All amounts are integer **minor units** (Ghana pesewas), no float calculations.
- Provider API requests can fail after a remote transaction exists. Intents remain **initiating**, pending reconciliation, rather than allowing another unsafe charge.
- Use server-to-server verification on every `success`, including previously missing signed webhooks.

## Tests

Run `node --test tests/checkout-policy.test.mjs tests/payment-provider-unit.test.mjs`. Actual DB tests use a disposable PostgreSQL database with PostGIS enabled and the migration set including `017`. See `tests/checkout-db.test.mjs`. QR rendering requires native dependency install and an actual mobile build, neither can be inferred from JS syntax alone.

## Financial journal on verified digital delivery

Two separate balanced accounting events prevent PSP acceptance from being mistaken for platform earned commission:

1. Provider-confirmed customer payment: **debit provider receivable, credit customer delivery liability**. This is not evidence that the PSP has paid ELESEND's bank account.
2. Successfully completed verified delivery: **debit customer delivery liability, credit rider payable and credit ELESEND platform commission revenue** (per completed order, using its locked 3% initial quotation policy).

Verified payments received after cancellation, over/underpayment, conflicting status or late PSP success are posted to **provider receivable vs customer refund liability** with an immutable exception record. The shipment is NOT marked paid or dispatched, and a refund must be reviewed; live refund initiation/confirmation remains unimplemented.

`checkout_unapplied_payments` and `GET /api/v1/admin/payments/exceptions` provide authorized visibility of exceptions; **administrative payment policy toggles do not override verification.**
