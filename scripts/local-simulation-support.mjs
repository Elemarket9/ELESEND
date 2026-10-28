import assert from 'node:assert/strict';
import {randomUUID,randomInt,createHmac,timingSafeEqual} from 'node:crypto';
import {database} from '../services/api/db.mjs';
import {migrate} from './migrate.mjs';
import {fixtureRouting} from '../services/api/dispatch-routing.mjs';

export function simulationTarget(env=process.env){
 assert(['test','development'].includes(env.NODE_ENV),'Set NODE_ENV=test or development; simulations are forbidden elsewhere');
 assert(env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; DATABASE_URL is never a simulation fallback');
 const u=new URL(env.TEST_DATABASE_URL);
 assert(['127.0.0.1','localhost','[::1]'].includes(u.hostname),'Simulation database must be loopback');
 assert(/^\/elesend_test(?:_[a-z0-9_]+)?$/.test(u.pathname),'Dedicated test database required');
 return u;
}

export async function withSimulationDatabase(task,{poolMax=12}={}){
 const target=simulationTarget(),admin=database(target.toString());
 const name='elesend_test_sim_'+randomUUID().replaceAll('-','');
 let db,created=false;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);created=true;
  target.pathname='/'+name;db=database(target.toString(),{max:poolMax});
  await migrate(db);
  return await task(db);
 }finally{
  await db?.close();
  if(created){
   assert(/^elesend_test_sim_[a-f0-9]{32}$/.test(name));
   await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  }
  await admin.close();
 }
}
export const simulationPhone=()=>'+2332'+randomInt(10000000,99999999);
export function simulationBoundaries(){
 const sms=new Map(),payments=new Map(),secret=randomUUID()+randomUUID();
 let routingDown=false,providerDown=false;
 const routing=fixtureRouting(async()=>{
  if(routingDown)throw Object.assign(Error('SIMULATED routing outage'),{status:503});
  return {distanceMeters:1500,durationSeconds:180};
 });
 const provider={name:'local_simulation',methods:['MOMO','CARD'],allowedCheckoutHosts:['checkout.simulation.invalid'],
  async createCheckout(x){
   if(providerDown)throw Object.assign(Error('SIMULATED provider outage'),{status:503});
   payments.set(x.reference,{...x,status:'pending'});
   return {reference:x.reference,checkoutUrl:'https://checkout.simulation.invalid/'+x.reference};
  },
  async verifyPayment(ref){
   if(providerDown)throw Object.assign(Error('SIMULATED provider outage'),{status:503});
   const p=payments.get(ref);assert(p,'Unknown simulated payment');
   return {...p,verified:true,channel:'mobile_money',eventId:'sim_'+ref};
  },
  async parseVerifiedWebhook(raw,headers){
   const expected=createHmac('sha256',secret).update(raw).digest('hex'),actual=headers['x-simulation-signature'];
   assert(typeof actual==='string'&&actual.length===expected.length&&timingSafeEqual(Buffer.from(actual),Buffer.from(expected)),'Invalid simulated provider signature');
   return this.verifyPayment(JSON.parse(raw).reference);
  }
 };
 return {routing,provider,sms,transport:{async send(x){sms.set(x.challengeId,x);return {accepted:true};}},
  setRoutingOutage:value=>{routingDown=value;},setProviderOutage:value=>{providerDown=value;},
  paid(reference){assert(payments.has(reference));payments.get(reference).status='success';},
  callback(reference){const body=JSON.stringify({reference});return {body,signature:createHmac('sha256',secret).update(body).digest('hex')};}
 };
}
