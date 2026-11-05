# Moolre setup

The Moolre adapter is off unless `PAYMENT_PROVIDER=moolre`. It has passed fixture tests only. It has not run against Moolre's sandbox or live service.

## What it does

| ELESEND action | Moolre call |
| --- | --- |
| Customer checkout and commission repayment | Hosted payment link, MoMo |
| Confirm a payment | Callback secret check, then `POST /open/transact/status` |
| Rider withdrawal | `POST /open/transact/transfer` |
| Confirm a withdrawal or refund | `POST /open/transact/status`, polled by reconciliation |
| Refund | Transfer to the customer's SMS-verified number |

## Confirm with Moolre before going live

1. The payment link path. `/embed/link` is our default, but the docs we could read do not print it. Change it with `MOOLRE_CHECKOUT_PATH`.
2. The checkout link's domain. Change the list with `MOOLRE_CHECKOUT_HOSTS`. An unknown domain is refused.
3. Where the callback secret comes from, and whether callbacks retry.
4. What `txstatus` values mean on a transfer. Until `txstatus` 2 is confirmed as final, a failed withdrawal stays locked for staff. Then set `MOOLRE_FAILED_STATUS_CONFIRMED=true`.
5. Whether `amount` in a status response includes Moolre's or the network's fee. A mismatch stops the order from being marked paid.
6. Who pays the fee on collections. Set `MOOLRE_CUSTOMER_FEE_BPS` so the customer is not charged twice.
7. Which key the status lookup needs for payments and for transfers.
8. Whether one wallet can both collect payments and fund payouts.

## Testing order

1. Set `MOOLRE_SANDBOX=true`, the API user, account number, callback secret and merchant email.
2. Run one checkout, one failed payment, one withdrawal and one refund in the sandbox.
3. In live mode, repeat with small real amounts, with a low daily payout limit.
