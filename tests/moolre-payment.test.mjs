import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {moolreCheckout} from '../services/api/modules/payments/providers/moolre-payment.mjs';
import {assertPaymentOperations} from '../services/api/startup-guards.mjs';
import {validateConfig} from '../services/api/config.mjs';

const SECRET='callback-secret-value',ACCOUNT='100000100002';
function adapter(answer,options={}){
 const calls=[];
 const p=moolreCheckout({apiUser:'elesend',publicKey:'pub',privateKey:'priv',accountNumber:ACCOUNT,callbackSecret:SECRET,merchantEmail:'pay@example.test',callbackBaseUrl:'https://api.example.test',returnBaseUrl:'https://app.example.test',processingFeeBps:0,production:false,
  fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);calls.push({url:String(url),headers:init.headers,body});const r=answer(String(url),body);if(r instanceof Error)throw r;return {ok:r.httpOk??true,json:async()=>r};},...options});
 return {p,calls};
}
const status=(id,over={},top={})=>({status:1,code:'SS01',message:'Transaction Successful',go:null,...top,data:{txstatus:1,accountnumber:ACCOUNT,amount:'62.50',value:'62.50',transactionid:'31772290',externalref:id,thirdpartyref:'47',...over}});

test('a complete adapter for production startup, chosen only explicitly',()=>{
 const {p}=adapter(()=>({}));
 assert.doesNotThrow(()=>assertPaymentOperations(p,{production:true}));
 assert.equal(validateConfig({}).config.payment.provider,null);
 const missing=validateConfig({PAYMENT_PROVIDER:'moolre',MOOLRE_API_USER:'u'});
 for(const key of ['MOOLRE_ACCOUNT_NUMBER','MOOLRE_CALLBACK_SECRET','MOOLRE_PRIVATE_KEY','MOOLRE_CUSTOMER_FEE_BPS'])assert.ok(missing.errors.some(e=>e.includes(key)),key);
 assert.throws(()=>adapter(()=>({}),{production:true,sandbox:true}),/sandbox/);
 assert.throws(()=>adapter(()=>({}),{callbackSecret:''}),/secret/);
});

test('checkout uses a safe reference and a trusted link, and sends money as text',async()=>{
 const {p,calls}=adapter(()=>({status:1,code:'POS09',data:{authorization_url:'https://pos.moolre.com/pay/abc',reference:'x'}}));
 const out=await p.createCheckout({reference:'es_abc12345',amountMinor:17397,currency:'GHS',method:'MOMO'});
 assert.equal(out.reference,'es_abc12345');
 assert.equal(calls[0].body.externalref,'es-abc12345');
 assert.equal(calls[0].body.amount,'173.97');
 assert.equal(calls[0].body.accountnumber,ACCOUNT);
 assert.equal(calls[0].headers['X-API-PUBKEY'],'pub');
 assert.equal(calls[0].headers['X-API-KEY'],undefined,'the private key is not used for checkout');
 const bad=adapter(()=>({status:1,data:{authorization_url:'https://evil.example.test/pay'}}));
 await assert.rejects(bad.p.createCheckout({reference:'es_abc12345',amountMinor:100,currency:'GHS',method:'MOMO'}),/Untrusted/);
 await assert.rejects(p.createCheckout({reference:'es_abc12345',amountMinor:100,currency:'GHS',method:'CARD'}),/not enabled/);
});

test('a payment only counts when Moolre reports it, for this reference and wallet',async()=>{
 const verify=async(data,top)=>adapter((u,b)=>status(b.id,data,top)).p.verifyPayment('es_abc12345');
 const ok=await verify();
 assert.deepEqual([ok.status,ok.amountMinor,ok.reference,ok.eventId],['success',6250,'es_abc12345','moolre-transaction:31772290']);
 assert.equal((await verify({txstatus:0})).status,'pending');
 assert.equal((await verify({txstatus:2})).status,'failed');
 assert.equal((await verify({},{code:'SS09'})).status,'pending');
 await assert.rejects(verify({externalref:'es-other0000'}),/another transaction/);
 await assert.rejects(verify({accountnumber:'999999'}),/another wallet/);
 assert.equal((await adapter(()=>({status:0,code:'SS07',data:{txstatus:2}})).p.verifyPayment('es_abc12345')).status,'pending','not found is not a failure');
});

test('a callback needs the secret, and is read back from Moolre before it counts',async()=>{
 const {p,calls}=adapter((u,b)=>status(b.id));
 const body=(over={},code='P01')=>Buffer.from(JSON.stringify({status:code==='P01'?1:0,code,data:{txstatus:1,externalref:'es-abc12345',amount:'999999',secret:SECRET,...over}}));
 await assert.rejects(p.parseVerifiedWebhook(body({secret:'wrong-secret-value-x'}),{}),/secret/);
 await assert.rejects(p.parseVerifiedWebhook(body({secret:undefined}),{}),/secret/);
 assert.equal(calls.length,0);
 const record=await p.parseVerifiedWebhook(body(),{});
 assert.equal(record.reference,'es_abc12345');
 assert.equal(record.amountMinor,6250,'the amount comes from the lookup, not the callback');
 assert.equal(await p.parseVerifiedWebhook(body({},'P02'),{}),null,'a failed payment callback marks nothing paid');
 assert.equal(await p.parseVerifiedWebhook(body({externalref:'espayout-'+randomUUID()}),{}),null);
 const id=randomUUID();
 const commission=await p.parseVerifiedWebhook(body({externalref:'escomm-'+id.replaceAll('-','')}),{});
 assert.equal(p.commissionIntentId(commission),id);
});

