import {check} from './security.mjs';
import {hubtelCheckout} from './providers/hubtel-payment.mjs';
import {paystackCheckout} from './paystack-checkout-adapter.mjs';
import {paymentGateway} from './providers/payment-gateway.mjs';

// Only this composition boundary knows concrete adapter names. A deployment
// can use its own contracted PSP through the documented gateway contract.
export function createPaymentProvider(config,{adapters={hubtel:hubtelCheckout,paystack:paystackCheckout,gateway:paymentGateway}}={}){
 if(!config.provider)return null;
 const factory=adapters[config.provider];
 check(typeof factory==='function',500,'Payment adapter is not installed');
 return factory(config[config.provider]||config.options||{});
}

export function validatePayer(provider,input){
 for(const field of provider?.payerFields||[]){
  check(field==='email',500,'Unsupported payment payer field');
  check(typeof input.email==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email),400,'Payment receipt email is required');
 }
 provider?.validateCheckoutInput?.(input);
}

export function paymentWebhook({db,provider,checkout,finance,money,moneyOperations}){
 const moneySvc=moneyOperations??money;
 return async(rawBody,headers)=>{
  check(typeof provider?.parseVerifiedWebhook==='function',503,'Payment webhook unavailable');
  const record=await provider.parseVerifiedWebhook(rawBody,headers);
  if(!record)return {status:'ignored'};
  if(record.type==='refund'||record.kind==='refund')return record.status==='refunded'?moneySvc.confirmRefund(record):{status:'acknowledged'};
  if(record.type==='payout'||record.kind==='payout')return record.status==='paid'?moneySvc.confirmPayout(record):{status:'acknowledged'};
  const reversal=record.status==='reversed';
  if(record.status!=='success'&&!reversal)return {status:'ignored'};
  if((await db.query('SELECT 1 FROM shipment_checkout_intents WHERE provider=$1 AND reference=$2',[provider.name,record.reference])).rowCount){
   // Customer-payment reversals/chargebacks require finance review; never auto-confirm or silently drop.
   if(reversal){await db.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES(NULL,'payment.checkout_reversal_reported',NULL)");return {status:'acknowledged',requiresReview:true};}
   return checkout.confirmVerified(record);
  }
  let intentId=provider.commissionIntentId?.(record)??provider.commissionIntentId?.(record.reference)??null;
  if(!intentId&&record.reference){
   const byRef=await db.query('SELECT id FROM settlement_intents WHERE provider_reference=$1 AND provider=$2',[record.reference,provider.name]);
   intentId=byRef.rows?.[0]?.id??null;
  }else if(intentId){
   const found=await db.query('SELECT id FROM settlement_intents WHERE (id=$1 OR provider_reference=$2) AND provider=$3',[intentId,record.reference??null,provider.name]);
   check(found.rowCount,404,'Unrecognized payment reference');
   if(found.rows?.[0]?.id)intentId=found.rows[0].id;
  }
  check(intentId,404,'Unrecognized payment reference');
  // Verified provider reversal of a commission repayment reinstates the debt (idempotent per event).
  if(reversal)return finance.reversed({providerName:provider.name,eventId:record.eventId,intentId,reason:record.failureReason||'Provider reversal'});
  const channels=(await db.query("SELECT repayment_channels FROM rider_wallet_policy WHERE id='default'")).rows?.[0]?.repayment_channels??['mobile_money'];
  check(record.status==='success'&&channels.includes(record.channel),409,'Commission repayment not verified');
  return finance.confirmed({providerName:provider.name,eventId:record.eventId,intentId,amountMinor:record.amountMinor,currency:record.currency});
 };
}
