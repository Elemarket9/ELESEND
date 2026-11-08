// SIMULATION ONLY: runs the real API on loopback against a throwaway test database, with stand-ins for SMS,
// payments and routing (simulationBoundaries). Used by local:load, local:simulate and the device session script.
import {randomInt,randomBytes} from 'node:crypto';
import {platform} from '../services/api/platform.mjs';
import {httpServer} from '../services/api/http.mjs';
import {dispatchEngine} from '../services/api/dispatch.mjs';
import {checkoutService,financeService,moneyOperations,paymentWebhook} from '../services/api/modules/payments/index.mjs';
import {simulationBoundaries,simulationPhone,withSimulationDatabase} from './local-simulation-support.mjs';

export async function bootSimulation(db,{port=0}={}){
 process.env.REDIS_URL ||= 'disabled';
 const otpKey=process.env.OTP_KEY&&/^[0-9a-f]{64}$/i.test(process.env.OTP_KEY)?process.env.OTP_KEY:randomBytes(32).toString('hex');
 const boundary=simulationBoundaries();
 const dispatch=dispatchEngine(db,{routing:boundary.routing});
 const app=platform(db,{otpKey,routing:boundary.routing,dispatch,sms:boundary.transport});
 const checkout=checkoutService(db,{provider:boundary.provider,sms:boundary.transport,dispatch,routing:boundary.routing});
 const finance=financeService(db,{provider:boundary.provider});
 const money=moneyOperations(db,{provider:boundary.provider});
 const server=httpServer(db,app,dispatch,finance,checkout,{
  paymentsWebhook:paymentWebhook({db,provider:boundary.provider,checkout,finance,money,moneyOperations:money}),
  moneyOperations:money
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const origin='http://127.0.0.1:'+server.address().port;
 async function raw(path,{token=null,method='GET',headers={},body}={}){
  const res=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},
   body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
  const text=await res.text();let parsed;try{parsed=text?JSON.parse(text):{};}catch{parsed={text};}
  return {status:res.status,body:parsed};
 }
 async function api(path,options){
  const res=await raw(path,options);
  if(res.status>=400)throw Object.assign(Error(res.body?.error||('HTTP '+res.status)),{status:res.status});
  return res.body;
 }
 /** A brand-new account made through the real sign-up, with its phone marked confirmed. */
 async function participant(kind,extra={}){
  const phone=simulationPhone(),password='simulation lantern river '+randomInt(1e6);
  await api('/api/v1/auth/register',{method:'POST',body:{phone,password,kind,...(kind==='rider'?{vehicle:'motorcycle',maxWeightG:20000,name:'Simulated Rider'}:{}),...extra}});
  const login=await api('/api/v1/auth/login',{method:'POST',body:{phone,password}});
  await db.query('UPDATE users SET phone_verified_at=now() WHERE id=$1',[login.user.id]);
  return {id:login.user.id,token:login.token,phone,password,kind};
 }
 return {origin,raw,api,participant,boundary,app,dispatch,checkout,
  close:()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(()=>resolve());})};
}

/** One delivery from booking to a rider offer, through the real API. */
export async function runLocalSimulation(){
 return withSimulationDatabase(async db=>{
  const sim=await bootSimulation(db);
  try{
   const customer=await sim.participant('customer'),rider=await sim.participant('rider');
   await db.query("UPDATE riders SET status='approved' WHERE id=$1",[rider.id]);
   await db.query("UPDATE checkout_method_policies SET enabled=true WHERE method='MOMO'");
   await sim.api('/api/v1/rider/availability',{token:rider.token,method:'POST',body:{online:true}});
   await sim.api('/api/v1/rider/location',{token:rider.token,method:'POST',body:{latitude:5.6,longitude:-0.18,accuracyMeters:5,observedAt:new Date().toISOString()}});
   const quote=await sim.api('/api/v1/quotes',{token:customer.token,method:'POST',body:{pickup:{address:'Simulated pickup, Accra',latitude:5.6,longitude:-0.18},destination:{address:'Simulated drop-off, Accra',latitude:5.61,longitude:-0.19},vehicle:'motorcycle',recipientPhone:simulationPhone(),weightG:1000,description:'SIMULATION ONLY parcel',paymentMethod:'MOMO'}});
   const shipment=await sim.api('/api/v1/shipments',{token:customer.token,method:'POST',headers:{'Idempotency-Key':'sim-'+randomInt(1e9)},body:{quoteId:quote.id}});
   const intent=await sim.api(`/api/v1/shipments/${shipment.id}/checkout`,{token:customer.token,method:'POST',body:{idempotencyKey:'sim-'+randomInt(1e9)}});
   sim.boundary.paid(intent.reference);const signed=sim.boundary.callback(intent.reference);
   await sim.api('/api/v1/payments/webhook',{method:'POST',headers:{'x-simulation-signature':signed.signature},body:signed.body});
   await sim.dispatch.tick();
   const offers=await sim.api('/api/v1/rider/offers',{token:rider.token});
   return {SIMULATED_ONLY:true,shipmentId:shipment.id,amountMinor:quote.amount_minor??quote.amountMinor,paid:(await db.query('SELECT paid FROM shipments WHERE id=$1',[shipment.id])).rows[0].paid,riderOffers:offers.length};
  }finally{await sim.close();}
 });
}
