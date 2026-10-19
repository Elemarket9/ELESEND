import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {paystackCheckout} from '../services/api/paystack-checkout-adapter.mjs';
const key='sk_test_test-only-placeholder-not-a-real-key';
function fixture(){
 const requests=[],payments=new Map();
 const fetchImpl=async(url,{method,body,headers}={})=>{
  const path=new URL(url).pathname;
  assert.equal(headers.Authorization,`Bearer ${key}`);
  requests.push({path,method,body});
  if(path==='/transaction/initialize'){
   const b=JSON.parse(body);payments.set(b.reference,{id:requests.length,reference:b.reference,status:'success',domain:'test',amount:Number(b.amount),currency:b.currency,channel:b.channels[0]});
   return {ok:true,json:async()=>({status:true,data:{reference:b.reference,authorization_url:'https://checkout.paystack.com/test-checkout'}})};
  }
  if(path.startsWith('/transaction/verify/')){
   const ref=decodeURIComponent(path.split('/').at(-1));
   return {ok:true,json:async()=>({status:true,data:payments.get(ref)})};
  }
  return {ok:false,status:404,json:async()=>({})};
 };
 return {provider:paystackCheckout({secretKey:key,fetchImpl,production:false}),payments,requests};
}
test('MOMO uses authorized hosted mobile_money; QR link uses PSP-backed channels, card uses hosted checkout',async()=>{
 const {provider,payments,requests}=fixture();
 for(const method of ['MOMO','CARD','QR']){
  const reference='es_12345678_'+method;
  const r=await provider.createCheckout({reference,amountMinor:3550,currency:'GHS',method,email:'payer@example.org'});
  assert.equal(r.reference,reference);assert.equal(r.checkoutUrl,'https://checkout.paystack.com/test-checkout');
  const body=JSON.parse(requests.at(-1).body);
  assert.deepEqual(body.channels,method==='MOMO'?['mobile_money']:method==='CARD'?['card']:['mobile_money','card']);
  assert.equal((await provider.verifyPayment(reference)).amountMinor,3550);
 }
 assert.equal(payments.size,3);
});
test('webhook must be signed AND independently verified, not trust injected amount',async()=>{
 const {provider,payments}=fixture();
 const ref='es_abcdefgh01234567';
 await provider.createCheckout({reference:ref,amountMinor:5500,currency:'GHS',method:'MOMO',email:'payer@example.org'});
 const raw=Buffer.from(JSON.stringify({event:'charge.success',data:{reference:ref,amount:1,status:'success'}}));
 const signed={'x-paystack-signature':createHmac('sha512',key).update(raw).digest('hex')};
 await assert.rejects(provider.parseVerifiedWebhook(raw,{}),e=>e.status===403);
 await assert.rejects(provider.parseVerifiedWebhook(raw,{'x-paystack-signature':'0'.repeat(128)}),e=>e.status===403);
 const data=await provider.parseVerifiedWebhook(raw,signed);
 assert.equal(data.amountMinor,5500);assert.equal(data.reference,ref);
 payments.get(ref).status='pending';assert.equal((await provider.parseVerifiedWebhook(raw,signed)).status,'pending');
});
test('production rejects test keys',()=>{
 assert.throws(()=>paystackCheckout({secretKey:key,production:true}),e=>e.status===503);
});
test('commission settlement uses separate reference prefix and verified MoMo channel',async()=>{
 const {provider}=fixture();
 const intentId='8abbb8cb-1bba-4bcd-8200-112233445566';
 const issued=await provider.createPayment({intentId,amountMinor:800,currency:'GHS',email:'rider@example.org'});
 const raw=Buffer.from(JSON.stringify({event:'charge.success',data:{reference:issued.reference}}));
 const headers={'x-paystack-signature':createHmac('sha512',key).update(raw).digest('hex')};
 const result=await provider.verifyEvent({rawBody:raw,headers});
 assert.equal(result.intentId,intentId);assert.equal(result.amountMinor,800);assert.equal(result.providerName,'paystack');
});
