/** Reads and writes other modules need from payment tables. Those modules never query the tables themselves. */
import {payoutSettings} from './payout-settings.mjs';
const holdHours=()=>payoutSettings().earningsHoldHours;

export async function ensureCommissionAccount(c,riderId){
 await c.query('INSERT INTO commission_accounts(rider_id) VALUES($1) ON CONFLICT DO NOTHING',[riderId]);
}
export async function paymentMethodEnabled(c,method){
 return Boolean((await c.query('SELECT enabled FROM checkout_method_policies WHERE method=$1',[method])).rows[0]?.enabled);
}
export async function findPaymentEvent(c,provider,eventId){
 return (await c.query('SELECT * FROM payment_events WHERE provider=$1 AND event_id=$2',[provider,eventId])).rows[0];
}
export async function recordPaymentEvent(c,{provider,eventId,shipmentId,amountMinor,currency}){
 await c.query('INSERT INTO payment_events(provider,event_id,shipment_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5)',[provider,eventId,shipmentId,amountMinor,currency]);
}
export async function recordFinancialEntry(c,{shipment,beneficiaryId}){
 const entitlementMinor=Number(BigInt(shipment.amount_minor)-BigInt(shipment.commission_minor));
 await c.query('INSERT INTO financial_entries(shipment_id,beneficiary_id,customer_charge_minor,commission_minor,entitlement_minor,payout_status) VALUES($1,$2,$3,$4,$5,$6)',[shipment.id,beneficiaryId,shipment.amount_minor,shipment.commission_minor,entitlementMinor,shipment.payment_method==='CASH'?'cash_rider_reported':'held']);
}
export async function earningsEntriesFor(c,userId){
 return (await c.query('SELECT f.* FROM financial_entries f WHERE f.beneficiary_id=$1 OR f.beneficiary_id IN (SELECT id FROM companies WHERE owner_id=$1) ORDER BY f.created_at DESC LIMIT 100',[userId])).rows;
}
export async function senderCashCollectedInFull(c,shipmentId,amountMinor){
 return (await c.query("SELECT 1 FROM cash_collections WHERE shipment_id=$1 AND cash_payer='sender' AND reported_status='reported_full' AND reported_minor=$2",[shipmentId,amountMinor])).rowCount>0;
}
export async function cashCollectionFor(c,shipmentId,riderId){
 return (await c.query('SELECT * FROM cash_collections WHERE shipment_id=$1 AND rider_id=$2',[shipmentId,riderId])).rows[0];
}
export async function cashAlreadyReported(c,shipmentId){
 return (await c.query('SELECT 1 FROM cash_collections WHERE shipment_id=$1',[shipmentId])).rowCount>0;
}
export async function accrueRestaurantSettlement(c,s){
 await c.query(`INSERT INTO restaurant_settlements(
   order_id,restaurant_id,gross_sales_minor,restaurant_discount_minor,elesend_subsidy_minor,
   commission_bps,commission_minor,net_payable_minor,commission_basis,commission_base_minor,
   commission_snapshot,promotion_snapshot,status
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'accrued') ON CONFLICT(order_id) DO NOTHING`,
  [s.orderId,s.restaurantId,s.grossSales,s.restDiscount,s.elesendSubsidy,s.commBps,s.commMinor,s.netPayable,s.commBasis,s.commBase,JSON.stringify(s.commissionSnapshot||{}),JSON.stringify(s.promotionSnapshot||{})]);
}
export async function firstConfirmedPaymentAt(c,shipmentId){
 return (await c.query("SELECT confirmed_at FROM shipment_checkout_intents WHERE shipment_id=$1 AND status='confirmed' ORDER BY confirmed_at LIMIT 1",[shipmentId])).rows[0];
}
export async function settlementIntentForRider(c,intentId,riderId){
 return (await c.query('SELECT id, provider, provider_reference, amount_minor, status, receipt_number, momo_network, momo_phone, confirmed_at, created_at FROM settlement_intents WHERE id=$1 AND rider_id=$2',[intentId,riderId])).rows[0];
}
/** Lifetime history in `totals`, and what is owed now from the ledger in `balance`. */
export async function restaurantFinanceSummary(c,restaurantId){
 const settlements=(await c.query(
  `SELECT s.*, o.created_at AS order_date, o.payment_method
   FROM restaurant_settlements s
   JOIN food_orders o ON o.id = s.order_id
   WHERE s.restaurant_id = $1
   ORDER BY s.created_at DESC LIMIT 100`,[restaurantId])).rows;
 const totals=(await c.query(
  `SELECT
    COALESCE(SUM(gross_sales_minor), 0)::bigint AS gross_sales_minor,
    COALESCE(SUM(restaurant_discount_minor), 0)::bigint AS restaurant_discount_minor,
    COALESCE(SUM(elesend_subsidy_minor), 0)::bigint AS elesend_subsidy_minor,
    COALESCE(SUM(commission_minor), 0)::bigint AS commission_minor,
    COALESCE(SUM(net_payable_minor), 0)::bigint AS net_payable_minor,
    COUNT(*)::int AS count
   FROM restaurant_settlements
   WHERE restaurant_id = $1`,[restaurantId])).rows[0];
 const owed=(await c.query(
  `SELECT coalesce(sum(payable) FILTER (WHERE in_progress), 0)::bigint AS in_progress,
          coalesce(sum(payable) FILTER (WHERE NOT in_progress AND on_hold), 0)::bigint AS on_hold,
          coalesce(sum(payable) FILTER (WHERE NOT in_progress AND NOT on_hold), 0)::bigint AS available
   FROM (
     SELECT sum(CASE WHEN l.side = 'credit' THEN l.amount_minor ELSE -l.amount_minor END) AS payable,
            EXISTS(SELECT 1 FROM payout_operations p WHERE p.shipment_id = s.id AND p.kind = 'restaurant' AND p.status IN ('proposed', 'initiating', 'pending', 'needs_review')) AS in_progress,
            (coalesce(s.completed_at, s.created_at) > now() - make_interval(hours => $2)
              OR EXISTS(SELECT 1 FROM restaurant_settlements rs WHERE rs.order_id = f.id AND rs.status = 'withheld')) AS on_hold
     FROM food_orders f
     JOIN shipments s ON s.id = f.shipment_id
     JOIN checkout_accounting_journals j ON j.shipment_id = s.id
     JOIN checkout_accounting_lines l ON l.journal_id = j.id AND l.account = 'restaurant_payable'
     WHERE f.restaurant_id = $1
     GROUP BY s.id, f.id
   ) unpaid WHERE payable > 0`,[restaurantId,holdHours()])).rows[0];
 const paid=(await c.query(
  `SELECT coalesce(sum(p.amount_minor), 0)::bigint AS total
   FROM payout_operations p JOIN food_orders f ON f.shipment_id = p.shipment_id
   WHERE f.restaurant_id = $1 AND p.kind = 'restaurant' AND p.status = 'paid'`,[restaurantId])).rows[0];
 return {settlements,totals,balance:{availableMinor:Number(owed.available),onHoldMinor:Number(owed.on_hold),inProgressMinor:Number(owed.in_progress),paidMinor:Number(paid.total)}};
}
/** The rider's own earnings, from one record, for goals and totals. */
export async function riderEarningsTotals(c,riderId){
 const r=(await c.query(`SELECT
   coalesce(sum(entitlement_minor) FILTER(WHERE (created_at AT TIME ZONE 'UTC')::date=(now() AT TIME ZONE 'UTC')::date),0)::bigint AS today,
   coalesce(sum(entitlement_minor) FILTER(WHERE (created_at AT TIME ZONE 'UTC')>=date_trunc('week',now() AT TIME ZONE 'UTC')),0)::bigint AS week
  FROM financial_entries WHERE beneficiary_id=$1`,[riderId])).rows[0];
 return {todayMinor:Number(r.today),weekMinor:Number(r.week)};
}
/** Money still owed to this person: their own rider earnings, plus their company's and restaurant's. */
export async function unpaidEarningsMinor(c,userId){
 return Number((await c.query(`SELECT coalesce(sum(owed),0)::bigint AS total FROM (
   SELECT sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END) AS owed
     FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id JOIN shipments s ON s.id=j.shipment_id
    WHERE ((l.account='rider_payable' AND ((s.rider_id=$1 AND s.company_id IS NULL) OR s.company_id IN (SELECT id FROM companies WHERE owner_id=$1)))
       OR (l.account='restaurant_payable' AND s.id IN (SELECT f.shipment_id FROM food_orders f JOIN restaurants r ON r.id=f.restaurant_id WHERE r.owner_id=$1)))
      AND NOT EXISTS(SELECT 1 FROM payout_operations p WHERE p.shipment_id=s.id AND p.kind=CASE WHEN l.account='restaurant_payable' THEN 'restaurant' ELSE 'rider' END AND p.status NOT IN ('failed','superseded'))
    GROUP BY s.id,l.account HAVING sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END)>0) earnings`,[userId])).rows[0].total);
}
export const withdrawalFeeMinor=()=>payoutSettings().feeMinor;
