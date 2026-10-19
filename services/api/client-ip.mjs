import {isIP} from 'node:net';

/** Derive rate-limit subject without allowing caller-controlled XFF spoofing.
 * By default the socket peer is authoritative. Enable CIDRs ONLY for a proxy
 * that is the exclusive ingress to the API; do not whitelist arbitrary LANs.
 */
function v4int(s){if(isIP(s)!==4)return null;return s.split('.').reduce((a,b)=>((a<<8)>>>0)+Number(b),0)>>>0;}
function normalizedIp(value){
 if(typeof value!=='string'||value.length>64)return null;
 const x=value.startsWith('::ffff:')&&isIP(value.slice(7))===4?value.slice(7):value;
 return isIP(x)?x:null;
}
function trusted(ip,entries){
 if(!ip)return false;
 for(const entry of entries){
  const [raw,prefix]=entry.split('/');const base=normalizedIp(raw);
  if(!base)continue;
  if(prefix===undefined){if(base===ip)return true;continue;}
  const bits=Number(prefix),a=v4int(ip),b=v4int(base);
  if(a===null||b===null||!Number.isInteger(bits)||bits<0||bits>32)continue;
  if(bits===0||((a>>>(32-bits))===(b>>>(32-bits))))return true;
 }
 return false;
}
export function clientIp(req,trustedCidrs=process.env.TRUSTED_PROXY_CIDRS??''){
 const peer=normalizedIp(req.socket?.remoteAddress)||'unknown';
 const entries=trustedCidrs.split(',').map(s=>s.trim()).filter(Boolean);
 if(!trusted(peer,entries))return peer;
 const h=req.headers?.['x-forwarded-for'];
 if(typeof h!=='string'||h.length>512)return peer;
 const forwarded=h.split(',').map(s=>normalizedIp(s.trim()));
 if(forwarded.length<1||forwarded.length>12||forwarded.some(x=>!x))return peer;
 // Work from right to left; rightmost untrusted hop is the real client.
 for(const ip of [...forwarded,peer].reverse())if(!trusted(ip,entries))return ip;
 return forwarded[0];
}
