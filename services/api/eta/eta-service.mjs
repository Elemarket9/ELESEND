import {baselineFactorFor} from './baseline-factors.mjs';
import {check} from '../security.mjs';
import {ETA_ASSUMPTIONS,calculateStageEta,classifyGps,routeDecision,etaRange,stabilizeArrival,etaCustomerMessage,summarizeTripEvidence,travelAdjustment,timeBucket,cityBucket} from './stage-eta.mjs';

const ACTIVE_STATES=new Set(['RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP']);
const EVIDENCE_CACHE_MS=600000;

// Travel measured from pickup to code-verified handover. Excludes kitchen and dispatch waiting.
const TRANSIT_SAMPLES=`
 SELECT p.adjusted_seconds AS "predictedSeconds",
        EXTRACT(EPOCH FROM (done.occurred_at-up.occurred_at))::float AS "actualSeconds",
        p.vehicle,p.delivery_type AS "deliveryType",p.city,p.time_bucket AS "timeBucket",p.road_seconds AS "roadSeconds"
 FROM eta_predictions p
 JOIN delivery_milestones up ON up.shipment_id=p.shipment_id AND up.milestone='picked_up' AND up.rider_id=p.rider_id
 JOIN delivery_milestones done ON done.shipment_id=p.shipment_id AND done.milestone='otp_completed' AND done.rider_id=p.rider_id
 WHERE p.stage IN ('PICKUP_VERIFIED','IN_TRANSIT') AND p.adjusted_seconds IS NOT NULL AND p.predicted_at>=up.occurred_at`;

