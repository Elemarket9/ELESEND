import {foodDispatchAllowed} from './food-payment.mjs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check} from './security.mjs';
import {haversine,classifyMovement} from './dispatch-geometry.mjs';
import {freshStops,bestInsertion,evaluateStops,activeStates,weightCapacityValid} from './multi-parcel.mjs';
import {roadMatrixBatched,memoRoadRouting} from './algorithms/roads.mjs';
import {discoverByRadii} from './algorithms/discovery.mjs';
import {eligibleAndRank} from './algorithms/ranking.mjs';
import {cashEligible} from './finance.mjs';
import {evaluateRiderWeeklyEligibility} from './weekly-settlement.mjs';
import {requireDebtEligible} from './rider-wallet.mjs';
import {buildRemainingRoadCorridor} from './algorithms/corridor.mjs';
import {smoothGps} from './algorithms/gps.mjs';
import {calibrateETA} from './algorithms/eta.mjs';
import {minCostBipartiteAssignment} from './algorithms/batch.mjs';
import {featureService} from './algorithms/features.mjs';
import {getRedisClient} from './infrastructure/cache/redis.mjs';
import {chatEngine} from './chat-engine.mjs';
const uuid=z.string().uuid();
const sampleSchema=z.object({latitude:z.number().finite().min(-90).max(90),longitude:z.number().finite().min(-180).max(180),accuracyMeters:z.number().finite().min(0).max(1000),observedAt:z.string().datetime({offset:true}),headingDegrees:z.number().finite().min(0).max(359.999).optional(),speedMps:z.number().finite().min(0).max(80).optional()}).strict();
const point=r=>({latitude:Number(r.latitude),longitude:Number(r.longitude)});
const audit=(c,who,action,sid)=>c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[who,action,sid]);
const change=(c,sid,type)=>c.query('INSERT INTO outbox(shipment_id,kind,payload) VALUES($1,$2,$3)',[sid,type,JSON.stringify({shipmentId:sid,kind:type})]);
async function policy(db){return (await db.query('SELECT * FROM dispatch_policy WHERE id=1')).rows[0];}
function authorizedRider(r){check(r&&r.status==='approved',403,'Approved rider required');}
export function dispatchEngine(db,{routing}={}){
 check(routing&&typeof routing.route==='function'&&typeof routing.matrix==='function',500,'Road routing adapter required');
 const features=featureService(db);
 const chat=chatEngine(db);
 async function getPolicy(actor){check(actor?.kind==='admin',403,'Administrator required');check((await db.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission='dispatch:configure'",[actor.id])).rowCount,403,'Dispatch configuration permission required');return policy(db);}
 async function configure(actor,body){const schema=z.object({searchRadiiM:z.array(z.number().int().min(250).max(100000)).min(1).max(8),candidateLimit:z.number().int().min(1).max(200),freshSeconds:z.number().int().min(10).max(300),maxSampleAgeSeconds:z.number().int().min(15).max(600),maxAccuracyM:z.number().int().min(5).max(1000),maxSpeedMps:z.number().int().min(2).max(100),offerSeconds:z.number().int().min(10).max(180),retrySeconds:z.number().int().min(10).max(900),maxAttempts:z.number().int().min(1).max(100),sampleRetentionHours:z.number().int().min(1).max(168),movingUploadSeconds:z.number().int().min(5).max(120),idleUploadSeconds:z.number().int().min(15).max(600),multiStopEnabled:z.boolean(),maxActiveParcels:z.number().int().min(1).max(10),maxDetourSeconds:z.number().int().min(0).max(1800),deliverySlackSeconds:z.number().int().min(120).max(7200),maxPickupEtaSeconds:z.number().int().min(120).max(7200),maxOfferMovementM:z.number().int().min(20).max(2000)}).strict();
  const v=schema.parse(body);check(v.searchRadiiM.every((n,i)=>i===0||n>v.searchRadiiM[i-1]),400,'Search radii must strictly increase');check(v.freshSeconds<=v.maxSampleAgeSeconds,400,'Fresh threshold must not exceed accepted sample age');check(v.movingUploadSeconds<v.freshSeconds&&v.idleUploadSeconds>=v.movingUploadSeconds,400,'Invalid tracking intervals');
  await getPolicy(actor);
  return db.tx(async c=>{await c.query('SELECT * FROM dispatch_policy WHERE id=1 FOR UPDATE');
   // The admin's single multi-stop switch atomically enables its required
   // feature dependencies. Disabling multi-stop immediately prevents NEW pooled offers.
   if(v.multiStopEnabled){await c.query("UPDATE dispatch_algorithm_features SET enabled=true,updated_by=$1,updated_at=now() WHERE feature_key IN ('multi_parcel_vrp','dynamic_pickup_insertion')",[actor.id]);
    await audit(c,actor.id,'dispatch.multi_parcel_algorithms_activated',null);}await c.query(`UPDATE dispatch_policy SET search_radii_m=$1,candidate_limit=$2,fresh_seconds=$3,max_sample_age_seconds=$4,max_accuracy_m=$5,max_speed_mps=$6,offer_seconds=$7,retry_seconds=$8,max_attempts=$9,sample_retention_hours=$10,moving_upload_seconds=$11,idle_upload_seconds=$12,multi_stop_enabled=$13,max_active_parcels=$14,max_detour_seconds=$15,delivery_slack_seconds=$16,max_pickup_eta_seconds=$17,max_offer_movement_m=$18,updated_at=now() WHERE id=1`,[v.searchRadiiM,v.candidateLimit,v.freshSeconds,v.maxSampleAgeSeconds,v.maxAccuracyM,v.maxSpeedMps,v.offerSeconds,v.retrySeconds,v.maxAttempts,v.sampleRetentionHours,v.movingUploadSeconds,v.idleUploadSeconds,v.multiStopEnabled,v.maxActiveParcels,v.maxDetourSeconds,v.deliverySlackSeconds,v.maxPickupEtaSeconds,v.maxOfferMovementM]);await audit(c,actor.id,'dispatch.policy_updated',null);return {ok:true,multiStopEnabled:v.multiStopEnabled};});
 }
 async function riskSignals(actor){await getPolicy(actor);return (await db.query("SELECT id,rider_id,shipment_id,signal_code,severity,review_status,created_at FROM operational_risk_signals WHERE review_status='pending' ORDER BY created_at DESC LIMIT 100")).rows;}
 async function reviewRisk(actor,input){await getPolicy(actor);const v=z.object({signalId:z.number().int().positive(),decision:z.enum(['reviewed','dismissed']),reason:z.string().trim().min(12).max(500)}).strict().parse(input);
  return db.tx(async c=>{const old=(await c.query('SELECT * FROM operational_risk_signals WHERE id=$1 FOR UPDATE',[v.signalId])).rows[0];check(old,404,'Risk event not found');check(old.review_status==='pending',409,'Already reviewed');
   await c.query('UPDATE operational_risk_signals SET review_status=$2 WHERE id=$1',[v.signalId,v.decision]);
   await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,`risk.${v.decision}.${v.reason}`,old.shipment_id]);
   return {signalId:v.signalId,decision:v.decision};});
 }
 /** Bounded administrator preview; never makes an exclusive assignment or payment. */
 async function previewFleetBatch(actor){
  await getPolicy(actor);check(await features.enabled('fleet_batch_optimization'),409,'Fleet planning experiment disabled');
  const rows=(await db.query(`SELECT s.id,q.request,s.payment_method,s.commission_minor FROM shipments s JOIN quotes q ON q.id=s.quote_id
   WHERE s.state='AWAITING_ASSIGNMENT' AND (s.paid OR s.payment_method='CASH')
   ORDER BY s.created_at LIMIT 4`)).rows;
  const riderCandidates=new Map(),perOrder=[];
  for(const sh of rows){
   const eligible=await nearby(sh.request.pickup,sh.request.weightG,{shipmentId:sh.id,parcelCategory:sh.request.parcelCategory??'general',parcelSize:sh.request.parcelSize??'small'});
   const allowed=[];for(const r of eligible){
    if(sh.payment_method==='CASH'){try{await db.tx(c=>cashEligible(c,r.id,sh.commission_minor));}catch(e){if(e.status===403||e.status===409)continue;throw e;}}
    allowed.push(r);
   }
   const rank=await evaluate(allowed,sh.request.pickup);perOrder.push(rank);
   for(const candidate of rank.slice(0,10))riderCandidates.set(candidate.id,candidate);
  }
  const riderIds=[...riderCandidates.keys()].slice(0,20);
  const costs=perOrder.map(rank=>riderIds.map(id=>rank.find(x=>x.id===id)?.roadEtaSeconds??Infinity));
  const plan=minCostBipartiteAssignment(costs);
  return {mode:'read_only_advisory',ordersConsidered:rows.length,driversConsidered:riderIds.length,
   totalPickupEtaSeconds:Number.isFinite(plan.cost)?plan.cost:null,
   suggestions:plan.matches.map(x=>({shipmentId:rows[x.job].id,riderId:riderIds[x.rider],estimatedRoadPickupSeconds:costs[x.job][x.rider]})),
   disclaimer:'Not an assignment or guaranteed availability. All delivery offers still require final authorization and rider acceptance.'};
 }
 async function trackingSettings(actor){check(actor?.kind==='rider',403,'Rider credentials required');const p=await policy(db);return {movingUploadSeconds:p.moving_upload_seconds,idleUploadSeconds:p.idle_upload_seconds,locationFreshSeconds:p.fresh_seconds,privacyRetentionHours:p.sample_retention_hours};}
 async function vehiclePolicy(actor){await getPolicy(actor);return (await db.query('SELECT * FROM vehicle_capabilities ORDER BY vehicle')).rows;}
 async function setVehiclePolicy(actor,input){await getPolicy(actor);const v=z.object({vehicle:z.enum(['bicycle','motorcycle','tricycle','car','pickup','van','truck']),maxParcelSize:z.enum(['small','medium','large']),allowedCategories:z.array(z.enum(['general','documents','fragile','food'])).min(1).max(4),enabled:z.boolean()}).strict().parse(input);
  return db.tx(async c=>{await c.query('UPDATE vehicle_capabilities SET max_parcel_size=$2,allowed_categories=$3,enabled=$4 WHERE vehicle=$1',[v.vehicle,v.maxParcelSize,[...new Set(v.allowedCategories)],v.enabled]);await audit(c,actor.id,'dispatch.vehicle_policy_changed',null);return {ok:true};});
 }
 async function riderPosition(actor,input){check(actor?.kind==='rider',403,'Rider credentials required');const v=sampleSchema.parse(input),p=await policy(db);
  const age=(Date.now()-Date.parse(v.observedAt))/1000;
  check(Number.isFinite(age)&&age>=-15&&age<=p.max_sample_age_seconds,400,'Location observation timestamp unavailable or stale');
  check(v.accuracyMeters<=p.max_accuracy_m,422,'GPS accuracy insufficient');check(v.speedMps===undefined||v.speedMps<=p.max_speed_mps,422,'Implausible GPS speed');
  return db.tx(async c=>{
   // Same lock used for accepting offers, preventing races with status/position changes.
   const pre=(await c.query('SELECT company_id FROM riders WHERE id=$1',[actor.id])).rows[0];check(pre,403,'Rider required');
   if(pre.company_id)check((await c.query("SELECT 1 FROM companies WHERE id=$1 AND status='approved' FOR UPDATE",[pre.company_id])).rowCount,403,'Company inactive');
   const r=(await c.query('SELECT * FROM riders WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];authorizedRider(r);
   check(r.online,409,'Rider must be online to share dispatch location');
   if(r.position_at){
    const elapsed=(Date.parse(v.observedAt)-new Date(r.position_at).getTime())/1000;
    check(elapsed>0,409,'Out-of-order or replayed GPS observation');
    // ST_X/ST_Y extracted separately so geography is never trusted as JS-native coordinates.
    const prev=(await c.query('SELECT ST_Y(current_position::geometry) AS latitude,ST_X(current_position::geometry) AS longitude FROM riders WHERE id=$1',[actor.id])).rows[0];
    const speed=haversine(point(prev),v)/elapsed;
    check(speed<=p.max_speed_mps+Math.min(10,(Number(r.position_accuracy_m)+v.accuracyMeters)/Math.max(elapsed,1)),422,'Implausible GPS movement');
    if(await featureService(c).enabled('gps_filtering')){
     const hint=smoothGps({...point(prev),accuracyMeters:Number(r.position_accuracy_m),observedAt:new Date(r.position_at).toISOString()},v,{maxSpeedMps:p.max_speed_mps,maxAccuracyM:p.max_accuracy_m});
     check(hint.accepted,422,'GPS continuity validation rejected observation');
     // Never replace the verified raw GPS record with a fabricated smoothed observation.
    }
   }
   await c.query('UPDATE riders SET current_position=ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,position_at=$4,position_accuracy_m=$5,observed_heading_deg=$6,observed_speed_mps=$7 WHERE id=$1',[actor.id,v.longitude,v.latitude,v.observedAt,v.accuracyMeters,v.headingDegrees??null,v.speedMps??null]);
   await c.query('INSERT INTO rider_location_samples(rider_id,position,observed_at,accuracy_m) VALUES($1,ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,$4,$5)',[actor.id,v.longitude,v.latitude,v.observedAt,v.accuracyMeters]);
   const activeRows=(await c.query("SELECT id,state FROM shipments WHERE rider_id=$1 AND state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP') ORDER BY created_at",[actor.id])).rows;
   const trackedShipmentIds=[];
   if(activeRows.length){
    const planRow=(await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1',[actor.id])).rows[0];
    const stops=Array.isArray(planRow?.stops)?planRow.stops:[];
    const firstStopShipmentId=stops[0]?.shipmentId??null;
    const hasInCustody=activeRows.some(s=>s.state!=='RIDER_ASSIGNED');
    for(const sh of activeRows){
     const shouldPublish=sh.state!=='RIDER_ASSIGNED'||!stops.length||firstStopShipmentId===sh.id||(!hasInCustody&&activeRows.length===1);
     if(shouldPublish){
      await c.query(`INSERT INTO locations(shipment_id,rider_id,latitude,longitude,updated_at) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(shipment_id) DO UPDATE SET rider_id=EXCLUDED.rider_id,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,updated_at=EXCLUDED.updated_at`,
       [sh.id,actor.id,v.latitude,v.longitude,v.observedAt]);
      trackedShipmentIds.push(sh.id);
     }
    }
   }
   const pendingOffers=(await c.query(`SELECT o.id AS "offerId",o.shipment_id AS id,o.expires_at AS "expiresAt",o.pickup_eta_seconds AS "pickupEtaSeconds",o.pickup_road_meters AS "pickupRoadMeters",o.pickup_road_meters AS distance_m,o.direction,o.quoted_entitlement_minor AS entitlement_minor,o.expected_active AS "existingParcels",o.planned_dropoff_seconds AS "estimatedDropoffSeconds",
     s.amount_minor,s.commission_minor,s.payment_method,s.cash_payer,COALESCE(q.request->>'vehicle',$2) AS vehicle,q.request->>'description' AS description,q.request->'pickup' AS pickup,q.request->'destination' AS destination
    FROM dispatch_offers o JOIN shipments s ON s.id=o.shipment_id JOIN quotes q ON q.id=s.quote_id
    WHERE o.rider_id=$1 AND o.status='offered' AND o.expires_at>now() AND s.state='AWAITING_ASSIGNMENT' AND (s.paid OR s.payment_method='CASH') ORDER BY o.created_at LIMIT 10`,[actor.id,r.vehicle])).rows;
   getRedisClient().saveRiderLocation(actor.id, {
     latitude: v.latitude,
     longitude: v.longitude,
     heading: v.headingDegrees,
     speed: v.speedMps,
     accuracy: v.accuracyMeters,
     observedAt: v.observedAt
   }).catch(() => {});
   return {ok:true,eligibleUntil:new Date(Date.parse(v.observedAt)+p.fresh_seconds*1000).toISOString(),trackedShipments:trackedShipmentIds.length,pendingOffers};
  });
 }
 async function optIn(actor,input){check(actor?.kind==='rider',403,'Rider required');const v=z.object({enabled:z.boolean()}).strict().parse(input);
  return db.tx(async c=>{const r=(await c.query('SELECT * FROM riders WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];authorizedRider(r);
   await c.query('UPDATE riders SET multi_stop_opt_in=$2 WHERE id=$1',[actor.id,v.enabled]);await audit(c,actor.id,'dispatch.multistop_preference',actor.id);return {multiStopOptIn:v.enabled};});
 }
 async function manifest(actor){check(actor?.kind==='rider',403,'Rider required');
  const r=(await db.query('SELECT status,multi_stop_opt_in,vehicle,max_weight_g FROM riders WHERE id=$1',[actor.id])).rows[0];check(r,403);
  const shipments=(await db.query(`SELECT s.id,s.state,s.recipient_phone,s.amount_minor,s.commission_minor,s.payment_method,s.cash_payer,q.request,c.promised_delivery_before
    FROM shipments s JOIN quotes q ON q.id=s.quote_id LEFT JOIN dispatch_commitments c ON c.shipment_id=s.id
    WHERE s.rider_id=$1 AND s.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED') ORDER BY s.created_at`,[actor.id])).rows;
  const plan=(await db.query('SELECT stops,revision FROM rider_dispatch_plans WHERE rider_id=$1',[actor.id])).rows[0];
  const shipmentMap=new Map(shipments.map(s=>[s.id,s]));
  const stops=(plan?.stops??[]).map(st=>{
    const sh=shipmentMap.get(st.shipmentId);
    return {
      ...st,
      id: st.shipmentId,
      state: sh?.state??'RIDER_ASSIGNED',
      recipient_phone: sh?.recipient_phone,
      amount_minor: sh?.amount_minor??0,
      commission_minor: sh?.commission_minor??0,
      payment_method: sh?.payment_method??'CASH',
      cash_payer: sh?.cash_payer??'recipient',
      description: sh?.request?.description??'Package',
      pickup: sh?.request?.pickup,
      destination: sh?.request?.destination
    };
  });
  const finalStops=stops.length?stops:shipments.map(s=>({
    id: s.id,
    shipmentId: s.id,
    kind: s.state==='RIDER_ASSIGNED'?'pickup':'dropoff',
    state: s.state,
    recipient_phone: s.recipient_phone,
    amount_minor: s.amount_minor,
    commission_minor: s.commission_minor,
    payment_method: s.payment_method,
    cash_payer: s.cash_payer,
    description: s.request?.description??'Package',
    pickup: s.request?.pickup,
    destination: s.request?.destination
  }));
  return {optedIn:r.multi_stop_opt_in,vehicle:r.vehicle,capacityG:r.max_weight_g,shipments,stops:finalStops,revision:plan?.revision??0};
 }
 // A previously accepted route must be complete and have explicit delivery deadlines before inserting another parcel.
 async function planForCandidate(r,request,sid,p,routeEngine=routing){
  const active=(await db.query(`SELECT s.id,s.state,q.request,c.promised_delivery_before FROM shipments s
   JOIN quotes q ON q.id=s.quote_id LEFT JOIN dispatch_commitments c ON c.shipment_id=s.id
   WHERE s.rider_id=$1 AND s.state = ANY($2::text[]) ORDER BY s.created_at`,[r.id,activeStates])).rows;
  if(active.length>=p.max_active_parcels||active.some(s=>['FAILED','RETURN_REQUESTED'].includes(s.state)))return null;
  const multiEnabled=p.multi_stop_enabled&&await features.enabled('multi_parcel_vrp')&&await features.enabled('dynamic_pickup_insertion');
  if(active.length&&(!multiEnabled||!r.multi_stop_opt_in||active.some(s=>!s.promised_delivery_before)))return null;
  const plan=(await db.query('SELECT stops,revision FROM rider_dispatch_plans WHERE rider_id=$1',[r.id])).rows[0];
  if(active.length&&!plan)return null;
  const existing=plan?.stops??[];
  if(active.length){const ids=new Set(active.map(s=>s.id));if(existing.length===0||existing.some(s=>!ids.has(s.shipmentId)))return null;
   for(const s of active){if(!existing.some(x=>x.shipmentId===s.id&&x.kind==='dropoff'))return null;
    if(s.state==='RIDER_ASSIGNED'&&!existing.some(x=>x.shipmentId===s.id&&x.kind==='pickup'))return null;
    if(s.state!=='RIDER_ASSIGNED'&&existing.some(x=>x.shipmentId===s.id&&x.kind==='pickup'))return null;
   }
  }
  if(!active.length&&existing.length)return null;
  const onboardIds=active.filter(s=>s.state!=='RIDER_ASSIGNED').map(s=>s.id),newStops=freshStops(sid,request);
  const deadlines=Object.fromEntries(active.map(s=>[s.id,s.promised_delivery_before]));
  const opts={vehicle:r.vehicle,capacityG:r.max_weight_g,deadlines,now:Date.now()+p.offer_seconds*1000,onboardIds,maxPickupSeconds:p.max_pickup_eta_seconds,maxDetourSeconds:p.max_detour_seconds};
  const start=point(r);let result;
  if(active.length)result=await bestInsertion(routeEngine,start,existing,newStops,opts);
  else result=await evaluateStops(routeEngine,start,newStops,{...opts,shipmentId:sid});
  if(!result)return null;
  return {...result,revision:Number(plan?.revision??0),expectedActive:active.length,anchor:{latitude:start.latitude,longitude:start.longitude}};
 }
 async function nearby(pickup,weightG,{shipmentId=null,parcelCategory='general',parcelSize='small',vehicle=null}={}){
  const p=await policy(db);
  const discovery=await discoverByRadii({radiiMeters:p.search_radii_m,limit:p.candidate_limit,queryRadius:async radius=>{
   const result=await db.query(`SELECT r.id,r.company_id,r.vehicle,r.max_weight_g,r.position_at,r.multi_stop_opt_in,
      ST_Y(r.current_position::geometry) AS latitude,ST_X(r.current_position::geometry) AS longitude,
      ST_Distance(r.current_position,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS crow_meters
     FROM riders r LEFT JOIN companies co ON co.id=r.company_id JOIN vehicle_capabilities vc ON vc.vehicle=r.vehicle
     WHERE r.status='approved' AND r.online AND (r.company_id IS NULL OR co.status='approved')
       AND (r.vehicle<>'car' OR EXISTS(SELECT 1 FROM rider_vehicle_registrations vr WHERE vr.rider_id=r.id AND vr.vehicle='car' AND vr.verification_status='approved'))
       AND r.position_at>now()-($3::int * interval '1 second')
       AND r.position_accuracy_m<=$4
       AND r.max_weight_g>=$5 AND vc.enabled AND $9=ANY(vc.allowed_categories) AND ($13::text IS NULL OR r.vehicle=$13)
       AND CASE vc.max_parcel_size WHEN 'large' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END >= CASE $10::text WHEN 'large' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END
       AND ST_DWithin(r.current_position,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,r.service_radius_m)
       AND NOT EXISTS (SELECT 1 FROM shipments failed WHERE failed.rider_id=r.id AND failed.state IN ('FAILED','RETURN_REQUESTED'))
       AND (
         NOT EXISTS (SELECT 1 FROM shipments active WHERE active.rider_id=r.id AND active.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP'))
         OR ($11::boolean AND r.multi_stop_opt_in AND
           (SELECT count(*) FROM shipments active WHERE active.rider_id=r.id AND active.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP')) < $12
           /* Staggered pickup/dropoff capacity is validated against the complete
              ordered parcel manifest by weightCapacityValid, not by summing all jobs. */
         )
       )
       AND ($6::uuid IS NULL OR NOT EXISTS(SELECT 1 FROM dispatch_offers o WHERE o.rider_id=r.id AND o.shipment_id=$6 AND o.status IN ('declined','invalidated','expired')))
       AND ST_DWithin(r.current_position,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,$7)
     ORDER BY r.current_position <-> ST_SetSRID(ST_MakePoint($1,$2),4326)::geography LIMIT $8`,
     [pickup.longitude,pickup.latitude,p.fresh_seconds,p.max_accuracy_m,weightG,shipmentId,radius,p.candidate_limit,parcelCategory,parcelSize,p.multi_stop_enabled&&await features.enabled('multi_parcel_vrp')&&await features.enabled('dynamic_pickup_insertion'),p.max_active_parcels,vehicle]);
   return result.rows;
  }});
  let candidates=discovery.candidates;
  // Extended corridor discovery: riders may be far away as-the-crow-flies, but
  // their *remaining, provider-derived road path* can run close to the pickup.
  // Both PostGIS proximity gates and later full route-insertion feasibility apply.
  if(p.multi_stop_enabled&&await features.enabled('multi_parcel_vrp')&&await features.enabled('dynamic_pickup_insertion')&&await features.enabled('road_corridor_discovery')){
   const corridorRadius=1500; // bounded search envelope; not a replacement for route ETA
   const extra=await db.query(`SELECT r.id,r.company_id,r.vehicle,r.max_weight_g,r.position_at,r.multi_stop_opt_in,
      ST_Y(r.current_position::geometry) AS latitude, ST_X(r.current_position::geometry) AS longitude,
      ST_Distance(r.current_position,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS crow_meters
    FROM rider_route_corridors rc JOIN riders r ON r.id=rc.rider_id
    LEFT JOIN companies co ON co.id=r.company_id JOIN vehicle_capabilities vc ON vc.vehicle=r.vehicle
    WHERE rc.valid_until>now() AND r.online AND r.status='approved' AND r.multi_stop_opt_in
     AND (r.company_id IS NULL OR co.status='approved')
     AND r.position_at>now()-($3::int*interval '1 second') AND r.position_accuracy_m<=$4
     AND r.max_weight_g>=$5 AND vc.enabled AND $9=ANY(vc.allowed_categories) AND ($13::text IS NULL OR r.vehicle=$13)
     AND (r.vehicle<>'car' OR EXISTS(SELECT 1 FROM rider_vehicle_registrations vr WHERE vr.rider_id=r.id AND vr.vehicle='car' AND vr.verification_status='approved'))
     AND CASE vc.max_parcel_size WHEN 'large' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END>=CASE $10::text WHEN 'large' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END
     AND (SELECT count(*) FROM shipments ac WHERE ac.rider_id=r.id AND ac.state=ANY($11::text[]))<$12
     AND NOT EXISTS(SELECT 1 FROM shipments f WHERE f.rider_id=r.id AND f.state IN ('FAILED','RETURN_REQUESTED'))
     AND ($6::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM dispatch_offers o WHERE o.rider_id=r.id AND o.shipment_id=$6 AND o.status IN ('declined','invalidated','expired')))
     AND ST_DWithin(rc.road_path,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,$7)
     AND ST_DWithin(ST_LineSubstring(rc.road_path::geometry,
       ST_LineLocatePoint(rc.road_path::geometry,r.current_position::geometry),1)::geography,
       ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,$7)
    ORDER BY ST_Distance(rc.road_path,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography)
    LIMIT $8`,[pickup.longitude,pickup.latitude,p.fresh_seconds,p.max_accuracy_m,weightG,shipmentId,corridorRadius,p.candidate_limit,parcelCategory,parcelSize,activeStates,p.max_active_parcels,vehicle]);
   const seen=new Set(candidates.map(x=>x.id));for(const row of extra.rows)if(!seen.has(row.id)){candidates.push(row);seen.add(row.id);}
  }
  return vehicle?candidates.filter(r=>r.vehicle===vehicle):candidates;
 }
 async function availability(input){const v=z.object({pickup:z.object({latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180)}).passthrough(),vehicle:z.enum(['motorcycle','car','van']).optional(),weightG:z.number().int().positive(),parcelCategory:z.enum(['general','documents','fragile','food']).default('general'),parcelSize:z.enum(['small','medium','large']).default('small')}).parse(input);
  const riders=await nearby(v.pickup,v.weightG,{vehicle:v.vehicle,parcelCategory:v.parcelCategory,parcelSize:v.parcelSize});return {status:riders.length?'potential':'none_identified',eligibleNearbyCount:riders.length,guaranteed:false,note:'A nearby rider has not necessarily accepted. Road feasibility and rider acceptance remain unconfirmed.'};
 }
 async function evaluate(candidates,pickup,{request=null,shipmentId=null,dispatchPolicy=null}={}){
  const byVehicle=new Map();for(const c of candidates){if(!byVehicle.has(c.vehicle))byVehicle.set(c.vehicle,[]);byVehicle.get(c.vehicle).push(c);}
  const memoRouting=memoRoadRouting(routing);
  const ranked=[];let routingFailures=0;const calibrate=await features.enabled('eta_calibration');
  for(const [vehicle,group] of byVehicle){
   let samples=[];
   if(calibrate){
    const result=await db.query(`SELECT o.pickup_eta_seconds AS "predictedSeconds",
       EXTRACT(EPOCH FROM (ch.consumed_at-o.accepted_at))::float AS "actualSeconds",true AS verified
     FROM dispatch_offers o JOIN riders rr ON rr.id=o.rider_id
     JOIN challenges ch ON ch.shipment_id=o.shipment_id AND ch.rider_id=o.rider_id AND ch.purpose='pickup'
     WHERE rr.vehicle=$1 AND o.status='accepted' AND o.accepted_at IS NOT NULL
       AND ch.consumed_at>o.accepted_at AND ch.consumed_at<o.accepted_at+interval '2 hours'
     ORDER BY ch.consumed_at DESC LIMIT 200`,[vehicle]);samples=result.rows;
   }
   let routes=[];try{
    routes=await roadMatrixBatched(routing,group.map(point),pickup,{vehicle,batchSize:25});
   }catch{routingFailures++;continue;}
   for(let i=0;i<group.length;i++){const r=routes[i];if(!r||r.source==='haversine'||!Number.isFinite(r.durationSeconds)||!Number.isFinite(r.distanceMeters))continue;
    const row=group[i];let direction='unknown';
    const prev=(await db.query(`SELECT ST_Y(position::geometry) AS latitude,ST_X(position::geometry) AS longitude,observed_at AS "observedAt"
       FROM rider_location_samples WHERE rider_id=$1 AND observed_at<$2 ORDER BY observed_at DESC LIMIT 1`,[row.id,row.position_at])).rows[0];
    if(prev&&await features.enabled('direction_matching')){try{const old=await routing.route(point(prev),pickup,{vehicle});direction=classifyMovement({previous:{...point(prev),observedAt:prev.observedAt},current:{...point(row),observedAt:row.position_at},priorEtaSeconds:old.durationSeconds,currentEtaSeconds:r.durationSeconds});}catch{/* not enough credible evidence */}}
    let plan=null;
    if(request&&shipmentId){plan=await planForCandidate(row,request,shipmentId,dispatchPolicy,memoRouting);if(!plan)continue;
     if(await features.enabled('road_corridor_discovery')){
      try{plan.corridor=await buildRemainingRoadCorridor(memoRouting,point(row),plan.stops,{vehicle});}
      catch{plan.corridor=null;} // No imaginary straight-line corridor when provider fails.
     }
    }
    const providerEta=plan?.pickupEtaSeconds??r.durationSeconds;
    const eta=calibrate?calibrateETA(providerEta,samples):{durationSeconds:providerEta,calibrated:false};
    ranked.push({...row,roadMeters:r.distanceMeters,roadEtaSeconds:eta.durationSeconds,roadProviderEtaSeconds:providerEta,etaCalibrated:eta.calibrated,direction,plan});
   }
  }
  if(!ranked.length&&routingFailures>0)check(false,503,'No working road routing profile for nearby eligible riders');
  // ETA strictly dominates distance. Direction only breaks exact ETA ties.
  return eligibleAndRank(ranked.map(r=>({...r,eligible:true,locationFresh:true,vehicleFits:true,
   capacityFits:true,roadVerified:true,pickupEtaSeconds:r.roadEtaSeconds,approaching:r.direction==='approaching'})),
   {maxPickupEtaSeconds:dispatchPolicy?.max_pickup_eta_seconds??7200});
 }
 async function dispatchShipment(sid){uuid.parse(sid);
  const sh=(await db.query(`SELECT s.*,q.request FROM shipments s JOIN quotes q ON q.id=s.quote_id WHERE s.id=$1`,[sid])).rows[0];check(sh,404,'Shipment unavailable');
  if(sh.state!=='AWAITING_ASSIGNMENT'||!(sh.paid||sh.payment_method==='CASH'))return {status:'not_dispatchable'};
  if(!await foodDispatchAllowed(db,sid))return {status:'awaiting_paid_kitchen_acceptance'};
  const p=await policy(db);if(sh.dispatch_attempts>=p.max_attempts)return {status:'manual_review_required'};
  const nearbyRiders=await nearby(sh.request.pickup,sh.request.weightG,{vehicle:sh.request.vehicle??null,shipmentId:sid,parcelCategory:sh.request.parcelCategory??'general',parcelSize:sh.request.parcelSize??'small'});
  // Avoid buying route-matrix calls for riders already blocked by commission policy.
  // Acceptance STILL independently revalidates under a locked rider transaction.
  const eligible=[];
  for(const r of nearbyRiders){
   try{
    await db.tx(async c=>{
     const weekly=await evaluateRiderWeeklyEligibility(c,r.id);
     check(weekly.eligible,409,`Rider commission eligibility: ${weekly.reason}`);
     await requireDebtEligible(c,r.id);
     if(sh.payment_method==='CASH')await cashEligible(c,r.id,sh.commission_minor);
    });
    eligible.push(r);
   }catch(e){if(e.status!==403&&e.status!==409)throw e;}
  }
  let ranked;try{ranked=await evaluate(eligible,sh.request.pickup,{request:sh.request,shipmentId:sid,dispatchPolicy:p});}catch(e){
   // Backoff routing-provider outages, never fabricate straight-line success.
   await db.tx(async c=>{const current=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[sid])).rows[0];
    if(current?.state==='AWAITING_ASSIGNMENT'&&(current.paid||current.payment_method==='CASH')){await c.query("UPDATE shipments SET next_dispatch_at=now()+($2::int*interval '1 second'),dispatch_attempts=dispatch_attempts+1 WHERE id=$1",[sid,p.retry_seconds]);await audit(c,null,'dispatch.routing_unavailable',sid);}
   });return {status:'routing_unavailable',retryAfterSeconds:p.retry_seconds,code:e.status??'routing_error'};
  }
  return db.tx(async c=>{
   const s=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[sid])).rows[0];check(s,404);
   if(s.state!=='AWAITING_ASSIGNMENT'||!(s.paid||s.payment_method==='CASH'))return {status:'not_dispatchable'};
   if(!await foodDispatchAllowed(c,sid))return {status:'awaiting_paid_kitchen_acceptance'};
   await c.query("UPDATE dispatch_offers SET status='expired' WHERE shipment_id=$1 AND status='offered' AND expires_at<=now()",[sid]);
   if((await c.query("SELECT 1 FROM dispatch_offers WHERE shipment_id=$1 AND status='offered'",[sid])).rowCount)return {status:'offer_pending'};
   if(s.dispatch_attempts>=p.max_attempts)return {status:'manual_review_required'};
   const broadcast=await features.enabled('multi_rider_broadcast');
   const selected=[];
   // The shortlist is already road-feasible, sorted by verified road ETA.
   // Check each candidate again; advisory candidate discovery does NOT grant access.
   for(const r of ranked){
    const current=(await c.query(`SELECT r.id FROM riders r LEFT JOIN companies co ON co.id=r.company_id JOIN vehicle_capabilities vc ON vc.vehicle=r.vehicle
      WHERE r.id=$1 AND r.online AND r.status='approved' AND (r.company_id IS NULL OR co.status='approved')
       AND r.position_at>now()-($2::int * interval '1 second') AND r.max_weight_g>=$3 AND vc.enabled
       AND $4=ANY(vc.allowed_categories) AND CASE vc.max_parcel_size WHEN 'large' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END >= CASE $5::text WHEN 'large' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END
       AND (r.vehicle<>'car' OR EXISTS(SELECT 1 FROM rider_vehicle_registrations vr WHERE vr.rider_id=r.id AND vr.vehicle='car' AND vr.verification_status='approved'))`,
      [r.id,p.fresh_seconds,sh.request.weightG,sh.request.parcelCategory??'general',sh.request.parcelSize??'small'])).rowCount;
    const snapshot=(await c.query('SELECT revision FROM rider_dispatch_plans WHERE rider_id=$1',[r.id])).rows[0];
    const active=(await c.query('SELECT count(*)::int AS n FROM shipments WHERE rider_id=$1 AND state=ANY($2::text[])',[r.id,activeStates])).rows[0].n;
    const found=current && active===r.plan?.expectedActive && Number(snapshot?.revision??0)===r.plan?.revision;
    if(found)selected.push(r);
    if(found&&!broadcast)break;
   }
   const attempts=s.dispatch_attempts+1;
   await c.query("UPDATE shipments SET dispatch_attempts=$2,next_dispatch_at=now()+($3::int * interval '1 second') WHERE id=$1",[sid,attempts,p.retry_seconds]);
   if(!selected.length){await audit(c,null,'dispatch.no_candidate',sid);return {status:'no_road_eligible_rider',attempt:attempts};}
   const offered=[];
   for(const rider of selected){
    const offerId=randomUUID();
    await c.query(`INSERT INTO dispatch_offers(id,shipment_id,rider_id,pickup_eta_seconds,pickup_road_meters,direction,quoted_entitlement_minor,expires_at,plan_revision,proposed_stops,anchor_lat,anchor_lon,expected_active,planned_dropoff_seconds,route_corridor_geojson)
     VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8::int*interval '1 second'),$9,$10,$11,$12,$13,$14,$15)`,
     [offerId,sid,rider.id,rider.roadEtaSeconds,rider.roadMeters,rider.direction,Number(BigInt(s.amount_minor)-BigInt(s.commission_minor)),p.offer_seconds,rider.plan.revision,JSON.stringify(rider.plan.stops),rider.plan.anchor.latitude,rider.plan.anchor.longitude,rider.plan.expectedActive,rider.plan.dropoffEtaSeconds,rider.plan.corridor?JSON.stringify(rider.plan.corridor):null]);
    await c.query('INSERT INTO outbox(shipment_id,kind,payload) VALUES($1,$2,$3)',[sid,'dispatch.offer_for_rider',JSON.stringify({shipmentId:sid,offerId,riderId:rider.id,expiresInSeconds:p.offer_seconds})]);
    offered.push({offerId,riderId:rider.id,pickupEtaSeconds:rider.roadEtaSeconds});
   }
   await audit(c,null,'dispatch.offers_created',sid);
   // No customer identity or phone numbers returned in broadcast telemetry.
   return {status:'offered',offerCount:offered.length,attempt:attempts,broadcast,
    // Backwards-compatible worker result for the existing single-offer flow.
    ...(!broadcast?{offerId:offered[0].offerId,riderId:offered[0].riderId,pickupEtaSeconds:offered[0].pickupEtaSeconds}:{} )};
  });
 }
 async function offers(actor){check(actor?.kind==='rider',403,'Rider credentials required');return db.tx(async c=>{
  const pre=(await c.query('SELECT company_id FROM riders WHERE id=$1',[actor.id])).rows[0];check(pre,403,'Rider required');
  if(pre.company_id)check((await c.query("SELECT 1 FROM companies WHERE id=$1 AND status='approved' FOR UPDATE",[pre.company_id])).rowCount,403,'Company inactive');
  const r=(await c.query("SELECT * FROM riders WHERE id=$1 AND status='approved' FOR UPDATE",[actor.id])).rows[0];authorizedRider(r);check(r.online,409,'Go online first');
  return (await c.query(`SELECT o.id AS "offerId",o.shipment_id AS id,o.expires_at AS "expiresAt",o.pickup_eta_seconds AS "pickupEtaSeconds",o.pickup_road_meters AS "pickupRoadMeters",o.pickup_road_meters AS distance_m,o.direction,o.quoted_entitlement_minor AS entitlement_minor,o.expected_active AS "existingParcels",o.planned_dropoff_seconds AS "estimatedDropoffSeconds",
    s.amount_minor,s.commission_minor,s.payment_method,s.cash_payer,COALESCE(q.request->>'vehicle',$2) AS vehicle,q.request->>'description' AS description,q.request->'pickup' AS pickup,q.request->'destination' AS destination
   FROM dispatch_offers o JOIN shipments s ON s.id=o.shipment_id JOIN quotes q ON q.id=s.quote_id
   WHERE o.rider_id=$1 AND o.status='offered' AND o.expires_at>now() AND s.state='AWAITING_ASSIGNMENT' AND (s.paid OR s.payment_method='CASH') ORDER BY o.created_at LIMIT 30`,[actor.id,r.vehicle])).rows;
 });}
 async function accept(actor,sid,offerId){uuid.parse(sid);uuid.parse(offerId);check(actor?.kind==='rider',403,'Rider credentials required');
  return db.tx(async c=>{
   // Company -> rider -> shipment -> offer lock order is consistent with existing verification methods.
   const pre=(await c.query('SELECT company_id FROM riders WHERE id=$1',[actor.id])).rows[0];check(pre,403,'Rider required');
   if(pre.company_id)check((await c.query("SELECT 1 FROM companies WHERE id=$1 AND status='approved' FOR UPDATE",[pre.company_id])).rowCount,403,'Company suspended');
   const r=(await c.query('SELECT * FROM riders WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];authorizedRider(r);check(r.online,409,'Rider offline');
   const s=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[sid])).rows[0];check(s,404);
   check((s.paid||s.payment_method==='CASH')&&s.state==='AWAITING_ASSIGNMENT',409,'Shipment already assigned or unavailable');
   check(await foodDispatchAllowed(c,sid),409,'Food order awaits verified payment and kitchen acceptance');
   const o=(await c.query("SELECT * FROM dispatch_offers WHERE id=$1 AND shipment_id=$2 AND rider_id=$3 FOR UPDATE",[offerId,sid,actor.id])).rows[0];
   check(o&&o.status==='offered'&&new Date(o.expires_at)>new Date(),409,'Offer expired or not assigned to rider');
   const p=await policy(c);check(r.position_at&&new Date(r.position_at).getTime()>Date.now()-p.fresh_seconds*1000,409,'Location refresh required');
   const location=(await c.query('SELECT ST_Y(current_position::geometry) AS latitude,ST_X(current_position::geometry) AS longitude FROM riders WHERE id=$1',[actor.id])).rows[0];
   check(location?.latitude!==null&&haversine(point(location),{latitude:o.anchor_lat,longitude:o.anchor_lon})<=p.max_offer_movement_m,409,'Rider moved: fresh road offer required');
   const q=(await c.query('SELECT request FROM quotes WHERE id=$1',[s.quote_id])).rows[0];check(q.request.weightG<=r.max_weight_g,409,'Vehicle capacity exceeded');
   check(!q.request.vehicle||q.request.vehicle===r.vehicle,409,'Vehicle does not match accepted quote');
   const vc=(await c.query('SELECT * FROM vehicle_capabilities WHERE vehicle=$1 AND enabled',[r.vehicle])).rows[0];
   check(vc&&vc.allowed_categories.includes(q.request.parcelCategory??'general')&&({small:1,medium:2,large:3})[vc.max_parcel_size]>=({small:1,medium:2,large:3})[q.request.parcelSize??'small'],409,'Vehicle restriction changed');
   if(r.vehicle==='car')check((await c.query("SELECT 1 FROM rider_vehicle_registrations WHERE rider_id=$1 AND vehicle='car' AND verification_status='approved'",[actor.id])).rowCount,403,'Car not verified');
   const plan=(await c.query('SELECT * FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE',[actor.id])).rows[0];
   const active=(await c.query('SELECT s.id,s.state,q.request FROM shipments s JOIN quotes q ON q.id=s.quote_id WHERE s.rider_id=$1 AND s.state=ANY($2::text[])',[actor.id,activeStates])).rows;
   check(active.length===o.expected_active&&Number(plan?.revision??0)===Number(o.plan_revision),409,'Manifest changed: fresh offer required');
   check(!(await c.query("SELECT 1 FROM challenges ch JOIN shipments sh ON sh.id=ch.shipment_id WHERE sh.rider_id=$1 AND ch.consumed_at IS NULL AND ch.expires_at>now()",[actor.id])).rowCount,409,'Active OTP handover must finish before new route is accepted');
   check(active.length<p.max_active_parcels&&!active.some(s=>['FAILED','RETURN_REQUESTED'].includes(s.state)),409,'Unresolved custody or parcel limit');
   check(active.length===0||(p.multi_stop_enabled&&r.multi_stop_opt_in&&await features.enabled('multi_parcel_vrp')&&await features.enabled('dynamic_pickup_insertion')),409,'Multi-parcel approval required');
   const proposed=o.proposed_stops;
   check(Array.isArray(proposed)&&proposed.length<=p.max_active_parcels*2&&
    proposed.filter(x=>x.shipmentId===sid&&x.kind==='pickup').length===1&&
    proposed.filter(x=>x.shipmentId===sid&&x.kind==='dropoff').length===1,409,'Missing verified delivery route');
   const expected=new Set([sid,...active.map(s=>s.id)]);
   check(proposed.every(x=>expected.has(x.shipmentId)&&['pickup','dropoff'].includes(x.kind)),409,'Unexpected shipment in route');
   const onboard=active.filter(x=>x.state!=='RIDER_ASSIGNED').map(x=>x.id);
   check(weightCapacityValid(proposed,onboard,r.max_weight_g),409,'Vehicle capacity/order constraints violated');
   for(const current of active){
    check(proposed.filter(x=>x.shipmentId===current.id&&x.kind==='dropoff').length===1,409,'Accepted parcel dropoff omitted');
    check(proposed.filter(x=>x.shipmentId===current.id&&x.kind==='pickup').length===(current.state==='RIDER_ASSIGNED'?1:0),409,'Accepted parcel custody sequence changed');
   }
   check(s.amount_minor-s.commission_minor===o.quoted_entitlement_minor,409,'Compensation changed: fresh offer required');
   const weekly=await evaluateRiderWeeklyEligibility(c,actor.id);
   check(weekly.eligible,409,`Rider commission eligibility: ${weekly.reason}`);
   // Locks commission_accounts (same lock as commission posting/repayment) so a concurrent debt
   // increase cannot slip an assignment past the configured debt limit.
   await requireDebtEligible(c,actor.id);
   if(s.payment_method==='CASH')await cashEligible(c,actor.id,s.commission_minor);
   await c.query("UPDATE dispatch_offers SET status='accepted',accepted_at=now() WHERE id=$1",[o.id]);
   await c.query("UPDATE dispatch_offers SET status='invalidated' WHERE shipment_id=$1 AND id<>$2 AND status='offered'",[sid,o.id]);
   await c.query("UPDATE shipments SET rider_id=$2,company_id=$3,state='RIDER_ASSIGNED',watchdog_last_inspected_at=NULL,watchdog_next_review_at=NULL WHERE id=$1",[sid,r.id,r.company_id]);
   await c.query(`INSERT INTO rider_dispatch_plans(rider_id,revision,stops) VALUES($1,1,$2)
      ON CONFLICT(rider_id) DO UPDATE SET revision=rider_dispatch_plans.revision+1,stops=$2,updated_at=now()`,[r.id,JSON.stringify(o.proposed_stops)]);
   await c.query("INSERT INTO dispatch_commitments(shipment_id,rider_id,promised_delivery_before) VALUES($1,$2,now()+($3::int * interval '1 second'))",[sid,r.id,o.planned_dropoff_seconds+p.delivery_slack_seconds]);
   if(!Array.isArray(o.proposed_stops)||!o.proposed_stops.length||o.proposed_stops[0]?.shipmentId===sid){
    await c.query(`INSERT INTO locations(shipment_id,rider_id,latitude,longitude,updated_at) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(shipment_id) DO UPDATE SET rider_id=EXCLUDED.rider_id,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,updated_at=EXCLUDED.updated_at`,
     [sid,r.id,location.latitude,location.longitude,r.position_at]);
   }
   if(o.route_corridor_geojson?.type==='LineString'){
    // Corridors contain provider-certified road geometry, never straight-line shortcuts.
    await c.query(`INSERT INTO rider_route_corridors(rider_id,road_path,plan_revision,valid_until)
     VALUES($1,ST_SetSRID(ST_GeomFromGeoJSON($2),4326)::geography,$3,now()+interval '20 minutes')
     ON CONFLICT(rider_id) DO UPDATE SET road_path=EXCLUDED.road_path,plan_revision=EXCLUDED.plan_revision,refreshed_at=now(),valid_until=EXCLUDED.valid_until`,
     [r.id,JSON.stringify(o.route_corridor_geojson),Number(plan?.revision??0)+1]);
   }
   await c.query('INSERT INTO outbox(shipment_id,kind,payload) VALUES($1,$2,$3)',[sid,'dispatch.offer_withdrawn',JSON.stringify({shipmentId:sid,winnerRiderId:r.id})]);
   await audit(c,actor.id,'dispatch.assignment_accepted',sid);await change(c,sid,'assigned');return {ok:true,shipmentId:sid,riderEarningsMinor:o.quoted_entitlement_minor};
  });
 }
 async function decline(actor,sid,offerId){uuid.parse(sid);uuid.parse(offerId);check(actor?.kind==='rider',403);
  return db.tx(async c=>{
   const s=(await c.query('SELECT id FROM shipments WHERE id=$1 FOR UPDATE',[sid])).rows[0];check(s,404);
   const changed=await c.query("UPDATE dispatch_offers SET status='declined' WHERE id=$1 AND shipment_id=$2 AND rider_id=$3 AND status='offered' AND expires_at>now() RETURNING id",[offerId,sid,actor.id]);check(changed.rowCount,409,'Offer cannot be declined');
   await c.query('UPDATE shipments SET next_dispatch_at=now() WHERE id=$1',[sid]);await audit(c,actor.id,'dispatch.offer_declined',sid);return {ok:true};
  });
 }
 async function release(actor,sid,reason){uuid.parse(sid);check(actor?.kind==='rider'&&typeof reason==='string'&&reason.trim().length>=5&&reason.length<=500,400,'Rider release reason required');return db.tx(async c=>{
   const pre=(await c.query('SELECT company_id FROM riders WHERE id=$1',[actor.id])).rows[0];check(pre,403,'Rider required');
   if(pre.company_id)await c.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[pre.company_id]);
   const r=(await c.query('SELECT * FROM riders WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];check(r,403,'Rider required');
   const s=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[sid])).rows[0];check(s,404,'Shipment unavailable');check(s.rider_id===actor.id,403,'Assigned rider required');check(['RIDER_ASSIGNED','FAILED'].includes(s.state),409,'Pickup custody started or assignment no longer releasable');
   check(!(await c.query("SELECT 1 FROM challenges WHERE shipment_id=$1 AND purpose='pickup' AND consumed_at IS NOT NULL",[sid])).rowCount,409,'Parcel already collected');
   check(!(await c.query('SELECT 1 FROM cash_collections WHERE shipment_id=$1',[sid])).rowCount,409,'Cash already reported: manual reassignment and reconciliation required');
   await c.query('UPDATE challenges SET expires_at=now() WHERE shipment_id=$1 AND consumed_at IS NULL',[sid]);
   await c.query("UPDATE dispatch_offers SET status='invalidated' WHERE shipment_id=$1 AND status IN ('offered','accepted')",[sid]);
   await c.query("UPDATE shipments SET state='AWAITING_ASSIGNMENT',rider_id=NULL,company_id=NULL,next_dispatch_at=now(),dispatch_attempts=0 WHERE id=$1",[sid]);
   const m=(await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE',[actor.id])).rows[0];
   if(m)await c.query('UPDATE rider_dispatch_plans SET stops=$2,revision=revision+1,updated_at=now() WHERE rider_id=$1',[actor.id,JSON.stringify(m.stops.filter(x=>x.shipmentId!==sid))]);
   // A released commitment belongs to the old rider. Delete it so a subsequent
   // eligible rider can atomically create a fresh deadline on acceptance.
   // The release/old owner remains reconstructible from append-only audit and offers.
   await c.query('DELETE FROM dispatch_commitments WHERE shipment_id=$1 AND rider_id=$2',[sid,actor.id]);
   await c.query('DELETE FROM locations WHERE shipment_id=$1',[sid]);
   await c.query("INSERT INTO dispatch_exceptions(shipment_id,actor_id,kind,reason) VALUES($1,$2,'pre_pickup_rider_release',$3)",[sid,actor.id,reason.trim()]);
   await audit(c,actor.id,'dispatch.rider_released_pre_pickup',sid);await change(c,sid,'dispatch.reassignment_needed');return {status:'AWAITING_ASSIGNMENT',reassignmentPending:true};
  });}
 /** Refresh remaining ROUTED corridor after each parcel stop or meaningful route-plan change.
  * Provider requests occur OUTSIDE DB transactions; optimistic plan revision guards the write.
  * Failed routing cannot manufacture a synthetic corridor. */
 async function refreshCorridors(limit=2){
  if(!await features.enabled('road_corridor_discovery'))return {status:'disabled'};
  const p=await policy(db);if(!p.multi_stop_enabled||!await features.enabled('multi_parcel_vrp')||!await features.enabled('dynamic_pickup_insertion'))return {status:'multi_stop_disabled'};
  const results=[];
  const rows=(await db.query(`SELECT plan.rider_id,plan.revision,plan.stops,r.vehicle,
    ST_Y(r.current_position::geometry) AS latitude,ST_X(r.current_position::geometry) AS longitude
   FROM rider_dispatch_plans plan JOIN riders r ON r.id=plan.rider_id
   LEFT JOIN rider_route_corridors rc ON rc.rider_id=plan.rider_id
   WHERE r.online AND r.status='approved' AND r.position_at>now()-($1::int*interval '1 second')
    AND jsonb_array_length(plan.stops)>0 AND jsonb_array_length(plan.stops)<=30
    AND (rc.rider_id IS NULL OR rc.plan_revision<>plan.revision OR rc.valid_until<now()+interval '2 minutes')
   ORDER BY plan.updated_at DESC LIMIT $2`,[p.fresh_seconds,limit])).rows;
  for(const row of rows){
   try{
    const geom=await buildRemainingRoadCorridor(routing,point(row),row.stops,{vehicle:row.vehicle});
    if(!geom)continue;
    const updated=await db.query(`INSERT INTO rider_route_corridors(rider_id,road_path,plan_revision,valid_until)
      SELECT $1,ST_SetSRID(ST_GeomFromGeoJSON($3),4326)::geography,$2,now()+interval '20 minutes'
      FROM rider_dispatch_plans p WHERE p.rider_id=$1 AND p.revision=$2
      ON CONFLICT(rider_id) DO UPDATE SET road_path=EXCLUDED.road_path,plan_revision=EXCLUDED.plan_revision,
        refreshed_at=now(),valid_until=EXCLUDED.valid_until`,[row.rider_id,row.revision,JSON.stringify(geom)]);
    if(updated.rowCount)results.push(row.rider_id);
   }catch{/* Do not claim corridor coverage when provider/plan changed. */}
  }
  return {refreshed:results.length,checked:rows.length};
 }
 async function pruneSamples(){const p=await policy(db);
   getRedisClient().purgeStaleRiders(p.fresh_seconds || 120).catch(() => 0);
   return db.tx(async c=>{
  const samples=await c.query(`DELETE FROM rider_location_samples WHERE observed_at<now()-($1::int*interval '1 hour')
    AND NOT EXISTS (SELECT 1 FROM disputes d JOIN shipments s ON d.shipment_id=s.id WHERE s.rider_id=rider_location_samples.rider_id AND d.status='open')
    AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.rider_id=rider_location_samples.rider_id AND s.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED'))`,[p.sample_retention_hours]);
  const snapshots=await c.query(`UPDATE riders SET current_position=NULL,position_at=NULL,position_accuracy_m=NULL,observed_heading_deg=NULL,observed_speed_mps=NULL WHERE position_at<now()-($1::int*interval '1 hour')
    AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.rider_id=riders.id AND s.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED'))`,[p.sample_retention_hours]);
  const tracking=await c.query(`DELETE FROM locations WHERE updated_at<now()-($1::int*interval '1 hour')
    AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.shipment_id=locations.shipment_id AND d.status='open')
    AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.id=locations.shipment_id AND s.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED'))`,[p.sample_retention_hours]);
  return {removedSamples:samples.rowCount,removedRiderSnapshots:snapshots.rowCount,removedShipmentTracking:tracking.rowCount};
  });}
 async function watchdog({limit=25,staleGpsSeconds=null,pickupGraceSeconds=null,reviewIntervalSeconds=60,autoReassignPreCustody=true,onlyDueReviews=false}={}){
  check(Number.isInteger(limit)&&limit>=1&&limit<=100,400,'Invalid watchdog batch size');
  const p=await policy(db);
  const staleSec=Number.isInteger(staleGpsSeconds)&&staleGpsSeconds>0?staleGpsSeconds:Math.max(Number(p.fresh_seconds||120)*2,180);
  const pickupGraceSec=Number.isInteger(pickupGraceSeconds)&&pickupGraceSeconds>0?pickupGraceSeconds:Math.max(Number(p.delivery_slack_seconds||600),300);
  const reviewSec=Number.isInteger(reviewIntervalSeconds)&&reviewIntervalSeconds>=1?reviewIntervalSeconds:60;
  const candidates=(await db.query(`
   SELECT s.id, s.rider_id, r.company_id, s.state, s.customer_id,
          f.id AS food_order_id, f.ready_at, f.state AS food_state,
          r.online AS rider_online, r.position_at AS rider_position_at,
          l.updated_at AS location_updated_at,
          dc.promised_delivery_before,
          (SELECT o.accepted_at FROM dispatch_offers o WHERE o.shipment_id=s.id AND o.rider_id=s.rider_id AND o.status='accepted' ORDER BY o.accepted_at DESC LIMIT 1) AS offer_accepted_at,
          (SELECT o.pickup_eta_seconds FROM dispatch_offers o WHERE o.shipment_id=s.id AND o.rider_id=s.rider_id AND o.status='accepted' ORDER BY o.accepted_at DESC LIMIT 1) AS offer_pickup_eta_seconds
   FROM shipments s
   JOIN riders r ON r.id=s.rider_id
   LEFT JOIN food_orders f ON f.shipment_id=s.id
   LEFT JOIN locations l ON l.shipment_id=s.id AND l.rider_id=s.rider_id
   LEFT JOIN dispatch_commitments dc ON dc.shipment_id=s.id AND dc.rider_id=s.rider_id
   WHERE s.rider_id IS NOT NULL
     AND s.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP')
     AND (NOT $4::boolean OR COALESCE(s.watchdog_next_review_at, '-infinity'::timestamptz) <= clock_timestamp())
     AND (
      r.online = false
      OR GREATEST(COALESCE(r.position_at, '-infinity'::timestamptz), COALESCE(l.updated_at, '-infinity'::timestamptz)) < now() - ($1::int * interval '1 second')
      OR (s.state='RIDER_ASSIGNED' AND f.ready_at IS NOT NULL AND f.ready_at < now() - ($2::int * interval '1 second'))
      OR (s.state='RIDER_ASSIGNED' AND EXISTS (
       SELECT 1 FROM dispatch_offers o
       WHERE o.shipment_id=s.id AND o.rider_id=s.rider_id AND o.status='accepted'
         AND o.accepted_at + ((COALESCE(o.pickup_eta_seconds, 300) + $2::int) * interval '1 second') < now()
      ))
      OR (s.state IN ('PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP') AND dc.promised_delivery_before IS NOT NULL AND dc.promised_delivery_before < now())
     )
   ORDER BY
    CASE WHEN COALESCE(s.watchdog_next_review_at, '-infinity'::timestamptz) <= clock_timestamp() THEN 0 ELSE 1 END ASC,
    s.watchdog_last_inspected_at ASC NULLS FIRST,
    s.watchdog_next_review_at ASC NULLS FIRST,
    s.created_at ASC
   LIMIT $3
  `,[staleSec,pickupGraceSec,limit,Boolean(onlyDueReviews)])).rows;
  const results=[];
  for(const cand of candidates){
   try{
    const item=await db.tx(async c=>{
     // Enforce canonical delivery lock hierarchy: companies -> riders -> shipments -> rider_dispatch_plans -> food_orders
     if(cand.company_id)await c.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[cand.company_id]);
     const r=(await c.query('SELECT * FROM riders WHERE id=$1 FOR UPDATE',[cand.rider_id])).rows[0];
     const s=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[cand.id])).rows[0];
     if(!s||!s.rider_id||s.rider_id!==cand.rider_id||!['RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP'].includes(s.state))return null;
     const plan=(await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE',[s.rider_id])).rows[0];
     const f=cand.food_order_id?(await c.query('SELECT * FROM food_orders WHERE id=$1 FOR UPDATE',[cand.food_order_id])).rows[0]:null;
     const loc=(await c.query('SELECT updated_at FROM locations WHERE shipment_id=$1 AND rider_id=$2',[s.id,s.rider_id])).rows[0];
     const dc=(await c.query('SELECT promised_delivery_before FROM dispatch_commitments WHERE shipment_id=$1 AND rider_id=$2',[s.id,s.rider_id])).rows[0];
     const accOffer=(await c.query("SELECT id,accepted_at,pickup_eta_seconds FROM dispatch_offers WHERE shipment_id=$1 AND rider_id=$2 AND status='accepted' ORDER BY accepted_at DESC LIMIT 1",[s.id,s.rider_id])).rows[0];
     const pickedUp=s.state!=='RIDER_ASSIGNED'||
      Boolean((await c.query("SELECT 1 FROM challenges WHERE shipment_id=$1 AND purpose='pickup' AND consumed_at IS NOT NULL",[s.id])).rowCount)||
      Boolean((await c.query('SELECT 1 FROM cash_collections WHERE shipment_id=$1',[s.id])).rowCount)||
      f?.state==='IN_TRANSIT';
     const nowMs=Date.now();
     const latestGpsMs=Math.max(
      r?.position_at?new Date(r.position_at).getTime():-Infinity,
      loc?.updated_at?new Date(loc.updated_at).getTime():-Infinity
     );
     const isStaleGps=!r?.online||!Number.isFinite(latestGpsMs)||(nowMs-latestGpsMs)>staleSec*1000;
     const pickupDeadlineMs=Math.min(
      ...[
       f?.ready_at?new Date(f.ready_at).getTime()+pickupGraceSec*1000:Infinity,
       accOffer?.accepted_at?new Date(accOffer.accepted_at).getTime()+(Number(accOffer.pickup_eta_seconds||300)+pickupGraceSec)*1000:Infinity
      ]
     );
     const isOverduePickup=!pickedUp&&Number.isFinite(pickupDeadlineMs)&&nowMs>pickupDeadlineMs;
     const isOverdueDelivery=pickedUp&&dc?.promised_delivery_before&&nowMs>new Date(dc.promised_delivery_before).getTime();
     const reasons=[];
     const signals=[];
     if(isStaleGps){reasons.push('stale_gps');signals.push({code:'STALE_GPS',severity:pickedUp?'high':'medium'});}
     if(isOverduePickup){reasons.push('overdue_pickup');signals.push({code:'OVERDUE_PICKUP',severity:'medium'});}
     if(isOverdueDelivery){reasons.push('overdue_delivery');signals.push({code:'OVERDUE_DELIVERY',severity:'high'});}
     if(!reasons.length)return null;
     const oldRiderId=s.rider_id;
     for(const sig of signals){
      const existingSig=(await c.query("SELECT id FROM operational_risk_signals WHERE rider_id=$1 AND shipment_id=$2 AND signal_code=$3 AND review_status='pending' LIMIT 1",[oldRiderId,s.id,sig.code])).rows[0];
      if(!existingSig){
       await c.query('INSERT INTO operational_risk_signals(rider_id,shipment_id,signal_code,severity,evidence) VALUES($1,$2,$3,$4,$5)',
        [oldRiderId,s.id,sig.code,sig.severity,JSON.stringify({reasons,foodOrderId:f?.id??null,state:s.state,lastGpsAt:Number.isFinite(latestGpsMs)?new Date(latestGpsMs).toISOString():null,promisedDeliveryBefore:dc?.promised_delivery_before??null})]);
      }
     }
     const reasonSummary=`Watchdog detected ${reasons.join(', ')} for rider ${oldRiderId} in state ${s.state}`;
     if(!pickedUp){
      await c.query("INSERT INTO dispatch_exceptions(shipment_id,actor_id,kind,reason) VALUES($1,NULL,'reassignment_review',$2)",[s.id,reasonSummary]);
      await c.query("INSERT INTO notification_jobs(id,recipient_id,kind,payload) VALUES($1,$2,'delivery_watchdog_alert',$3) ON CONFLICT(id) DO NOTHING",
       [`watchdog-pre:${s.id}:${oldRiderId}`,s.customer_id,JSON.stringify({shipmentId:s.id,orderId:f?.id??null,reasons,action:autoReassignPreCustody?'reassigned_pre_pickup':'reassignment_offered',message:'Your assigned courier became unresponsive before pickup. We are reassigning your delivery to the next available courier.'})]);
      if(autoReassignPreCustody){
       await c.query('UPDATE challenges SET expires_at=now() WHERE shipment_id=$1 AND consumed_at IS NULL',[s.id]);
       await c.query("UPDATE dispatch_offers SET status='invalidated' WHERE shipment_id=$1 AND status IN ('offered','accepted')",[s.id]);
       if(plan&&Array.isArray(plan.stops)){
        await c.query('UPDATE rider_dispatch_plans SET stops=$2,revision=revision+1,updated_at=now() WHERE rider_id=$1',[oldRiderId,JSON.stringify(plan.stops.filter(x=>x.shipmentId!==s.id))]);
       }
       await c.query('DELETE FROM dispatch_commitments WHERE shipment_id=$1',[s.id]);
       await c.query('DELETE FROM locations WHERE shipment_id=$1',[s.id]);
       await c.query("UPDATE shipments SET state='AWAITING_ASSIGNMENT',rider_id=NULL,company_id=NULL,next_dispatch_at=now(),dispatch_attempts=0,watchdog_last_inspected_at=clock_timestamp(),watchdog_next_review_at=NULL WHERE id=$1",[s.id]);
       await chat.revokeRiderConversations(c,{shipmentId:s.id,oldRiderUserId:oldRiderId,reason:'watchdog_reassigned'});
       if(f){
        await c.query('UPDATE food_orders SET dispatch_started_at=now(),watchdog_last_inspected_at=clock_timestamp(),watchdog_next_review_at=NULL,updated_at=now() WHERE id=$1',[f.id]);
        await c.query('INSERT INTO audit_logs(action,entity_id) VALUES($1,$2)',[`food_order.watchdog_reassigned:${reasons.join(',')}`,f.id]);
       }
       await audit(c,null,`dispatch.watchdog_reassigned_pre_pickup:${reasons.join(',')}`,s.id);
       await change(c,s.id,'dispatch.reassignment_needed');
       return {shipmentId:s.id,foodOrderId:f?.id??null,previousRiderId:oldRiderId,status:'reassigned_pre_pickup',reasons,shipmentState:'AWAITING_ASSIGNMENT',supportAlerted:true,reassignmentOffered:true};
      }
      const sched=(await c.query("UPDATE shipments SET watchdog_last_inspected_at=clock_timestamp(),watchdog_next_review_at=clock_timestamp()+($2::int*interval '1 second') WHERE id=$1 RETURNING watchdog_last_inspected_at,watchdog_next_review_at",[s.id,reviewSec])).rows[0];
      if(f)await c.query('UPDATE food_orders SET watchdog_last_inspected_at=$2,watchdog_next_review_at=$3 WHERE id=$1',[f.id,sched?.watchdog_last_inspected_at??new Date(),sched?.watchdog_next_review_at??new Date(Date.now()+reviewSec*1000)]);
      await audit(c,null,`dispatch.watchdog_pre_pickup_alert:${reasons.join(',')}`,s.id);
      return {shipmentId:s.id,foodOrderId:f?.id??null,riderId:oldRiderId,status:'escalated_pre_pickup',reasons,shipmentState:s.state,supportAlerted:true,reassignmentOffered:true,lastInspectedAt:sched?.watchdog_last_inspected_at??null,nextReviewAt:sched?.watchdog_next_review_at??null};
     }
     const existingEx=(await c.query("SELECT 1 FROM dispatch_exceptions WHERE shipment_id=$1 AND kind='reassignment_review' AND created_at>now()-interval '15 minutes' LIMIT 1",[s.id])).rowCount;
     if(!existingEx){
      await c.query("INSERT INTO dispatch_exceptions(shipment_id,actor_id,kind,reason) VALUES($1,NULL,'reassignment_review',$2)",[s.id,reasonSummary]);
     }
     const sched=(await c.query("UPDATE shipments SET watchdog_last_inspected_at=clock_timestamp(),watchdog_next_review_at=clock_timestamp()+($2::int*interval '1 second') WHERE id=$1 RETURNING watchdog_last_inspected_at,watchdog_next_review_at",[s.id,reviewSec])).rows[0];
     if(f)await c.query('UPDATE food_orders SET watchdog_last_inspected_at=$2,watchdog_next_review_at=$3 WHERE id=$1',[f.id,sched?.watchdog_last_inspected_at??new Date(),sched?.watchdog_next_review_at??new Date(Date.now()+reviewSec*1000)]);
     await c.query("INSERT INTO notification_jobs(id,recipient_id,kind,payload) VALUES($1,$2,'delivery_watchdog_alert',$3) ON CONFLICT(id) DO NOTHING",
      [`watchdog-custody:${s.id}:${oldRiderId}:${ reasons.join('_') }`,s.customer_id,JSON.stringify({shipmentId:s.id,orderId:f?.id??null,riderId:oldRiderId,reasons,action:'support_escalated',message:'Delivery monitoring flagged a delay on your active order and alerted operations support.'})]);
     await audit(c,null,`dispatch.watchdog_escalated_in_custody:${reasons.join(',')}`,s.id);
     await change(c,s.id,'dispatch.delivery_escalated');
     return {shipmentId:s.id,foodOrderId:f?.id??null,riderId:oldRiderId,status:'escalated_in_custody',reasons,shipmentState:s.state,supportAlerted:true,reassignmentOffered:false,lastInspectedAt:sched?.watchdog_last_inspected_at??null,nextReviewAt:sched?.watchdog_next_review_at??null};
    });
    if(item)results.push(item);
   }catch(e){results.push({shipmentId:cand.id,foodOrderId:cand.food_order_id??null,status:'error',code:e.code??e.status??'internal'});}
  }
  return results;
 }
 async function tick(limit=8){check(Number.isInteger(limit)&&limit>=1&&limit<=20,400);
  await watchdog({limit});
  const due=(await db.query(`SELECT s.id FROM shipments s WHERE state='AWAITING_ASSIGNMENT' AND (paid OR payment_method='CASH') AND next_dispatch_at<=now()
    AND NOT EXISTS (SELECT 1 FROM food_orders f WHERE f.shipment_id=s.id AND (f.payment_status<>'PAID' OR f.payment_method='CASH' OR f.state NOT IN ('ACCEPTED','PREPARING','READY_FOR_PICKUP')))
    AND NOT EXISTS (SELECT 1 FROM dispatch_offers o WHERE o.shipment_id=s.id AND o.status='offered' AND o.expires_at>now())
    ORDER BY next_dispatch_at,created_at LIMIT $1`,[limit])).rows;
  const results=[];for(const row of due){try{results.push(await dispatchShipment(row.id));}catch(e){results.push({shipmentId:row.id,status:'error',code:e.code??e.status??'internal'});}}return results;
 }
 return {getPolicy,configure,algorithmFeatures:features.list,setAlgorithmFeature:features.set,riskSignals,reviewRisk,previewFleetBatch,trackingSettings,vehiclePolicy,setVehiclePolicy,riderPosition,optIn,manifest,nearby,availability,evaluate,dispatchShipment,offers,accept,decline,release,pruneSamples,refreshCorridors,watchdog,tick};
}
