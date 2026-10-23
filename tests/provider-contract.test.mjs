import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPaymentProvider,paymentWebhook,validatePayer} from '../services/api/payment-provider.mjs';
import {validateConfig} from '../services/api/config.mjs';
import {restaurantOpenNow} from '../services/api/food-payment.mjs';
import {paymentGateway} from '../services/api/providers/payment-gateway.mjs';
import {paystackCheckout} from '../services/api/paystack-checkout-adapter.mjs';
test('provider is explicitly selected; installing another adapter does not change checkout',()=>{
 const p=createPaymentProvider({provider:'different',options:{merchant:'example'}},{adapters:{different:options=>({name:'different',...options})}});
 assert.equal(p.name,'different');assert.equal(p.merchant,'example');
 assert.equal(createPaymentProvider({provider:null}),null);
 const r=validateConfig({PAYSTACK_SECRET_KEY:'sk_test_example'});assert.equal(r.config.payment.provider,null);
});
test('payer requirements belong to the adapter',()=>{
 assert.doesNotThrow(()=>validatePayer({payerFields:[]},{}));
 assert.throws(()=>validatePayer({payerFields:['email']},{}),/email/);
 assert.doesNotThrow(()=>validatePayer({payerFields:['email']},{email:'person@example.test'}));
});
test('one verified webhook routes arbitrary references to checkout or commission',async()=>{
 const intent=randomUUID();let record={reference:'arbitrary-order-reference',status:'success',channel:'mobile_money',eventId:'evt_123',amountMinor:100,currency:'GHS'};
 const calls=[];
 const handle=paymentWebhook({db:{query:async(sql)=>({rowCount:sql.includes('shipment_checkout_intents')?(record.reference==='arbitrary-order-reference'?1:0):1})},provider:{name:'different',parseVerifiedWebhook:async()=>record,commissionIntentId:()=>intent},checkout:{confirmVerified:async r=>calls.push(['order',r.reference])},finance:{confirmed:async r=>calls.push(['commission',r.intentId])}});
 await handle(Buffer.from('{}'),{});record={...record,reference:'arbitrary-commission-reference'};await handle(Buffer.from('{}'),{});
 assert.deepEqual(calls,[['order','arbitrary-order-reference'],['commission',intent]]);
});
test('bridge supports an approved external PSP without built-in vendor names',async()=>{
 let calls=0;
 const gateway=paymentGateway({name:'other_psp',endpoint:'https://bridge.example.test/api',allowedHost:'bridge.example.test',token:'x'.repeat(32),checkoutHosts:['pay.example.test'],fetchImpl:async(url,options)=>{calls++;assert.equal(url.hostname,'bridge.example.test');assert.equal(options.redirect,'error');return {ok:true,json:async()=>({verified:true,status:'success',reference:'merchant-reference'})};}});
 assert.equal(gateway.name,'other_psp');assert.equal((await gateway.verifyPayment('merchant-reference')).verified,true);assert.equal(calls,1);
 assert.throws(()=>paymentGateway({name:'other_psp',endpoint:'http://bridge.example.test',allowedHost:'bridge.example.test',token:'x'.repeat(32),checkoutHosts:['pay.example.test']}),/approved HTTPS/);
});
test('operating hours include overnight service and reject closed times',()=>{
 const r={is_open:true,is_paused:false,operating_hours:{monday:{open:'20:00',close:'02:00'}}};
 assert.equal(restaurantOpenNow(r,new Date('2026-10-19T21:00:00Z')),true);
 assert.equal(restaurantOpenNow(r,new Date('2026-10-20T01:00:00Z')),true);
 assert.equal(restaurantOpenNow(r,new Date('2026-10-20T03:00:00Z')),false);
});
test('native refund adapter independently verifies amount and original transaction',async()=>{
 const requestId=randomUUID(),wrongId=randomUUID();let amount=6200,noteId=requestId;
 const p=paystackCheckout({secretKey:'sk_test_example',production:false,fetchImpl:async(url)=>({ok:true,json:async()=>({status:true,data:String(url).includes('/transaction/verify/')?{id:123,reference:'es_reference',status:'success',amount:6200,currency:'GHS',channel:'mobile_money',domain:'test'}:{id:45,transaction:123,amount,currency:'GHS',status:'processed',domain:'test',merchant_note:'ELESEND refund '+noteId}})})});
 const input={requestId,providerId:'45',reference:'es_reference',amountMinor:6200,currency:'GHS'};
 const verified=await p.verifyRefund(input);
 assert.equal(verified.status,'refunded');assert.equal(verified.requestId,requestId);
 noteId=wrongId;assert.equal((await p.verifyRefund(input)).requestId,wrongId);
 amount=1;noteId=requestId;await assert.rejects(p.verifyRefund(input),/mismatch/);
});
test('adapter commissionIntentId and parseVerifiedWebhook support both object and positional invocation',async()=>{
 const id=randomUUID(),ref='escomm_'+id.replaceAll('-','');
 const gateway=paymentGateway({name:'other_psp',endpoint:'https://bridge.example.test/api',allowedHost:'bridge.example.test',token:'x'.repeat(32),checkoutHosts:['pay.example.test'],fetchImpl:async()=>({ok:true,json:async()=>({verified:true,status:'success',reference:ref,channel:'mobile_money',amountMinor:1500,currency:'GHS',eventId:'evt_gw_1'})})});
 assert.equal(gateway.commissionIntentId(ref),id);
 assert.equal(gateway.commissionIntentId({reference:ref}),id);
 const parsedObj=await gateway.parseVerifiedWebhook({rawBody:Buffer.from('{"ok":true}'),headers:{'x-custom':'1'}});
 assert.equal(parsedObj.reference,ref);
 const parsedPos=await gateway.parseVerifiedWebhook(Buffer.from('{"ok":true}'),{'x-custom':'1'});
 assert.equal(parsedPos.reference,ref);
});