export function etaService(db,{routing=null,baselineFactors={},routingLabel='osrm',now=()=>Date.now()}={}){
 const evidenceCache=new Map();

 async function evidenceFor({vehicle,deliveryType,city,bucket}){
  const key=[vehicle,deliveryType,city,bucket].join(':'),cached=evidenceCache.get(key);
  if(cached&&cached.expires>now())return cached.value;
  const rows=(await db.query(`${TRANSIT_SAMPLES} AND p.vehicle=$1 AND p.delivery_type=$2 AND p.city=$3 AND p.time_bucket=$4 ORDER BY p.predicted_at DESC LIMIT 500`,[vehicle,deliveryType,city,bucket])).rows;
  // Compare with raw road time, so a past adjustment cannot feed back into the next one.
  const value=summarizeTripEvidence(rows.map(r=>({predictedSeconds:r.roadSeconds,actualSeconds:r.actualSeconds})));
  evidenceCache.set(key,{value,expires:now()+EVIDENCE_CACHE_MS});
  return value;
 }

 async function loadContext(shipmentId){
  return (await db.query(`SELECT s.id,s.state,s.rider_id,s.quote_id,q.request,q.pricing_evidence,
    f.id AS food_id,f.state AS food_state,f.ready_at AS food_ready_at,
    plan.stops AS plan_stops,
    l.latitude AS rider_latitude,l.longitude AS rider_longitude,l.updated_at AS rider_updated_at,
    rd.position_accuracy_m,rd.vehicle AS rider_vehicle,
    st.stage AS cached_stage,st.route_rider_id,st.route_duration_seconds,st.route_distance_meters,st.route_geometry,st.route_computed_at,st.pickup_to_dropoff_seconds,st.displayed_arrival_at,st.displayed_stage,st.last_change_reason
   FROM shipments s JOIN quotes q ON q.id=s.quote_id
   LEFT JOIN food_orders f ON f.shipment_id=s.id
   LEFT JOIN rider_dispatch_plans plan ON plan.rider_id=s.rider_id
   LEFT JOIN locations l ON l.shipment_id=s.id AND l.rider_id=s.rider_id
   LEFT JOIN riders rd ON rd.id=s.rider_id
   LEFT JOIN shipment_eta_state st ON st.shipment_id=s.id
   WHERE s.id=$1`,[shipmentId])).rows[0];
 }

 async function previousSample(riderId,before){
  if(!riderId||!before)return null;
  return (await db.query(`SELECT ST_Y(position::geometry) AS latitude,ST_X(position::geometry) AS longitude,observed_at AS "observedAt"
   FROM rider_location_samples WHERE rider_id=$1 AND observed_at<$2 ORDER BY observed_at DESC LIMIT 1`,[riderId,before])).rows[0]??null;
 }

 /** One road route through any earlier stops, including time spent handing over at each. */
 async function routeThroughStops(start,earlierStops,target,vehicle){
  let previous=start,durationSeconds=0,distanceMeters=0;const coordinates=[];
  for(const point of [...earlierStops,target]){
   const leg=await routing.route(previous,point,{vehicle,traffic:true});
   if(leg?.source!=='routing-provider'&&leg?.source!=='fixture')return null;
   durationSeconds+=leg.durationSeconds;distanceMeters+=leg.distanceMeters;
   coordinates.push(...(leg.geometry?.coordinates??[]));
   previous=point;
  }
  durationSeconds+=earlierStops.length*ETA_ASSUMPTIONS.pickupHandoverSeconds;
  return {durationSeconds,distanceMeters,geometry:coordinates.length>1?{type:'LineString',coordinates}:null};
 }

 async function compute(shipmentId){
  const row=await loadContext(shipmentId);
  if(!row)return null;
  const at=now(),stage=row.state,isFood=Boolean(row.food_id),vehicle=row.request?.vehicle||row.rider_vehicle||'motorcycle';
  const pickup=row.request?.pickup,dropoff=row.request?.destination;
  const riderPoint=Number.isFinite(row.rider_latitude)?{latitude:row.rider_latitude,longitude:row.rider_longitude}:null;
  const gps=ACTIVE_STATES.has(stage)?classifyGps({latitude:row.rider_latitude,longitude:row.rider_longitude,updatedAt:row.rider_updated_at,accuracyMeters:row.position_accuracy_m==null?NaN:Number(row.position_accuracy_m),previous:await previousSample(row.rider_id,row.rider_updated_at)},{now:at}):{quality:'not_applicable',usable:false};
  const deliveryType=isFood?'food':'parcel',city=cityBucket(dropoff),bucket=timeBucket(at);
  const evidence=await evidenceFor({vehicle,deliveryType,city,bucket});
  const adjustment=travelAdjustment({evidence,baselineFactor:baselineFactorFor(baselineFactors,vehicle,bucket)});

  const toPickup=stage==='RIDER_ASSIGNED',target=toPickup?pickup:dropoff;
  const cached=row.cached_stage&&row.route_rider_id===row.rider_id&&row.route_computed_at
   ?{stage:row.cached_stage,computedAt:row.route_computed_at,durationSeconds:Number(row.route_duration_seconds),geometry:row.route_geometry?.coordinates}
   :null;
  let roadSeconds=null,pickupToDropoff=row.pickup_to_dropoff_seconds==null?null:Number(row.pickup_to_dropoff_seconds);
  let changeReason=row.last_change_reason??null,routeFailed=false,routeStored=false;
  // Other parcels the rider must serve first add real time to this delivery.
  const stops=Array.isArray(row.plan_stops)?row.plan_stops:[];
  const targetIndex=stops.findIndex(s=>s.shipmentId===shipmentId&&s.kind===(toPickup?'pickup':'dropoff'));
  const earlierStops=targetIndex>0?stops.slice(0,targetIndex):[];
  const routed=ACTIVE_STATES.has(stage)&&stage!=='AWAITING_DELIVERY_OTP'&&gps.usable&&riderPoint&&target;
  if(routed){
   const decision=routeDecision({cached,stage,position:riderPoint,now:at});
   if(decision.recalculate){
    changeReason=decision.reason;
    if(routing){
     try{
      const leg=await routeThroughStops(riderPoint,earlierStops,target,vehicle);
      if(leg){
       roadSeconds=leg.durationSeconds;
       await db.query(`INSERT INTO shipment_eta_state(shipment_id,stage,route_rider_id,route_duration_seconds,route_distance_meters,route_geometry,route_computed_at,last_change_reason,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),$8,now())
         ON CONFLICT(shipment_id) DO UPDATE SET stage=EXCLUDED.stage,route_rider_id=EXCLUDED.route_rider_id,route_duration_seconds=EXCLUDED.route_duration_seconds,route_distance_meters=EXCLUDED.route_distance_meters,route_geometry=EXCLUDED.route_geometry,route_computed_at=EXCLUDED.route_computed_at,last_change_reason=EXCLUDED.last_change_reason,updated_at=now()`,
        [shipmentId,stage,row.rider_id,leg.durationSeconds,leg.distanceMeters,JSON.stringify(leg.geometry??null),at,decision.reason]);
       routeStored=true;
      }else routeFailed=true;
     }catch{routeFailed=true;}
    }else routeFailed=true;
   }else roadSeconds=decision.remainingSeconds;
   if(toPickup&&!routeFailed&&pickupToDropoff===null&&pickup&&dropoff&&routing){
    try{
     const leg=await routing.route(pickup,dropoff,{vehicle,traffic:true});
     if(leg?.source==='routing-provider'||leg?.source==='fixture'){
      pickupToDropoff=leg.durationSeconds;
      await db.query('UPDATE shipment_eta_state SET pickup_to_dropoff_seconds=$2 WHERE shipment_id=$1',[shipmentId,pickupToDropoff]);
     }
    }catch{/* Reported below as no_route. */}
   }
  }
  const scale=s=>Number.isFinite(s)?s*adjustment.factor:null;
  const result=calculateStageEta({state:stage,isFood,foodState:row.food_state,foodReadyAt:row.food_ready_at,gps,now:at,
   riderToPickupSeconds:toPickup&&!routeFailed?scale(roadSeconds):null,
   riderToDropoffSeconds:!toPickup&&!routeFailed?scale(roadSeconds):null,
   pickupToDropoffSeconds:scale(pickupToDropoff)});
  const diagnostics={routingLabel,vehicle,deliveryType,city,timeBucket:bucket,gpsQuality:gps.quality,gpsAgeSeconds:gps.ageSeconds==null?null:Math.round(gps.ageSeconds),roadSeconds,pickupToDropoffSeconds:pickupToDropoff,breakdown:result.breakdown??null,adjustment:{factor:adjustment.factor,source:adjustment.source,sampleCount:adjustment.sampleCount},evidence,changeReason,routeRecalculated:routeStored,earlierStops:earlierStops.length};
  if(result.status!=='estimated')return {customer:{status:'unavailable',stage,message:result.customerMessage??null,confidence:'none',reason:result.reason},diagnostics:{...diagnostics,reason:result.reason}};

  const confidence=earlierStops.length?'low':adjustment.source==='measured'&&gps.quality==='good'?'high':result.confidence;
  const previous=row.displayed_arrival_at?{arrivalMs:new Date(row.displayed_arrival_at).getTime(),stage:row.displayed_stage}:null;
  const stable=stabilizeArrival({previous,arrivalMs:at+result.remainingSeconds*1000,stage,now:at});
  if(stable.changed)await db.query(`INSERT INTO shipment_eta_state(shipment_id,stage,displayed_arrival_at,displayed_stage,updated_at) VALUES($1,$2,to_timestamp($3/1000.0),$2,now())
    ON CONFLICT(shipment_id) DO UPDATE SET displayed_arrival_at=EXCLUDED.displayed_arrival_at,displayed_stage=EXCLUDED.displayed_stage,updated_at=now()`,[shipmentId,stage,stable.arrivalMs]);
  const remaining=Math.max(60,(stable.arrivalMs-at)/1000);
  const range=etaRange(remaining,{confidence,measuredSpread:adjustment.measuredSpread});
  // Predictions come from the first estimate of each stage, using road time before any adjustment.
  await db.query(`INSERT INTO eta_predictions(shipment_id,stage,rider_id,vehicle,delivery_type,city,time_bucket,routing_label,road_seconds,adjusted_seconds,predicted_remaining_seconds,adjustment_source,gps_quality,confidence)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
   [shipmentId,stage,row.rider_id,vehicle,deliveryType,city,bucket,routingLabel,roadSeconds,scale(roadSeconds),result.remainingSeconds,adjustment.source,gps.quality,confidence]);
  return {
   customer:{status:'estimated',stage,confidence,minMinutes:range.minMinutes,maxMinutes:range.maxMinutes,arrivalAt:new Date(stable.arrivalMs).toISOString(),message:etaCustomerMessage({confidence,...range,gpsQuality:gps.quality})},
   diagnostics:{...diagnostics,remainingSeconds:result.remainingSeconds}
  };
 }

 const safeCompute=async id=>{try{return await compute(id);}catch{return null;}};
 return {
  async refreshActive({limit=200}={}){
   const rows=(await db.query("SELECT id FROM shipments WHERE state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP') ORDER BY created_at DESC LIMIT $1",[limit])).rows;
   for(const {id} of rows)await safeCompute(id);
   return rows.length;
  },
  /** Customer view: never exposes routing, GPS or calibration detail. A failure here must not break tracking. */
  async customerEta(shipmentId){return (await safeCompute(shipmentId))?.customer??{status:'unavailable',message:'We cannot estimate your arrival time right now.',confidence:'none',reason:'error'};},
  async diagnostics(actor,shipmentId){
   check(actor?.kind==='admin',403,'Administrator required');
   check((await db.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission='shipments:read'",[actor.id])).rowCount,403,'Permission required');
   const result=await compute(shipmentId);check(result,404,'Shipment not found');
   const milestones=(await db.query('SELECT milestone,rider_id,occurred_at FROM delivery_milestones WHERE shipment_id=$1 ORDER BY occurred_at',[shipmentId])).rows;
   const predictions=(await db.query('SELECT stage,rider_id,road_seconds,adjusted_seconds,predicted_remaining_seconds,adjustment_source,gps_quality,confidence,predicted_at FROM eta_predictions WHERE shipment_id=$1 ORDER BY predicted_at',[shipmentId])).rows;
   return {...result,milestones,predictions};
  },
  /** Measured travel accuracy by group, with sample counts. Empty until real trips exist. */
  async accuracyReport(actor){
   check(actor?.kind==='admin',403,'Administrator required');
   check((await db.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission=ANY($2::text[])",[actor.id,['shipments:read','dispatch:configure']])).rowCount,403,'Permission required');
   const rows=(await db.query(`${TRANSIT_SAMPLES} ORDER BY p.predicted_at DESC LIMIT 5000`)).rows,groups=new Map();
   for(const r of rows){const key=[r.vehicle,r.deliveryType,r.city,r.timeBucket].join('|');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
   return {
    measuredTrips:rows.length,
    groups:[...groups].map(([key,list])=>{const [vehicle,deliveryType,city,bucket]=key.split('|');return {vehicle,deliveryType,city,timeBucket:bucket,estimate:summarizeTripEvidence(list),roadTime:summarizeTripEvidence(list.map(r=>({predictedSeconds:r.roadSeconds,actualSeconds:r.actualSeconds})))};}),
    note:'Measures pickup to handover travel. Calibration needs at least 30 valid trips per group.'
   };
  }
 };
}
