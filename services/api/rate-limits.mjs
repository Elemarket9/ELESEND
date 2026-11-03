import {check} from './security.mjs';

// Many Ghanaian mobile users can share one public IP (carrier-grade NAT), so per-IP limits are
// set for a crowd, and per-account, per-phone and per-user limits provide the tighter protection.
const BASE_IP_LIMITS={
 httpPerMinute:12000,
 publicTrackPerMinute:3000,
 registrationsPerHour:300,
 loginAttemptsPer15Min:3000,
 loginFailuresPer15Min:300,
 recoveryPer15Min:100,
 resetPer15Min:150,
 accountSmsPer15Min:200
};

export function parseIpLimitMultiplier(value){
 if(value===undefined||value===null||String(value).trim()==='')return 1;
 const n=Number(value);
 return Number.isFinite(n)&&n>=0.1&&n<=100?n:null;
}

export function ipLimits(multiplier=parseIpLimitMultiplier(process.env.IP_LIMIT_MULTIPLIER)??1){
 return Object.fromEntries(Object.entries(BASE_IP_LIMITS).map(([k,v])=>[k,Math.max(1,Math.round(v*multiplier))]));
}

/** Per-process flood guard for high-volume routes, so ordinary traffic adds no database write per request.
 * With several API instances the effective limit is per instance, which suits a coarse guard. */
export function memoryRateLimiter({maxKeys=100000,now=()=>Date.now()}={}){
 const windows=new Map();
 function prune(at){
  for(const [key,w] of windows)if(w.expiresAt<=at)windows.delete(key);
  // Under a flood of distinct addresses, keep memory bounded by dropping the oldest windows.
  for(const key of windows.keys()){if(windows.size<maxKeys)break;windows.delete(key);}
 }
 return {
  hit(key,max,seconds){
   const at=now();let w=windows.get(key);
   if(!w||w.expiresAt<=at){
    windows.delete(key);
    if(windows.size>=maxKeys)prune(at);
    w={count:0,expiresAt:at+seconds*1000};windows.set(key,w);
   }
   w.count++;
   check(w.count<=max,429,'Too many requests');
  },
  size:()=>windows.size
 };
}
