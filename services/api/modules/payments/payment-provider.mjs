import {check} from '../../security.mjs';
import {confirmedRepaymentChannelAllowed} from './checkout-policy.mjs';
import {hubtelCheckout} from './providers/hubtel-payment.mjs';
import {paystackCheckout} from './paystack-checkout-adapter.mjs';
import {paymentGateway} from './providers/payment-gateway.mjs';
import {moolreCheckout} from './providers/moolre-payment.mjs';

// Only this composition boundary knows concrete adapter names. A deployment
// can use its own contracted PSP through the documented gateway contract.
export function createPaymentProvider(config,{adapters={hubtel:hubtelCheckout,paystack:paystackCheckout,moolre:moolreCheckout,gateway:paymentGateway}}={}){
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
  if(record.type==='payout'||record.kind==='payout'){
   // Money returned after a payout looked complete needs finance review: ledgers are never rewritten automatically.
   if(record.reversed){const handled=await moneySvc?.reverseWithdrawal?.(record);if(handled)return handled;await db.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES(NULL,$1,$2)',['payment.payout_reversal_reported:'+record.eventId,record.requestId]);return {status:'acknowledged',requiresReview:true};}
   return record.status==='paid'?moneySvc.confirmPayout(record):{status:'acknowledged'};
  }
  const reversal=record.status==='reversed';
  if(record.status!=='success'&&!reversal)return {status:'ignored'};
  const checkoutIntent=await db.query('SELECT shipment_id FROM shipment_checkout_intents WHERE provider=$1 AND reference=$2',[provider.name,record.reference]);
  if(checkoutIntent.rowCount){
   // Customer-payment reversals/chargebacks require finance review; never auto-confirm or silently drop.
   // The entity and reference are what let finance find the affected payment.
   if(reversal){await db.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES(NULL,$1,$2)',['payment.checkout_reversal_reported:'+record.reference,checkoutIntent.rows[0].shipment_id]);return {status:'acknowledged',requiresReview:true};}
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
  check(record.status==='success'&&confirmedRepaymentChannelAllowed(record.channel,{policyChannels:channels,provider}),409,'Commission repayment not verified');
  return finance.confirmed({providerName:provider.name,eventId:record.eventId,intentId,amountMinor:record.amountMinor,currency:record.currency});
 };
}
