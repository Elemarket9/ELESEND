/** REPRODUCIBLE PostgreSQL integration test, NOT executed in the package build environment.
 * Requires a dedicated disposable elesend_test* database with PostGIS.
 * Fixture line geometry is SYNTHETIC, not a measured Ghana road path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {database} from '../services/api/db.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {platform} from '../services/api/platform.mjs';
import {dispatchEngine} from '../services/api/dispatch.mjs';
import {financeService} from '../services/api/finance.mjs';
import {fixtureRouting} from '../services/api/dispatch-routing.mjs';
const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!/^elesend_test(?:_|$)/.test(new URL(databaseUrl).pathname.slice(1)))throw Error('Dedicated elesend_test database required');
const db=database(databaseUrl),messages=[];
const pickup={address:'Mallam Junction, Greater Accra',latitude:5.565,longitude:-0.303};
const destination={address:'Lapaz, Greater Accra',latitude:5.62,longitude:-0.251};
const routing=fixtureRouting(async(from,to)=>({durationSeconds:180,distanceMeters:2000,
 geometry:{type:'LineString',coordinates:[[from.longitude,from.latitude],[to.longitude,to.latitude]]}}));
const dispatcher=dispatchEngine(db,{routing});
const app=platform(db,{dispatch:dispatcher,routing,otpKey:randomBytes(32).toString('hex'),sms:{async send(data){messages.push(data);}}});
const finance=financeService(db);
const newAccount=async(number,kind='customer')=>app.register({phone:number,password:'ELESEND-test-safe-strong-password-123!',kind});
test('broadcast to all matching riders: first valid accept wins; 3% posted exactly once on secure handover',async()=>{
 try{
  await migrate(db);await db.query('TRUNCATE users,pricing_policies RESTART IDENTITY CASCADE');
  const administrator=await newAccount('0240000911'),customer=await newAccount('0240000912'),A=await newAccount('0240000913','rider'),B=await newAccount('0240000914','rider');
  await db.query("UPDATE users SET kind='admin' WHERE id=$1",[administrator.id]);administrator.kind='admin';
  await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'pricing:write'),($1,'verification:write'),($1,'dispatch:configure')",[administrator.id]);
  await app.setPricing(administrator,{baseMinor:3000,perKmMinor:1,commissionBps:300});
  await dispatcher.setAlgorithmFeature(administrator,{featureKey:'multi_rider_broadcast',enabled:true});
  for(const rider of [A,B]){
   await app.approve(administrator,'riders',rider.id,'approved');await app.availability(rider,{online:true});
   await dispatcher.riderPosition(rider,{latitude:pickup.latitude+(rider===A?.001:.002),longitude:pickup.longitude,accuracyMeters:8,observedAt:new Date().toISOString()});
  }
  const quote=await app.quote(customer,{pickup,destination,recipientPhone:'0240000915',weightG:700,
    description:'Test parcel',paymentMethod:'CASH',cashPayer:'recipient'});
  const job=await app.book(customer,{quoteId:quote.id},randomUUID());
  const broadcast=await dispatcher.dispatchShipment(job.id);assert.equal(broadcast.status,'offered');assert.equal(broadcast.offerCount,2);
  const oa=(await app.offers(A)).find(o=>o.id===job.id),ob=(await app.offers(B)).find(o=>o.id===job.id);
  assert.ok(oa&&ob);assert.notEqual(oa.offerId,ob.offerId);
  const attempts=await Promise.allSettled([app.accept(A,job.id,oa.offerId),app.accept(B,job.id,ob.offerId)]);
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  const winner=attempts[0].status==='fulfilled'?A:B;
  assert.equal((await db.query("SELECT count(*)::int AS n FROM dispatch_offers WHERE shipment_id=$1 AND status='accepted'",[job.id])).rows[0].n,1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM dispatch_offers WHERE shipment_id=$1 AND status='invalidated'",[job.id])).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM financial_entries WHERE shipment_id=$1',[job.id])).rows[0].n,0);
  const pickupChallenge=await app.challenge(winner,job.id,'pickup');await app.verify(winner,job.id,{challengeId:pickupChallenge.challengeId,code:messages.at(-1).code});
  await app.transition(winner,job.id,{action:'start'});
  await finance.reportCash(winner,job.id,{reportedMinor:job.amount_minor,cashPayer:'recipient',idempotencyKey:randomUUID()});
  const delivered=await app.challenge(winner,job.id,'delivery');await app.verify(winner,job.id,{challengeId:delivered.challengeId,code:messages.at(-1).code});
  const entries=(await db.query('SELECT commission_minor,customer_charge_minor FROM financial_entries WHERE shipment_id=$1',[job.id])).rows;
  assert.equal(entries.length,1);assert.equal(Number(entries[0].commission_minor),Number(quote.commission_minor));
  assert.equal(Number(quote.commission_minor),Math.round(Number(job.amount_minor)*.03));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM finance_journals WHERE shipment_id=$1 AND kind='cash_commission'",[job.id])).rows[0].n,1);
 }finally{await db.close();}
});
