import {baselineFactorFor,etaBaselineFactors,quotedEtaMinutes} from './eta/baseline-factors.mjs';
import {activeTollRules,applicableTolls} from './toll-rules.mjs';
import {cityBucket,timeBucket,travelAdjustment} from './eta/stage-eta.mjs';
import {tripEvidence} from './eta/eta-service.mjs';
import {ACTIVE_PUSH_TOKEN_FILTER,queueNotification} from './notifications.mjs';
import {envInt} from '../../shared/env-values.mjs';
import {cashAlreadyReported,confirmedPaymentMinor,unpaidEarningsMinor,withdrawalFeeMinor} from '../payments/index.mjs';
import {approveVehicleRecord,riderMeetsVehicleLicence} from '../riders/index.mjs';
import {ACCEPTED_SERVICES,assertCompanyDelivery} from '../riders/index.mjs';
import {ensureCommissionAccount,paymentMethodEnabled,findPaymentEvent,recordPaymentEvent,recordFinancialEntry,earningsEntriesFor,senderCashCollectedInFull,cashCollectionFor,accrueRestaurantSettlement} from '../payments/index.mjs';
import {approveRiderDocuments,shredRiderDocuments} from '../riders/index.mjs';
import {approveRiderLicence,shredRiderLicence} from '../riders/index.mjs';
import {randomUUID} from 'node:crypto';
import {MARKET_CURRENCY,MARKET_TIME_ZONE} from '../../shared/market.mjs';
import {decryptAdminSecret,verifyAdminTotp} from '../riders/index.mjs';
import {z} from 'zod';
import {assertAcceptablePassword,passwordNeedsUpgrade,UNKNOWN_ACCOUNT_HASH,check,phone,hash,passwordHash,passwordMatches,newToken,newCode,mac,equal,limit,recordAttempt,assertUnderLimit,securityEvent} from '../../shared/security.mjs';
import {carRegistration,registerVehicleInTx} from '../riders/index.mjs';
import {removeStop,removeShipment} from './multi-parcel.mjs';
import {settleCompletedDelivery,debtState,companyDebtMinor} from '../payments/index.mjs';
import {requestCheckoutRefund} from '../payments/index.mjs';
import {requireFoodPayment} from '../payments/index.mjs';
import {calculateQuote,waitingFeeMinor} from './pricing.mjs';
import {calculateLongVehicleQuote} from './long-vehicle-pricing.mjs';
import {getSurgeMultiplier,validateGhanaBoundary} from './pricing-surge.mjs';
import {measuredSurge} from './pricing-surge.mjs';
import {haversine} from '../../shared/dispatch-geometry.mjs';
// A rider may complete a delivery only with a server-received fix this close to the quoted drop-off.
const DELIVERY_HANDOVER_RADIUS_M=200;
const DELIVERY_HANDOVER_MAX_AGE_SECONDS=120;
export async function requireAcceptedTerms(db,actor){
 if(!actor?.id||!['customer','business','company'].includes(actor.kind))return;
 const row=(await db.query('SELECT terms_accepted_at FROM users WHERE id=$1',[actor.id])).rows[0];
 check(row?.terms_accepted_at,409,'Accept the current terms before booking');
}
export async function warnPlaceholderTariffs(db){
 const vehicles=(await db.query("SELECT vehicle FROM pricing_policies WHERE active AND vehicle IS NOT NULL AND is_placeholder AND vehicle<>'long_vehicle' UNION ALL SELECT 'long_vehicle' WHERE NOT EXISTS(SELECT 1 FROM long_vehicle_pricing_policies WHERE active AND NOT is_placeholder) ORDER BY vehicle")).rows.map(x=>x.vehicle);
 if(vehicles.length)process.stderr.write(JSON.stringify({level:'warn',component:'pricing',code:'placeholder_vehicle_tariffs',vehicles})+'\n');
}
import {featureService} from '../../shared/algorithms/features.mjs';
import {detectFraudSignals} from '../../shared/algorithms/fraud.mjs';
import {marketService} from '../../shared/markets.mjs';
import {getRedisClient} from '../../shared/cache/redis.mjs';
import {promotionEngine} from '../food/index.mjs';
import {disconnectRealtimeUser} from '../safety/index.mjs';
const VEHICLE_LABELS={bicycle:'bicycle',motorcycle:'motorbike',tricycle:'cargo tricycle',car:'car',pickup:'pickup truck',van:'van',truck:'truck',box_truck:'box truck',long_vehicle:'long vehicle'};
const kg=g=>`${Math.round(Number(g)/1000)} kg`,km=m=>`${Math.round(Number(m)/1000)} km`;
const id=()=>randomUUID();
const uuid=z.string().uuid();
// Phone numbers are shared for the delivery, not kept: riders lose the customer's and recipient's numbers, and
// customers the rider's, two hours after delivery (as the shared tracking link does), or at once if it was
// cancelled or returned. Staff keep access. Later contact goes through support.
const CONTACT_WINDOW_MS=2*3600*1000;
const contactOpen=s=>s.state==='COMPLETED'?Boolean(s.completed_at)&&Date.now()-new Date(s.completed_at).getTime()<CONTACT_WINDOW_MS:!['CANCELLED','RETURNED'].includes(s.state);
/** A price that was never booked still holds the recipient's phone number and both addresses, so it is removed a week
 * after it expired. Booked quotes stay with their delivery. */
export async function purgeUnbookedQuotes(db){
 return (await db.query("DELETE FROM quotes WHERE id IN (SELECT q.id FROM quotes q WHERE q.expires_at<now()-interval '7 days' AND NOT EXISTS(SELECT 1 FROM shipments s WHERE s.quote_id=q.id) LIMIT 5000)")).rowCount;
}
export function hideEndedContacts(actor,s){
 if(!s||actor?.kind==='admin')return s;
 const stripDeclared=d=>d&&typeof d==='object'?{...d,declaredGoodsValueMinor:undefined}:d;
 const strip=d=>d&&typeof d==='object'?{...d,recipientPhone:undefined,pickupPhone:undefined,declaredGoodsValueMinor:undefined}:d;
 if(actor?.kind==='rider'){
  if(contactOpen(s))return {...s,details:stripDeclared(s.details),quote_request:stripDeclared(s.quote_request)};
  return {...s,recipient_phone:null,rider_phone:s.rider_phone===undefined?undefined:null,details:strip(s.details),quote_request:strip(s.quote_request)};
 }
 if(contactOpen(s))return s;
 if(actor?.id===s.customer_id)return {...s,rider_phone:s.rider_phone===undefined?undefined:null};
 return {...s,recipient_phone:null,details:strip(s.details),rider_phone:s.rider_phone===undefined?undefined:null};
}
const vehicleTypes=['bicycle','motorcycle','tricycle','car','pickup','van','box_truck','long_vehicle','truck'];
const registration=z.object({phone:z.string().max(30),termsVersion:z.string().trim().min(1).max(40),password:z.string().min(12).max(128),kind:z.enum(['customer','business','rider','company']),name:z.string().min(2).max(160).optional(),vehicle:z.enum(vehicleTypes).optional(),maxWeightG:z.number().int().min(1).max(30000000).optional(),car:carRegistration.optional(),vehicleDetails:carRegistration.optional(),services:z.array(z.enum(ACCEPTED_SERVICES)).min(1).max(2).optional()}).strict();
const address=z.object({address:z.string().min(5).max(400),latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180)}).strict();
const quoteSchema=z.object({pickup:address,destination:address,vehicle:z.enum(vehicleTypes.filter(x=>x!=='bicycle')).optional(),recipientPhone:z.string().max(30),pickupPhone:z.string().max(30).optional(),weightG:z.number().int().min(1).max(30000000),lengthCm:z.number().int().positive().max(30000).optional(),volumeL:z.number().int().positive().max(1000000).optional(),helpers:z.number().int().min(0).max(4).default(0),pickupFloorsNoLift:z.number().int().min(0).max(100).default(0),dropoffFloorsNoLift:z.number().int().min(0).max(100).default(0),declaredGoodsValueMinor:z.number().int().min(1).max(2147483647).optional(),description:z.string().min(2).max(500),parcelCategory:z.enum(['general','documents','fragile','food']).default('general'),parcelSize:z.enum(['small','medium','large']).default('small'),paymentMethod:z.enum(['CASH','MOMO','CARD','QR','DIGITAL']).default('DIGITAL'),cashPayer:z.enum(['sender','recipient']).default('recipient')}).strict();
// Legacy SMS handovers are disabled by default in production. Test/development fixtures remain compatible.
const allowLegacySmsHandover=()=>process.env.NODE_ENV!=='production'||process.env.HANDOVER_SMS_LEGACY_ENABLED==='true';
const ACCOUNT_SMS_PER_NUMBER=5,ACCOUNT_SMS_BLOCK_SECONDS=900;
/** Allows 5 account SMS per number per 15 minutes; the 6th attempt starts a full 15-minute block.
 * Call outside a transaction, so a failed request cannot roll the count back. */
