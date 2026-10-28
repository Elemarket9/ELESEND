import {withSimulationDatabase} from './local-simulation-support.mjs';
import {bootSimulation} from './prelaunch-simulation.mjs';
process.env.NODE_ENV ||= 'test';
process.env.REDIS_URL='disabled';
await withSimulationDatabase(async db=>{
 const sim=await bootSimulation(db,{port:3090});
 try{
  const customer=await sim.participant('customer'),rider=await sim.participant('rider');
  await db.query("UPDATE riders SET status='approved' WHERE id=$1",[rider.id]);
  console.log(JSON.stringify({SIMULATED_ONLY:true,origin:sim.origin,customer:{phone:customer.phone,password:customer.password},rider:{phone:rider.phone,password:rider.password},expiresInSeconds:600}));
  await new Promise(resolve=>{const timer=setTimeout(resolve,600000);process.once('SIGINT',()=>{clearTimeout(timer);resolve();});process.once('SIGTERM',()=>{clearTimeout(timer);resolve();});});
 }finally{await sim.close();}
});
