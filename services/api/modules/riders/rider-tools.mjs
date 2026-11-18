/** Earnings goals, demand areas, referrals, reward campaigns and automatic rider safety checks. */
import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check} from '../../shared/security.mjs';
import {envInt} from '../../shared/env-values.mjs';
import {riderEarningsTotals} from '../payments/index.mjs';
import {haversine} from '../../shared/dispatch-geometry.mjs';
import {awardPromotionCredit} from '../payments/index.mjs';

const requireRider=actor=>check(actor?.kind==='rider',403,'Rider account required');
const setting=(value,fallback)=>envInt(value,fallback,0);

export async function riderEarningsGoals(db,actor){
 requireRider(actor);
 const r=(await db.query('SELECT daily_goal_minor,weekly_goal_minor,rest_until FROM riders WHERE id=$1',[actor.id])).rows[0];
 check(r,403,'Rider account required');
 return {...await riderEarningsTotals(db,actor.id),dailyGoalMinor:r.daily_goal_minor===null?null:Number(r.daily_goal_minor),weeklyGoalMinor:r.weekly_goal_minor===null?null:Number(r.weekly_goal_minor),restUntil:r.rest_until};
}
export async function setEarningsGoals(db,actor,input){
 requireRider(actor);
 const goal=z.number().int().min(100).max(100000000).nullable();
 const v=z.object({dailyGoalMinor:goal,weeklyGoalMinor:goal}).strict().parse(input);
 await db.query('UPDATE riders SET daily_goal_minor=$2,weekly_goal_minor=$3 WHERE id=$1',[actor.id,v.dailyGoalMinor,v.weeklyGoalMinor]);
 return riderEarningsGoals(db,actor);
}
/** Grouped areas only, and never fewer than three orders, so no single customer can be located. */
export async function demandAreas(db,actor){
 requireRider(actor);
 const me=(await db.query('SELECT ST_Y(current_position::geometry) AS latitude,ST_X(current_position::geometry) AS longitude FROM riders WHERE id=$1',[actor.id])).rows[0];
 // Same demand as surge pricing: distinct customers waiting for a rider in the last 10 minutes.
 const rows=(await db.query(`SELECT round((q.request->'pickup'->>'latitude')::numeric,2)::float AS latitude,round((q.request->'pickup'->>'longitude')::numeric,2)::float AS longitude,count(DISTINCT s.customer_id)::int AS orders
   FROM shipments s JOIN quotes q ON q.id=s.quote_id
   WHERE s.state='AWAITING_ASSIGNMENT' AND (s.paid OR s.payment_method='CASH') AND s.created_at>now()-interval '10 minutes' AND q.request->'pickup'->>'latitude' IS NOT NULL
   GROUP BY 1,2 HAVING count(DISTINCT s.customer_id)>=3 ORDER BY orders DESC LIMIT 10`)).rows;
 return {areas:rows.map(a=>({...a,distanceMeters:me?.latitude!=null?Math.round(haversine(me,a)):null}))};
}
export async function referralSummary(db,actor){
 requireRider(actor);
 let code=(await db.query('SELECT referral_code FROM riders WHERE id=$1',[actor.id])).rows[0]?.referral_code;
 if(!code){
  code=randomBytes(4).toString('hex').toUpperCase();
  await db.query('UPDATE riders SET referral_code=coalesce(referral_code,$2) WHERE id=$1',[actor.id,code]);
  code=(await db.query('SELECT referral_code FROM riders WHERE id=$1',[actor.id])).rows[0].referral_code;
 }
 const stats=(await db.query("SELECT count(*)::int AS invited,count(*) FILTER(WHERE status='earned')::int AS earned,coalesce(sum(reward_minor),0)::bigint AS rewarded FROM rider_referrals WHERE referrer_id=$1",[actor.id])).rows[0];
 return {code,invited:stats.invited,earned:stats.earned,rewardedMinor:Number(stats.rewarded),targetDeliveries:setting(process.env.REFERRAL_TARGET_DELIVERIES,10),rewardMinor:setting(process.env.REFERRAL_REWARD_MINOR,0)};
}
export async function applyReferralCode(db,actor,input){
 requireRider(actor);
 const {code}=z.object({code:z.string().trim().regex(/^[A-Fa-f0-9]{8}$/)}).strict().parse(input);
 return db.tx(async c=>{
  const referrer=(await c.query('SELECT id FROM riders WHERE referral_code=$1',[code.toUpperCase()])).rows[0];
  check(referrer&&referrer.id!==actor.id,404,'This referral code is not valid');
  check(!(await c.query("SELECT 1 FROM shipments WHERE rider_id=$1 AND state='COMPLETED'",[actor.id])).rowCount,409,'Referral codes are for new riders');
  const row=await c.query('INSERT INTO rider_referrals(referred_id,referrer_id) VALUES($1,$2) ON CONFLICT(referred_id) DO NOTHING RETURNING referred_id',[actor.id,referrer.id]);
  check(row.rowCount,409,'A referral code is already on your account');
  return {status:'pending'};
 });
}
const awardCredit=awardPromotionCredit;
const completedSince=(c,riderId,from,to)=>c.query("SELECT count(*)::int AS n FROM shipments WHERE rider_id=$1 AND state='COMPLETED' AND completed_at>=$2 AND completed_at<=$3",[riderId,from,to]).then(r=>r.rows[0].n);
/** Rewards are commission credit, used automatically against future cash commission. */
export async function settleRiderRewards(db,{limit=100}={}){
 const target=setting(process.env.REFERRAL_TARGET_DELIVERIES,10),reward=setting(process.env.REFERRAL_REWARD_MINOR,0);
 const due=reward>0?(await db.query(`SELECT f.referred_id,f.referrer_id FROM rider_referrals f
   WHERE f.status='pending' AND (SELECT count(*) FROM shipments s WHERE s.rider_id=f.referred_id AND s.state='COMPLETED')>=$1 ORDER BY f.created_at LIMIT $2`,[target,limit])).rows:[];
 for(const f of due)await db.tx(async c=>{
  const updated=await c.query("UPDATE rider_referrals SET status='earned',reward_minor=$2,earned_at=now() WHERE referred_id=$1 AND status='pending' RETURNING referred_id",[f.referred_id,reward]);
  if(updated.rowCount&&reward>0)await awardCredit(c,f.referrer_id,'referral:'+f.referred_id,reward);
 });
 const campaigns=(await db.query("SELECT * FROM rider_reward_campaigns WHERE active AND starts_at<=now() AND ends_at>=now()-interval '7 days'")).rows;
 for(const k of campaigns){
  const winners=(await db.query(`SELECT s.rider_id FROM shipments s WHERE s.state='COMPLETED' AND s.completed_at>=$1 AND s.completed_at<=$2 AND s.rider_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM rider_campaign_awards a WHERE a.campaign_id=$3 AND a.rider_id=s.rider_id)
    GROUP BY s.rider_id HAVING count(*)>=$4 LIMIT $5`,[k.starts_at,k.ends_at,k.id,k.target_deliveries,limit])).rows;
  for(const {rider_id:riderId} of winners)await db.tx(async c=>{
   const row=await c.query('INSERT INTO rider_campaign_awards(campaign_id,rider_id,reward_minor) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING rider_id',[k.id,riderId,k.reward_minor]);
   if(row.rowCount)await awardCredit(c,riderId,`campaign:${k.id}:${riderId}`,Number(k.reward_minor));
  });
 }
 return {referrals:due.length,campaigns:campaigns.length};
}
const campaignSchema=z.object({title:z.string().trim().min(3).max(120),targetDeliveries:z.number().int().min(1).max(10000),rewardMinor:z.number().int().min(1).max(100000000),days:z.number().int().min(1).max(90)}).strict();
export async function createRewardCampaign(db,actor,input){
 const v=campaignSchema.parse(input);
 check(actor?.kind==='admin'&&(await db.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission='finance:configure'",[actor.id])).rowCount,403,'Finance permission required');
 const id=randomUUID();
 await db.query("INSERT INTO rider_reward_campaigns(id,title,target_deliveries,reward_minor,starts_at,ends_at,created_by) VALUES($1,$2,$3,$4,now(),now()+make_interval(days=>$5),$6)",[id,v.title,v.targetDeliveries,v.rewardMinor,v.days,actor.id]);
 await db.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'rider.reward_campaign_created',$1)",[actor.id]);
 return {id};
}
export async function riderCampaigns(db,actor){
 requireRider(actor);
 const rows=(await db.query('SELECT id,title,target_deliveries,reward_minor,starts_at,ends_at FROM rider_reward_campaigns WHERE active AND ends_at>now() ORDER BY ends_at LIMIT 10')).rows;
 const out=[];
 for(const k of rows)out.push({id:k.id,title:k.title,targetDeliveries:k.target_deliveries,rewardMinor:Number(k.reward_minor),endsAt:k.ends_at,completed:await completedSince(db,actor.id,k.starts_at,k.ends_at)});
 return {campaigns:out};
}
/** Long online shifts force a rest. Short breaks do not reset the clock. */
/** A rider whose session has ended cannot answer offers, so stop sending them any. */
export async function offlineSignedOutRiders(db){
 await db.query("UPDATE riders r SET online=false WHERE r.online AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=r.id AND s.expires_at>now())");
}
export async function enforceDrivingLimits(db){
 const hours=setting(process.env.RIDER_MAX_ONLINE_HOURS,12)||12,rest=setting(process.env.RIDER_REST_HOURS,6)||6;
 await db.query('UPDATE riders SET shift_started_at=NULL WHERE NOT online AND shift_started_at IS NOT NULL AND last_offline_at<now()-make_interval(hours=>$1)',[rest]);
 const rows=(await db.query(`UPDATE riders SET online=false,rest_until=now()+make_interval(hours=>$2),shift_started_at=NULL
   WHERE online AND shift_started_at<now()-make_interval(hours=>$1)
    -- A rider over the limit finishes the parcels they hold first; the next run sends them to rest.
    AND NOT EXISTS(SELECT 1 FROM shipments s WHERE s.rider_id=riders.id AND s.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP'))
   RETURNING id`,[hours,rest])).rows;
 for(const {id} of rows){
  await db.query("UPDATE dispatch_offers SET status='invalidated' WHERE rider_id=$1 AND status='offered'",[id]);
  await db.query("INSERT INTO audit_logs(action,entity_id) VALUES('rider.rest_enforced',$1)",[id]);
 }
 return rows.map(r=>r.id);
}
/** A rider who has not moved for a long time mid-delivery is flagged, and the rider is asked if they are safe. */
export async function flagUnusualStops(db,{minutes=setting(process.env.UNUSUAL_STOP_MINUTES,20),metres=100}={}){
 await db.query("DELETE FROM delivery_stop_watch w USING shipments s WHERE s.id=w.shipment_id AND s.state NOT IN ('PICKUP_VERIFIED','IN_TRANSIT')");
 const rows=(await db.query(`SELECT s.id,s.rider_id,ST_Y(r.current_position::geometry) AS latitude,ST_X(r.current_position::geometry) AS longitude,
    w.latitude AS w_lat,w.longitude AS w_lng,w.since,w.alerted_at
   FROM shipments s JOIN riders r ON r.id=s.rider_id LEFT JOIN delivery_stop_watch w ON w.shipment_id=s.id
   WHERE s.state IN ('PICKUP_VERIFIED','IN_TRANSIT') AND r.current_position IS NOT NULL AND r.position_at>now()-make_interval(mins=>$1) LIMIT 500`,[Math.max(30,minutes*2)])).rows;
 const flagged=[];
 for(const x of rows){
  if(x.w_lat===null||haversine({latitude:x.w_lat,longitude:x.w_lng},x)>metres){
   await db.query(`INSERT INTO delivery_stop_watch(shipment_id,latitude,longitude,since) VALUES($1,$2,$3,now())
     ON CONFLICT(shipment_id) DO UPDATE SET latitude=$2,longitude=$3,since=now(),alerted_at=NULL`,[x.id,x.latitude,x.longitude]);
   continue;
  }
  if(x.alerted_at||Date.now()-new Date(x.since).getTime()<minutes*60000)continue;
  await db.tx(async c=>{
   await c.query('UPDATE delivery_stop_watch SET alerted_at=now() WHERE shipment_id=$1',[x.id]);
   await c.query("INSERT INTO operational_risk_signals(rider_id,shipment_id,signal_code,severity,evidence) VALUES($1,$2,'UNUSUAL_STOP','medium',$3)",[x.rider_id,x.id,JSON.stringify({since:x.since,latitude:x.latitude,longitude:x.longitude})]);
   await c.query("INSERT INTO notification_jobs(id,recipient_id,kind,payload) VALUES($1,$2,'delivery_watchdog_alert',$3) ON CONFLICT(id) DO NOTHING",[`stop:${x.id}:${new Date(x.since).getTime()}`,x.rider_id,JSON.stringify({shipmentId:x.id,action:'unusual_stop',message:'You have not moved for a while. If you need help, press the emergency button.'})]);
  });
  flagged.push(x.id);
 }
 return flagged;
}
