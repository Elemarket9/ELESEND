import {BlockList,isIP} from 'node:net';

/** Derive rate-limit subject without allowing caller-controlled XFF spoofing.
 * By default the socket peer is authoritative. Enable CIDRs ONLY for a proxy
 * that is the exclusive ingress to the API; do not whitelist arbitrary LANs.
 */
function normalizedIp(value){
 if(typeof value!=='string'||value.length>64)return null;
 const x=value.startsWith('::ffff:')&&isIP(value.slice(7))===4?value.slice(7):value;
 return isIP(x)?x:null;
}
function trusted(ip,entries){
 const clean=normalizedIp(ip);
 if(!clean)return false;
 const list=new BlockList();
 for(const entry of entries){
  const [raw,prefix]=entry.split('/');const base=normalizedIp(raw);
  if(!base)continue;
  const family=isIP(base)===6?'ipv6':'ipv4';
  const maxBits=family==='ipv6'?128:32;
  if(prefix===undefined){list.addAddress(base,family);continue;}
  const bits=Number(prefix);
  if(!Number.isInteger(bits)||bits<0||bits>maxBits)continue;
  list.addSubnet(base,bits,family);
 }
 return list.check(clean,isIP(clean)===6?'ipv6':'ipv4');
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

/** Rate-limit identity for an address. One IPv6 customer controls a whole /64, so limits apply to the /64. */
export function rateLimitKey(ip){
 if(isIP(ip)!==6)return ip;
 const [head,tail='']=ip.split('%')[0].split('::');
 const left=head?head.split(':'):[],right=tail?tail.split(':'):[];
 const full=ip.includes('::')?[...left,...Array(Math.max(0,8-left.length-right.length)).fill('0'),...right]:left;
 return full.slice(0,4).map(h=>h.toLowerCase().replace(/^0+(?=.)/,'')).join(':')+'::/64';
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


