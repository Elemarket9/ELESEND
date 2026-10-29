import {createHmac} from 'node:crypto';
import {isIP} from 'node:net';
import {check} from './security.mjs';
import {emitRealtimeUserEvent} from './chat-engine.mjs';

export const RIDER_OFFER_ALERT_CHANNEL = 'elesend-rider-offers';

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

export function notificationWorker(db,{transport=null,sms=null}={}){
 let busy=false;
 const hasNotificationSms=Boolean(sms&&typeof sms.sendNotification==='function');
 const hasExternalChannel=Boolean(transport||hasNotificationSms);
 return {async tick(){
  if(busy)return {enabled:hasExternalChannel};
  busy=true;
  try{
   await db.query("UPDATE notification_jobs SET state='failed',lease_until=NULL WHERE attempts>=8 AND state='sending' AND lease_until<now()");
   await db.query(`INSERT INTO notification_jobs(id,recipient_id,kind,payload)
    SELECT 'offer:'||o.id::text,o.rider_id,'dispatch_offer',jsonb_build_object(
     'offerId',o.id,
     'shipmentId',o.shipment_id,
     'expiresAt',o.expires_at,
     'channelId',$1::text,
     'priority','high',
     'wakeScreen',true,
     'message','ELESEND: a delivery offer is available. Open the app to review it.'
    )
    FROM dispatch_offers o WHERE o.status='offered' AND o.expires_at>now() ON CONFLICT(id) DO NOTHING`,[RIDER_OFFER_ALERT_CHANNEL]);
   await db.query(`INSERT INTO notification_jobs(id,recipient_id,kind,payload)
    SELECT 'settlement:'||n.id::text,n.rider_id,n.notification_type,jsonb_build_object('notificationId',n.id,'message',n.message)
    FROM settlement_notifications n WHERE n.sent_at IS NULL ON CONFLICT(id) DO NOTHING`);
   if(!hasExternalChannel)return {enabled:false};
   const jobs=(await db.tx(async c=>(await c.query(`WITH due AS (
    SELECT j.id FROM notification_jobs j
    WHERE ((j.state='pending' AND j.available_at<=now()) OR (j.state='sending' AND j.lease_until<now()))
      AND j.attempts<8
    ORDER BY j.available_at LIMIT 10 FOR UPDATE SKIP LOCKED
   ) UPDATE notification_jobs j SET state='sending',attempts=j.attempts+1,lease_until=now()+interval '2 minutes' FROM due WHERE j.id=due.id RETURNING j.*`)).rows));
   for(const job of jobs){
    try{
     if(job.kind==='dispatch_offer'&&!(await db.query("SELECT 1 FROM dispatch_offers WHERE id=$1 AND status='offered' AND expires_at>now()",[job.payload.offerId])).rowCount){await db.query("UPDATE notification_jobs SET state='expired',lease_until=NULL WHERE id=$1",[job.id]);continue;}
     if(job.kind==='chat_message'){
      const vp=(await db.query("SELECT p.role,c.shipment_id,s.rider_id FROM chat_participants p JOIN chat_conversations c ON c.id=p.conversation_id LEFT JOIN shipments s ON s.id=c.shipment_id WHERE p.conversation_id=$1 AND p.user_id=$2 AND p.membership_status='active' AND p.muted=FALSE AND c.state IN ('CREATED','ACTIVE','RESTRICTED')",[job.payload?.conversationId,job.recipient_id])).rows[0];
      if(!vp||(vp.role==='rider'&&vp.rider_id!==job.recipient_id)){await db.query("UPDATE notification_jobs SET state='expired',lease_until=NULL WHERE id=$1",[job.id]);continue;}
     }
     const user=(await db.query('SELECT phone FROM users WHERE id=$1',[job.recipient_id])).rows[0];
     const pushTokens=(await db.query(
      `SELECT t.id,t.platform,t.push_token,t.app_state,t.battery_saver_enabled,t.background_location_enabled
         FROM user_push_tokens t
        WHERE t.user_id=$1
          AND t.active=true
          AND (
            t.session_token_hash IS NULL
            OR EXISTS (
              SELECT 1 FROM sessions s
               WHERE s.token_hash=t.session_token_hash
                 AND s.user_id=t.user_id
                 AND s.expires_at>now()
            )
          )
        ORDER BY t.updated_at DESC
        LIMIT 5`,
      [job.recipient_id]
     )).rows;
     try{
      emitRealtimeUserEvent(job.recipient_id,{
       type:'background.alert',
       jobId:job.id,
       kind:job.kind,
       channelId:job.payload?.channelId||RIDER_OFFER_ALERT_CHANNEL,
       priority:'high',
       wakeScreen:true,
       payload:job.payload,
       sentAt:new Date().toISOString()
      });
     }catch{}
     let receipt=null;
     if(transport){
      const enrichedPayload=pushTokens.length
       ?{...job.payload,channelId:job.payload?.channelId||RIDER_OFFER_ALERT_CHANNEL,priority:'high',wakeScreen:true,pushTokens:pushTokens.map(t=>({platform:t.platform,token:t.push_token,appState:t.app_state,batterySaverEnabled:t.battery_saver_enabled}))}
       :job.payload;
      receipt=await transport.send({...job,phone:user?.phone,payload:enrichedPayload});
     }else if(hasNotificationSms){
      receipt=await sms.sendNotification({
       phone:user?.phone,
       message:job.payload?.message||`ELESEND notification (${job.kind})`,
       jobId:job.id,
       clientReference:job.id,
       kind:job.kind
      });
     }
     check(receipt?.accepted===true&&typeof receipt.messageId==='string'&&receipt.messageId.length>0,503,'Notification acceptance not verified');
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
