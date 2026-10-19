// REAL PostgreSQL/PostGIS integration suite. Never run against customer data.
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {database} from '../services/api/db.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {platform} from '../services/api/platform.mjs';
import {dispatchEngine} from '../services/api/dispatch.mjs';
import {financeService,cashEligible} from '../services/api/finance.mjs';
import {fixtureRouting} from '../services/api/dispatch-routing.mjs';
import {resetDispatchFixtures} from './helpers/reset-dispatch-fixtures.mjs';
const url=process.env.TEST_DATABASE_URL;
if(!url||!/^elesend_test(?:_|$)/.test(new URL(url).pathname.slice(1)))throw Error('Dedicated elesend_test PostgreSQL required');
const db=database(url),messages=[];
const a={latitude:5.6037,longitude:-.187,address:'Kwame Nkrumah Circle, Accra'},b={latitude:5.650,longitude:-.161,address:'East Legon, Accra'};
const routing=fixtureRouting(async(x,y)=>({distanceMeters:0,durationSeconds:65,geometry:{type:'LineString',coordinates:[[x.longitude,x.latitude],[y.longitude,y.latitude]]}}));
const dispatch=dispatchEngine(db,{routing});
const app=platform(db,{otpKey:randomBytes(32).toString('hex'),sms:{async send(e){messages.push(e);}},dispatch,routing});
// This is a synthetic authenticated payment adapter for TESTS ONLY. It is not real MTN / PSP verification.
const fixtureKey=randomBytes(32);
function signFixture(raw){return {'x-fixture-hmac':createHmac('sha256',fixtureKey).update(raw).digest('hex')};}
const fake={name:'fake-test-psp',async createPayment(x){return {reference:'fixture-'+x.intentId,requestedAmount:x.amountMinor};},async verifyEvent({rawBody,headers}){
 const expected=createHmac('sha256',fixtureKey).update(rawBody).digest();
 const given=typeof headers['x-fixture-hmac']==='string'&&/^[0-9a-f]{64}$/.test(headers['x-fixture-hmac'])?Buffer.from(headers['x-fixture-hmac'],'hex'):Buffer.alloc(0);
 if(given.length!==expected.length||!timingSafeEqual(given,expected))throw Object.assign(Error('Bad signature'),{status:403});
 return {...JSON.parse(rawBody.toString()),verified:true,providerName:'fake-test-psp'};
}};

const finance=financeService(db,{provider:fake});
let rider,other,customer,admin,admin2;
const pw='Long-test-only-passphrase!';
const request={pickup:a,destination:b,recipientPhone:'0241234567',weightG:700,description:'Documents',paymentMethod:'CASH',cashPayer:'recipient'};
const rejects=(fn,status)=>assert.rejects(fn,e=>e.status===status);
async function account(p,kind='customer'){return app.register({phone:p,password:pw,kind});}
async function makeJob(){const q=await app.quote(customer,request);assert.equal(q.amount_minor,3000);assert.equal(q.commission_minor,300);
 const job=await app.book(customer,{quoteId:q.id},randomUUID());assert.equal(job.paid,false);assert.equal(job.payment_method,'CASH');assert.equal(job.state,'AWAITING_ASSIGNMENT');return job;}
async function assign(job){await dispatch.riderPosition(rider,{latitude:a.latitude,longitude:a.longitude,accuracyMeters:8,observedAt:new Date().toISOString()});const offer=await dispatch.dispatchShipment(job.id);assert.equal(offer.status,'offered');assert.equal(offer.riderId,rider.id);await app.accept(rider,job.id,offer.offerId);}
async function passOtp(job,purpose){const code=await app.challenge(rider,job.id,purpose);assert.equal(code.code,undefined);return app.verify(rider,job.id,{challengeId:code.challengeId,code:messages.at(-1).code});}
async function deliver(job,cash=3000){await assign(job);await passOtp(job,'pickup');await app.transition(rider,job.id,{action:'start'});
 const report=await finance.reportCash(rider,job.id,{reportedMinor:cash,cashPayer:'recipient',idempotencyKey:randomUUID()});
 assert.equal(report.cashVerifiedByPlatform,false);await passOtp(job,'delivery');return report;}
