/** Provider calls share these, so timeouts, concurrency and submission rules cannot drift apart. */
export function raceTimeout(promise,ms,timeoutError){
 if(!Number.isFinite(ms)||ms<=0)return promise;
 let timer;
 return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(timeoutError()),ms);})]).finally(()=>clearTimeout(timer));
}
export async function pool(items,limit,fn){
 const out=new Array(items.length),workers=Math.max(1,limit|0);let next=0;
 await Promise.all(Array.from({length:Math.min(workers,items.length)},async()=>{while(next<items.length){const i=next++;out[i]=await fn(items[i]);}}));
 return out;
}
export const errorText=(e,fallback='unknown')=>String(e?.message||e||fallback).slice(0,500);
export function submissionChecks(inFlight){
 const leased=row=>new Date(row.submission_lease_until).getTime()>Date.now();
 return {
  isSubmissionCallActive(row){
   if(!row||row.status!=='initiating')return false;
   if(inFlight.has(row.id))return true;
   return Boolean(row.submission_token&&row.submission_lease_until)&&leased(row);
  },
  canCreationStillComplete(row){
   if(!row||row.status!=='initiating')return false;
   if(inFlight.has(row.id))return true;
   return Boolean(row.submission_lease_until)&&leased(row);
  }
 };
}