async function limitAccountSms(db,phoneNumber){
 const r=await db.query(`INSERT INTO rate_limits(subject,count,expires_at) VALUES($1,1,now()+$2*interval '1 second')
  ON CONFLICT(subject) DO UPDATE SET
   count=CASE WHEN rate_limits.expires_at<=now() THEN 1 ELSE rate_limits.count+1 END,
   expires_at=CASE WHEN rate_limits.expires_at<=now() OR rate_limits.count=$3 THEN excluded.expires_at ELSE rate_limits.expires_at END
  RETURNING count`,['account-sms:'+hash(phoneNumber),ACCOUNT_SMS_BLOCK_SECONDS,ACCOUNT_SMS_PER_NUMBER]);
 check(r.rows[0].count<=ACCOUNT_SMS_PER_NUMBER,429,'Too many SMS requests for this number. Try again in 15 minutes.');
}
const audit=(c,actor,action,entity)=>c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor,action,entity]);
/** A returned parcel is paid for like a delivery: the sender pays, the rider earns and commission applies. */
async function settleReturnedParcel(c,s){
 await recordFinancialEntry(c,{shipment:s,beneficiaryId:s.company_id??s.rider_id});
 await settleCompletedDelivery(c,s);
}
export function platform(db,{otpKey,sms,dispatch,routing,adminMfaKey=process.env.ADMIN_MFA_ENCRYPTION_KEY}={}){
 check(/^[a-f0-9]{64}$/i.test(otpKey??''),500,'OTP_KEY must be 32 random bytes encoded as hex');
 async function event(c,s,kind){await c.query('INSERT INTO outbox(shipment_id,kind,payload) VALUES($1,$2,$3)',[s,kind,JSON.stringify({shipmentId:s,kind})]);}
 async function permission(c,actor,p){check((await c.query('SELECT 1 FROM permissions WHERE user_id=$1 AND permission=$2',[actor.id,p])).rowCount,403,'Permission required');}
 /** Free until a set time after a rider accepts. After that a set fee goes to that rider, taken from the refund. */
 const quoteEvidenceCache=new Map();
 async function quoteEvidence(key){
  const cacheKey=Object.values(key).join(':'),cached=quoteEvidenceCache.get(cacheKey);
  if(cached&&cached.expires>Date.now())return cached.value;
  const value=await tripEvidence(db,key);
  quoteEvidenceCache.set(cacheKey,{value,expires:Date.now()+600000});
  return value;
 }
 /**
  * Rider's waiting at a stop. The clock starts once the rider stays inside the stop's geofence, so a
  * drive-past costs nothing, and stops at their first code request. Several parcels on one wait pay once.
  * In cash, only the person being waited for pays: the sender at pickup, the recipient at the door.
  * Off until WAITING_CHARGES_ENABLED=true.
  */
 async function chargeWaiting(c,s,stop){
  if(process.env.WAITING_CHARGES_ENABLED!=='true'||!['pickup','delivery'].includes(stop))return null;
  if(s.payment_method==='CASH'&&(stop==='pickup')!==(s.cash_payer==='sender'))return null;
  if((await c.query('SELECT 1 FROM food_orders WHERE shipment_id=$1',[s.id])).rowCount)return null;
  const span=(await c.query(`SELECT m.occurred_at AS arrived_at,coalesce(ch.first_at,h.confirmed_at) AS ended_at
    FROM delivery_milestones m,LATERAL (SELECT min(created_at) AS first_at FROM challenges WHERE shipment_id=$1 AND rider_id=$2 AND purpose=$4) ch,LATERAL (SELECT min(confirmed_at) AS confirmed_at FROM shipment_handover_events WHERE shipment_id=$1 AND rider_id=$2 AND kind=$4) h
    WHERE m.shipment_id=$1 AND m.rider_id=$2 AND m.milestone=$3 ORDER BY m.occurred_at LIMIT 1`,[s.id,s.rider_id,stop==='pickup'?'arrived_pickup':'arrived_customer',stop])).rows[0];
  if(!span?.ended_at)return null;
  // The terms the customer saw at quote time.
  const quote=(await c.query('SELECT p.wait_per_minute_minor,q.pricing_evidence,q.request FROM quotes q JOIN pricing_policies p ON p.id=q.policy_id WHERE q.id=$1',[s.quote_id])).rows[0];
  const terms=quote?.pricing_evidence?.waitingTerms;
  if(!terms?.enabled)return null;
  const place=quote.request[stop==='pickup'?'pickup':'destination'];
  const stay=(await c.query(`SELECT min(observed_at) AS started_at,count(*)::int AS samples,extract(epoch FROM $3::timestamptz-min(observed_at))::int AS seconds
    FROM (SELECT observed_at,inside,max(observed_at) FILTER (WHERE NOT inside) OVER () AS left_at
      FROM (SELECT observed_at,ST_DWithin(position,ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,75) AS inside
        FROM rider_location_samples WHERE rider_id=$1 AND observed_at>=$2 AND observed_at<=$3 AND accuracy_m<=50) fixes) marked
    WHERE inside AND (left_at IS NULL OR observed_at>left_at)`,[s.rider_id,span.arrived_at,span.ended_at,place.longitude,place.latitude])).rows[0];
  if(!stay?.started_at||stay.samples<2)return null;
  const shared=await c.query(`SELECT 1 FROM shipment_waiting_charges w JOIN shipments o ON o.id=w.shipment_id
    WHERE o.rider_id=$1 AND o.id<>$2 AND w.stop=$3 AND w.arrived_at<$4 AND w.ended_at>$5 LIMIT 1`,[s.rider_id,s.id,stop,span.ended_at,stay.started_at]);
  if(shared.rowCount)return null;
  const seconds=Number(stay.seconds);
  const feeMinor=waitingFeeMinor(seconds,Number(quote.pricing_evidence?.waitPerMinuteMinor??quote.wait_per_minute_minor??0),terms);
  if(!feeMinor)return null;
  const collection=s.payment_method==='CASH'?'collect_cash':'not_collected';
  await c.query('INSERT INTO shipment_waiting_charges(shipment_id,stop,arrived_at,ended_at,waited_seconds,fee_minor,collection) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[s.id,stop,stay.started_at,span.ended_at,seconds,feeMinor,collection]);
  if(collection==='collect_cash')await c.query("INSERT INTO notification_jobs(id,recipient_id,kind,payload) VALUES($1,$2,'waiting_fee',$3) ON CONFLICT(id) DO NOTHING",[`waiting:${s.id}:${stop}`,s.customer_id,JSON.stringify({shipmentId:s.id,title:'Waiting fee',body:`GH₵${(feeMinor/100).toFixed(2)} for ${Math.ceil(seconds/60)} min waiting at ${stop==='pickup'?'pickup':'delivery'}. Report a problem on this delivery if it looks wrong.`})]);
  return {feeMinor,waitedSeconds:seconds,collection};
 }
 async function cancellationTerms(c,s){
  const paidMinor=s.paid?await confirmedPaymentMinor(c,s.id):0;
  let feeMinor=0,freeSecondsLeft=null;
  if(s.state==='RIDER_ASSIGNED'&&s.paid){
   const accepted=(await c.query("SELECT extract(epoch FROM now()-accepted_at)::int AS seconds FROM dispatch_offers WHERE shipment_id=$1 AND rider_id=$2 AND status='accepted' ORDER BY accepted_at DESC LIMIT 1",[s.id,s.rider_id])).rows[0];
   freeSecondsLeft=Math.max(0,envInt(process.env.CANCEL_FREE_SECONDS,300,0)-Number(accepted?.seconds??0));
   if(freeSecondsLeft===0)feeMinor=Math.min(envInt(process.env.CANCEL_FEE_MINOR,500,0),Number(s.amount_minor)-Number(s.commission_minor));
  }
  return {canCancel:['AWAITING_PAYMENT','AWAITING_ASSIGNMENT','RIDER_ASSIGNED'].includes(s.state),feeMinor,refundMinor:Math.max(0,paidMinor-feeMinor),freeSecondsLeft};
 }
 /** A failed parcel is skipped, so it cannot hold up another customer's parcel on the same bike. */
 async function nextOpenStop(c,stops){
  const failed=new Set((await c.query("SELECT id FROM shipments WHERE id=ANY($1::uuid[]) AND state IN ('FAILED','RETURN_REQUESTED')",[[...new Set(stops.map(s=>s.shipmentId))]])).rows.map(r=>r.id));
  return stops.find(s=>!failed.has(s.shipmentId));
 }
 /** A provider that answers without accepting the message counts as a failure. */
 async function sendSms(message){const result=await sms.send(message);if(result?.accepted===false)throw Error('SMS not accepted');return result;}
 async function rider(c,actor){
  if(actor.custodyOnly){const held=(await c.query('SELECT * FROM riders WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];check(held,403,'Rider required');return held;}
  // Lock company before rider, serializing verification with company suspension.
  const pre=(await c.query('SELECT company_id FROM riders WHERE id=$1',[actor.id])).rows[0];
  check(pre,403,'Rider required');
  if(pre.company_id)check((await c.query("SELECT id FROM companies WHERE id=$1 AND status='approved' FOR UPDATE",[pre.company_id])).rowCount,403,'Company not approved');
  const r=(await c.query("SELECT * FROM riders WHERE id=$1 AND status='approved' FOR UPDATE",[actor.id])).rows[0];
  check(r,403,'Approved rider required');return r;
 }
 async function locked(c,sid){uuid.parse(sid);const s=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[sid])).rows[0];check(s,404,'Shipment not found');return s;}
 async function access(c,actor,s){
  if(s.customer_id===actor.id||s.rider_id===actor.id)return;
  if(s.company_id&&(await c.query('SELECT 1 FROM companies WHERE id=$1 AND owner_id=$2',[s.company_id,actor.id])).rowCount)return;
  await permission(c,actor,'shipments:read');
 }
 async function requireVerifiedPhone(c,actor){
  const r=(await c.query('SELECT phone_verified_at FROM users WHERE id=$1',[actor.id])).rows[0];
  check(r?.phone_verified_at,403,'Verify your registered phone number before using delivery services');
 }
 // Both legacy OTP and rider-confirmed handovers share one atomic settlement and custody path.
 // No financial release, restaurant settlement, or cash guard is skipped.
 async function applyHandover(c,actor,s,sid,purpose,source){
   if(purpose==='return'){
    await c.query("UPDATE shipments SET state='RETURNED' WHERE id=$1",[sid]);
    const returning=(await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE',[actor.id])).rows[0];
    if(returning)await c.query('UPDATE rider_dispatch_plans SET stops=$2,revision=revision+1,updated_at=now() WHERE rider_id=$1',[actor.id,JSON.stringify(removeShipment(returning.stops,sid))]);
    await c.query('DELETE FROM dispatch_commitments WHERE shipment_id=$1',[sid]);
    await c.query('DELETE FROM locations WHERE shipment_id=$1',[sid]);
    await settleReturnedParcel(c,s);
    await audit(c,actor.id,'return.verified',sid);await event(c,sid,'RETURNED');
    return {ok:true};
   }
   // Every parcel requires a separate, auditable physical custody event. Advancing one stop never advances another.
   const plan=(await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE',[actor.id])).rows[0];
   if(plan){const updated=removeStop(plan.stops,sid,purpose==='pickup'?'pickup':'dropoff');
    check(updated.length===plan.stops.length-1,409,'Route manifest stop missing');
    await c.query('UPDATE rider_dispatch_plans SET stops=$2,revision=revision+1,updated_at=now() WHERE rider_id=$1',[actor.id,JSON.stringify(updated)]);
   }
   if(purpose==='pickup'){
    if(s.payment_method==='CASH'&&s.cash_payer==='sender')check(await senderCashCollectedInFull(c,sid,s.amount_minor),409,'Full sender cash collection required before normal pickup; report shortfall and use dispute/exception flow');
    await c.query("UPDATE shipments SET state='PICKUP_VERIFIED' WHERE id=$1",[sid]);
    await c.query("UPDATE food_orders SET state='IN_TRANSIT', updated_at=now() WHERE shipment_id=$1 AND state IN ('ACCEPTED','PREPARING','READY_FOR_PICKUP')",[sid]);
    await c.query(
     `INSERT INTO locations(shipment_id,rider_id,latitude,longitude,updated_at)
      SELECT $1,$2,ST_Y(current_position::geometry),ST_X(current_position::geometry),COALESCE(position_at,now())
      FROM riders WHERE id=$2 AND current_position IS NOT NULL
      ON CONFLICT(shipment_id) DO UPDATE SET rider_id=EXCLUDED.rider_id,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,updated_at=EXCLUDED.updated_at`,
     [sid,actor.id]
    );
   }
   else {
    if(s.payment_method==='CASH'){
     const collection=await cashCollectionFor(c,sid,actor.id);
     check(collection&&collection.reported_status==='reported_full'&&Number(collection.reported_minor)===Number(s.amount_minor),409,'Full cash collection report required for normal handover. Open a payment dispute or exception/return flow for unpaid or partial cash.');
    }else check(s.paid,409,'Digital payment must be verified');
    await c.query("UPDATE shipments SET state='COMPLETED',completed_at=now() WHERE id=$1",[sid]);
    await c.query('DELETE FROM locations WHERE shipment_id=$1',[sid]);
    const fo=(await c.query('SELECT * FROM food_orders WHERE shipment_id=$1 FOR UPDATE',[sid])).rows[0];
    if(fo){
     const food=fo;
     await requireFoodPayment(c,food);
     await c.query("UPDATE food_orders SET state='DELIVERED', payment_status='PAID', completed_at=now(), updated_at=now() WHERE id=$1",[fo.id]);
     const grossSales=Number(fo.subtotal_minor);
     const commBps=Number(fo.food_commission_bps);
     const commMinor=Number(fo.food_commission_minor);
     const restDiscount=Math.min(Number(fo.restaurant_funded_discount_minor||0),Math.max(0,grossSales-commMinor));
     const elesendSubsidy=Number(fo.elesend_funded_discount_minor||0);
     const netPayable=Math.max(0,grossSales-restDiscount-commMinor);
     const commBasis=fo.commission_calculation_basis||'gross_subtotal';
     const commBase=Number(fo.commission_base_minor??grossSales);
     await accrueRestaurantSettlement(c,{orderId:fo.id,restaurantId:fo.restaurant_id,grossSales,restDiscount,elesendSubsidy,commBps,commMinor,netPayable,commBasis,commBase,commissionSnapshot:fo.commission_snapshot,promotionSnapshot:fo.promotion_snapshot});
     await promotionEngine(db).finalizeOrderPromotions(c,fo.id);
    }
    await recordFinancialEntry(c,{shipment:{...s,id:sid},beneficiaryId:s.company_id??actor.id});
    // One settlement path: exactly-once commission/earnings posting plus automatic debt recovery,
    // in the same locked, auditable completion transaction.
    await settleCompletedDelivery(c,s);
   }
   const waitingFee=await chargeWaiting(c,s,purpose);
   await audit(c,actor.id,purpose+(source==='otp'?'.verified':'.rider_confirmed'),sid);await event(c,sid,purpose==='delivery'?'completed':'pickup_verified');return {ok:true,...(waitingFee?{waitingFee}:{})};
 }
 async function assertAtDropoff(c,actor,s){
  const request=(await c.query('SELECT request FROM quotes WHERE id=$1',[s.quote_id])).rows[0]?.request;
  const dest=request?.destination;
  const latitude=Number(dest?.latitude),longitude=Number(dest?.longitude);
  check(Number.isFinite(latitude)&&Number.isFinite(longitude),409,'This delivery has no drop-off point');
  const fix=(await c.query(`SELECT ST_Y(current_position::geometry) AS latitude,ST_X(current_position::geometry) AS longitude,
    EXTRACT(EPOCH FROM (now()-position_at)) AS age_seconds FROM riders WHERE id=$1`,[actor.id])).rows[0];
  const age=Number(fix?.age_seconds);
  check(fix?.latitude!=null&&fix.longitude!=null&&Number.isFinite(age)&&age>=-15&&age<=DELIVERY_HANDOVER_MAX_AGE_SECONDS,409,'Share a fresh GPS fix before completing this delivery');
  const metres=haversine({latitude:Number(fix.latitude),longitude:Number(fix.longitude)},{latitude,longitude});
  check(metres<=DELIVERY_HANDOVER_RADIUS_M,409,'You are too far from the drop-off to complete this delivery');
 }
 async function handover(actor,sid,input){
  const v=z.object({kind:z.enum(['pickup','delivery']),confirmed:z.literal(true)}).strict().parse(input);
  return db.tx(async c=>{
   await rider(c,actor);
   const s=await locked(c,sid);
   check(s.rider_id===actor.id,403,'Only the assigned rider may confirm a handover');
   check(s.verification_authority==='elesend',409,'External verification not enabled');
   const finishedState={pickup:'PICKUP_VERIFIED',delivery:'COMPLETED',return:'RETURNED'}[v.kind];
   if(s.state===finishedState){
    const prior=(await c.query('SELECT 1 FROM shipment_handover_events WHERE shipment_id=$1 AND rider_id=$2 AND kind=$3',[sid,actor.id,v.kind])).rowCount;
    if(prior)return {ok:true,duplicate:true,state:finishedState};
   }
   const eligible={pickup:['RIDER_ASSIGNED'],delivery:['PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP']};
   check(eligible[v.kind].includes(s.state),409,'Shipment not eligible for this handover');
   const manifest=(await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE',[actor.id])).rows[0];
   if(manifest?.stops?.length){
    const next=await nextOpenStop(c,manifest.stops);
    check(next?.shipmentId===sid&&next?.kind===(v.kind==='pickup'?'pickup':'dropoff'),409,'Complete the next route stop first');
   }
   if(v.kind==='delivery')await assertAtDropoff(c,actor,s);
   if(v.kind==='delivery'&&s.state==='PICKUP_VERIFIED')await c.query("UPDATE shipments SET state='IN_TRANSIT' WHERE id=$1",[sid]);
   // Capture actual server time and the rider's most recent observed position without inventing GPS.
   await c.query(`INSERT INTO shipment_handover_events(shipment_id,rider_id,kind,confirmed_at,position,position_at,accuracy_m)
    SELECT $1,r.id,$2,now(),r.current_position,r.position_at,r.position_accuracy_m FROM riders r WHERE r.id=$3
    ON CONFLICT(shipment_id,kind) DO NOTHING`,[sid,v.kind,actor.id]);
   check((await c.query('SELECT 1 FROM shipment_handover_events WHERE shipment_id=$1 AND rider_id=$2 AND kind=$3',[sid,actor.id,v.kind])).rowCount,409,'Handover evidence mismatch');
   return applyHandover(c,actor,s,sid,v.kind,'rider_reported');
  });
 }

 return {
 async acceptTerms(actor,input){const v=z.object({termsVersion:z.string().trim().min(1).max(40)}).strict().parse(input);check(actor?.id&&actor.kind!=='admin',403,'Sign in to accept the terms');
  await db.query('UPDATE users SET terms_version=$2,terms_accepted_at=now() WHERE id=$1 AND terms_accepted_at IS NULL',[actor.id,v.termsVersion]);
  const row=(await db.query('SELECT terms_version FROM users WHERE id=$1',[actor.id])).rows[0];
  return {termsVersion:row?.terms_version??null,accepted:Boolean(row?.terms_version)};
 },
 async phoneStatus(actor){const u=(await db.query('SELECT phone,phone_verified_at FROM users WHERE id=$1',[actor.id])).rows[0];check(u,401);return {phone:u.phone,verified:!!u.phone_verified_at};},
 async phoneChallenge(actor){check(sms&&typeof sms.send==='function',503,'Phone SMS verification unavailable');
  check(['customer','business','rider','company'].includes(actor.kind),403);
  // Requests that would send nothing should not use up the number's allowance.
  const current=(await db.query('SELECT phone,phone_verified_at FROM users WHERE id=$1',[actor.id])).rows[0];
  check(current&&!current.phone_verified_at,409,'Phone already verified or account unavailable');
  check(!(await db.query('SELECT 1 FROM account_phone_challenges WHERE user_id=$1 AND expires_at>now() AND consumed_at IS NULL',[actor.id])).rowCount,409,'A phone verification code is already active');
  await limitAccountSms(db,current.phone);
  const cid=id(),code=newCode(),to=await db.tx(async c=>{
   const u=(await c.query('SELECT phone,phone_verified_at FROM users WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];
   check(u&&!u.phone_verified_at,409,'Phone already verified or account unavailable');
   check(!(await c.query('SELECT 1 FROM account_phone_challenges WHERE user_id=$1 AND expires_at>now() AND consumed_at IS NULL',[actor.id])).rowCount,409,'A phone verification code is already active');
   const digest=mac(otpKey,['account-phone-v1',cid,actor.id,u.phone,code]);
   await c.query("INSERT INTO account_phone_challenges(id,user_id,phone,digest,expires_at) VALUES($1,$2,$3,$4,now()+interval '5 minutes')",[cid,actor.id,u.phone,digest]);
   await audit(c,actor.id,'auth.phone_challenge_requested',actor.id);return u.phone;
  });
  try{await sendSms({phone:to,code,purpose:'account',challengeId:cid});
   await db.tx(async c=>{
    const u=(await c.query('SELECT phone,phone_verified_at FROM users WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];
    check(u?.phone===to&&!u.phone_verified_at,409,'Phone verification is no longer required');
    check((await c.query('UPDATE account_phone_challenges SET sent=true WHERE id=$1 AND user_id=$2 AND expires_at>now() AND consumed_at IS NULL RETURNING id',[cid,actor.id])).rowCount,409,'Phone challenge expired before provider acceptance');
   });
  }catch{
   await db.tx(async c=>{await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor.id]);await c.query('UPDATE account_phone_challenges SET expires_at=now() WHERE id=$1 AND sent=false',[cid]);});
   check(false,503,'Phone verification message unavailable');
  }
  return {challengeId:cid,expiresInSeconds:300};
 },
 async verifyPhone(actor,input){
  check(['customer','business','rider','company'].includes(actor.kind),403);
  const v=z.object({challengeId:uuid,code:z.string().regex(/^\d{6}$/)}).strict().parse(input);
  const result=await db.tx(async c=>{
   const u=(await c.query('SELECT phone,phone_verified_at FROM users WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];
   check(u&&!u.phone_verified_at,409,'Phone already verified or account unavailable');
   const ch=(await c.query('SELECT *,expires_at>now() AS live FROM account_phone_challenges WHERE id=$1 AND user_id=$2 FOR UPDATE',[v.challengeId,actor.id])).rows[0];
   check(ch&&ch.sent&&ch.live&&!ch.consumed_at&&ch.attempts<5&&ch.phone===u.phone,409,'Phone verification challenge unavailable');
   if(!equal(ch.digest,mac(otpKey,['account-phone-v1',ch.id,actor.id,u.phone,v.code]))){
    const nextAttempts=ch.attempts+1;
    await c.query('UPDATE account_phone_challenges SET attempts=$2,expires_at=CASE WHEN $2>=5 THEN now() ELSE expires_at END WHERE id=$1',[ch.id,nextAttempts]);
    await audit(c,actor.id,'auth.phone_verification_rejected',actor.id);return {invalid:true};
   }
   await c.query('UPDATE account_phone_challenges SET consumed_at=now() WHERE id=$1',[ch.id]);
   await c.query('UPDATE users SET phone_verified_at=now() WHERE id=$1',[actor.id]);
   await audit(c,actor.id,'auth.phone_verified',actor.id);return {verified:true};
  });
  check(!result.invalid,400,'Incorrect verification code');return result;
 },
 async passwordRecoveryChallenge(input){
  check(sms&&typeof sms.send==='function',503,'Password recovery SMS unavailable');
  const v=z.object({phone:z.string().max(30)}).strict().parse(input);
  const p=phone(v.phone);
  await limitAccountSms(db,p);
  const cid=id(),code=newCode();
  const target=await db.tx(async c=>{
   const u=(await c.query('SELECT id,phone,kind FROM users WHERE phone=$1 FOR UPDATE',[p])).rows[0];
   if(!u||u.kind==='admin'){
    mac(otpKey,['account-recovery-v1',cid,u?.id||'00000000-0000-0000-0000-000000000000',p,code]);
    if(u?.kind==='admin')await audit(c,u.id,'auth.password_recovery_blocked_admin',u.id);
    return null;
   }
   await c.query('UPDATE account_recovery_challenges SET expires_at=now() WHERE user_id=$1 AND consumed_at IS NULL AND expires_at>now()',[u.id]);
   const digest=mac(otpKey,['account-recovery-v1',cid,u.id,u.phone,code]);
   await c.query("INSERT INTO account_recovery_challenges(id,user_id,phone,digest,expires_at) VALUES($1,$2,$3,$4,now()+interval '5 minutes')",[cid,u.id,u.phone,digest]);
   await audit(c,u.id,'auth.password_recovery_requested',u.id);
   return {userId:u.id,phone:u.phone};
  });
  if(target){
   try{
    await sendSms({phone:target.phone,code,purpose:'account_recovery',challengeId:cid});
    await db.tx(async c=>{
     check((await c.query('UPDATE account_recovery_challenges SET sent=true WHERE id=$1 AND user_id=$2 AND expires_at>now() AND consumed_at IS NULL RETURNING id',[cid,target.userId])).rowCount,409,'Recovery challenge expired before SMS acceptance');
    });
   }catch{
    // Keep public response uniform during SMS transport failures; expire unsent challenge and record privately.
    await db.tx(async c=>{
     await c.query('UPDATE account_recovery_challenges SET expires_at=now() WHERE id=$1 AND sent=false',[cid]);
     await c.query("INSERT INTO notification_jobs(id,recipient_id,kind,payload) VALUES($1,$2,'account_recovery_sms_failed',$3) ON CONFLICT(id) DO NOTHING",['pw-rec-fail:'+cid,target.userId,JSON.stringify({challengeId:cid,purpose:'account_recovery'})]);
     await audit(c,target.userId,'auth.password_recovery_sms_failed',cid);
    }).catch(()=>{});
   }
  }
  return {challengeId:cid,expiresInSeconds:300};
 },
 async resetPassword(input){
  const v=z.object({phone:z.string().max(30),challengeId:uuid,code:z.string().regex(/^\d{6}$/),newPassword:z.string().min(12).max(128)}).strict().parse(input);
  const p=phone(v.phone);
  await limit(db,'pw-reset:'+hash(p),10,900);
  assertAcceptablePassword(v.newPassword,{phone:v.phone});
  const pw=await passwordHash(v.newPassword);
  const result=await db.tx(async c=>{
   const u=(await c.query('SELECT id,phone,kind FROM users WHERE phone=$1 FOR UPDATE',[p])).rows[0];
   const ch=u&&u.kind!=='admin'
    ?(await c.query('SELECT *,expires_at>now() AS live FROM account_recovery_challenges WHERE id=$1 AND user_id=$2 FOR UPDATE',[v.challengeId,u.id])).rows[0]
    :null;
   const dummyDigest=mac(otpKey,['account-recovery-v1',v.challengeId,u?.id||'00000000-0000-0000-0000-000000000000',p,'000000']);
   const candidateDigest=mac(otpKey,['account-recovery-v1',ch?.id||v.challengeId,u?.id||'00000000-0000-0000-0000-000000000000',u?.phone||p,v.code]);
   const codeMatches=equal(ch?.digest||dummyDigest,candidateDigest);
   if(!u||u.kind==='admin'){
    if(u?.kind==='admin')await audit(c,u.id,'auth.password_reset_blocked_admin',u.id);
    return {invalid:true};
   }
   if(!ch||!ch.sent||!ch.live||ch.consumed_at||ch.attempts>=5||ch.phone!==u.phone){
    await audit(c,u.id,'auth.password_recovery_rejected',u.id);
    return {invalid:true};
   }
   if(!codeMatches){
    const nextAttempts=ch.attempts+1;
    await c.query('UPDATE account_recovery_challenges SET attempts=$2,expires_at=CASE WHEN $2>=5 THEN now() ELSE expires_at END WHERE id=$1',[ch.id,nextAttempts]);
    await audit(c,u.id,'auth.password_recovery_rejected',u.id);
    return {invalid:true};
   }
   await c.query('UPDATE account_recovery_challenges SET consumed_at=now() WHERE id=$1',[ch.id]);
   await c.query('UPDATE users SET password_hash=$2,phone_verified_at=COALESCE(phone_verified_at,now()) WHERE id=$1',[u.id,pw]);
   const revoked=await c.query('DELETE FROM sessions WHERE user_id=$1',[u.id]);
   await c.query('UPDATE user_push_tokens SET active=false,session_token_hash=NULL,updated_at=now() WHERE user_id=$1 AND active=true',[u.id]);
   // Whoever had the old password may have made API keys or a webhook to keep access, so those go too.
   const revokedKeys=await c.query('UPDATE api_clients SET revoked_at=now() WHERE owner_id=$1 AND revoked_at IS NULL',[u.id]);
   await c.query('DELETE FROM api_webhooks WHERE owner_id=$1',[u.id]);
   disconnectRealtimeUser(u.id,'password_reset');
   await audit(c,u.id,'auth.password_reset_completed',u.id);
   return {ok:true,revokedSessions:revoked.rowCount,revokedApiKeys:revokedKeys.rowCount};
  });
  check(!result.invalid,400,'Incorrect or expired recovery code');
  return result;
 },
 async registerPushToken(actor,input,{sessionToken=null}={}){
  check(actor?.id,401,'Authentication required');
  const v=z.object({
   token:z.string().trim().min(8).max(512).optional(),
   pushToken:z.string().trim().min(8).max(512).optional(),
   platform:z.enum(['android','ios','expo','fcm','apns','web']).default('android'),
   appScope:z.enum(['rider','customer','restaurant']).optional(),
   channelId:z.string().trim().min(2).max(120).default('elesend-rider-offers'),
   deviceId:z.string().trim().max(160).optional(),
   installationId:z.string().trim().max(160).optional(),
   appState:z.enum(['active','background','inactive']).default('active'),
   batterySaverEnabled:z.boolean().default(false),
   backgroundLocationEnabled:z.boolean().default(true)
  }).strict().parse(input);
  const rawToken=v.token||v.pushToken;
  check(rawToken,400,'Push token is required');
  const scope=v.appScope||(actor.kind==='rider'?'rider':actor.kind==='business'?'restaurant':'customer');
  const installationId=v.deviceId||v.installationId||null;
  const sessionTokenHash=typeof sessionToken==='string'&&sessionToken.length===64
   ?hash(sessionToken)
   :(actor.sessionTokenHash??null);
  return db.tx(async c=>{
   // Serialize concurrent registrations for the same push token or installation and
   // atomically transfer ownership in a single UNIQUE(push_token) upsert so one device
   // can never be linked to two accounts simultaneously.
   const lockKeys=[`push-token:${rawToken}`];
   if(installationId)lockKeys.push(`push-device:${scope}:${installationId}`);
   lockKeys.sort();
   for(const key of lockKeys){
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[key]);
   }
   if(installationId){
    await c.query(
     `DELETE FROM user_push_tokens
       WHERE app_scope = $1
         AND device_id = $2
         AND push_token <> $3`,
     [scope,installationId,rawToken]
    );
   }
   const row=(await c.query(
    `INSERT INTO user_push_tokens(id,user_id,platform,app_scope,push_token,channel_id,device_id,session_token_hash,app_state,battery_saver_enabled,background_location_enabled,active,last_seen_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,now(),now())
     ON CONFLICT(push_token) DO UPDATE
     SET user_id=EXCLUDED.user_id,
         platform=EXCLUDED.platform,
         app_scope=EXCLUDED.app_scope,
         channel_id=EXCLUDED.channel_id,
         device_id=CASE
           WHEN user_push_tokens.user_id=EXCLUDED.user_id
           THEN COALESCE(EXCLUDED.device_id,user_push_tokens.device_id)
           ELSE EXCLUDED.device_id
         END,
         session_token_hash=CASE
           WHEN user_push_tokens.user_id=EXCLUDED.user_id
           THEN COALESCE(EXCLUDED.session_token_hash,user_push_tokens.session_token_hash)
           ELSE EXCLUDED.session_token_hash
         END,
         app_state=EXCLUDED.app_state,
         battery_saver_enabled=EXCLUDED.battery_saver_enabled,
         background_location_enabled=EXCLUDED.background_location_enabled,
         active=true,
         last_seen_at=now(),
         updated_at=now()
     RETURNING id,user_id,platform,app_scope,push_token,channel_id,device_id,session_token_hash,app_state,battery_saver_enabled,background_location_enabled,active,last_seen_at`,
    [id(),actor.id,v.platform,scope,rawToken,v.channelId,installationId,sessionTokenHash,v.appState,v.batterySaverEnabled,v.backgroundLocationEnabled]
   )).rows[0];
   return {ok:true,registration:row};
  });
 },
 async listPushTokens(actor){
  check(actor?.id,401,'Authentication required');
  return (await db.query(
   `SELECT id,platform,app_scope,push_token,channel_id,device_id,app_state,battery_saver_enabled,background_location_enabled,active,last_seen_at
      FROM user_push_tokens t
     WHERE ${ACTIVE_PUSH_TOKEN_FILTER}
     ORDER BY t.updated_at DESC`,
   [actor.id]
  )).rows;
 },
 async register(input){const v=registration.parse(input);const uid=id(),p=phone(v.phone);assertAcceptablePassword(v.password,{phone:p});const pw=await passwordHash(v.password);
  await db.tx(async c=>{await c.query('INSERT INTO users(id,phone,password_hash,kind) VALUES($1,$2,$3,$4)',[uid,p,pw,v.kind]);
   if(v.kind==='rider'){
    const type=v.vehicle??'motorcycle';const details=v.vehicleDetails??v.car;check(['bicycle','motorcycle'].includes(type)||details,400,'Vehicle registration details required');
    await c.query('INSERT INTO riders(id,vehicle,max_weight_g,display_name) VALUES($1,$2,$3,$4)',[uid,type,v.maxWeightG??20000,v.name?v.name.trim().slice(0,60):null]);
    await ensureCommissionAccount(c,uid);
    if(!['bicycle','motorcycle'].includes(type))await registerVehicleInTx(c,uid,{vehicle:type,maxWeightG:v.maxWeightG??20000,vehicleDetails:details});
   }
   if(v.kind==='company'){check(v.name,400,'Company name required');await c.query('INSERT INTO companies(id,owner_id,name,services) VALUES($1,$2,$3,$4)',[id(),uid,v.name,[...new Set(v.services??['riders'])]]);}
   await c.query('UPDATE users SET terms_version=$2,terms_accepted_at=now() WHERE id=$1',[uid,v.termsVersion]);
   await audit(c,uid,'registered',uid);
  });return {id:uid,kind:v.kind,phone:p,phoneVerified:false};
 },
 async login(input,{clientIp='unknown'}={}){const v=z.object({phone:z.string().max(30),password:z.string().max(128),totpCode:z.string().regex(/^\d{6}$/).optional()}).strict().parse(input);const p=phone(v.phone);
  // Attempts are limited per source so one attacker cannot lock the real owner out of an account.
  // The higher account-wide cap still bounds guessing spread across many addresses.
  await limit(db,'login-source:'+hash(p+'|'+clientIp),10,900);await limit(db,'login:'+hash(p),100,900);
  const u=(await db.query('SELECT * FROM users WHERE phone=$1',[p])).rows[0];
  // Spend equivalent password derivation work for unknown identities.
  const ok=await passwordMatches(v.password,u?.password_hash??UNKNOWN_ACCOUNT_HASH);check(u&&ok,401,'Invalid credentials');
  const upgradedHash=passwordNeedsUpgrade(u.password_hash)?await passwordHash(v.password):null;
  const token=newToken();
  // Five wrong authenticator codes lock administrator sign-in for 15 minutes, from any address, so the
  // six-digit code cannot be worked through by someone who already has the password.
  const mfaFailures='admin-mfa-fail:'+u.id;
  if(u.kind==='admin')await assertUnderLimit(db,mfaFailures,5);
  try{return await db.tx(async c=>{
   const current=(await c.query('SELECT * FROM users WHERE phone=$1 FOR UPDATE',[p])).rows[0];
   // The password was checked above and this confirms it has not changed since, without holding a database connection through the slow check.
   check(current&&current.id===u.id&&current.password_hash===u.password_hash,401,'Invalid credentials');
   if(upgradedHash)await c.query('UPDATE users SET password_hash=$2 WHERE id=$1',[current.id,upgradedHash]);
   if(current.kind==='admin'){
    check(v.totpCode,401,'Administrator authenticator code required');
    // FOR UPDATE serializes counter consumption across concurrent mobile logins.
    const factor=(await c.query('SELECT * FROM admin_mfa_credentials WHERE user_id=$1 FOR UPDATE',[current.id])).rows[0];
    check(factor,403,'Administrator MFA provisioning required');
    const secret=decryptAdminSecret(factor.secret_encrypted,current.id,adminMfaKey);
    const step=verifyAdminTotp(secret,v.totpCode,{lastUsedStep:factor.last_used_step});
    if(step===null)throw Object.assign(Error('Invalid or reused authenticator code'),{status:401,adminMfaFailed:true});
    await c.query('UPDATE admin_mfa_credentials SET last_used_step=$2 WHERE user_id=$1',[current.id,step]);
    await c.query("INSERT INTO sessions(token_hash,user_id,expires_at,admin_mfa_verified) VALUES($1,$2,now()+interval '4 hours',true)",[hash(token),current.id]);
    await audit(c,current.id,'auth.admin_mfa_login',current.id);
    return {token,user:{id:current.id,kind:current.kind}};
   }
   await c.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')",[hash(token),current.id]);
   const review=current.kind==='rider'?(await c.query('SELECT status,company_id FROM riders WHERE id=$1',[current.id])).rows[0]:current.kind==='company'?(await c.query('SELECT status FROM companies WHERE owner_id=$1',[current.id])).rows[0]:null;
   return {token,user:{id:current.id,kind:current.kind,...(review?.status==='pending'?{awaitingApproval:true}:{})}};
  });}catch(e){
   // Counted outside the sign-in transaction, which the failure rolls back.
   if(e.adminMfaFailed){await recordAttempt(db,mfaFailures,900);securityEvent('admin_mfa_failed',{userId:u.id});}
   throw e;
  }
 },
 async authenticate(token,{allowPending=false}={}){check(token&&typeof token==='string'&&token.length===64,401,'Authentication required');const tokenHash=hash(token);const u=(await db.query("SELECT u.id,u.kind,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND (u.kind<>'admin' OR (s.admin_mfa_verified=true AND s.last_seen_at>now()-interval '30 minutes'))",[tokenHash])).rows[0];check(u,401,'Session expired or administrator MFA required');if(u.kind==='admin')await db.query("UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1 AND last_seen_at<now()-interval '1 minute'",[tokenHash]);
  // Anyone using the app stays signed in. The session ends after 30 days without use.
  else await db.query("UPDATE sessions SET last_seen_at=now(),expires_at=now()+interval '30 days' WHERE token_hash=$1 AND last_seen_at<now()-interval '1 hour'",[tokenHash]);
  let awaitingApproval=false,custodyOnly=false;if(u.kind==='rider'){const r=(await db.query("SELECT r.status, c.status AS company_status, r.company_id FROM riders r LEFT JOIN companies c ON c.id=r.company_id WHERE r.id=$1",[u.id])).rows[0];awaitingApproval=allowPending&&r?.status==='pending';if(!awaitingApproval&&!(r&&r.status==='approved'&&(!r.company_id||r.company_status==='approved'))){
    // A rider stopped while carrying a parcel can still finish that delivery, and take no new work.
    custodyOnly=allowPending&&Boolean(r)&&(await db.query("SELECT 1 FROM shipments WHERE rider_id=$1 AND state IN ('PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED') LIMIT 1",[u.id])).rowCount>0;
    check(custodyOnly,403,'Rider account suspended or not approved');
   }}if(u.kind==='company'){const c=(await db.query("SELECT status FROM companies WHERE owner_id=$1",[u.id])).rows[0];awaitingApproval=allowPending&&c?.status==='pending';check(awaitingApproval||c?.status==='approved',403,'Company suspended or not approved');}return {...u,...(awaitingApproval?{awaitingApproval:true}:{}),...(custodyOnly?{custodyOnly:true}:{}),sessionTokenHash:tokenHash};},
 async logout(token,input={},actor=null){
  const tokenHash=typeof token==='string'&&token.length>0?hash(token):(actor?.sessionTokenHash??null);
  const deviceId=typeof input?.deviceId==='string'&&input.deviceId.trim().length>0
   ?input.deviceId.trim()
   :(typeof input?.installationId==='string'&&input.installationId.trim().length>0?input.installationId.trim():null);
  const pushToken=typeof input?.pushToken==='string'&&input.pushToken.trim().length>0
   ?input.pushToken.trim()
   :(typeof input?.token==='string'&&input.token.trim().length>0?input.token.trim():null);
  return db.tx(async c=>{
   const deleted=tokenHash?(await c.query('DELETE FROM sessions WHERE token_hash=$1 RETURNING user_id',[tokenHash])).rows[0]:null;
   const uid=deleted?.user_id||actor?.id||null;
   await c.query(
    `UPDATE user_push_tokens
        SET active = false,
            session_token_hash = NULL,
            updated_at = now()
      WHERE active = true
        AND (
          ($1::text IS NOT NULL AND session_token_hash = $1)
          OR ($2::uuid IS NOT NULL AND user_id = $2 AND (
               session_token_hash IS NULL
               OR ($3::text IS NOT NULL AND device_id = $3)
               OR ($4::text IS NOT NULL AND push_token = $4)
               OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = $2 AND s.expires_at > now())
             ))
        )`,
    [tokenHash,uid,deviceId,pushToken]
   );
   return {ok:true};
  });
 },
 /** Removes login and contact details. Financial, audit and custody records stay, unlinked from any phone number. */
 async deleteAccount(actor,input){
  const v=z.object({password:z.string().min(1).max(128)}).strict().parse(input);
  check(actor?.id&&actor.kind!=='admin',403,'Administrator accounts are removed by another administrator');
  const stored=(await db.query('SELECT password_hash FROM users WHERE id=$1',[actor.id])).rows[0]?.password_hash;
  check(stored&&await passwordMatches(v.password,stored),401,'Incorrect password');
  return db.tx(async c=>{
   const user=(await c.query('SELECT id,kind,password_hash FROM users WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];
   check(user?.password_hash===stored,401,'Incorrect password');
   // Earned money is paid out first, because a deleted account cannot receive it.
   const unpaid=await unpaidEarningsMinor(c,actor.id);
   check(unpaid<=withdrawalFeeMinor(),409,`You have GH₵${(unpaid/100).toFixed(2)} in unpaid earnings. Withdraw or receive it before deleting your account. Earnings become available 24 hours after each delivery.`);
   check(!(await c.query("SELECT 1 FROM shipments WHERE (customer_id=$1 OR rider_id=$1 OR company_id IN (SELECT id FROM companies WHERE owner_id=$1)) AND state NOT IN ('COMPLETED','CANCELLED','RETURNED') LIMIT 1",[actor.id])).rowCount,409,'Finish or cancel your active deliveries first');
   check(!(await c.query("SELECT 1 FROM food_orders f JOIN restaurants r ON r.id=f.restaurant_id WHERE r.owner_id=$1 AND f.state NOT IN ('DELIVERED','CANCELLED','REJECTED') LIMIT 1",[actor.id])).rowCount,409,'Finish your open restaurant orders first');
   if(user.kind==='rider'){
    const debt=await debtState(c,actor.id);
    check(debt.debtMinor===0,409,'Settle your outstanding commission first');
    await c.query("UPDATE riders SET online=false,status='suspended',current_position=NULL,position_at=NULL WHERE id=$1",[actor.id]);
    await c.query('DELETE FROM rider_location_samples WHERE rider_id=$1',[actor.id]);
    await c.query("UPDATE dispatch_offers SET status='invalidated' WHERE rider_id=$1 AND status='offered'",[actor.id]);
   }else if(user.kind==='company'){
    const cos=(await c.query('SELECT id FROM companies WHERE owner_id=$1 FOR UPDATE',[actor.id])).rows;
    for(const co of cos){
     check(await companyDebtMinor(c,co.id)===0,409,'Settle your outstanding company commission first');
     await c.query("UPDATE companies SET status='suspended' WHERE id=$1",[co.id]);
     await c.query('UPDATE riders SET company_id=NULL,online=false WHERE company_id=$1',[co.id]);
    }
   }
   await c.query("UPDATE restaurants SET status='suspended' WHERE owner_id=$1",[actor.id]);
   await c.query('UPDATE api_clients SET revoked_at=now() WHERE owner_id=$1 AND revoked_at IS NULL',[actor.id]);
   await c.query('DELETE FROM api_webhooks WHERE owner_id=$1',[actor.id]);
   await shredRiderDocuments(c,actor.id);
   await shredRiderLicence(c,actor.id);
   await c.query('DELETE FROM sessions WHERE user_id=$1',[actor.id]);
   await c.query('DELETE FROM user_push_tokens WHERE user_id=$1',[actor.id]);
   await c.query('DELETE FROM account_phone_challenges WHERE user_id=$1',[actor.id]);
   await c.query('DELETE FROM account_recovery_challenges WHERE user_id=$1',[actor.id]);
   await c.query("UPDATE users SET deleted_at=now(),phone='deleted:'||id::text,password_hash='deleted',phone_verified_at=NULL WHERE id=$1",[actor.id]);
   await audit(c,actor.id,'auth.account_deleted',actor.id);
   disconnectRealtimeUser(actor.id,'account_deleted');
   return {ok:true};
  });
 },
 async setPricing(actor,input){const v=z.object({baseMinor:z.number().int().min(1).max(1000000),perKmMinor:z.number().int().min(1).max(100000),commissionBps:z.number().int().min(0).max(10000).default(1300),commissionMode:z.enum(['percentage','fixed','hybrid']).default('percentage'),commissionFixedMinor:z.number().int().min(0).max(1000000).default(0),commissionCapMinor:z.number().int().min(0).max(1000000).nullable().default(null),perMinuteMinor:z.number().int().min(0).max(100000).default(0),waitPerMinuteMinor:z.number().int().min(0).max(100000).default(0),perExtraStopMinor:z.number().int().min(0).max(1000000).default(0)}).strict().parse(input);
  return db.tx(async c=>{await permission(c,actor,'pricing:write');await c.query('SELECT pg_advisory_xact_lock(617290113)');await c.query('UPDATE pricing_policies SET active=false WHERE active AND vehicle IS NULL');const pid=id();await c.query('INSERT INTO pricing_policies(id,base_minor,per_km_minor,commission_bps,commission_mode,commission_fixed_minor,commission_cap_minor,per_minute_minor,wait_per_minute_minor,per_extra_stop_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[pid,v.baseMinor,v.perKmMinor,v.commissionBps,v.commissionMode,v.commissionFixedMinor,v.commissionCapMinor,v.perMinuteMinor,v.waitPerMinuteMinor,v.perExtraStopMinor]);await audit(c,actor.id,'pricing.created',pid);return {id:pid};});
 },
 async configureVehicleTariff(actor,input){
  const v=z.object({vehicle:z.enum(['motorcycle','car','tricycle','pickup','van','box_truck','long_vehicle','truck']),baseMinor:z.number().int().min(1).max(1000000),perKmMinor:z.number().int().min(0).max(100000),perMinuteMinor:z.number().int().min(0).max(100000).default(0),minimumMinor:z.number().int().min(0).max(100000000).default(0),rushHourEnabled:z.boolean().default(false),supplyDemandEnabled:z.boolean().default(false),commissionBps:z.number().int().min(0).max(10000).default(1300),rushHourBps:z.number().int().min(10000).max(20000).optional(),waitPerMinuteMinor:z.number().int().min(0).max(1000).optional(),trafficTimePricing:z.boolean().optional(),bookingFeeBps:z.number().int().min(0).max(3000).optional(),perExtraStopMinor:z.number().int().min(0).max(1000000).optional(),perHelperMinor:z.number().int().min(0).max(10000000).optional(),perFloorMinor:z.number().int().min(0).max(10000000).optional(),freeLoadingMinutes:z.number().int().min(0).max(240).optional()}).strict().parse(input);
  check(v.vehicle!=='long_vehicle',400,'Long vehicles use the heavy-freight pricing controls.');
  return db.tx(async c=>{await permission(c,actor,'pricing:write');await c.query('SELECT pg_advisory_xact_lock(617290113)');
   const kept=(await c.query('SELECT rush_hour_bps,wait_per_minute_minor,traffic_time_pricing,booking_fee_bps,per_extra_stop_minor,per_helper_minor,per_floor_minor,free_loading_minutes FROM pricing_policies WHERE active AND vehicle=$1',[v.vehicle])).rows[0];
   await c.query('UPDATE pricing_policies SET active=false WHERE active AND vehicle=$1',[v.vehicle]);const pid=id();
   await c.query('INSERT INTO pricing_policies(id,vehicle,base_minor,per_km_minor,per_minute_minor,minimum_minor,rush_hour_enabled,supply_demand_enabled,commission_bps,rush_hour_bps,wait_per_minute_minor,traffic_time_pricing,booking_fee_bps,per_extra_stop_minor,per_helper_minor,per_floor_minor,free_loading_minutes,is_placeholder) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,false)',[pid,v.vehicle,v.baseMinor,v.perKmMinor,v.perMinuteMinor,v.minimumMinor,v.rushHourEnabled,v.supplyDemandEnabled,v.commissionBps,v.rushHourBps??kept?.rush_hour_bps??14000,v.waitPerMinuteMinor??kept?.wait_per_minute_minor??0,v.trafficTimePricing??kept?.traffic_time_pricing??false,v.bookingFeeBps??kept?.booking_fee_bps??0,v.perExtraStopMinor??kept?.per_extra_stop_minor??0,v.perHelperMinor??kept?.per_helper_minor??0,v.perFloorMinor??kept?.per_floor_minor??0,v.freeLoadingMinutes??kept?.free_loading_minutes??5]);
   await audit(c,actor.id,'pricing.vehicle_version_created',pid);return {id:pid,...v};
  });
 },
 async getLongVehiclePricing(actor){check(actor?.kind==='admin',403);await permission(db,actor,'pricing:write');return (await db.query("SELECT * FROM long_vehicle_pricing_policies WHERE active AND vehicle='long_vehicle'")).rows[0]??null;},
 async setLongVehiclePricing(actor,input){const v=z.object({baseMinor:z.number().int().min(0).max(100000000),perKmMinor:z.number().int().min(0).max(10000000),perTonneKmMinor:z.number().int().min(0).max(10000000),minimumMinor:z.number().int().min(1).max(2147483647),commissionBps:z.number().int().min(0).max(10000),returnLegBps:z.number().int().min(0).max(10000),perHelperMinor:z.number().int().min(0).max(10000000),perFloorMinor:z.number().int().min(0).max(10000000),perExtraStopMinor:z.number().int().min(0).max(10000000),bookingFeeBps:z.number().int().min(0).max(3000),waitPerMinuteMinor:z.number().int().min(0).max(100000),freeLoadingMinutes:z.number().int().min(0).max(240)}).strict().parse(input);
  return db.tx(async c=>{await permission(c,actor,'pricing:write');await c.query('SELECT pg_advisory_xact_lock(617290113)');await c.query("UPDATE long_vehicle_pricing_policies SET active=false WHERE active AND vehicle='long_vehicle'");const pid=id();await c.query(`INSERT INTO long_vehicle_pricing_policies(id,base_minor,per_km_minor,per_tonne_km_minor,minimum_minor,commission_bps,return_leg_bps,per_helper_minor,per_floor_minor,per_extra_stop_minor,booking_fee_bps,wait_per_minute_minor,free_loading_minutes,is_placeholder,active)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,true)`,[pid,v.baseMinor,v.perKmMinor,v.perTonneKmMinor,v.minimumMinor,v.commissionBps,v.returnLegBps,v.perHelperMinor,v.perFloorMinor,v.perExtraStopMinor,v.bookingFeeBps,v.waitPerMinuteMinor,v.freeLoadingMinutes]);await audit(c,actor.id,'pricing.long_vehicle_version_created',pid);return {id:pid,vehicle:'long_vehicle',...v,is_placeholder:false,active:true};});
 },
 async vehicleTariffs(actor){check(['customer','business','company','admin'].includes(actor.kind),403);const generic=(await db.query(`SELECT p.id,p.vehicle,p.base_minor,p.per_km_minor,p.per_minute_minor,p.minimum_minor,p.rush_hour_enabled,p.is_placeholder,p.per_helper_minor,p.per_floor_minor,p.free_loading_minutes,
   vc.max_weight_g,vc.max_trip_m,vc.max_length_cm,vc.max_volume_l,vc.customer_description,vc.customer_example
   FROM pricing_policies p JOIN vehicle_capabilities vc ON vc.vehicle=p.vehicle
   WHERE p.active AND NOT p.is_placeholder AND p.vehicle IS NOT NULL AND p.vehicle<>'long_vehicle' AND vc.enabled ORDER BY p.vehicle`)).rows;
  const heavy=(await db.query(`SELECT lp.id,'long_vehicle' AS vehicle,lp.base_minor,lp.per_km_minor,0 AS per_minute_minor,lp.minimum_minor,false AS rush_hour_enabled,false AS is_placeholder,
    lp.per_helper_minor,lp.per_floor_minor,lp.free_loading_minutes,lp.per_tonne_km_minor,lp.return_leg_bps,
    vc.max_weight_g,vc.max_trip_m,vc.max_length_cm,vc.max_volume_l,vc.customer_description,vc.customer_example
    FROM long_vehicle_pricing_policies lp JOIN vehicle_capabilities vc ON vc.vehicle='long_vehicle'
    WHERE lp.active AND NOT lp.is_placeholder AND vc.enabled`)).rows;
  return [...generic,...heavy];},
 async getCargoPolicy(actor){check(actor?.kind==='admin',403);await permission(db,actor,'pricing:write');return (await db.query('SELECT liability_limit_minor,liability_terms,updated_at FROM cargo_policy_settings WHERE id=1')).rows[0];},
 async setCargoPolicy(actor,input){const v=z.object({liabilityLimitMinor:z.number().int().min(1).max(2147483647),liabilityTerms:z.string().trim().min(20).max(4000)}).strict().parse(input);return db.tx(async c=>{await permission(c,actor,'pricing:write');await c.query('UPDATE cargo_policy_settings SET liability_limit_minor=$1,liability_terms=$2,updated_by=$3,updated_at=now() WHERE id=1',[v.liabilityLimitMinor,v.liabilityTerms,actor.id]);await audit(c,actor.id,'pricing.cargo_terms_updated',actor.id);return {ok:true,...v};});},
 async getPricing(actor){check(actor?.kind==='admin',403);check((await db.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission=ANY($2::text[])",[actor.id,['pricing:write','finance:read','finance:approve','finance:configure']])).rowCount,403,'Pricing permission required');return (await db.query('SELECT * FROM pricing_policies WHERE active ORDER BY vehicle NULLS FIRST')).rows;},
 async configureCommission(actor,input){
  const v=z.object({vehicle:z.enum(['motorcycle','car','tricycle','pickup','van','box_truck','long_vehicle','truck']).nullable().optional(),commissionBps:z.number().int().min(0).max(10000),commissionMode:z.enum(['percentage','fixed','hybrid']).default('percentage'),commissionFixedMinor:z.number().int().min(0).max(1000000).default(0),commissionCapMinor:z.number().int().min(0).max(1000000).nullable().default(null)}).strict().parse(input);
  check(v.vehicle!=='long_vehicle',400,'Set long-vehicle commission in its heavy-freight tariff.');
  return db.tx(async c=>{
   await permission(c,actor,'pricing:write');await c.query('SELECT pg_advisory_xact_lock(617290113)');
   let targets;
   if(v.vehicle){targets=(await c.query('SELECT * FROM pricing_policies WHERE active AND vehicle=$1',[v.vehicle])).rows;}
   else{targets=(await c.query('SELECT * FROM pricing_policies WHERE active')).rows;}
   check(targets.length>0,404,'No active policy found');
   const created=[];
   for(const cur of targets){
    await c.query('UPDATE pricing_policies SET active=false WHERE id=$1',[cur.id]);
    const pid=id();
    await c.query('INSERT INTO pricing_policies(id,vehicle,base_minor,per_km_minor,per_minute_minor,minimum_minor,rush_hour_enabled,supply_demand_enabled,commission_bps,commission_mode,commission_fixed_minor,commission_cap_minor,wait_per_minute_minor,per_extra_stop_minor,rush_hour_bps,traffic_time_pricing,booking_fee_bps,per_helper_minor,per_floor_minor,free_loading_minutes,is_placeholder) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)',[pid,cur.vehicle,cur.base_minor,cur.per_km_minor,cur.per_minute_minor??0,cur.minimum_minor??0,cur.rush_hour_enabled??false,cur.supply_demand_enabled??false,v.commissionBps,v.commissionMode,v.commissionFixedMinor,v.commissionCapMinor,cur.wait_per_minute_minor??0,cur.per_extra_stop_minor??0,cur.rush_hour_bps??14000,cur.traffic_time_pricing??false,cur.booking_fee_bps??0,cur.per_helper_minor??0,cur.per_floor_minor??0,cur.free_loading_minutes??5,Boolean(cur.is_placeholder)]);
    await audit(c,actor.id,'pricing.commission_configured',pid);
    created.push({id:pid,vehicle:cur.vehicle,commissionBps:v.commissionBps,commissionMode:v.commissionMode,commissionFixedMinor:v.commissionFixedMinor,commissionCapMinor:v.commissionCapMinor});
   }
   return {ok:true,policies:created};
  });
 },
 async configureSurgeZone(actor,input){
  const v=z.object({name:z.string().trim().min(2).max(80),latitude:z.number().finite(),longitude:z.number().finite(),radiusM:z.number().int().min(500).max(50000),enabled:z.boolean().default(false),replaceId:uuid.optional()}).strict().parse(input);validateGhanaBoundary(v.latitude,v.longitude);
  return db.tx(async c=>{await permission(c,actor,'pricing:write');await c.query('SELECT pg_advisory_xact_lock(617290113)');
   if(v.replaceId){check((await c.query('UPDATE pricing_surge_zones SET enabled=false WHERE id=$1 RETURNING id',[v.replaceId])).rowCount,404,'Zone not found');await audit(c,actor.id,'pricing.surge_zone_retired',v.replaceId);}
   const zoneId=id();await c.query('INSERT INTO pricing_surge_zones(id,name,center,radius_m,enabled) VALUES($1,$2,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,$5,$6)',[zoneId,v.name,v.longitude,v.latitude,v.radiusM,v.enabled]);
   await audit(c,actor.id,'pricing.surge_zone_created',zoneId);return {id:zoneId,...v};
  });
 },
 async approve(actor,type,target,status){check(['riders','companies'].includes(type),400);uuid.parse(target);check(['approved','suspended','rejected'].includes(status),400);
  return db.tx(async c=>{await permission(c,actor,'verification:write');
   if(type==='riders'){
    // ELESEND's own approval is the full check, so it replaces any earlier company check.
    if(status==='approved'){await approveRiderLicence(c,target,actor.id);await approveRiderDocuments(c,target,actor.id);await approveVehicleRecord(c,target,actor.id);await c.query('UPDATE riders SET verified_by_company_id=NULL WHERE id=$1',[target]);}
    const result=await c.query('UPDATE riders SET status=$2,online=CASE WHEN $2=\'approved\' THEN online ELSE false END WHERE id=$1 RETURNING id',[target,status]);check(result.rowCount,404);
    if(status!=='approved'){
     await c.query('DELETE FROM sessions WHERE user_id = $1',[target]);disconnectRealtimeUser(target,'account_'+status);await c.query("UPDATE dispatch_offers SET status='invalidated' WHERE rider_id=$1 AND status='offered'",[target]);
     await c.query("UPDATE notification_jobs SET state='expired',lease_until=NULL WHERE recipient_id=$1 AND kind='dispatch_offer' AND state IN ('pending','sending')",[target]);
     getRedisClient().removeRiderLocation(target).catch(()=>{});
    }
   }else{
    const result=await c.query('UPDATE companies SET status=$2 WHERE id=$1 RETURNING id',[target,status]);check(result.rowCount,404);
    if(status!=='approved'){
     await c.query('DELETE FROM sessions WHERE user_id = (SELECT owner_id FROM companies WHERE id = $1) OR user_id IN (SELECT id FROM riders WHERE company_id = $1)',[target]);
     const ownerRow = (await c.query('SELECT owner_id FROM companies WHERE id = $1', [target])).rows[0];
     if (ownerRow) disconnectRealtimeUser(ownerRow.owner_id, 'company_' + status);
     const companyRiders=(await c.query('UPDATE riders SET online=false WHERE company_id=$1 RETURNING id',[target])).rows;
     await c.query("UPDATE dispatch_offers SET status='invalidated' WHERE status='offered' AND rider_id IN (SELECT id FROM riders WHERE company_id=$1)",[target]);
     await c.query("UPDATE notification_jobs SET state='expired',lease_until=NULL WHERE kind='dispatch_offer' AND state IN ('pending','sending') AND recipient_id IN (SELECT id FROM riders WHERE company_id=$1)",[target]);
     for(const cr of companyRiders){getRedisClient().removeRiderLocation(cr.id).catch(()=>{});disconnectRealtimeUser(cr.id,'company_'+status);}
    }
   }
   await audit(c,actor.id,type+'.'+status,target);return {ok:true};
  });
 },
 async availability(actor,input){const v=z.object({online:z.boolean()}).strict().parse(input);return db.tx(async c=>{const r=await rider(c,actor);
   if(v.online&&process.env.NODE_ENV==='production')await requireVerifiedPhone(c,actor);
   if(v.online&&!['bicycle','motorcycle'].includes(r.vehicle))check((await c.query(`SELECT 1 FROM rider_vehicle_registrations WHERE rider_id=$1 AND vehicle=$2 AND verification_status='approved'
     AND roadworthy_expires_on>=CURRENT_DATE AND insurance_expires_on>=CURRENT_DATE`,[actor.id,r.vehicle])).rowCount,403,'Your vehicle papers must be current and approved before you go online');
   if(v.online){const policy=(await c.query('SELECT min_licence_class FROM vehicle_capabilities WHERE vehicle=$1 AND enabled',[r.vehicle])).rows[0];check(policy,403,'This vehicle type is not available for work');check(await riderMeetsVehicleLicence(c,actor.id,policy.min_licence_class),403,'Your driver licence must be reviewed for this vehicle before you go online');}
   if(v.online){
    const rest=(await c.query('SELECT rest_until FROM riders WHERE id=$1 AND rest_until>now()',[actor.id])).rows[0];
    check(!rest,409,'You have reached your driving time limit. You can go online again after your rest');
   }
    await c.query('UPDATE riders SET online=$2,shift_started_at=CASE WHEN $2 THEN COALESCE(shift_started_at,now()) ELSE shift_started_at END,last_offline_at=CASE WHEN NOT $2 THEN now() ELSE last_offline_at END WHERE id=$1',[actor.id,v.online]);if(!v.online){await c.query("UPDATE dispatch_offers SET status='invalidated' WHERE rider_id=$1 AND status='offered'",[actor.id]);getRedisClient().removeRiderLocation(actor.id).catch(()=>{});}return v;});},
 async quote(actor,input){check(['customer','business','company'].includes(actor.kind),403);await requireAcceptedTerms(db,actor);await assertCompanyDelivery(db,actor);
  // Do not accept live bookings when an essential custody-verification provider is absent.
  if(process.env.NODE_ENV==='production'){
   check(dispatch,503,'Delivery booking paused: dispatch unavailable');
   await requireVerifiedPhone(db,actor);
  }
  await marketService(db).assertGhanaOperating();const v=quoteSchema.parse(input);v.recipientPhone=phone(v.recipientPhone);
  // A business can name who hands over parcels, so the code does not go to the account owner.
  if(v.pickupPhone){check(['business','company'].includes(actor.kind),400,'Pickup contact is for business accounts');v.pickupPhone=phone(v.pickupPhone);}
  // Companies pay through hosted checkout, which the older DIGITAL method cannot start.
  if(actor.kind==='company'&&v.paymentMethod==='DIGITAL')v.paymentMethod='MOMO';
  if(process.env.NODE_ENV==='production')check(v.vehicle,400,'Select a vehicle before requesting a fare');
  // Preserve prior API clients' implicit DIGITAL method in existing tests/migrations.
  // Native clients explicitly choose CASH/MOMO/CARD/QR. Legacy DIGITAL cannot
  // initiate public checkout or self-report payment success.
  if(v.paymentMethod!=='DIGITAL'){check(await paymentMethodEnabled(db,v.paymentMethod),503,'Payment method is not active');}
  const capability=v.vehicle?(await db.query('SELECT enabled,max_weight_g,max_trip_m,max_length_cm,max_volume_l FROM vehicle_capabilities WHERE vehicle=$1',[v.vehicle])).rows[0]:null;
  if(v.vehicle){check(capability?.enabled!==false,409,'This vehicle type is not available yet');
   if(['tricycle','pickup','van','box_truck','long_vehicle','truck'].includes(v.vehicle)){
    check(v.lengthCm&&v.volumeL,400,'Enter the load length and volume so we can match it to the right cargo vehicle.');
    check(capability?.max_length_cm&&capability?.max_volume_l,503,'This vehicle is not accepting cargo quotes yet. Staff must set its verified load length and volume limits first.');
   }
   // Quote only what this vehicle can carry; otherwise the order is paid for and no rider can take it.
   const heavier=(await db.query(`SELECT vehicle,enabled FROM vehicle_capabilities WHERE vehicle<>$1 AND max_weight_g>=$2
    AND (max_length_cm IS NULL OR $3::int IS NULL OR max_length_cm>=$3) AND (max_volume_l IS NULL OR $4::int IS NULL OR max_volume_l>=$4)
    ORDER BY max_weight_g,max_trip_m LIMIT 1`,[v.vehicle,v.weightG,v.lengthCm??null,v.volumeL??null])).rows[0];
   const largerName=heavier?(VEHICLE_LABELS[heavier.vehicle]??'a larger vehicle')+(heavier.enabled?'':' (not available yet)'):'a larger vehicle';
   check(!capability?.max_weight_g||v.weightG<=capability.max_weight_g,422,`This load is too heavy for a ${VEHICLE_LABELS[v.vehicle]??v.vehicle}. Try ${largerName} or split the load.`);
   check(!v.lengthCm||!capability?.max_length_cm||v.lengthCm<=capability.max_length_cm,422,`This load is too long for a ${VEHICLE_LABELS[v.vehicle]??v.vehicle}. Try ${largerName} or split the load.`);
   check(!v.volumeL||!capability?.max_volume_l||v.volumeL<=capability.max_volume_l,422,`This load is too large for a ${VEHICLE_LABELS[v.vehicle]??v.vehicle}. Try ${largerName} or split the load.`);}
  for(const location of [v.pickup,v.destination])validateGhanaBoundary(location.latitude,location.longitude);
  const longVehicle=v.vehicle==='long_vehicle';
  const p=(await db.query('SELECT * FROM pricing_policies WHERE active AND vehicle IS NOT DISTINCT FROM $1',[v.vehicle??null])).rows[0];
  const longPolicy=longVehicle?(await db.query("SELECT * FROM long_vehicle_pricing_policies WHERE active AND vehicle='long_vehicle'")).rows[0]:null;
  check(p&&(longVehicle?Boolean(longPolicy&&!longPolicy.is_placeholder):!p.is_placeholder),503,longVehicle?'Long-vehicle heavy-freight rates are not configured yet. Please choose another vehicle or contact support.':'This vehicle price is being prepared. Please choose another vehicle or contact support.');
  let liabilityStatement=null,liabilityEvidence=null;
  if(['tricycle','pickup','van','box_truck','long_vehicle','truck'].includes(v.vehicle)){
   const terms=(await db.query('SELECT liability_limit_minor,liability_terms FROM cargo_policy_settings WHERE id=1')).rows[0];
   check(terms?.liability_limit_minor&&terms.liability_terms.trim(),503,'Cargo terms are being prepared. Please choose another vehicle or contact support.');
   liabilityEvidence={limitMinor:Number(terms.liability_limit_minor),terms:terms.liability_terms};
   liabilityStatement=`Declared value is recorded for disputes only. It does not buy insurance. ELESEND’s liability is limited to GH₵${(Number(terms.liability_limit_minor)/100).toFixed(2)} under the published cargo terms. ${terms.liability_terms}`;
  }
  check(routing,503,'Road routing not configured; prices cannot be estimated safely');
  const route=await routing.route(v.pickup,v.destination,{vehicle:v.vehicle??'car',billing:true});
  check(route.source==='routing-provider'||(process.env.NODE_ENV!=='production'&&route.source==='fixture'),503,'Unsupported road estimate');
  const meters=route.distanceMeters;
  check(Number.isSafeInteger(meters)&&meters>=0,503,'Invalid road distance');
  if(capability?.max_trip_m&&meters>capability.max_trip_m){const larger=(await db.query(`SELECT vehicle,enabled FROM vehicle_capabilities WHERE vehicle<>$1 AND max_trip_m>=$2 AND max_weight_g>=$3
    AND (max_length_cm IS NULL OR $4::int IS NULL OR max_length_cm>=$4) AND (max_volume_l IS NULL OR $5::int IS NULL OR max_volume_l>=$5)
    ORDER BY max_trip_m,max_weight_g LIMIT 1`,[v.vehicle,meters,v.weightG,v.lengthCm??null,v.volumeL??null])).rows[0];const largerName=larger?(VEHICLE_LABELS[larger.vehicle]??'larger vehicle')+(larger.enabled?'':' (not available yet)'):'larger vehicle';check(false,422,`This trip is ${km(meters)} by road, beyond this ${VEHICLE_LABELS[v.vehicle]??v.vehicle}'s ${km(capability.max_trip_m)} limit. Try a ${largerName}.`);}
  check(Number.isSafeInteger(route.durationSeconds)&&route.durationSeconds>=0,503,'Invalid road duration');
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:MARKET_TIME_ZONE,hour:'2-digit',hourCycle:'h23'}).format(new Date()));
  const scheduledMultiplier=!longVehicle&&p.rush_hour_enabled&&!p.traffic_time_pricing?getSurgeMultiplier(v.pickup.latitude,v.pickup.longitude,hour):1;
  const surgeObservation=!longVehicle&&p.supply_demand_enabled&&v.vehicle?await measuredSurge(db,v.pickup,v.vehicle):{multiplierBps:10000,reason:'disabled'};
  const surgeBps=longVehicle?10000:Math.max(scheduledMultiplier>1?Number(p.rush_hour_bps??14000):10000,surgeObservation.multiplierBps);
  const surgeMultiplier=surgeBps/10000;
  // A tariff charges for traffic one way only: its rush multiplier, or the time the trip will really take.
  const bucket=timeBucket(new Date());
  const adjustment=travelAdjustment({evidence:await quoteEvidence({vehicle:v.vehicle??'car',deliveryType:'parcel',city:cityBucket(v.destination),bucket}),baselineFactor:baselineFactorFor(etaBaselineFactors(),v.vehicle??'car',bucket,cityBucket(v.pickup))});
  const trafficFactor=adjustment.factor;
  const waitRate=Number(longVehicle?longPolicy.wait_per_minute_minor:p.wait_per_minute_minor??0);
  const freeLoadingMinutes=Number(longVehicle?longPolicy.free_loading_minutes:p.free_loading_minutes??5);
  const waitingEnabled=process.env.WAITING_CHARGES_ENABLED==='true'&&waitRate>0;
  const waitingTerms={freeMinutes:freeLoadingMinutes,maxMinor:waitingEnabled?envInt(process.env.WAIT_FEE_MAX_MINOR,1500,0):0,enabled:waitingEnabled};
  const pricedSeconds=!longVehicle&&p.traffic_time_pricing?Math.round(route.durationSeconds*trafficFactor):route.durationSeconds;
  const tolls=applicableTolls(await activeTollRules(db),{geometry:route.geometry,vehicle:v.vehicle??'car'});
  const tollMinor=tolls.reduce((sum,toll)=>sum+toll.amountMinor,0);
  const floors=v.pickupFloorsNoLift+v.dropoffFloorsNoLift;
  const priced=longVehicle?calculateLongVehicleQuote(longPolicy,meters,{weightG:v.weightG,helpers:v.helpers,pickupFloors:v.pickupFloorsNoLift,dropoffFloors:v.dropoffFloorsNoLift,tollMinor}):calculateQuote(p,meters,{durationSeconds:pricedSeconds,surgeBps,tollMinor,helpers:v.helpers,pickupFloors:v.pickupFloorsNoLift,dropoffFloors:v.dropoffFloorsNoLift});
  const {amountMinor,commissionMinor,riderEarningsMinor,breakdown}=priced;const qid=id();
  const evidence={policyId:p.id,pricingEngine:longVehicle?'long_vehicle_heavy_freight_v1':'standard_road_delivery_v1',longVehiclePolicyId:longPolicy?.id??null,vehicle:v.vehicle??'legacy_unspecified',routeVehicle:v.vehicle??'car',distanceMeters:meters,durationSeconds:route.durationSeconds,pricedSeconds,tolls,breakdown,waitingTerms,waitPerMinuteMinor:waitRate,liability:liabilityEvidence,routeProfile:routing.capabilities?.profileVersion??null,source:route.source,surgeBps,scheduledMultiplier,surgeObservation,quotedAt:new Date().toISOString(),commissionBps:longVehicle?longPolicy.commission_bps:p.commission_bps,minimumMinor:longVehicle?longPolicy.minimum_minor:p.minimum_minor};
  const r=await db.query("INSERT INTO quotes(id,customer_id,policy_id,long_vehicle_policy_id,request,amount_minor,commission_minor,expires_at,payment_method,pricing_evidence) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '15 minutes',$8,$9) RETURNING id,amount_minor,commission_minor,expires_at,payment_method",[qid,actor.id,p.id,longPolicy?.id??null,JSON.stringify(v),amountMinor,commissionMinor,v.paymentMethod,JSON.stringify(evidence)]);
  const capacity=dispatch?await dispatch.availability({pickup:v.pickup,weightG:v.weightG,vehicle:v.vehicle,parcelCategory:v.parcelCategory,parcelSize:v.parcelSize,lengthCm:v.lengthCm,volumeL:v.volumeL}):{status:'unknown',guaranteed:false};
  const fareBreakdown={...breakdown,tolls:tolls.map(({name,amountMinor})=>({name,amountMinor})),tariffId:longVehicle?longPolicy.id:p.id,startMinor:Number(longVehicle?longPolicy.base_minor:p.base_minor),perKmMinor:Number(longVehicle?longPolicy.per_km_minor:p.per_km_minor),perMinuteMinor:longVehicle?0:Number(p.per_minute_minor??0),perTonneKmMinor:longVehicle?Number(longPolicy.per_tonne_km_minor):0,pricedMinutes:longVehicle?0:Math.ceil(pricedSeconds/60),minimumMinor:Number(longVehicle?longPolicy.minimum_minor:p.minimum_minor??0),rushHourMultiplier:longVehicle?1:surgeMultiplier,waitPerMinuteMinor:waitingEnabled?waitRate:0,waitFreeMinutes:waitingTerms.freeMinutes,waitMaxMinor:waitingTerms.maxMinor,waitingEnabled,helpers:v.helpers,pickupFloorsNoLift:v.pickupFloorsNoLift,dropoffFloorsNoLift:v.dropoffFloorsNoLift,pricingEngine:evidence.pricingEngine};
  return {...r.rows[0],currency:MARKET_CURRENCY,vehicle:v.vehicle??null,pricingEngine:evidence.pricingEngine,pricingEvidence:evidence,fareBreakdown,liabilityStatement,etaMinutes:quotedEtaMinutes(route.durationSeconds,trafficFactor,{riderSeconds:capacity.nearestRiderSeconds,source:adjustment.source}),surgeMultiplier:longVehicle?1:surgeMultiplier,riderEarningsMinor,driverEarningGhs:riderEarningsMinor/100,platformCommissionGhs:commissionMinor/100,distanceMeters:meters,distanceMethod:route.source==='fixture'?'synthetic road routing fixture':'provider road routing',travelSeconds:route.durationSeconds,trafficAware:route.trafficAware===true,availability:capacity};
 },
 async book(actor,input,key){await marketService(db).assertGhanaOperating();const v=z.object({quoteId:uuid}).strict().parse(input);check(typeof key==='string'&&/^[\w-]{8,128}$/.test(key),400,'Idempotency-Key required');check(['customer','business','company'].includes(actor.kind),403);await requireAcceptedTerms(db,actor);await assertCompanyDelivery(db,actor);
  if(process.env.NODE_ENV==='production')check(dispatch,503,'Delivery booking paused: dispatch unavailable');
  return db.tx(async c=>{if(process.env.NODE_ENV==='production')await requireVerifiedPhone(c,actor);await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[actor.id+key]);
   const old=(await c.query('SELECT * FROM shipments WHERE customer_id=$1 AND idempotency_key=$2',[actor.id,key])).rows[0];if(old){check(old.quote_id===v.quoteId,409,'Idempotency key reused with different request');return old;}
   const q=(await c.query('SELECT * FROM quotes WHERE id=$1 AND customer_id=$2 AND expires_at>now() FOR UPDATE',[v.quoteId,actor.id])).rows[0];check(q,409,'Quote unavailable or expired');
   // Cash jobs cost the sender nothing until the rider arrives, so one account could book many fake pickups and send
   // riders across town for nothing. Open cash bookings are capped per account (businesses get more).
   if(q.payment_method==='CASH'){
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['cash-bookings:'+actor.id]);
    const cap=actor.kind==='customer'?Number(process.env.MAX_OPEN_CASH_BOOKINGS)||3:Number(process.env.MAX_OPEN_CASH_BOOKINGS_BUSINESS)||20;
    const open=(await c.query("SELECT count(*)::int AS n FROM shipments WHERE customer_id=$1 AND payment_method='CASH' AND state IN ('AWAITING_ASSIGNMENT','RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP')",[actor.id])).rows[0].n;
    check(open<cap,429,`You have ${open} cash deliveries in progress. Pay by mobile money or card, or wait for one to finish`);
   }
   const sid=id();const result=await c.query("INSERT INTO shipments(id,customer_id,quote_id,idempotency_key,state,recipient_phone,amount_minor,commission_minor,payment_method,cash_payer) VALUES($1,$2,$3,$4,$8,$5,$6,$7,$9,$10) RETURNING *",[sid,actor.id,q.id,key,q.request.recipientPhone,q.amount_minor,q.commission_minor,q.payment_method==='CASH'?'AWAITING_ASSIGNMENT':'AWAITING_PAYMENT',q.payment_method,q.payment_method==='CASH'?(q.request.cashPayer??'recipient'):null]);await audit(c,actor.id,'shipment.booked',sid);await event(c,sid,'booked');return result.rows[0];
  });
 },
 async paymentConfirmed({provider,eventId,shipmentId,amountMinor,currency}){
  // Internal adapter entry only. Never mounted as an unsigned public route.
  check(typeof provider==='string'&&provider.length>0&&typeof eventId==='string'&&eventId.length>0,400);uuid.parse(shipmentId);check(Number.isSafeInteger(amountMinor)&&currency===MARKET_CURRENCY,400);
  return db.tx(async c=>{const s=await locked(c,shipmentId);check(s.amount_minor===amountMinor,409,'Payment amount mismatch');
   const previous=await findPaymentEvent(c,provider,eventId);
   if(previous){check(previous.shipment_id===shipmentId&&previous.amount_minor===amountMinor,409,'Event conflict');return {duplicate:true};}
   check(s.payment_method==='DIGITAL'&&s.state==='AWAITING_PAYMENT'&&!s.paid,409,'Shipment cannot receive provider payment');
   await recordPaymentEvent(c,{provider,eventId,shipmentId,amountMinor,currency});
   await c.query("UPDATE shipments SET paid=true,state='AWAITING_ASSIGNMENT' WHERE id=$1",[shipmentId]);await event(c,shipmentId,'payment_confirmed');return {ok:true};
  });
 },
 async offers(actor){check(dispatch,503,'Dispatch engine unavailable');return dispatch.offers(actor);},
 async accept(actor,sid,offerId){check(dispatch,503,'Dispatch engine unavailable');return dispatch.accept(actor,sid,offerId);},
 async get(actor,sid){uuid.parse(sid);const s=(await db.query(`SELECT sh.*,(SELECT confirmed_at FROM shipment_receipt_confirmations WHERE shipment_id=sh.id) AS receipt_confirmed_at,(SELECT confirmed_at FROM shipment_handover_events WHERE shipment_id=sh.id AND kind='delivery') AS rider_reported_at FROM shipments sh WHERE sh.id=$1`,[sid])).rows[0];check(s,404);await access(db,actor,s);const q=(await db.query('SELECT request FROM quotes WHERE id=$1',[s.quote_id])).rows[0];const waiting=(await db.query('SELECT stop,waited_seconds,fee_minor,collection FROM shipment_waiting_charges WHERE shipment_id=$1',[sid])).rows;return hideEndedContacts(actor,{...s,details:q.request,waitingCharges:waiting});},
 async list(actor,{asClient=Boolean(actor.api_client_id)}={}){
  const baseQuery=`SELECT s.*, (SELECT confirmed_at FROM shipment_receipt_confirmations WHERE shipment_id=s.id) AS receipt_confirmed_at, (SELECT confirmed_at FROM shipment_handover_events WHERE shipment_id=s.id AND kind='delivery') AS rider_reported_at, (SELECT id FROM food_orders WHERE shipment_id=s.id) AS food_order_id, (SELECT phone FROM users WHERE id=s.rider_id) AS rider_phone, q.request AS details, q.request->'pickup' AS pickup, q.request->'destination' AS destination FROM shipments s JOIN quotes q ON q.id=s.quote_id`;
  if(['customer','business'].includes(actor.kind)||(actor.kind==='company'&&asClient))return (await db.query(`${baseQuery} WHERE s.customer_id=$1 ORDER BY s.created_at DESC LIMIT 100`,[actor.id])).rows.map(r=>hideEndedContacts(actor,r));
  if(actor.kind==='rider')return (await db.query(`${baseQuery} WHERE s.rider_id=$1 ORDER BY s.created_at DESC LIMIT 100`,[actor.id])).rows.map(r=>hideEndedContacts(actor,r));
  if(actor.kind==='company')return (await db.query(`${baseQuery} JOIN companies c ON c.id=s.company_id WHERE c.owner_id=$1 ORDER BY s.created_at DESC LIMIT 100`,[actor.id])).rows.map(r=>hideEndedContacts(actor,r));
  await permission(db,actor,'shipments:read');return (await db.query(`${baseQuery} ORDER BY s.created_at DESC LIMIT 100`)).rows;
 },
 async confirmReceipt(actor,sid,input){
  z.object({received:z.literal(true)}).strict().parse(input);
  check(['customer','business','company'].includes(actor?.kind)&&!actor?.api_client_id,403,'Booking customer required');
  return db.tx(async c=>{
   const shipment=await locked(c,sid);
   check(shipment.customer_id===actor.id,403,'Only the booking customer can acknowledge receipt');
   check(shipment.state==='COMPLETED',409,'Delivery must be reported complete before receipt acknowledgement');
   const inserted=await c.query('INSERT INTO shipment_receipt_confirmations(shipment_id,customer_id) VALUES($1,$2) ON CONFLICT(shipment_id) DO NOTHING RETURNING confirmed_at',[sid,actor.id]);
   if(inserted.rowCount){
    await audit(c,actor.id,'shipment.customer_receipt_acknowledged',sid);
   }
   const row=inserted.rows[0]||(await c.query('SELECT confirmed_at FROM shipment_receipt_confirmations WHERE shipment_id=$1 AND customer_id=$2',[sid,actor.id])).rows[0];
   check(row,409,'Receipt acknowledgement belongs to another account');
   return {received:true,duplicate:!inserted.rowCount,confirmedAt:row.confirmed_at};
  });
 },
 async challenge(actor,sid,purpose){check(allowLegacySmsHandover(),410,'SMS handover verification is disabled; update the rider app');check(['pickup','delivery','return'].includes(purpose),400);check(sms,503,'SMS adapter unavailable');
  const code=newCode(),cid=id();
  const resolveChallengeRecipient=async c=>{
   const s=await locked(c,sid);
   if(purpose==='delivery')return {s,destination:s.recipient_phone};
   const fo=(await c.query(`SELECT f.id,r.phone AS restaurant_phone,u.phone AS owner_phone FROM food_orders f JOIN restaurants r ON r.id=f.restaurant_id LEFT JOIN users u ON u.id=r.owner_id WHERE f.shipment_id=$1`,[sid])).rows[0];
   check(purpose!=='return'||!fo,409,'The restaurant confirms returned food orders');
   if(fo){
    const restPhone=fo.restaurant_phone||fo.owner_phone;
    check(restPhone,409,'Restaurant handover contact phone unavailable');
    return {s,destination:restPhone};
   }
   const contact=(await c.query("SELECT request->>'pickupPhone' AS phone FROM quotes WHERE id=$1",[s.quote_id])).rows[0]?.phone;
   if(contact)return {s,destination:contact};
   const cust=(await c.query('SELECT phone FROM users WHERE id=$1',[s.customer_id])).rows[0];
   check(cust?.phone,409,'Sender handover contact phone unavailable');
   return {s,destination:cust.phone};
  };
  const target=await db.tx(async c=>{await rider(c,actor);const {s,destination}=await resolveChallengeRecipient(c);check(s.rider_id===actor.id,403,'Assigned rider required');check(s.verification_authority==='elesend',409,'External verification not enabled');
   check((purpose==='pickup'?['RIDER_ASSIGNED']:purpose==='return'?['RETURN_REQUESTED']:['PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP']).includes(s.state),409,'Shipment not eligible for challenge');
   const manifest=(await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE',[actor.id])).rows[0];
   if(purpose!=='return'&&manifest?.stops.length){const next=await nextOpenStop(c,manifest.stops);check(next?.shipmentId===sid&&next?.kind===(purpose==='pickup'?'pickup':'dropoff'),409,'Complete the next verified route stop first');}
   await limit(c,'otp:'+sid+':'+purpose,3,900);
   check(!(await c.query('SELECT 1 FROM challenges WHERE shipment_id=$1 AND purpose=$2 AND expires_at>now() AND consumed_at IS NULL AND attempts<5',[sid,purpose])).rowCount,409,'Challenge still active');
   const digest=mac(otpKey,[purpose,cid,sid,actor.id,destination,code]);
   await c.query("INSERT INTO challenges(id,shipment_id,rider_id,purpose,phone,digest,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '5 minutes')",[cid,sid,actor.id,purpose,destination,digest]);
   if(purpose==='delivery'){if(s.state==='PICKUP_VERIFIED')await c.query("UPDATE shipments SET state='IN_TRANSIT' WHERE id=$1",[sid]);await c.query("UPDATE shipments SET state='AWAITING_DELIVERY_OTP' WHERE id=$1",[sid]);await c.query("UPDATE food_orders SET state='IN_TRANSIT',updated_at=now() WHERE shipment_id=$1 AND state IN ('ACCEPTED','PREPARING','READY_FOR_PICKUP')",[sid]);}await audit(c,actor.id,purpose+'.challenge_requested',sid);return destination;
  });
  try{await sendSms({phone:target,code,purpose,challengeId:cid});await db.tx(async c=>{
    const current=await locked(c,sid);
    check(current.rider_id===actor.id&&current.verification_authority==='elesend',409,'Shipment verification authority changed');
    check((await c.query('UPDATE challenges SET sent=true WHERE id=$1 AND rider_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING id',[cid,actor.id])).rowCount,409,'OTP challenge expired before SMS acceptance');
   });}
  catch {await db.tx(async c=>{await locked(c,sid);await c.query('UPDATE challenges SET expires_at=now() WHERE id=$1',[cid]);if(purpose==='delivery'){
    // A failed SMS cannot be marked sent; operator must use failure flow, no status bypass.
    await audit(c,actor.id,'delivery.sms_failed',sid);
   }
   await c.query("INSERT INTO dispatch_exceptions(shipment_id,actor_id,kind,reason) VALUES($1,$2,'handover_sms_failed',$3)",[sid,actor.id,`The ${purpose} code could not be sent by SMS`]);
  });check(false,503,'We could not send the code by SMS. Try again in a minute. ELESEND support has been alerted.');}
  return {challengeId:cid,expiresInSeconds:300};
 },
 // The customer may correct an accidental phone typo before the rider takes custody.\n // After pickup, the original handover recipient must remain immutable; rerouting is a support/dispute action.
 async correctRecipient(actor,sid,input){const v=z.object({recipientPhone:z.string().max(30)}).strict().parse(input);const p=phone(v.recipientPhone);
  return db.tx(async c=>{const s=await locked(c,sid);check(s.customer_id===actor.id,404,'Shipment not found');
   check(['AWAITING_PAYMENT','AWAITING_ASSIGNMENT','RIDER_ASSIGNED'].includes(s.state),409,'Recipient correction is unavailable after pickup; contact support about a delivery dispute');
   if(s.recipient_phone===p)return {shipmentId:sid,recipientPhone:p,changed:false};
   await limit(c,'recipient:'+sid,3,86400);
   await c.query("SELECT set_config('elesend.recipient_correction',$1,true)",[sid]);
   await c.query('UPDATE shipments SET recipient_phone=$2 WHERE id=$1',[sid,p]);
   await c.query("SELECT set_config('elesend.recipient_correction','',true)");
   const cancelled=(await c.query("UPDATE challenges SET expires_at=now() WHERE shipment_id=$1 AND purpose='delivery' AND consumed_at IS NULL AND expires_at>now() RETURNING id",[sid])).rowCount;
   await audit(c,actor.id,'shipment.recipient_changed',sid);
   return {shipmentId:sid,recipientPhone:p,changed:true,deliveryCodeCancelled:cancelled>0};
  });
 },
 async handover(actor,sid,input){return handover(actor,sid,input);},
 async verify(actor,sid,input){const v=z.object({challengeId:uuid.optional(),code:z.string().regex(/^\d{6}$/)}).strict().parse(input);
  const result=await db.tx(async c=>{await rider(c,actor);const s=await locked(c,sid);check(s.rider_id===actor.id,403,'Assigned rider required');
   const ch=(v.challengeId?await c.query('SELECT *,expires_at>now() AS live FROM challenges WHERE id=$1 AND shipment_id=$2 AND rider_id=$3 FOR UPDATE',[v.challengeId,sid,actor.id]):await c.query('SELECT *,expires_at>now() AS live FROM challenges WHERE shipment_id=$1 AND rider_id=$2 AND sent=true AND consumed_at IS NULL AND expires_at>now() AND attempts<5 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',[sid,actor.id])).rows[0];
   check(ch&&ch.sent&&ch.live&&!ch.consumed_at&&ch.attempts<5,409,'Challenge unavailable');
   check(s.state===({pickup:'RIDER_ASSIGNED',return:'RETURN_REQUESTED'}[ch.purpose]??'AWAITING_DELIVERY_OTP'),409,'Wrong delivery state');
   const pending=(await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE',[actor.id])).rows[0];
   if(ch.purpose!=='return'&&pending?.stops.length){const next=await nextOpenStop(c,pending.stops);check(next?.shipmentId===sid&&next?.kind===(ch.purpose==='pickup'?'pickup':'dropoff'),409,'Stop order changed; verification blocked');}
   let expectedPhone=s.recipient_phone;
   if(ch.purpose==='return'||ch.purpose==='pickup'){
    const fo=ch.purpose==='pickup'?(await c.query(`SELECT r.phone AS restaurant_phone,u.phone AS owner_phone FROM food_orders f JOIN restaurants r ON r.id=f.restaurant_id LEFT JOIN users u ON u.id=r.owner_id WHERE f.shipment_id=$1`,[sid])).rows[0]:null;
    const pickupContact=!fo?(await c.query("SELECT request->>'pickupPhone' AS phone FROM quotes WHERE id=$1",[s.quote_id])).rows[0]?.phone:null;
    expectedPhone=fo?(fo.restaurant_phone||fo.owner_phone):(pickupContact||(await c.query('SELECT phone FROM users WHERE id=$1',[s.customer_id])).rows[0]?.phone);
   }
   check(Boolean(expectedPhone)&&ch.phone===expectedPhone,409,'Challenge recipient mismatch');
   if(!equal(ch.digest,mac(otpKey,[ch.purpose,ch.id,sid,actor.id,expectedPhone,v.code]))){await c.query('UPDATE challenges SET attempts=attempts+1,expires_at=CASE WHEN attempts+1>=5 THEN now() ELSE expires_at END WHERE id=$1',[ch.id]);await audit(c,actor.id,'otp.rejected',sid);
    if(ch.attempts+1>=5&&await featureService(c).enabled('fraud_signals')){
     const signals=detectFraudSignals({otpFailures:ch.attempts+1});
     for(const risk of signals.signals)await c.query('INSERT INTO operational_risk_signals(rider_id,shipment_id,signal_code,severity,evidence) VALUES($1,$2,$3,$4,$5)',[actor.id,sid,risk.code,risk.severity,JSON.stringify({challengeId:ch.id,attempts:ch.attempts+1})]);
    }return {invalid:true};}
   await c.query('UPDATE challenges SET consumed_at=now() WHERE id=$1',[ch.id]);
   return applyHandover(c,actor,s,sid,ch.purpose,'otp');
  });check(!result.invalid,400,'Incorrect code');return result;
 },
 /** What cancelling costs right now, so the customer sees it before deciding. */
 async cancelTerms(actor,sid){uuid.parse(sid);const s=(await db.query('SELECT * FROM shipments WHERE id=$1',[sid])).rows[0];check(s&&s.customer_id===actor.id,404,'Shipment not found');return cancellationTerms(db,s);},
 async transition(actor,sid,input){const v=z.object({action:z.enum(['start','fail','return','returned','cancel']),reason:z.string().min(3).max(1000).optional()}).strict().parse(input);
  return db.tx(async c=>{if(actor.kind==='rider')await rider(c,actor);const s=await locked(c,sid);
   const transitions={start:['PICKUP_VERIFIED','IN_TRANSIT'],fail:[['RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP'],'FAILED'],return:['FAILED','RETURN_REQUESTED'],returned:['RETURN_REQUESTED','RETURNED'],cancel:[['AWAITING_PAYMENT','AWAITING_ASSIGNMENT','RIDER_ASSIGNED'],'CANCELLED']};
   const [from,to]=transitions[v.action];check([from].flat().includes(s.state),409,'Invalid transition');
   let foOwnerReturned=false,cancelledRider=null,cancellationFeeMinor=0;
   if(v.action==='cancel'){
    check(s.customer_id===actor.id,403);
    check(!(await c.query('SELECT 1 FROM food_orders WHERE shipment_id=$1',[sid])).rowCount,409,'Cancel food orders through the food order cancellation endpoint');
    if(s.state==='RIDER_ASSIGNED'){
     check(!(await c.query("SELECT 1 FROM challenges WHERE shipment_id=$1 AND purpose='pickup' AND consumed_at IS NOT NULL",[sid])).rowCount,409,'The rider has already collected this parcel');
     check(!await cashAlreadyReported(c,sid),409,'Cash has already been collected for this order. Please contact support');
     cancellationFeeMinor=(await cancellationTerms(c,s)).feeMinor;
     cancelledRider=s.rider_id;
     await c.query('UPDATE challenges SET expires_at=now() WHERE shipment_id=$1 AND consumed_at IS NULL',[sid]);
     await c.query("UPDATE dispatch_offers SET status='invalidated' WHERE shipment_id=$1 AND status IN ('offered','accepted')",[sid]);
     const plan=(await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE',[s.rider_id])).rows[0];
     if(plan)await c.query('UPDATE rider_dispatch_plans SET stops=$2,revision=revision+1,updated_at=now() WHERE rider_id=$1',[s.rider_id,JSON.stringify(removeShipment(plan.stops,sid))]);
     await c.query('DELETE FROM dispatch_commitments WHERE shipment_id=$1',[sid]);
     await queueNotification(c,{id:`cancelled:${sid}`,recipientId:s.rider_id,kind:'delivery_watchdog_alert',payload:{shipmentId:sid,action:'customer_cancelled',message:cancellationFeeMinor>0?`The customer cancelled this delivery. You receive GH₵${(cancellationFeeMinor/100).toFixed(2)} for your trip.`:'The customer cancelled this delivery. You can take other jobs.'}});
    }
    await requestCheckoutRefund(c,s,v.reason||'Customer cancelled',{riderFeeMinor:cancellationFeeMinor});
   }else if(v.action==='returned'){
    const foOwner=(await c.query('SELECT r.owner_id FROM food_orders f JOIN restaurants r ON r.id=f.restaurant_id WHERE f.shipment_id=$1',[sid])).rows[0];
    foOwnerReturned=Boolean(foOwner);
    if(foOwner)check(actor?.kind==='admin'||foOwner.owner_id===actor?.id,403,'Only restaurant owner or administrator may confirm physical return');
    else{
     check(actor?.kind==='admin',409,'Only the sender or administrator may confirm this return');
     // A rider under a missing-parcel incident is paid only if it was cleared as a false alarm.
     check(!(await c.query("SELECT 1 FROM parcel_custody_incidents WHERE shipment_id=$1 AND outcome IS DISTINCT FROM 'false_alarm'",[sid])).rowCount,409,'This parcel has a missing-parcel incident');
    }
   }else{
    check(s.rider_id===actor.id,403,'Assigned rider required');
    // Before pickup nothing was carried, so the job is released rather than charged as a failed delivery.
    if(v.action==='return'&&!(await c.query('SELECT 1 FROM food_orders WHERE shipment_id=$1',[sid])).rowCount)check((await c.query("SELECT 1 FROM shipment_handover_events WHERE shipment_id=$1 AND kind='pickup' UNION SELECT 1 FROM challenges WHERE shipment_id=$1 AND purpose='pickup' AND consumed_at IS NOT NULL",[sid])).rowCount,409,'This parcel was never picked up. Release the job instead');
   }
   if(v.action!=='start')check(v.reason,400,'Reason required');
   // Without a fee the rider is released from the order. With one, they stay on it so the fee reaches them.
   const dropRider=Boolean(cancelledRider)&&cancellationFeeMinor===0;
   await c.query('UPDATE shipments SET state=$2,rider_id=CASE WHEN $3::boolean THEN NULL ELSE rider_id END,company_id=CASE WHEN $3::boolean THEN NULL ELSE company_id END,cancellation_fee_minor=$4 WHERE id=$1',[sid,to,dropRider,cancellationFeeMinor]);
   if(['cancel','returned','fail'].includes(v.action)){
    await c.query('DELETE FROM locations WHERE shipment_id=$1',[sid]);
   }
   if(v.action==='returned'){
    const plan=s.rider_id?(await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE',[s.rider_id])).rows[0]:null;
    if(plan)await c.query('UPDATE rider_dispatch_plans SET stops=$2,revision=revision+1,updated_at=now() WHERE rider_id=$1',[s.rider_id,JSON.stringify(removeShipment(plan.stops,sid))]);
    await c.query('DELETE FROM dispatch_commitments WHERE shipment_id=$1',[sid]);
    if(s.rider_id)await c.query('DELETE FROM locations WHERE rider_id=$1 AND shipment_id=$2',[s.rider_id,sid]);
    const fo=(await c.query('SELECT * FROM food_orders WHERE shipment_id=$1 FOR UPDATE',[sid])).rows[0];
    if(fo&&!['DELIVERED','CANCELLED','REJECTED'].includes(fo.state)){
     await requestCheckoutRefund(c,s,v.reason||'Returned after delivery failure');
     await c.query("UPDATE food_orders SET state='CANCELLED',updated_at=now() WHERE id=$1",[fo.id]);
     await promotionEngine(db).releaseOrderPromotions(c,fo.id,{reason:'food_order_returned',isRefund:Boolean(s.paid)});
     await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,'food_order.returned_cancelled:'+v.reason,fo.id]);
    }
    if(!fo)await settleReturnedParcel(c,s);
   }
   await audit(c,actor.id,'shipment.'+v.action,sid);await event(c,sid,to);return {state:to,refundReviewRequired:(v.action==='cancel'||(v.action==='returned'&&Boolean(foOwnerReturned)))&&s.paid,...(cancelledRider?{releasedRiderId:cancelledRider,cancellationFeeMinor}:{})};
  });
 },
 async location(actor,sid,input){
  const v=z.object({
   latitude:z.number().min(-90).max(90),
   longitude:z.number().min(-180).max(180),
   accuracyMeters:z.number().min(0).max(120).optional(),
   observedAt:z.string().datetime().optional()
  }).strict().parse(input);
  validateGhanaBoundary(v.latitude,v.longitude);
  if(v.observedAt){
   const ageMs=Date.now()-new Date(v.observedAt).getTime();
   check(Number.isFinite(ageMs)&&ageMs>=-60000&&ageMs<=180000,422,'Stale or future-dated GPS sample rejected');
  }
  return db.tx(async c=>{
   await rider(c,actor);
   const s=await locked(c,sid);
   check(s.rider_id===actor.id&&['RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP'].includes(s.state),403);
   const prev=(await c.query('SELECT latitude,longitude,updated_at FROM locations WHERE shipment_id=$1',[sid])).rows[0];
   if(prev&&Number.isFinite(Number(prev.latitude))&&Number.isFinite(Number(prev.longitude))&&prev.updated_at){
    const dtSeconds=Math.max(1,(Date.now()-new Date(prev.updated_at).getTime())/1000);
    if(dtSeconds<=60){
     const distMeters=haversine({latitude:Number(prev.latitude),longitude:Number(prev.longitude)},{latitude:v.latitude,longitude:v.longitude});
     check(distMeters/Math.max(dtSeconds,5)<=60,422,'Impossible GPS velocity leap rejected');
    }
   }
   await c.query('INSERT INTO locations(shipment_id,rider_id,latitude,longitude) VALUES($1,$2,$3,$4) ON CONFLICT(shipment_id) DO UPDATE SET rider_id=$2,latitude=$3,longitude=$4,updated_at=now()',[sid,actor.id,v.latitude,v.longitude]);
   return {ok:true};
  });
 },
 async tracking(actor,sid){
  const s=await this.get(actor,sid);
  if(!s.rider_id||!['RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP'].includes(s.state))return null;
  return (await db.query(
   `SELECT l.latitude,l.longitude,l.updated_at
    FROM locations l
    WHERE l.shipment_id=$1
      AND l.rider_id=$2
      AND l.updated_at >= now() - make_interval(secs => COALESCE((SELECT fresh_seconds FROM dispatch_policy WHERE id=1), 180))`,
   [sid,s.rider_id]
  )).rows[0]??null;
 },
 async dispute(actor,sid,input){
  const v=z.object({
   category:z.enum(['lost','damaged','missing_items','quality','payment','waiting_fee','misconduct','address','other']),
   detail:z.string().min(5).max(2000),
   items:z.array(z.object({
    foodOrderItemId:uuid.optional(),
    menuItemId:uuid.optional(),
    name:z.string().max(200).optional(),
    quantity:z.number().int().min(1).max(100),
    amountMinor:z.number().int().min(1).max(100000000).optional()
   }).strict()).max(50).optional(),
   requestedRefundMinor:z.number().int().min(1).max(100000000).optional()
  }).strict().parse(input);
  await this.get(actor,sid);
  return db.tx(async c=>{
   await locked(c,sid);
   // Delivery confirmed by SMS, or a failed delivery the sender pays for, is never refunded.
   const refundClaim=['lost','damaged','missing_items','quality','payment'].includes(v.category)||v.items?.length||v.requestedRefundMinor;
   const finished=(await c.query("SELECT state,EXISTS(SELECT 1 FROM food_orders f WHERE f.shipment_id=s.id) AS food FROM shipments s WHERE s.id=$1 AND s.state IN ('COMPLETED','FAILED','RETURN_REQUESTED','RETURNED')",[sid])).rows[0];
   if(refundClaim&&finished?.food&&finished.state==='COMPLETED')check(false,409,'Delivered food orders are handled by the restaurant. Please chat with the restaurant from your order');
   if(refundClaim&&finished&&!finished.food)check(false,409,'Parcels confirmed by SMS and failed deliveries are not refunded');
   const did=id();
   await c.query(
    'INSERT INTO disputes(id,shipment_id,reporter_id,category,detail,items_json,requested_refund_minor) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [did,sid,actor.id,v.category,v.detail,JSON.stringify(v.items||[]),v.requestedRefundMinor??null]
   );
   await audit(c,actor.id,'dispute.opened',sid);
   return {id:did};
  });
 },
 async earnings(actor){return earningsEntriesFor(db,actor.id);},
 /** Orders staff should look at. Finished orders drop off the list. */
 async openExceptions(actor){await permission(db,actor,'dispatch:configure');return (await db.query(`SELECT e.id,e.shipment_id,e.kind,e.reason,e.created_at,s.state,s.paid,u.phone AS customer_phone,rp.phone AS rider_phone
   FROM dispatch_exceptions e JOIN shipments s ON s.id=e.shipment_id JOIN users u ON u.id=s.customer_id LEFT JOIN users rp ON rp.id=s.rider_id
   WHERE s.state NOT IN ('COMPLETED','CANCELLED','RETURNED') ORDER BY e.created_at DESC LIMIT 100`)).rows;},
 async reviewQueue(actor){await permission(db,actor,'verification:write');return {riders:(await db.query('SELECT r.id,u.phone,r.company_id,r.status,r.vehicle,r.max_weight_g FROM riders r LEFT JOIN users u ON u.id=r.id ORDER BY r.id LIMIT 100')).rows,companies:(await db.query('SELECT c.id,c.name,c.status,c.services,u.phone FROM companies c JOIN users u ON u.id=c.owner_id ORDER BY c.name LIMIT 100')).rows,vehicles:(await db.query('SELECT * FROM rider_vehicle_registrations ORDER BY submitted_at DESC LIMIT 100')).rows};}
 ,
  routing,
  dispatch,
  sms
 };
}