test('riders are paid only to their SMS-verified number',async()=>{
 const {p}=adapter(()=>({}));
 const {recipientReference}=await p.createBeneficiary({phone:'+233241234567',network:'MTN'});
 assert.equal(recipientReference,'moolre:1:0241234567');
 const check=phone=>p.verifyBeneficiary({beneficiaryId:'r',recipientReference,verifiedPhone:phone});
 assert.equal((await check('0241234567')).verified,true);
 assert.equal((await check('0551234567')).verified,false);
 await assert.rejects(p.createBeneficiary({phone:'0241234567',network:'OTHER'}),/Unsupported/);
 // Malformed/multi-number strings must never be silently truncated to a payout destination.
 for(const phone of ['abc0241234567','9990241234567','0241234567 ext 123','+233241234567000','024 1234567 extra']){
  await assert.rejects(p.createBeneficiary({phone,network:'MTN'}),/Valid mobile money number required/,phone);
 }
 const invalid=await check('9990241234567');
 assert.equal(invalid.verified,false,'a different/malformed phone cannot verify a payout destination');
});

test('a payout keeps one reference, uses the private key, and survives a repeat',async()=>{
 const requestId=randomUUID();let answer={status:'1',code:'OBGH01',data:{txstatus:1,transactionid:'32759150'}};
 const {p,calls}=adapter(()=>answer);
 const input={requestId,recipientReference:'moolre:6:0201234567',amountMinor:9900,currency:'GHS'};
 assert.deepEqual(await p.createPayout(input),{providerId:'32759150'});
 assert.equal(calls[0].headers['X-API-KEY'],'priv');
 assert.deepEqual([calls[0].body.channel,calls[0].body.receiver,calls[0].body.amount,calls[0].body.externalref],['6','0201234567','99.00','espayout-'+requestId]);
 answer={status:'0',code:'APY18'};
 assert.deepEqual(await p.createPayout(input),{providerId:null},'already sent: the lookup decides');
 answer={status:'0',code:'APY21',httpOk:false};
 await assert.rejects(p.createPayout(input),/not accepted/,'stays locked for review');
 calls.length=0;
 const network=adapter(()=>Object.assign(Error('timeout')));
 await assert.rejects(network.p.createPayout(input),/timeout/,'an unknown outcome is never treated as failed');
});

test('an unclear payout never releases money',async()=>{
 const requestId=randomUUID(),input={requestId,recipientReference:'moolre:1:0241234567',amountMinor:6250,currency:'GHS'};
 const outcome=async(answer,options)=>adapter(answer,options).p.verifyPayout(input);
 const paid=await outcome((u,b)=>status(b.id));
 assert.deepEqual([paid.status,paid.providerId,paid.amountMinor,paid.eventId],['paid','31772290',6250,'transfer:31772290']);
 assert.equal((await outcome(()=>({status:0,code:'SS07',data:{txstatus:2}}))).status,'not_found');
 assert.equal((await outcome((u,b)=>status(b.id,{txstatus:0}))).status,'pending');
 assert.equal((await outcome((u,b)=>status(b.id,{txstatus:2},{status:0,code:'SS02'}))).status,'pending','failure needs written confirmation');
 const failed=await outcome((u,b)=>status(b.id,{txstatus:2},{status:0,code:'SS02'}),{failedStatusConfirmed:true});
 assert.equal(failed.status,'failed');
 assert.ok(failed.eventId.endsWith(':failed'));
 await assert.rejects(outcome((u,b)=>status(b.id,{amount:'1.00'})),/mismatch/);
 await assert.rejects(outcome((u,b)=>status('espayout-other')),/another transaction/);
});

test('a refund goes to the verified customer number, up to what was paid',async()=>{
 const requestId=randomUUID(),input={requestId,reference:'es_abc12345',amountMinor:6250,currency:'GHS',customerPhone:'+233241234567'};
 // Moolre's name check confirms the number is on MTN (channel 1) and on no other network.
 const validate=b=>b.channel==='1'?{status:1,code:'AVD01',data:'KWAME MENSAH'}:{status:0,code:'AVD02',data:'Phone No. not found',httpOk:false};
 const {p,calls}=adapter((u,b)=>u.endsWith('/status')?status(b.id):u.endsWith('/validate')?validate(b):{status:'1',code:'OBGH01',data:{transactionid:'7'}});
 assert.equal(p.requiresRefundPhone,true);
 assert.deepEqual(await p.createRefund(input),{providerId:'7'});
 const sent=calls.at(-1);
 assert.deepEqual([sent.body.receiver,sent.body.channel,sent.body.externalref],['0241234567','1','esrefund-'+requestId]);
 await assert.rejects(p.createRefund({...input,amountMinor:6251}),/exceeds/);
 await assert.rejects(p.createRefund({...input,customerPhone:'+233111234567'}),/needs staff/);
 const done=adapter((u,b)=>status(b.id));
 const v=await done.p.verifyRefund({requestId,reference:'es_abc12345',amountMinor:6250,currency:'GHS'});
 assert.deepEqual([v.status,v.requestId,v.reference,v.providerId],['refunded',requestId,'es_abc12345','31772290']);
 assert.equal((await adapter(()=>({status:0,code:'SS07'})).p.verifyRefund({requestId,amountMinor:6250,currency:'GHS'})).status,'pending');
});

test('amounts round-trip without floating point',async()=>{
 const {p}=adapter((u,b)=>status(b.id,{amount:'1234.5'}));
 assert.equal((await p.verifyPayment('es_abc12345')).amountMinor,123450);
 assert.equal(Number.isNaN((await adapter((u,b)=>status(b.id,{amount:'1e3'})).p.verifyPayment('es_abc12345')).amountMinor),true,'unreadable amounts never become money');
});
