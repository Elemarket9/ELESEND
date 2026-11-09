import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {paystackCheckout} from '../services/api/modules/payments/paystack-checkout-adapter.mjs';
import {assertPaymentOperations} from '../services/api/startup-guards.mjs';
import {paymentWebhook} from '../services/api/modules/payments/payment-provider.mjs';
import {moneyOperations} from '../services/api/modules/payments/money-operations.mjs';
import {getPublicTracking,createPublicTrackingToken} from '../services/api/infrastructure/maps/web-tracker.mjs';

const KEY='sk_test_example',PHONE='+233241234567',RCP='RCP_abc123';
const recipient=over=>({recipient_code:RCP,type:'mobile_money',currency:'GHS',active:true,domain:'test',details:{account_number:'0241234567',account_name:null},...over});
function fake(handler){
 const calls=[];
 const fetchImpl=async(url,options={})=>{
  const path=String(url).replace('https://api.paystack.co','');const body=options.body?JSON.parse(options.body):null;calls.push({path,method:options.method||'GET',body});
  const data=handler(path,body);
  return {ok:data!==undefined,status:data===undefined?404:200,json:async()=>({status:true,data})};
 };
 return {calls,adapter:paystackCheckout({secretKey:KEY,production:false,fetchImpl})};
}
const transfer=(requestId,over={})=>({id:77,reference:'espayout-'+requestId,amount:5000,currency:'GHS',status:'success',domain:'test',transfer_code:'TRF_1',recipient:{recipient_code:RCP},...over});

test('Paystack now passes the production operations check',()=>{
 assert.doesNotThrow(()=>assertPaymentOperations(fake(()=>({})).adapter,{production:true}));
});

test('recipients use the verified phone and a network confirmed by Paystack',async()=>{
 const {adapter,calls}=fake(path=>path.startsWith('/bank')?[{code:'VOD',active:true}]:recipient());
 assert.deepEqual(await adapter.createBeneficiary({phone:PHONE,network:'TELECEL',accountName:' Ama Mensah '}),{recipientReference:RCP});
 const created=calls.find(c=>c.path==='/transferrecipient');
 assert.deepEqual(created.body,{type:'mobile_money',name:'Ama Mensah',account_number:'0241234567',bank_code:'VOD',currency:'GHS'});
 await assert.rejects(adapter.createBeneficiary({phone:PHONE,network:'MTN',accountName:'Ama'}),e=>e.status===503);
 await assert.rejects(adapter.createBeneficiary({phone:PHONE,network:'OTHER',accountName:'Ama'}),e=>e.status===400);
});

test('a recipient only verifies when it matches the verified phone and is usable',async()=>{
 for(const [over,phone,expected] of [
  [{},PHONE,true],[{details:{account_number:'233241234567'}},PHONE,true],
  [{details:{account_number:'0551112222'}},PHONE,false],[{active:false},PHONE,false],[{type:'nuban'},PHONE,false],[{currency:'NGN'},PHONE,false],[{},undefined,false]
 ]){
  const {adapter}=fake(()=>recipient(over));
  assert.equal((await adapter.verifyBeneficiary({beneficiaryId:'u',recipientReference:RCP,verifiedPhone:phone})).verified,expected,JSON.stringify(over));
 }
});

test('payouts send the documented request with a stable, valid reference',async()=>{
 const requestId=randomUUID();
 const {adapter,calls}=fake(()=>({status:'pending',transfer_code:'TRF_1'}));
 assert.deepEqual(await adapter.createPayout({requestId,recipientReference:RCP,amountMinor:5000,currency:'GHS'}),{providerId:'TRF_1'});
 const {body}=calls[0];
 assert.equal(calls[0].path,'/transfer');assert.equal(body.source,'balance');assert.equal(body.amount,5000);assert.equal(body.recipient,RCP);
 assert.match(body.reference,/^[a-z0-9_-]{16,50}$/);assert.ok(body.reference.includes(requestId));
 const otp=fake(()=>({status:'otp'})).adapter;
 await assert.rejects(otp.createPayout({requestId,recipientReference:RCP,amountMinor:5000,currency:'GHS'}),/OTP/);
});

test('transfer statuses map safely, and unknown ones stay pending',async()=>{
 const requestId=randomUUID();
 for(const [status,expected] of [['success','paid'],['failed','failed'],['reversed','failed'],['pending','pending'],['otp','pending'],['abandoned','failed'],['blocked','failed'],['rejected','failed'],['something_new','pending']]){
  const record=await fake(()=>transfer(requestId,{status})).adapter.verifyPayout({requestId});
  assert.equal(record.status,expected,status);assert.equal(record.requestId,requestId);assert.equal(record.recipientReference,RCP);
 }
});

test('production refuses test-mode transfers and recipients',async()=>{
 const requestId=randomUUID();
 const live=handler=>paystackCheckout({secretKey:'sk_live_example',production:true,fetchImpl:async()=>({ok:true,json:async()=>({status:true,data:handler()})})});
 await assert.rejects(live(()=>transfer(requestId)).verifyPayout({requestId}),/not live/);
 await assert.rejects(live(()=>recipient()).verifyBeneficiary({beneficiaryId:'u',recipientReference:RCP,verifiedPhone:PHONE}),/not live/);
});

const signed=(adapter,event)=>{const rawBody=Buffer.from(JSON.stringify(event));return {rawBody,headers:{'x-paystack-signature':createHmac('sha512',KEY).update(rawBody).digest('hex')}};};

