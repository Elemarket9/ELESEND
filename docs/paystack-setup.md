# Paystack setup for ELESEND (Ghana)

The adapter has only been tested against simulated Paystack responses. Complete every step below, including the live tests, before opening payments to the public.

## Account
1. Register a Paystack business. Transfers are only for registered businesses, not starter accounts.
2. Ask Paystack support to set settlement to "Settled to Balance", a one-time change that Paystack may call manual payouts. Nobody sends money by hand afterwards. It keeps customer payments in your Paystack balance, which the API pays riders and restaurants from. Without it, Paystack can move that money to your bank and leave withdrawals unfunded.
3. In Preferences, turn off "Confirm transfers before sending". While it is on, each transfer waits for a code and expires unpaid after 30 minutes.
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
- **Riders:** they press Withdraw and enter their password. The API sends the transfer with no staff step, minus the transfer fee.
- **Restaurants and delivery companies:** their available balance is paid automatically once a day when a payout account is saved.
- **Unclear results:** the system checks with Paystack and resends only with the same reference, which Paystack treats as the same transfer. If Paystack still has no transfer after 24 hours, or it fails or is reversed, the money returns to the available balance.

## Automatic payout protection
| Protection | Setting | Default |
| --- | --- | --- |
| Destination locked to the SMS-verified phone, and checked again before sending | | Always on |
| Password required for each rider withdrawal, 5 attempts per hour | | Always on |
| Hold on new earnings, and on any delivery with an open dispute | `WITHDRAWAL_EARNINGS_HOLD_HOURS` | 24 |
| Hold after a password or payout details change | `WITHDRAWAL_SECURITY_HOLD_HOURS` | 24 |
| Minimum withdrawal | `WITHDRAWAL_MIN_MINOR` | GH₵100 |
| One withdrawal per person per day, Ghana time. Failed or reversed ones do not count | | Always on |
| Transfer fee taken from each withdrawal | `WITHDRAWAL_FEE_MINOR` | GH₵1 |
| Optional daily ceiling across the platform, which pauses withdrawals when reached | `WITHDRAWAL_PLATFORM_DAILY_LIMIT_MINOR` | Off |
| Three failed withdrawals in 24 hours blocks more until the count clears | | Always on |

There is no limit on the amount a person can withdraw. Keep `WITHDRAWAL_FEE_MINOR` matched to Paystack's Mobile Money transfer fee.

- **Ledger gap:** a fee Paystack keeps on a reversed transfer, and processing fees Paystack keeps on refunded orders, are not recorded. Reconcile against your Paystack statements.

## What needs staff action
- **A refund in `needs-attention`:** stays pending in ELESEND. Supply the customer's account details in the Paystack dashboard.
- **Chargebacks and disputes:** not imported. Check the Paystack dashboard, and connect this before high volume.

## Live tests before launch
Use small real amounts, on each of MTN, Telecel and AT:
- [ ] Customer pays by mobile money and by card, and the order is confirmed.
- [ ] Full and partial refunds reach the customer.
- [ ] A rider withdrawal reaches the wallet and clears the rider's available balance.
- [ ] Paystack's fee on a real payment matches the customer fee, and whether it returns that fee on refunds is confirmed.
- [ ] A failed withdrawal, using an invalid number, returns the money to the balance and can be retried.
- [ ] A restaurant is paid by the daily automatic run.
- [ ] Withdrawing more than the Paystack balance recovers by itself once the balance is funded.
- [ ] Commission repayment reduces the rider's debt.
- [ ] Webhook retries and duplicates cause no double effects.
- [ ] Confirm with Paystack that the `VOD` code is still right for Telecel, and whether account names can be checked for mobile money.
