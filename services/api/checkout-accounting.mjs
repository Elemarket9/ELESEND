import {randomUUID} from 'node:crypto';
import {check} from './security.mjs';
/** Immutable double-entry for provider-verified customer delivery payment.
 * provider_receivable is NOT bank cash settlement evidence.
 */
export async function checkoutJournal(c,{shipmentId,eventKey,kind,entries}){
 const debits=entries.filter(x=>x[1]==='debit').reduce((v,x)=>v+BigInt(x[2]),0n);
 const credits=entries.filter(x=>x[1]==='credit').reduce((v,x)=>v+BigInt(x[2]),0n);
 check(entries.length>=2&&debits===credits&&debits>0n,409,'Unbalanced checkout accounting');
 for(const [,side,value] of entries)check(['debit','credit'].includes(side)&&Number.isSafeInteger(value)&&value>0,400,'Invalid journal line');
 const prior=await c.query('SELECT id FROM checkout_accounting_journals WHERE event_key=$1',[eventKey]);
 if(prior.rowCount)return {id:prior.rows[0].id,duplicate:true};
 const id=randomUUID();
 await c.query('INSERT INTO checkout_accounting_journals(id,shipment_id,event_key,kind) VALUES($1,$2,$3,$4)',[id,shipmentId,eventKey,kind]);
 for(const [i,[account,side,value]] of entries.entries())await c.query('INSERT INTO checkout_accounting_lines(journal_id,line_no,account,side,amount_minor) VALUES($1,$2,$3,$4,$5)',[id,i+1,account,side,value]);
 return {id,duplicate:false};
}
export const customerMoneyReceived=(c,{shipmentId,eventKey,amountMinor})=>checkoutJournal(c,{shipmentId,eventKey,kind:'psp_verified',entries:[['provider_receivable','debit',amountMinor],['customer_delivery_liability','credit',amountMinor]]});
export const customerMoneyUnapplied=(c,{shipmentId,eventKey,amountMinor})=>checkoutJournal(c,{shipmentId,eventKey,kind:'verified_unapplied',entries:[['provider_receivable','debit',amountMinor],['customer_refund_liability','credit',amountMinor]]});
export async function requestCheckoutRefund(c,shipment,reason){
 await c.query(
  `UPDATE shipment_checkout_intents
      SET status='expired',
          failure_reason=coalesce(failure_reason,$2),
          submission_token=NULL,
          submission_lease_until=NULL,
          updated_at=now()
    WHERE shipment_id=$1
      AND status IN ('initiating','pending')`,
  [shipment.id,'Order cancelled before verified payment ('+String(reason||'cancelled').slice(0,200)+')']
 );
 if(!shipment.paid)return {required:false};
 const intent=(await c.query("SELECT * FROM shipment_checkout_intents WHERE shipment_id=$1 AND status='confirmed' ORDER BY confirmed_at LIMIT 1",[shipment.id])).rows[0];
 check(intent,409,'Verified payment evidence required for refund review');
 const amountMinor=Number(intent.amount_minor);
 await checkoutJournal(c,{shipmentId:shipment.id,eventKey:'cancellation:'+shipment.id,kind:'refund_requested',entries:[['customer_delivery_liability','debit',amountMinor],['customer_refund_liability','credit',amountMinor]]});
 await c.query(`INSERT INTO checkout_refund_requests(shipment_id,intent_id,amount_minor,reason) VALUES($1,$2,$3,$4) ON CONFLICT(shipment_id) DO NOTHING`,[shipment.id,intent.id,amountMinor,reason]);
 return {required:true,amountMinor};
}
export async function digitalDeliveryCompleted(c,shipment){
 if(shipment.payment_method==='CASH')return {skipped:'cash'};
 const isNew=(await c.query("SELECT 1 FROM shipment_checkout_intents WHERE shipment_id=$1 AND status='confirmed'",[shipment.id])).rowCount;
 if(!isNew)return {skipped:'legacy digital without new checkout journal'};
 check(shipment.paid&&Number.isSafeInteger(Number(shipment.amount_minor))&&Number.isSafeInteger(Number(shipment.commission_minor)),409,'Invalid verified digital delivery accounting');
 const total=BigInt(shipment.amount_minor),fee=BigInt(shipment.commission_minor);
 const net=total-fee;
 const entries=[['customer_delivery_liability','debit',Number(total)],...(net>0n?[['rider_payable','credit',Number(net)]]:[]),...(fee>0n?[['platform_commission_revenue','credit',Number(fee)]]:[])];
 const food=(await c.query('SELECT * FROM food_orders WHERE shipment_id=$1',[shipment.id])).rows[0];
 if(food&&Number(food.subtotal_minor)>0){
  const subtotal=Number(food.subtotal_minor),commission=Number(food.food_commission_minor);
  const rawRestDiscount=Number(food.restaurant_funded_discount_minor||0);
  const elesendSubsidy=Number(food.elesend_funded_discount_minor||0);
  const restDiscount=Math.min(rawRestDiscount,Math.max(0,subtotal-commission));
  const restDeliveryDiscountExcess=Math.max(0,rawRestDiscount-restDiscount);
  check(
   Number.isSafeInteger(subtotal)&&Number.isSafeInteger(commission)&&
   Number.isSafeInteger(rawRestDiscount)&&Number.isSafeInteger(elesendSubsidy)&&
   rawRestDiscount>=0&&elesendSubsidy>=0&&commission>=0&&
   restDiscount+commission<=subtotal,
   409,'Invalid food settlement amounts'
  );
  entries[0][2]+=subtotal-rawRestDiscount-elesendSubsidy;
  if(elesendSubsidy>0)entries.push(['platform_promotion_subsidy_expense','debit',elesendSubsidy]);
  if(restDeliveryDiscountExcess>0)entries.push(['platform_promotion_subsidy_expense','debit',restDeliveryDiscountExcess]);
  const restPayable=subtotal-restDiscount-commission;
  if(restPayable>0)entries.push(['restaurant_payable','credit',restPayable]);
  if(commission>0)entries.push(['platform_food_commission_revenue','credit',commission]);
 }
 return checkoutJournal(c,{shipmentId:shipment.id,eventKey:'delivery:'+shipment.id+':digitally-completed',kind:'delivery_completed',entries});
}