before(async()=>{await migrate(db);await db.query('TRUNCATE users,pricing_policies RESTART IDENTITY CASCADE');await resetDispatchFixtures(db);
 admin=await account('0200000880');admin2=await account('0200000881');for(const person of [admin,admin2]){await db.query("UPDATE users SET kind='admin' WHERE id=$1",[person.id]);person.kind='admin';for(const perm of ['verification:write','pricing:write','dispatch:configure','finance:configure','finance:read','finance:adjust','finance:approve'])await db.query('INSERT INTO permissions(user_id,permission) VALUES($1,$2)',[person.id,perm]);}
 customer=await account('0200000882');rider=await account('0200000883','rider');other=await account('0200000884','rider');
 await app.approve(admin,'riders',rider.id,'approved');await app.availability(rider,{online:true});await app.setPricing(admin,{baseMinor:3000,perKmMinor:1,commissionBps:1000});
});
after(async()=>{await db.close();});
test('cash is dispatchable without PSP paid flag, but unauthorized rider cannot report collection',async()=>{
 const job=await makeJob();await assign(job);await rejects(()=>finance.reportCash(other,job.id,{reportedMinor:3000,cashPayer:'recipient',idempotencyKey:randomUUID()}),403);
 await passOtp(job,'pickup');await app.transition(rider,job.id,{action:'start'});
 const pending=await app.challenge(rider,job.id,'delivery');const originalCode=messages.at(-1).code;
 await rejects(()=>app.verify(rider,job.id,{challengeId:pending.challengeId,code:originalCode}),409);
 const key=randomUUID();await finance.reportCash(rider,job.id,{reportedMinor:3000,cashPayer:'recipient',idempotencyKey:key});
 const duplicate=await finance.reportCash(rider,job.id,{reportedMinor:3000,cashPayer:'recipient',idempotencyKey:key});assert.equal(duplicate.duplicate,true);
 await rejects(()=>finance.reportCash(rider,job.id,{reportedMinor:2000,cashPayer:'recipient',idempotencyKey:randomUUID()}),409);
 await app.verify(rider,job.id,{challengeId:pending.challengeId,code:originalCode});assert.equal((await app.get(customer,job.id)).paid,false);assert.equal((await db.query('SELECT payout_status FROM financial_entries WHERE shipment_id=$1',[job.id])).rows[0].payout_status,'cash_rider_reported');
 const entries=await db.query("SELECT kind FROM finance_journals WHERE shipment_id=$1",[job.id]);assert.deepEqual(entries.rows.map(x=>x.kind),['cash_commission']);
 assert.deepEqual(await (async()=>{const f=await finance.snapshot(rider);return [f.dueMinor,f.creditMinor,f.cashReportedMinor];})(),[300,0,3000]);
 await assert.rejects(()=>db.query('DELETE FROM cash_collections WHERE shipment_id=$1',[job.id]));
 await assert.rejects(()=>db.query("UPDATE finance_lines SET amount_minor=1"));
});
test('commission partial repayment and duplicate PSP webhook do not double collect',async()=>{
 const intent=await finance.initiate(rider,{kind:'commission_repayment',amountMinor:100,idempotencyKey:randomUUID()});assert.equal(intent.status,'pending');
 assert.equal((await finance.snapshot(rider)).dueMinor,300);
 const e={eventId:'test-event-1',intentId:intent.intentId,amountMinor:100,currency:'GHS'};
 await rejects(()=>finance.handleWebhook(Buffer.from(JSON.stringify(e)),{}),403);
 const first=await finance.handleWebhook(Buffer.from(JSON.stringify(e)),signFixture(Buffer.from(JSON.stringify(e))));assert.equal(first.status,'confirmed');
 const second=await finance.handleWebhook(Buffer.from(JSON.stringify(e)),signFixture(Buffer.from(JSON.stringify(e))));assert.equal(second.duplicate,true);
 assert.equal((await finance.snapshot(rider)).dueMinor,200);
});
test('prepaid credits purchase is disabled by default, then can be used without negative credits in explicit sandbox mode',async()=>{
 await rejects(()=>finance.initiate(rider,{kind:'credit_purchase',amountMinor:500,idempotencyKey:randomUUID()}),403);
 process.env.ENABLE_PREPAID_CREDITS='true';try{
  const intent=await finance.initiate(rider,{kind:'credit_purchase',amountMinor:500,idempotencyKey:randomUUID()});
  assert.equal((await finance.snapshot(rider)).creditMinor,0);await finance.handleWebhook(Buffer.from(JSON.stringify({eventId:'test-event-2',intentId:intent.intentId,amountMinor:500,currency:'GHS'})),signFixture(Buffer.from(JSON.stringify({eventId:'test-event-2',intentId:intent.intentId,amountMinor:500,currency:'GHS'}))));
  assert.equal((await finance.snapshot(rider)).creditMinor,500);
  const job=await makeJob();await deliver(job,3000);const state=await finance.snapshot(rider);
  assert.equal(state.creditMinor,200);assert.equal(state.dueMinor,200); // Previous debt outstanding. The new commission used credits.
 }finally{delete process.env.ENABLE_PREPAID_CREDITS;}
});
test('late second PSP settlement posts excess as unapplied liability, never extra commission',async()=>{
 // Use a fresh rider and authorized first cash commission so that balances are isolated.
 const x=await account('0200000877','rider');await app.approve(admin,'riders',x.id,'approved');
 // Use legitimate journal/obligation evidence to construct a 300-pesewa debt.
 await db.tx(async c=>{const {journal}=await import('../services/api/finance.mjs');
   await journal(c,{eventKey:'test-fixture-independent-obligation-'+x.id,riderId:x.id,kind:'cash_commission',value:300});
   await c.query("INSERT INTO commission_obligations(id,shipment_id,rider_id,original_minor,due_at) VALUES($1,NULL,$2,300,now()+interval '7 days')",[randomUUID(),x.id]);
 });
 const one=await finance.initiate(x,{kind:'commission_repayment',amountMinor:300,idempotencyKey:randomUUID()});
 const two=await finance.initiate(x,{kind:'commission_repayment',amountMinor:300,idempotencyKey:randomUUID()});
 for(const [i,intent] of [one,two].entries()){
  const body=Buffer.from(JSON.stringify({eventId:'late-test-'+x.id+'-'+i,intentId:intent.intentId,amountMinor:300,currency:'GHS'}));
  const result=await finance.handleWebhook(body,signFixture(body));
  if(i===0){assert.equal(result.collectedMinor,300);assert.equal(result.unappliedProviderMinor,0);}
  else{assert.equal(result.collectedMinor,0);assert.equal(result.unappliedProviderMinor,300);assert.equal(result.requiresReconciliation,true);}
 }
 const summary=await finance.snapshot(x);assert.equal(summary.dueMinor,0);assert.equal(summary.unappliedProviderMinor,300);
});
test('zero or partial cash report cannot authorize OTP completion or commission accrual',async()=>{
 const job=await makeJob();await assign(job);await passOtp(job,'pickup');await app.transition(rider,job.id,{action:'start'});
 await finance.reportCash(rider,job.id,{reportedMinor:0,cashPayer:'recipient',idempotencyKey:randomUUID()});
 const challenge=await app.challenge(rider,job.id,'delivery');
 await rejects(()=>app.verify(rider,job.id,{challengeId:challenge.challengeId,code:messages.at(-1).code}),409);
 assert.equal((await db.query('SELECT 1 FROM finance_journals WHERE shipment_id=$1',[job.id])).rowCount,0);
 assert.equal((await db.query('SELECT 1 FROM financial_entries WHERE shipment_id=$1',[job.id])).rowCount,0);
 assert.equal((await app.get(customer,job.id)).state,'AWAITING_DELIVERY_OTP');
 await app.transition(rider,job.id,{action:'fail',reason:'Recipient did not pay delivery charge'});
 await app.transition(rider,job.id,{action:'return',reason:'Return to sender for cash nonpayment'});
 await app.transition(rider,job.id,{action:'returned',reason:'Returned parcel safely to sender'});
});
test('postpaid limit includes new exposure and requires actual settlement',async()=>{
 await finance.policy(admin,rider.id,{postpaidEnabled:true,maxOutstandingMinor:200,maxUnpaidJobs:50,dueDays:7,blocked:false});
 await rejects(()=>db.tx(c=>cashEligible(c,rider.id,300)),409);
 await finance.policy(admin,rider.id,{postpaidEnabled:true,maxOutstandingMinor:4000,maxUnpaidJobs:50,dueDays:7,blocked:false});
});
test('financial correction requires two independently authorized admins, immutable contra posting',async()=>{
 const correction=await finance.adjustmentRequest(admin,{riderId:rider.id,direction:'waive',amountMinor:200,reason:'Verified cash collection dispute adjustment'});
 await rejects(()=>finance.approveAdjustment(admin,correction.id),403);
 await finance.approveAdjustment(admin2,correction.id);assert.equal((await finance.snapshot(rider)).dueMinor,0);
 await rejects(()=>finance.approveAdjustment(admin2,correction.id),409);
 assert.equal((await db.query("SELECT count(*)::integer AS n FROM finance_journals WHERE kind='waive' AND rider_id=$1",[rider.id])).rows[0].n,1);
});
