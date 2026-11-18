import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {hubtelCheckout} from '../services/api/modules/payments/providers/hubtel-payment.mjs';
import {assertPaymentOperations} from '../services/api/shared/startup-guards.mjs';
import {validateVerifiedPayment,confirmedRepaymentChannelAllowed} from '../services/api/modules/payments/checkout-policy.mjs';
import {paymentWebhook} from '../services/api/modules/payments/payment-provider.mjs';

const base={clientId:'id',clientSecret:'secret',merchantAccountNumber:'201234',disbursementAccountNumber:'301234',callbackBaseUrl:'https://api.example.test',returnBaseUrl:'https://app.example.test',production:false};
function build(routes){
 const calls=[];
 const fetchImpl=async(url,options={})=>{
  const href=String(url);
  calls.push({href,body:options.body?JSON.parse(options.body):null});
  const hit=routes.find(route=>href.includes(route.match));
  if(!hit)return {ok:false,status:404,json:async()=>({})};
  return {ok:(hit.status??200)<400,status:hit.status??200,json:async()=>hit.body};
 };
 return {calls,adapter:hubtelCheckout({...base,fetchImpl})};
}
const paid=(reference,amount=10.5,paymentMethod='mobilemoney')=>({responseCode:'0000',data:{status:'Paid',clientReference:reference,amount,transactionId:'tx1',paymentMethod,currencyCode:'GHS'}});
const initiated=url=>({ResponseCode:'0000',status:'Success',Data:{checkoutUrl:url,checkoutId:'abc'}});
const callback=(reference,amount=999999)=>Buffer.from(JSON.stringify({ResponseCode:'0000',Status:'Success',Data:{ClientReference:reference,Amount:amount,Status:'Success'}}));

test('a callback cannot set the amount or the status; the status query does',async()=>{
 const reference='es_abc12345';
 const {calls,adapter}=build([{match:'api-txnstatus.hubtel.com',body:paid(reference,'10.10')}]);
 const record=await adapter.parseVerifiedWebhook(callback(reference),{});
 assert.equal(record.amountMinor,1010);
 assert.equal(record.reference,reference);
 assert.equal(record.status,'success');
 assert.ok(calls.some(call=>call.href.includes('clientReference='+reference)));
});

test('a status result for a different reference is refused',async()=>{
 const {adapter}=build([{match:'api-txnstatus.hubtel.com',body:paid('es_otherref1')}]);
 await assert.rejects(adapter.parseVerifiedWebhook(callback('es_abc12345'),{}),/different payment reference/);
});

test('cedis amounts become whole pesewas without binary rounding',async()=>{
 const {adapter}=build([{match:'api-txnstatus.hubtel.com',body:paid('es_abc12345',45)}]);
 assert.equal((await adapter.verifyPayment('es_abc12345')).amountMinor,4500);
});

test('an unpaid lookup stays pending even when the callback says success',async()=>{
 const {adapter}=build([{match:'api-txnstatus.hubtel.com',body:{responseCode:'0000',data:{status:'Unpaid',clientReference:'es_abc12345',amount:10,transactionId:'tx1'}}}]);
 assert.equal(await adapter.parseVerifiedWebhook(callback('es_abc12345'),{}),null);
});

test('the production payment contract accepts this adapter and rejects a callback that is neither signed nor re-queried',()=>{
 const {adapter}=build([]);
 assert.doesNotThrow(()=>assertPaymentOperations(adapter,{production:true}));
 const unsigned={...adapter,webhookSignatureEnforced:false,callbackAuthenticatedByStatusQuery:false};
 assert.throws(()=>assertPaymentOperations(unsigned,{production:true}),error=>{
  assert.match(error.message,/webhook or callback authentication is not enforced/);
  assert.equal(/cannot be used in production/.test(error.message),false);
  return true;
 });
});

test('a full refund follows the confirmed payment, and a partial refund is refused',async()=>{
 const reference='es_abc12345';
 const {calls,adapter}=build([
  {match:'api-txnstatus.hubtel.com',body:paid(reference,10)},
  {match:'refund-api.hubtel.com',body:{responseCode:'0001',data:{orderId:'tx1'}}}
 ]);
 await assert.rejects(adapter.createRefund({requestId:randomUUID(),reference,amountMinor:500,currency:'GHS'}),/match the confirmed payment/);
 const refund=await adapter.createRefund({requestId:randomUUID(),reference,amountMinor:1000,currency:'GHS'});
 assert.equal(refund.providerId,'tx1');
 assert.ok(calls.some(call=>call.href.includes('/refund/201234/order/tx1')));
});

