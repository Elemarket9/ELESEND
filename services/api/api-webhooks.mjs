import {createHmac,randomUUID} from 'node:crypto';
import {lookup as dnsLookup} from 'node:dns';
import {request as httpsRequest} from 'node:https';
import {BlockList,isIP} from 'node:net';
import {z} from 'zod';
import {check,newToken} from './security.mjs';
import {seal,unseal} from './sealed-values.mjs';
import {riderDataKey} from './rider-licence.mjs';

const MAX_ATTEMPTS=8;
const TIMEOUT_MS=5000;
const blocked=new BlockList();
for(const [net,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(net,bits,'ipv4');
for(const [net,bits] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32]])blocked.addSubnet(net,bits,'ipv6');

/** True only for addresses on the public internet, including IPv4 written inside IPv6. */
export function isPublicAddress(address){
 const mapped=/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]??address;
 const family=isIP(mapped);
 if(family===0)return false;
 return !blocked.check(mapped,family===4?'ipv4':'ipv6');
}
export function validWebhookUrl(raw){
 let url;
 try{url=new URL(raw);}catch{check(false,400,'Enter a valid https address');}
 check(url.protocol==='https:'&&!url.username&&!url.password,400,'Webhook address must use https without a username or password');
 check(!url.port||url.port==='443',400,'Webhook address must use the standard https port');
 const host=url.hostname.replace(/^\[|\]$/g,'');
 check(host.includes('.')||isIP(host),400,'Webhook address must be on the public internet');
 if(isIP(host))check(isPublicAddress(host),400,'Webhook address must be on the public internet');
 return url.toString();
}
/** Checks the address at connection time, so a name cannot later point at an internal service. */
export function publicOnlyLookup(hostname,options,callback){
 dnsLookup(hostname,{...options,all:true},(error,addresses)=>{
  if(error)return callback(error);
  const usable=addresses.filter(a=>isPublicAddress(a.address));
  if(!usable.length||usable.length!==addresses.length)return callback(Object.assign(new Error('Address is not public'),{code:'EPUBLICONLY'}));
  if(options?.all)return callback(null,usable);
  callback(null,usable[0].address,usable[0].family);
 });
}
function post(url,body,headers){
 return new Promise((resolve,reject)=>{
  const req=httpsRequest(url,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),...headers},lookup:publicOnlyLookup,timeout:TIMEOUT_MS},res=>{res.resume();resolve(res.statusCode);});
  req.on('timeout',()=>req.destroy(new Error('timeout')));
  req.on('error',reject);
  req.end(body);
 });
}
export const signatureFor=(secret,timestamp,body)=>createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex');
const context=ownerId=>'elesend:api-webhook:v1:'+ownerId;

export function webhookService(db,{send=post,key=riderDataKey}={}){return {
 async get(actor){
  const row=(await db.query('SELECT id,url,created_at FROM api_webhooks WHERE owner_id=$1',[actor.id])).rows[0];
  if(!row)return null;
  const recent=(await db.query('SELECT event,shipment_id,attempts,delivered_at,abandoned_at,last_status,occurred_at FROM api_webhook_deliveries WHERE webhook_id=$1 ORDER BY id DESC LIMIT 20',[row.id])).rows;
  return {...row,recent};
 },
 /** The signing secret is shown once; saving again replaces it. */
 async set(actor,input){
  const v=z.object({url:z.string().min(10).max(500)}).strict().parse(input);
  const url=validWebhookUrl(v.url);
  const secret='whsec_'+newToken();
  const sealed=seal(key(),context(actor.id),secret);
  const row=(await db.query(`INSERT INTO api_webhooks(id,owner_id,url,secret_sealed,after_outbox_id)
    VALUES($1,$2,$3,$4,(SELECT coalesce(max(id),0) FROM outbox))
    ON CONFLICT(owner_id) DO UPDATE SET url=EXCLUDED.url,secret_sealed=EXCLUDED.secret_sealed RETURNING id,url`,[randomUUID(),actor.id,url,sealed])).rows[0];
  await db.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,'api_webhook.saved',row.id]);
  return {...row,secret};
 },
 async remove(actor){
  const row=(await db.query('DELETE FROM api_webhooks WHERE owner_id=$1 RETURNING id',[actor.id])).rows[0];
  if(row)await db.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,'api_webhook.removed',row.id]);
  return {ok:true};
 },
 async tick({limit=25}={}){
  await db.tx(async c=>{
   const newest=Number((await c.query('SELECT coalesce(max(id),0) AS id FROM outbox')).rows[0].id);
   await c.query(`INSERT INTO api_webhook_deliveries(webhook_id,outbox_id,shipment_id,event,occurred_at)
     SELECT w.id,o.id,o.shipment_id,o.kind,o.created_at FROM api_webhooks w
      JOIN shipments s ON s.customer_id=w.owner_id JOIN outbox o ON o.shipment_id=s.id
     WHERE o.id>w.after_outbox_id AND o.id<=$1 ON CONFLICT(webhook_id,outbox_id) DO NOTHING`,[newest]);
   await c.query('UPDATE api_webhooks SET after_outbox_id=$1 WHERE after_outbox_id<$1',[newest]);
  });
  // Claiming moves the next attempt forward first, so another worker will not send the same event at once.
  const due=(await db.query(`UPDATE api_webhook_deliveries d SET attempts=d.attempts+1,next_attempt_at=now()+make_interval(secs=>least(3600,30*power(2,d.attempts+1)))
    FROM api_webhooks w WHERE w.id=d.webhook_id AND d.id IN (
     SELECT id FROM api_webhook_deliveries WHERE delivered_at IS NULL AND abandoned_at IS NULL AND next_attempt_at<=now()
      ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
    RETURNING d.id,d.attempts,d.shipment_id,d.event,d.occurred_at,w.url,w.secret_sealed,w.owner_id`,[limit])).rows;
  const results=[];
  for(const d of due){
   const body=JSON.stringify({id:String(d.id),event:d.event,shipmentId:d.shipment_id,occurredAt:new Date(d.occurred_at).toISOString()});
   const timestamp=Math.floor(Date.now()/1000);
   let status=null;
   try{
    const secret=unseal(key(),context(d.owner_id),d.secret_sealed).toString('utf8');
    status=await send(d.url,body,{'X-Elesend-Event':d.event,'X-Elesend-Signature':`t=${timestamp},v1=${signatureFor(secret,timestamp,body)}`});
   }catch{status=null;}
   const delivered=status>=200&&status<300;
   await db.query(`UPDATE api_webhook_deliveries SET last_status=$2,
      delivered_at=CASE WHEN $3::boolean THEN now() END,
      abandoned_at=CASE WHEN NOT $3::boolean AND attempts>=$4 THEN now() END WHERE id=$1`,[d.id,status,delivered,MAX_ATTEMPTS]);
   results.push({id:d.id,delivered,status});
  }
  return results;
 }
};}
