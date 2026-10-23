import {createHmac} from 'node:crypto';
import {isIP} from 'node:net';
import {check} from './security.mjs';

// Deployment-owned bridge to a contracted SMS/push provider. The bridge must
// deduplicate Idempotency-Key and return durable provider acceptance evidence.
export function notificationGateway({endpoint,allowedHost,token,fetchImpl=fetch}={}){
 const url=new URL(endpoint);
 check(url.protocol==='https:'&&url.hostname===allowedHost&&!url.username&&!url.password&&!url.search&&!url.hash&&!url.port&&isIP(url.hostname)===0&&!/^(localhost|.*\.local)$/.test(url.hostname)&&typeof token==='string'&&token.length>=32,500,'Notification gateway requires an approved HTTPS host and secret');
 return {async send(job){
  const body=JSON.stringify({id:job.id,recipientId:job.recipient_id,phone:job.phone,kind:job.kind,...job.payload});
  const response=await fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':job.id,'X-Elesend-Signature':createHmac('sha256',token).update(body).digest('hex')},body});
  check(response.ok,503,'Notification delivery refused');
  const receipt=await response.json();
  check(receipt?.accepted===true&&typeof receipt.messageId==='string'&&receipt.messageId.length>0&&receipt.messageId.length<=160,503,'Notification acceptance not verified');
  return receipt;
 }};
}

export function notificationWorker(db,{transport}={}){
 let busy=false;
 return {async tick(){
  if(busy||!transport)return {enabled:!!transport};
  busy=true;
  try{
   await db.query("UPDATE notification_jobs SET state='failed',lease_until=NULL WHERE attempts>=8 AND state='sending' AND lease_until<now()");
   await db.query(`INSERT INTO notification_jobs(id,recipient_id,kind,payload)
    SELECT 'offer:'||o.id::text,o.rider_id,'dispatch_offer',jsonb_build_object('offerId',o.id,'shipmentId',o.shipment_id,'expiresAt',o.expires_at,'message','ELESEND: a delivery offer is available. Open the app to review it.')
    FROM dispatch_offers o WHERE o.status='offered' AND o.expires_at>now() ON CONFLICT(id) DO NOTHING`);
   await db.query(`INSERT INTO notification_jobs(id,recipient_id,kind,payload)
    SELECT 'settlement:'||n.id::text,n.rider_id,n.notification_type,jsonb_build_object('notificationId',n.id,'message',n.message)
    FROM settlement_notifications n WHERE n.sent_at IS NULL ON CONFLICT(id) DO NOTHING`);
   const jobs=(await db.tx(async c=>(await c.query(`WITH due AS (
    SELECT id FROM notification_jobs WHERE ((state='pending' AND available_at<=now()) OR (state='sending' AND lease_until<now())) AND attempts<8
    ORDER BY available_at LIMIT 10 FOR UPDATE SKIP LOCKED
   ) UPDATE notification_jobs j SET state='sending',attempts=j.attempts+1,lease_until=now()+interval '2 minutes' FROM due WHERE j.id=due.id RETURNING j.*`)).rows));
   for(const job of jobs){
    try{
     if(job.kind==='dispatch_offer'&&!(await db.query("SELECT 1 FROM dispatch_offers WHERE id=$1 AND status='offered' AND expires_at>now()",[job.payload.offerId])).rowCount){await db.query("UPDATE notification_jobs SET state='expired',lease_until=NULL WHERE id=$1",[job.id]);continue;}
     const user=(await db.query('SELECT phone FROM users WHERE id=$1',[job.recipient_id])).rows[0];
     const receipt=await transport.send({...job,phone:user.phone});
     await db.tx(async c=>{
      await c.query("UPDATE notification_jobs SET state='sent',sent_at=now(),provider_message_id=$2,lease_until=NULL WHERE id=$1",[job.id,receipt.messageId]);
      if(job.payload.notificationId)await c.query('UPDATE settlement_notifications SET sent_at=now() WHERE id=$1',[job.payload.notificationId]);
     });
    }catch{
     await db.query("UPDATE notification_jobs SET state=CASE WHEN attempts>=8 THEN 'failed' ELSE 'pending' END,available_at=now()+least(3600,power(2,attempts)::int)*interval '1 second',lease_until=NULL WHERE id=$1",[job.id]);
    }
   }
   return {enabled:true,processed:jobs.length};
  }finally{busy=false;}
 }};
}
