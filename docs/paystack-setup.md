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
- **Unclear results:** the system checks with Paystack and resends only with the same reference, which Paystack treats as the same transfer. If it fails or is reversed, the money returns to the available balance. If Paystack cannot find a transfer, the money stays locked and the same reference keeps being retried. After 24 hours it is flagged in the admin portal, where finance can release it after checking the Paystack dashboard. Released withdrawals are rechecked for a week, and a late payment puts the account on hold.

## Automatic payout protection
| Protection | Setting | Default |
| --- | --- | --- |
| Destination locked to the SMS-verified phone, and checked again before sending | | Always on |
| Password required for each rider withdrawal, 5 attempts per hour | | Always on |
| Hold on new earnings | `WITHDRAWAL_EARNINGS_HOLD_HOURS` | 24 |
| Hold after a password or payout details change | `WITHDRAWAL_SECURITY_HOLD_HOURS` | 24 |
| Minimum withdrawal | `WITHDRAWAL_MIN_MINOR` | GH₵100 |
| One withdrawal per person per day, Ghana time. Failed or reversed ones do not count | | Always on |
| Transfer fee taken from each withdrawal | `WITHDRAWAL_FEE_MINOR` | GH₵1 |
| Optional daily ceiling across the platform, which pauses withdrawals when reached | `WITHDRAWAL_PLATFORM_DAILY_LIMIT_MINOR` | Off |
| Three failed withdrawals in 24 hours blocks more until the count clears | | Always on |

There is no limit on the amount a person can withdraw. Keep `WITHDRAWAL_FEE_MINOR` matched to Paystack's Mobile Money transfer fee.

- **Ledger gap:** a fee Paystack keeps on a reversed transfer, and processing fees Paystack keeps on refunded orders, are not recorded. Reconcile against your Paystack statements.

## Commission and refund rules
- **Independent riders' cash commission:** becomes the rider's debt, due at the Monday cutoff plus 24 hours. It is repaid from earnings first, then by Mobile Money.
- **Company riders' cash commission:** the company owes it, and it is recovered from the company's unpaid earnings. At `COMPANY_COMMISSION_DEBT_LIMIT_MINOR` (default GH₵500), its riders stop receiving cash jobs until digital earnings clear the debt.
- **Delivered food orders:** ELESEND does not refund them or give up commission. The customer chats with the restaurant.
- **Parcels confirmed by SMS:** never refunded.
- **Failed parcel deliveries after pickup:** the sender pays the full fare, with no refund. The rider returns the parcel and gets the sender's SMS code, then earnings and commission settle like a completed delivery. If the fare was cash payable by the recipient, the rider collects it from the sender first.
- **Parcels never picked up:** the rider releases the job, and the sender can cancel for a full refund.

## Exception payouts
The propose-and-approve screen in the admin portal is for correcting a problem payout only. Normal payouts are withdrawals.

## Deploying without providers
ELESEND starts with no Paystack, SMS, Didit, map or routing settings. Features that need a missing provider stay off until you add its settings. Without SMS, bookings and account verification pause. Without a payment provider, only cash is available.

## Rider identity
Didit is optional. Without it, riders upload a licence photo and staff compare it with the details before approving. Adding the Didit settings later switches on the automatic check.

A rider cannot be approved without a current driver's licence, or a Ghana Card for bicycle riders, and a passed photo and selfie check through Didit. Didit stores the images. In its console, create a workflow with ID verification, liveness and face match, and set the webhook URL to `https://<API host>/api/v1/identity/webhook` using webhook version 3. Set `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID` and `DIDIT_WEBHOOK_SECRET`. Didit reads the photographed document but does not confirm it against a government licence register, so check licences with the DVLA or a registry lookup provider as well. Riders are suspended when the approved document expires. One document cannot back two accounts. Numbers and images are encrypted with `RIDER_ID_ENCRYPTION_KEY`, or a key derived from `ADMIN_MFA_ENCRYPTION_KEY` when it is unset. Back up whichever applies and do not change it, because the data cannot be read without it.

Riders also upload a profile photo, and motor vehicle riders add insurance and roadworthiness certificates with their expiry dates. Staff view them in the admin portal, and approval is refused until they are on file. Riders are suspended when a certificate expires. Staff approving a rider are confirming that these photos are readable and genuine.

## Missing parcels
A parcel still with its rider `PARCEL_CUSTODY_LIMIT_HOURS` (default 24) after pickup opens an incident. The rider is suspended, withdrawals stop, and the evidence is frozen. It appears in the admin portal under Risk Signals. Staff check the facts, then record the outcome and any police reference. The system never contacts the police itself.

## Safety and rider tools
- **Emergency button:** sends an SMS to `SAFETY_ALERT_PHONE` and the user's trusted contact, and offers to call 112. Both are optional, and alerts always appear in the admin portal. Set a number someone answers before relying on it.
- **Safety checks:** riders must rest `RIDER_REST_HOURS` after `RIDER_MAX_ONLINE_HOURS` online, repeat the selfie check every `RIDER_REVERIFY_DAYS` with 7 days' grace, and are flagged after `UNUSUAL_STOP_MINUTES` without moving mid-delivery.
- **Rewards:** referrals and campaigns pay commission credit, not cash. `REFERRAL_REWARD_MINOR` defaults to 0, which is off.
- **Not built:** private calls need a paid call-masking provider, so real phone numbers are still used on calls.

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
- [ ] A real Ghana driver's licence passes the Didit check, with its number read correctly.
- [ ] Confirm with Paystack that the `VOD` code is still right for Telecel, and whether account names can be checked for mobile money.
