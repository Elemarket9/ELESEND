// Executes ONLY on an explicit dedicated disposable PostGIS database.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHmac} from 'node:crypto';
import {database} from '../services/api/db.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {platform} from '../services/api/platform.mjs';
import {checkoutService} from '../services/api/checkout.mjs';
import {paystackCheckout} from '../services/api/paystack-checkout-adapter.mjs';
const url=process.env.TEST_DATABASE_URL;
if(!url||!/^elesend_test(?:_|$)/.test(new URL(url).pathname.slice(1)))throw Error('Dedicated elesend_test database required');
const db=database(url);
const key='sk_test_SATISFIES_UNIT_MOCK_ONLY';
const transactions=new Map();let latestId=0;
const provider=paystackCheckout({secretKey:key,production:false,allowedMethods:['MOMO','CARD','QR'],fetchImpl:async(url,{body}={})=>{
 const path=new URL(url).pathname;
 if(path==='/transaction/initialize'){
  const b=JSON.parse(body);transactions.set(b.reference,{id:++latestId,reference:b.reference,amount:Number(b.amount),currency:b.currency,status:'success',domain:'test',channel:b.channels[0]});
  return {ok:true,json:async()=>({status:true,data:{reference:b.reference,authorization_url:'https://checkout.paystack.com/test-payer-link'}})};
 }
 if(path.startsWith('/transaction/verify/'))return {ok:true,json:async()=>({status:true,data:transactions.get(decodeURIComponent(path.split('/').at(-1)))})};
 throw Error('Unexpected request');
}});
const routing={async route(){return {source:'fixture',distanceMeters:1200,durationSeconds:180};}};
const app=platform(db,{otpKey:randomBytes(32).toString('hex'),routing});
const checkout=checkoutService(db,{provider});
let customer,outsider,admin;
const position={address:'Kasoa Road, Accra',latitude:5.536,longitude:-0.33};
const end={address:'Tema Harbour Road, Ghana',latitude:5.67,longitude:0.04};
const reject=(fn,status)=>assert.rejects(fn,e=>e.status===status);
const createJob=async(method,who=customer)=>{
 const q=await app.quote(who,{pickup:position,destination:end,recipientPhone:'0241111222',weightG:900,description:'Documents',paymentMethod:method});
 return app.book(who,{quoteId:q.id},randomUUID());
};
const signedBody=ref=>{const raw=Buffer.from(JSON.stringify({event:'charge.success',data:{reference:ref,amount:1}}));return [raw,{'x-paystack-signature':createHmac('sha512',key).update(raw).digest('hex')}];};
before(async()=>{
 await migrate(db);
 await db.query('TRUNCATE users,pricing_policies RESTART IDENTITY CASCADE');
 await db.query("UPDATE checkout_method_policies SET enabled=(method='CASH'),updated_by=NULL");
 admin=await app.register({phone:'0241111301',password:'Long-test-password-for-payments',kind:'customer'});
 await db.query("UPDATE users SET kind='admin' WHERE id=$1",[admin.id]);admin.kind='admin';
 await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'payments:configure'),($1,'pricing:write')",[admin.id]);
 customer=await app.register({phone:'0241111302',password:'Long-test-password-for-payments',kind:'customer'});
 outsider=await app.register({phone:'0241111303',password:'Long-test-password-for-payments',kind:'customer'});
 await app.setPricing(admin,{baseMinor:3000,perKmMinor:100,commissionBps:300});
});
after(async()=>db.close());
test('CASH books directly; PSP checkout prohibited',async()=>{
 const s=await createJob('CASH');assert.equal(s.state,'AWAITING_ASSIGNMENT');assert.equal(s.paid,false);
 await reject(()=>checkout.initiate(customer,s.id,{idempotencyKey:randomUUID()}),409);
});
test('customer cannot quote inactive digital, admin configures supported methods, not all accounts',async()=>{
 await reject(()=>createJob('MOMO'),503);
 await reject(()=>checkout.configure(customer,{method:'MOMO',enabled:true}),403);
 for(const method of ['MOMO','CARD','QR'])await checkout.configure(admin,{method,enabled:true});
 assert.deepEqual((await checkout.methods()).filter(x=>x.enabled).map(x=>x.method).sort(),['CARD','CASH','MOMO','QR']);
});
for(const method of ['MOMO','CARD','QR'])test(`${method} PSP payment is verified and posted once; retry immutable`,async()=>{
 const s=await createJob(method);
 assert.equal(s.state,'AWAITING_PAYMENT');
 assert.equal(s.paid,false);
 await reject(()=>checkout.initiate(outsider,s.id,{idempotencyKey:randomUUID(),email:'payer@example.com'}),404);
 const k=randomUUID(),p=await checkout.initiate(customer,s.id,{idempotencyKey:k,email:'payer@example.com'});
 assert.equal(p.status,'pending');assert.equal(p.method,method);
 assert.equal((await checkout.initiate(customer,s.id,{idempotencyKey:k,email:'payer@example.com'})).intentId,p.intentId);
 await reject(()=>checkout.initiate(customer,s.id,{idempotencyKey:randomUUID(),email:'payer@example.com'}),409);
 await reject(()=>checkout.status(outsider,s.id),404);
 const [raw,signature]=signedBody(p.reference);
 await reject(()=>checkout.webhook(raw,{}),403);
 assert.equal((await app.get(customer,s.id)).paid,false);
 const completed=await Promise.all([checkout.webhook(raw,signature),checkout.webhook(raw,signature)]);
 assert.equal(completed.filter(x=>x.duplicate===false).length,1);
 assert.equal(completed.filter(x=>x.duplicate===true).length,1);
 assert.equal((await app.get(customer,s.id)).paid,true);
 assert.equal((await app.get(customer,s.id)).state,'AWAITING_ASSIGNMENT');
 const journals=await db.query("SELECT * FROM checkout_accounting_journals WHERE shipment_id=$1 AND kind='psp_verified'",[s.id]);
 assert.equal(journals.rowCount,1);
 const sums=await db.query("SELECT l.side,sum(l.amount_minor)::bigint AS amount FROM checkout_accounting_lines l WHERE journal_id=$1 GROUP BY l.side",[journals.rows[0].id]);
 assert.equal(sums.rows.find(x=>x.side==='debit').amount,sums.rows.find(x=>x.side==='credit').amount);
});
test('authoritatively verified short payment becomes refund-review, not dispatch or earnings',async()=>{
 const s=await createJob('CARD');const p=await checkout.initiate(customer,s.id,{idempotencyKey:randomUUID(),email:'payer@example.org'});
 const txn=transactions.get(p.reference);txn.amount=Number(s.amount_minor)-1;
 const [raw,h]=signedBody(p.reference);
 const result=await checkout.webhook(raw,h);
 assert.equal(result.status,'refund_review');assert.equal((await app.get(customer,s.id)).paid,false);
 assert.equal((await db.query('SELECT 1 FROM checkout_unapplied_payments WHERE shipment_id=$1',[s.id])).rowCount,1);
 assert.equal((await checkout.webhook(raw,h)).duplicate,true);
});
test('verified late payment after cancellation is recorded for refund review without dispatch',async()=>{
 const s=await createJob('MOMO'),p=await checkout.initiate(customer,s.id,{idempotencyKey:randomUUID(),email:'payer@example.org'});
 await db.query("UPDATE shipments SET state='CANCELLED' WHERE id=$1",[s.id]);
 const [raw,h]=signedBody(p.reference);const x=await checkout.webhook(raw,h);
 assert.equal(x.status,'refund_review');assert.equal((await app.get(customer,s.id)).paid,false);
});
test('admin can disable CARD while CASH remains operational',async()=>{
 await checkout.configure(admin,{method:'CARD',enabled:false});
 await reject(()=>createJob('CARD'),503);
 assert.equal((await createJob('CASH')).payment_method,'CASH');
});