test('a payout is sent for the verified wallet and checked by the same reference',async()=>{
 const requestId=randomUUID();
 const reference=requestId.replaceAll('-','');
 const {adapter}=build([
  {match:'smp.hubtel.com',body:{ResponseCode:'0001',Data:{ClientReference:reference,TransactionId:'po1',Amount:10}}},
  {match:'smrsc.hubtel.com',body:{ResponseCode:'success',Data:{ClientReference:reference,TransactionId:'po1',Amount:10,transactionStatus:'success'}}}
 ]);
 const recipient=await adapter.createBeneficiary({phone:'+233241234567',network:'MTN'});
 assert.equal(recipient.recipientReference,'hubtel:mtn-gh:233241234567');
 const sent=await adapter.createPayout({requestId,recipientReference:recipient.recipientReference,amountMinor:1000,currency:'GHS'});
 assert.equal(sent.providerId,'po1');
 const checked=await adapter.verifyPayout({requestId,recipientReference:recipient.recipientReference,amountMinor:1000,currency:'GHS'});
 assert.equal(checked.status,'paid');
 assert.equal(checked.requestId,requestId);
});

test('Hubtel checkout cannot be limited to one channel, and a confirmed card or QR payment is accepted',async()=>{
 const page={match:'payproxyapi.hubtel.com',body:initiated('https://checkout.hubtel.com/pay/abc')};
 const {calls,adapter}=build([page]);
 const checkout=await adapter.createCheckout({reference:'es_abc12345',amountMinor:1050,currency:'GHS',method:'MOMO',email:'a@b.test'});
 assert.equal(checkout.checkoutUrl,'https://checkout.hubtel.com/pay/abc');
 assert.equal(calls[0].body.clientReference,'es_abc12345');
 assert.equal('channel' in calls[0].body,false);
 assert.equal('allowedChannels' in calls[0].body,false);
 assert.equal(adapter.hostedCheckoutChannelRestricted,false);
 const intentId=randomUUID();
 calls.length=0;
 await adapter.createPayment({intentId,amountMinor:1000,currency:'GHS',allowedChannels:['mobile_money']});
 assert.equal(calls[0].body.clientReference,'escomm_'+intentId.replaceAll('-',''));
 assert.equal('allowedChannels' in calls[0].body,false);
 await assert.rejects(adapter.createPayment({intentId,amountMinor:1000,currency:'GHS',allowedChannels:'qr'}),/Invalid repayment channels/);

 const card=build([{match:'api-txnstatus.hubtel.com',body:paid('es_abc12345',10.5,'card')}]);
 assert.equal((await card.adapter.verifyPayment('es_abc12345')).channel,'card');
 const reference='escomm_'+intentId.replaceAll('-','');
 const qr=build([{match:'api-txnstatus.hubtel.com',body:paid(reference,10,'ghqr')}]);
 const event=await qr.adapter.verifyEvent({rawBody:callback(reference),headers:{}});
 assert.equal(event.verified,true);
 assert.equal(event.channel,'qr');
 assert.equal(event.intentId,intentId);
 const evidence={status:'success',reference:'es_abc12345',amountMinor:1050,currency:'GHS',eventId:'hubtel-transaction:tx1'};
 assert.equal(validateVerifiedPayment({...evidence,channel:'card'},{reference:evidence.reference,amountMinor:1050,currency:'GHS',method:'MOMO',acceptedChannels:adapter.collectableChannels}),true);
 assert.throws(()=>validateVerifiedPayment({...evidence,channel:'card'},{reference:evidence.reference,amountMinor:1050,currency:'GHS',method:'MOMO'}),/Unexpected payment channel/);
 assert.equal(confirmedRepaymentChannelAllowed('qr',{policyChannels:['mobile_money','card'],provider:adapter}),true);
 assert.equal(confirmedRepaymentChannelAllowed('bank_transfer',{policyChannels:['mobile_money','card'],provider:adapter}),false);
 assert.equal(confirmedRepaymentChannelAllowed('qr',{policyChannels:['mobile_money','card'],provider:{name:'paystack'}}),false);

 const callsMade=[];
 const handle=paymentWebhook({
  db:{query:async sql=>{
   if(String(sql).includes('shipment_checkout_intents'))return {rowCount:0,rows:[]};
   if(String(sql).includes('repayment_channels'))return {rowCount:1,rows:[{repayment_channels:['mobile_money','card']}]};
   return {rowCount:1,rows:[{id:intentId}]};
  }},
  provider:qr.adapter,
  checkout:{confirmVerified:async()=>{throw Error('checkout');}},
  finance:{confirmed:async record=>callsMade.push(record)}
 });
 await handle(callback(reference),{});
 assert.equal(callsMade[0].intentId,intentId);
 assert.equal(callsMade[0].amountMinor,1000);
});
