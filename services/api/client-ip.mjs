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
 const rawHeader=req.headers?.['x-forwarded-for'];
 const h=Array.isArray(rawHeader)?rawHeader.join(','):rawHeader;
 if(typeof h!=='string'||h.length>512)return peer;
 const rawHops=h.split(',').map(s=>s.trim()).filter(Boolean);
 if(rawHops.length<1||rawHops.length>12)return peer;
 // Work from right to left; rightmost untrusted valid hop is the real client.
 // Ignore any spoofed or malformed entries further to the left.
 let lastTrustedHop=null;
 for(let i=rawHops.length-1;i>=0;i--){
  const ip=normalizedIp(rawHops[i]);
  if(!ip)return lastTrustedHop||peer;
  if(!trusted(ip,entries))return ip;
  lastTrustedHop=ip;
 }
 return lastTrustedHop||peer;
}

export function resolveVerifiedHost(req, trustedCidrs = process.env.TRUSTED_PROXY_CIDRS ?? (process.env.NODE_ENV === 'production' ? '' : '127.0.0.1,::1')) {
 const peer = normalizedIp(req.socket?.remoteAddress);
 const entries = trustedCidrs.split(',').map(s => s.trim()).filter(Boolean);
 const peerIsTrusted = entries.length > 0 && trusted(peer, entries);
 let host = req.headers?.host || '';
 if (peerIsTrusted && req.headers?.['x-forwarded-host']) {
  const rawForwarded = String(req.headers['x-forwarded-host']).split(',')[0].trim();
  if (rawForwarded) host = rawForwarded;
 }
 return host.split(':')[0].toLowerCase();
}


