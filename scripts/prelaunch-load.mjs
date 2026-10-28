import os from 'node:os';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {hash} from '../services/api/security.mjs';
import {withSimulationDatabase,simulationPhone} from './local-simulation-support.mjs';
import {bootSimulation} from './prelaunch-simulation.mjs';

process.env.NODE_ENV ||= 'test';
// This server binds loopback only. Synthetic XFF subjects represent separate simulated devices.
process.env.TRUSTED_PROXY_CIDRS='127.0.0.1/32';
process.env.REDIS_URL='disabled';
const percentile=(values,p)=>values[Math.min(values.length-1,Math.floor(values.length*p))]??0;

export async function runLocalLoad(){return withSimulationDatabase(async db=>{
 const sim=await bootSimulation(db),results=[];
 try{
  const riders=[];
  for(let i=0;i<1000;i++)riders.push({id:randomUUID(),phone:simulationPhone(),token:randomUUID().replaceAll('-','')+randomUUID().replaceAll('-',''),ip:`10.88.${Math.floor(i/250)}.${i%250+1}`});
  await db.tx(async c=>{
   for(const r of riders){
    await c.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'SIMULATION ONLY','rider',now())",[r.id,r.phone]);
    await c.query("INSERT INTO riders(id,status,online,vehicle,max_weight_g) VALUES($1,'approved',true,'motorcycle',20000)",[r.id]);
    await c.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')",[hash(r.token),r.id]);
   }
  });
  const customer=await sim.participant('customer');
  await db.query('UPDATE pricing_policies SET active=false');
  await db.query("INSERT INTO pricing_policies(id,base_minor,per_km_minor,commission_bps,vehicle) VALUES($1,1000,100,1300,'motorcycle')",[randomUUID()]);
  await db.query("UPDATE checkout_method_policies SET enabled=true WHERE method='MOMO'");
  const quoteInput={pickup:{address:'Synthetic pickup in Accra',latitude:5.6,longitude:-0.18},destination:{address:'Synthetic destination in Accra',latitude:5.601,longitude:-0.181},vehicle:'motorcycle',weightG:1000,recipientPhone:customer.phone,paymentMethod:'MOMO'};
  quoteInput.description='SIMULATION ONLY parcel';
  for(const fleet of [50,100,250,500,1000]){
   if(os.freemem()<512*1024**2||process.memoryUsage().rss>1536*1024**2)throw Error('Resource safety threshold reached; stopped bounded local load');
   const latencies=[],errors={},cpu=process.cpuUsage(),start=performance.now();
   let active=0,peakActive=0,peakQueued=0,peakPool=0,peakWaiting=0,done=0,peakRss=0;
   const interval=setInterval(()=>{peakPool=Math.max(peakPool,db.pool.totalCount);peakWaiting=Math.max(peakWaiting,db.pool.waitingCount);peakRss=Math.max(peakRss,process.memoryUsage().rss);},100);
   async function measured(fn){const at=performance.now();try{await fn();}catch(e){const key=e.status||e.message;errors[key]=(errors[key]||0)+1;}finally{latencies.push(performance.now()-at);done++;}}
   async function execute(jobs){
    let next=0;peakQueued=Math.max(peakQueued,jobs.length);
    await Promise.all(Array.from({length:Math.min(16,jobs.length)},async()=>{while(next<jobs.length){const job=jobs[next++];active++;peakActive=Math.max(peakActive,active);try{await measured(job);}finally{active--;}}}));
   }
   for(let round=0;round<2;round++){
    if(round)await pause(Math.max(0,5000-(performance.now()-start)));
    const jobs=riders.slice(0,fleet).map(r=>async()=>{
     const response=await sim.raw('/api/v1/rider/location',{token:r.token,method:'POST',headers:{'x-forwarded-for':r.ip},body:{latitude:5.6,longitude:-0.18,accuracyMeters:5,speedMps:0,observedAt:new Date().toISOString()}});
     if(response.status!==200)throw Object.assign(Error(response.body.error||'GPS failed'),{status:response.status});
    });
    if(!round){
     for(let i=0;i<Math.ceil(fleet/25);i++)jobs.push(async()=>{
      const headers={'x-forwarded-for':`10.89.${Math.floor(i/250)}.${i%250+1}`};
      const q=await sim.api('/api/v1/quotes',{token:customer.token,method:'POST',headers,body:quoteInput});
      if(i%4===0){
       const s=await sim.api('/api/v1/shipments',{token:customer.token,method:'POST',headers:{...headers,'Idempotency-Key':randomUUID()},body:{quoteId:q.id}});
       const intent=await sim.api(`/api/v1/shipments/${s.id}/checkout`,{token:customer.token,method:'POST',headers,body:{idempotencyKey:randomUUID()}});
       sim.boundary.paid(intent.reference);const signed=sim.boundary.callback(intent.reference);
       await sim.api('/api/v1/payments/webhook',{method:'POST',headers:{...headers,'x-simulation-signature':signed.signature},body:signed.body});
      }
     });
    }
    await execute(jobs);
   }
   clearInterval(interval);
   const seconds=(performance.now()-start)/1000,cost=process.cpuUsage(cpu),sorted=latencies.sort((a,b)=>a-b);
   const queued=(await db.query("SELECT count(*)::int AS n FROM shipments WHERE state='AWAITING_ASSIGNMENT'")).rows[0].n;
   const health=await sim.raw('/health');assert.equal(health.status,200);
   results.push({simulatedRiders:fleet,gpsIntervalSeconds:5,rounds:2,operations:done,operationsPerSecond:+(done/seconds).toFixed(2),seconds:+seconds.toFixed(2),p50Ms:+percentile(sorted,.5).toFixed(2),p95Ms:+percentile(sorted,.95).toFixed(2),p99Ms:+percentile(sorted,.99).toFixed(2),errors,errorRate:Object.values(errors).reduce((a,b)=>a+b,0)/done,nodeCpuOneCorePercent:+((cost.user+cost.system)/1e4/seconds).toFixed(2),peakNodeRssMiB:+(peakRss/1024**2).toFixed(1),peakDatabaseConnections:peakPool,peakPoolWaiters:peakWaiting,peakConcurrentOperations:peakActive,peakScheduledQueue:peakQueued,queueDrained:active===0,paidOrdersAwaitingDispatch:queued,healthAfterLoad:health.status});
   console.log(JSON.stringify(results.at(-1)));
  }
  return {environment:'LOCAL COMPUTER; fixture road/provider boundaries; not VPS capacity',host:{cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalRamGiB:+(os.totalmem()/1024**3).toFixed(1)},results};
 }finally{await sim.close();}
});}
runLocalLoad().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});