test('transfer webhooks are re-verified with Paystack, and forged ones refused',async()=>{
 const requestId=randomUUID(),reference='espayout-'+requestId;
 const {adapter,calls}=fake(()=>transfer(requestId));
 const {rawBody,headers}=signed(adapter,{event:'transfer.success',data:{reference,status:'failed'}});
 const record=await adapter.parseVerifiedWebhook(rawBody,headers);
 assert.equal(record.status,'paid');assert.ok(calls.some(c=>c.path==='/transfer/verify/'+reference));
 await assert.rejects(adapter.parseVerifiedWebhook(rawBody,{'x-paystack-signature':'0'.repeat(128)}),e=>e.status===403);
 const other=signed(adapter,{event:'transfer.success',data:{reference:'someone-elses-transfer'}});
 assert.equal(await adapter.parseVerifiedWebhook(other.rawBody,other.headers),null);
});

test('a reversed transfer is flagged for review, not silently ignored',async()=>{
 const requestId=randomUUID(),logs=[];
 const db={query:async(sql,params)=>{logs.push({sql,params});return {rowCount:0,rows:[]};}};
 const provider={name:'paystack',parseVerifiedWebhook:async()=>({type:'payout',status:'failed',reversed:true,eventId:'transfer:7:reversed',requestId})};
 const result=await paymentWebhook({db,provider})(Buffer.from('{}'),{});
 assert.equal(result.requiresReview,true);
 assert.deepEqual(logs[0].params,['payment.payout_reversal_reported:transfer:7:reversed',requestId]);
});

test('payout details need a verified phone, and clients cannot choose another recipient',async()=>{
 const actor={id:randomUUID(),kind:'rider'};
 let verifiedPhoneSeen;const saved=[];
 const provider={name:'paystack',requiresVerifiedPhone:true,
  createBeneficiary:async({phone})=>({recipientReference:'RCP_'+phone.slice(-4)}),
  verifyBeneficiary:async x=>{verifiedPhoneSeen=x.verifiedPhone;return {verified:x.recipientReference==='RCP_4567',beneficiaryId:x.beneficiaryId,recipientReference:x.recipientReference};}};
 let user={phone:PHONE,phone_verified_at:new Date()};
 const db={query:async(sql,params)=>{if(sql.includes('FROM users'))return {rows:[user]};if(sql.includes('payout_beneficiaries'))saved.push(params);return {rows:[],rowCount:1};}};
 const money=moneyOperations(db,{provider});
 assert.deepEqual(await money.verifyBeneficiary(actor,{momoNetwork:'MTN',accountName:'Ama Mensah'}),{verified:true});
 assert.equal(verifiedPhoneSeen,PHONE);assert.equal(saved[0][2],'RCP_4567');
 await assert.rejects(money.verifyBeneficiary(actor,{recipientReference:'RCP_someoneelse'}),e=>e.status===409);
 user={phone:PHONE,phone_verified_at:null};
 await assert.rejects(money.verifyBeneficiary(actor,{momoNetwork:'MTN',accountName:'Ama Mensah'}),e=>e.status===403);
});

function trackingDb(id,customer){
 const row={id,customer_id:customer,rider_id:null,state:'AWAITING_ASSIGNMENT',created_at:new Date(),completed_at:null,request:{pickup:{address:'A',latitude:5.5,longitude:-0.2},destination:{address:'B [Instructions: gate 12]',latitude:5.6,longitude:-0.2}}};
 return {query:async()=>({rows:[row],rowCount:1})};
}

test('a shared tracking link does not include the rider phone',async()=>{
 const id=randomUUID(),customer=randomUUID(),rider=randomUUID();
 const row={id,customer_id:customer,rider_id:rider,state:'IN_TRANSIT',created_at:new Date(),completed_at:null,rider_phone:'+233241110000',request:{pickup:{address:'A',latitude:5.5,longitude:-0.2},destination:{address:'B',latitude:5.6,longitude:-0.2}}};
 const db={query:async()=>({rows:[row],rowCount:1})};
 const token=createPublicTrackingToken(id,{secret:'s'});
 assert.equal((await getPublicTracking(db,token,{secret:'s'})).riderPhone,null);
 assert.equal((await getPublicTracking(db,token,{secret:'s',actor:{id:customer,kind:'customer'}})).riderPhone,'+233241110000');
 assert.equal((await getPublicTracking(db,token,{secret:'s',actor:{id:rider,kind:'rider'}})).riderPhone,'+233241110000');
 assert.equal((await getPublicTracking(db,token,{secret:'s',actor:{id:randomUUID(),kind:'admin'}})).riderPhone,'+233241110000');
 assert.equal((await getPublicTracking(db,token,{secret:'s',actor:{id:randomUUID(),kind:'customer'}})).riderPhone,null);
});

test('a raw shipment ID no longer opens tracking for anyone else',async()=>{
 const id=randomUUID(),customer=randomUUID(),db=trackingDb(id,customer);
 assert.equal(await getPublicTracking(db,id,{secret:'s'}),null);
 assert.equal(await getPublicTracking(db,id,{secret:'s',actor:{id:randomUUID(),kind:'customer'}}),null);
 const own=await getPublicTracking(db,id,{secret:'s',actor:{id:customer,kind:'customer'}});
 assert.equal(own.shipmentId,id);assert.ok(own.trackingToken);
 assert.equal((await getPublicTracking(db,own.trackingToken,{secret:'s'})).shipmentId,id);
});

test('tampered, expired and wrongly signed links are refused',async()=>{
 const id=randomUUID(),db=trackingDb(id,randomUUID());
 const token=createPublicTrackingToken(id,{secret:'s'});
 assert.equal(await getPublicTracking(db,token,{secret:'other'}),null);
 assert.equal(await getPublicTracking(db,token.slice(0,-1)+(token.endsWith('0')?'1':'0'),{secret:'s'}),null);
 const [shipment,,signature]=token.split('.');
 assert.equal(await getPublicTracking(db,`${shipment}.1000000000.${signature}`,{secret:'s'}),null);
});
