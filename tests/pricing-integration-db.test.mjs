import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {database} from '../services/api/db.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {platform} from '../services/api/platform.mjs';
import {measuredSurge} from '../services/api/pricing-surge.mjs';
import {httpServer} from '../services/api/http.mjs';
import {resetDispatchFixtures} from './helpers/reset-dispatch-fixtures.mjs';
import {once} from 'node:events';
const url=process.env.TEST_DATABASE_URL;
if(!url||!/^elesend_test(?:_|$)/.test(new URL(url).pathname.slice(1)))throw Error('Disposable test database required');
const db=database(url),calls=[];
const routing={async route(a,b,{vehicle}){calls.push(vehicle);return {source:'fixture',distanceMeters:2500,durationSeconds:600};}};
const app=platform(db,{otpKey:randomBytes(32).toString('hex'),routing});
let admin,sender,other;
const request={pickup:{address:'Osu market main entrance',latitude:5.6,longitude:-.2},destination:{address:'Airport main gate entrance',latitude:5.62,longitude:-.18},vehicle:'motorcycle',recipientPhone:'0241234567',weightG:500,description:'Sealed documents',paymentMethod:'CASH'};
before(async()=>{await migrate(db);await db.query('TRUNCATE users,pricing_policies,pricing_surge_zones RESTART IDENTITY CASCADE');await resetDispatchFixtures(db);admin=await app.register({phone:'0248000001',password:'Long-Fixture-Only-Password!',kind:'customer'});await db.query("UPDATE users SET kind='admin' WHERE id=$1",[admin.id]);admin.kind='admin';await db.query("INSERT INTO permissions VALUES($1,'pricing:write')",[admin.id]);
 sender=await app.register({phone:'0248000002',password:'Long-Fixture-Only-Password!',kind:'business'});other=await app.register({phone:'0248000003',password:'Long-Fixture-Only-Password!',kind:'business'});
 await app.setPricing(admin,{baseMinor:500,perKmMinor:100});
 await app.configureVehicleTariff(admin,{vehicle:'motorcycle',baseMinor:1000,perKmMinor:200,perMinuteMinor:60});
 await app.configureVehicleTariff(admin,{vehicle:'car',baseMinor:2000,perKmMinor:300});
});
after(()=>db.close());
test('vehicle routes, persisted prices, commission and quote ownership use one authoritative flow',async()=>{
 const quote=await app.quote(sender,request);assert.equal(calls.at(-1),'motorcycle');assert.equal(quote.amount_minor,2100);assert.equal(quote.commission_minor,273);assert.equal(quote.riderEarningsMinor,1827);
 const saved=(await db.query('SELECT * FROM quotes WHERE id=$1',[quote.id])).rows[0];assert.equal(saved.request.vehicle,'motorcycle');assert.equal(saved.pricing_evidence.distanceMeters,2500);assert.equal(saved.pricing_evidence.policyId,saved.policy_id);
 await app.configureVehicleTariff(admin,{vehicle:'motorcycle',baseMinor:3000,perKmMinor:400});
 const key=randomUUID(),booked=await app.book(sender,{quoteId:quote.id},key);assert.equal(booked.amount_minor,2100);assert.equal(booked.commission_minor,273);
 assert.equal((await app.book(sender,{quoteId:quote.id},key)).id,booked.id);
 await assert.rejects(()=>app.book(other,{quoteId:quote.id},randomUUID()),e=>e.status===409);
 const car=await app.quote(sender,{...request,vehicle:'car'});assert.equal(car.amount_minor,2750);assert.equal(calls.at(-1),'car');
});
test('pricing versions cannot be edited and vehicle tariffs do not retire the legacy policy',async()=>{
 assert.equal((await db.query('SELECT count(*)::int n FROM pricing_policies WHERE active AND vehicle IS NULL')).rows[0].n,1);
 await assert.rejects(()=>db.query('UPDATE pricing_policies SET base_minor=1 WHERE active'));
 await assert.rejects(()=>app.configureVehicleTariff(sender,{vehicle:'van',baseMinor:1000,perKmMinor:100}),e=>e.status===403);
 await assert.rejects(()=>app.quote(sender,{...request,vehicle:'van'}),e=>e.status===503);
 await assert.rejects(()=>app.quote(sender,{...request,pickup:{...request.pickup,latitude:0,longitude:0}}),e=>e.status===422);
});
test('database rejects assigning a quoted motorcycle job to a car rider',async()=>{
 const rider=await app.register({phone:'0248000004',password:'Long-Fixture-Only-Password!',kind:'rider',vehicle:'van'});
 const quote=await app.quote(sender,request),shipment=await app.book(sender,{quoteId:quote.id},randomUUID());
 await assert.rejects(()=>db.query('UPDATE shipments SET rider_id=$2 WHERE id=$1',[shipment.id,rider.id]),/does not match/);
});
test('PostGIS demand observations serialize smoothing and ignore repeated unbooked quotes',async()=>{
 const zone=await app.configureSurgeZone(admin,{name:'Synthetic Accra test zone',latitude:5.6,longitude:-.2,radiusM:1000,enabled:true});
 // Two prior senders already have booked jobs; add a third independent sender.
 const third=await app.register({phone:'0248000005',password:'Long-Fixture-Only-Password!',kind:'business'});
 for(const actor of [other,third]){const q=await app.quote(actor,request);await app.book(actor,{quoteId:q.id},randomUUID());}
 const result=await measuredSurge(db,request.pickup,'motorcycle');assert.equal(result.demand,3);assert.equal(result.supply,0);assert.equal(result.multiplierBps,10500);
 const parallel=await Promise.all(Array.from({length:20},()=>measuredSurge(db,request.pickup,'motorcycle')));assert.ok(parallel.every(x=>x.multiplierBps===10500));
 await app.configureVehicleTariff(admin,{vehicle:'motorcycle',baseMinor:1000,perKmMinor:200,supplyDemandEnabled:true});
 const q=await app.quote(sender,request);assert.equal(q.surgeMultiplier,1.05);assert.equal(q.amount_minor,1575);
 await db.query("UPDATE pricing_surge_state SET updated_at=now()-interval '31 seconds' WHERE zone_id=$1",[zone.id]);
 const next=await measuredSurge(db,request.pickup,'motorcycle');assert.equal(next.multiplierBps,11000);assert.equal(next.demand,3);
});
test('main HTTP fare route stores a bookable owned quote and rejects unsafe requests',async()=>{
 const session=await app.login({phone:'0248000002',password:'Long-Fixture-Only-Password!'});
 const server=httpServer(db,app,null,null);server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 const send=(path,body,token=session.token)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body});
 try{
  const response=await send('/api/v1/calculate-fare',JSON.stringify(request));assert.equal(response.status,200);const quote=await response.json();
  assert.ok(quote.id);assert.ok((await db.query('SELECT 1 FROM quotes WHERE id=$1 AND customer_id=$2',[quote.id,sender.id])).rowCount);
  assert.equal((await send('/api/v1/calculate-fare',JSON.stringify({...request,surgeBps:10000}))).status,400);
  assert.equal((await send('/api/v1/calculate-fare','x'.repeat(33000))).status,413);
  assert.equal((await send('/api/v1/calculate-fare',new Uint8Array([255]))).status,400);
  assert.equal((await send('/api/v1/admin/pricing/vehicles',JSON.stringify({vehicle:'car',baseMinor:1,perKmMinor:0}))).status,403);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
