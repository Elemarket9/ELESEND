import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateVerifiedPayment,validatedCheckoutUrl,CHECKOUT_METHODS,DIGITAL_METHODS} from '../services/api/checkout-policy.mjs';
const ref='es_12345678';
const record={reference:ref,amountMinor:3000,currency:'GHS',channel:'mobile_money',eventId:'psp-transaction:123',status:'success'};
const check=method=>validateVerifiedPayment(record,{reference:ref,amountMinor:3000,currency:'GHS',method});
test('cash, MoMo, card, QR are distinct methods; QR is scannable hosted checkout',()=>{
 assert.deepEqual(CHECKOUT_METHODS,['CASH','MOMO','CARD','QR']);assert.deepEqual(DIGITAL_METHODS,['MOMO','CARD','QR']);
 assert.equal(check('MOMO'),true);assert.equal(check('QR'),true);
 assert.throws(()=>check('CARD'),/Unexpected payment channel/);
 assert.equal(validateVerifiedPayment({...record,channel:'card'},{reference:ref,amountMinor:3000,currency:'GHS',method:'CARD'}),true);
});
test('backend refuses forged payment evidence, mismatched amount, status, currency and ref',()=>{
 for(const mutation of [{amountMinor:2999},{status:'pending'},{currency:'NGN'},{reference:'other'},{eventId:''}]){
  assert.throws(()=>validateVerifiedPayment({...record,...mutation},{reference:ref,amountMinor:3000,currency:'GHS',method:'MOMO'}));
 }
});
test('hosted checkout requires trusted TLS origin not malicious URLs',()=>{
 const opts={allowedHosts:['checkout.paystack.com']};
 assert.equal(validatedCheckoutUrl('https://checkout.paystack.com/abc',opts),'https://checkout.paystack.com/abc');
 for(const url of ['http://checkout.paystack.com/a','https://checkout.paystack.com.evil.com/a','https://user:pass@checkout.paystack.com/a','https://127.0.0.1/','javascript:alert(1)','https://checkout.paystack.com:8443/a']){
  assert.throws(()=>validatedCheckoutUrl(url,opts));
 }
});
