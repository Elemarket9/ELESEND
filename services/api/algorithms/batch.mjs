/** For small rider/job sets: optimal distinct 1-to-1 matching via memoized assignment search. */
export function minCostBipartiteAssignment(costs,{maxJobs=12}={}){
 if(!Array.isArray(costs)||costs.length>maxJobs||costs.some(row=>!Array.isArray(row)))throw Error('Job set too large');
 const riders=Math.max(0,...costs.map(r=>r.length));if(riders>20)throw Error('Rider set too large');
 const cache=new Map();function solve(job,used){if(job===costs.length)return {cost:0,matches:[]};const key=job+':'+used;if(cache.has(key))return cache.get(key);
  let best={cost:Infinity,matches:[]};for(let rider=0;rider<riders;rider++){
   if(used&(1<<rider))continue;const c=costs[job][rider];if(!Number.isFinite(c)||c<0)continue;
   const next=solve(job+1,used|(1<<rider));if(c+next.cost<best.cost)best={cost:c+next.cost,matches:[{job,rider},...next.matches]};
  }cache.set(key,best);return best;
 }return solve(0,0);
}
