/** Algorithm 5 — bounded pickup-and-delivery route optimizer for queued parcels.
 * Enumerates *feasible* pickup/drop-off insertions; never approximates by straight lines.
 * Caller must supply authenticated road routing and strict capacity/deadlines.
 */
import {bestInsertion,evaluateStops,weightCapacityValid} from '../multi-parcel.mjs';
export async function optimizeParcelManifest(routing,start,existingStops,jobs,options={}){
 if(!Array.isArray(existingStops)||!Array.isArray(jobs)||jobs.length>8||
   jobs.some(j=>!j||!Array.isArray(j.stops)||j.stops.length!==2))throw Error('Invalid bounded multi-parcel optimization');
 let current=[...existingStops],accepted=[],rejected=[];
 const order=[...jobs].sort((a,b)=>(a.deadlineMs??Infinity)-(b.deadlineMs??Infinity)||String(a.id).localeCompare(String(b.id)));
 for(const job of order){
  const trial=await bestInsertion(routing,start,current,job.stops,{...options,deadlines:{...options.deadlines,[job.id]:job.deadlineMs??null}});
  if(!trial){rejected.push({jobId:job.id,reason:'no_feasible_road_insertion'});continue;}
  current=trial.stops;accepted.push({jobId:job.id,detourSeconds:trial.detourSeconds});
 }
 const final=await evaluateStops(routing,start,current,{...options,shipmentId:undefined});
 if(!final||!weightCapacityValid(current,options.onboardIds??[],options.capacityG))return {feasible:false,accepted:[],rejected:order.map(j=>({jobId:j.id,reason:'infeasible_manifest'}))};
 return {feasible:true,accepted,rejected,plan:final};
}
