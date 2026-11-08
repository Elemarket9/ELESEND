#!/usr/bin/env node
/**
 * ELESEND private-map diagnostic — exclusively queries the configured private
 * motorcycle OSRM graph. No web map APIs, no inferred road distances.
 *
 * Required: ELESEND_PRIVATE_OSRM_URL, PICKUP_LAT, PICKUP_LON,
 * DROP_LAT, DROP_LON. Optional: ELESEND_TARIFF_JSON (pricing policy).
 *
 * Example (with real coordinates resolved from ELESEND's own geocoder):
 * ELESEND_PRIVATE_OSRM_URL=http://localhost:5001 PICKUP_LAT=... \
 * PICKUP_LON=... DROP_LAT=... DROP_LON=... node scripts/private-delivery-route-check.mjs
 */
import {writeFile} from 'node:fs/promises';
import {osrmRouting} from '../services/api/dispatch-routing.mjs';
import {calculateQuote} from '../services/api/pricing.mjs';
import {calculateStageEta,etaRange} from '../services/api/eta/stage-eta.mjs';

function point(prefix){
 const latitude=Number(process.env[prefix+'_LAT']);
 const longitude=Number(process.env[prefix+'_LON']);
 if(!process.env[prefix+'_LAT']||!process.env[prefix+'_LON']||
    !Number.isFinite(latitude)||!Number.isFinite(longitude)||
    Math.abs(latitude)>90||Math.abs(longitude)>180)throw Error('Supply valid '+prefix+'_LAT and '+prefix+'_LON from ELESEND private geocoder');
 return {latitude,longitude};
}
const endpoint=process.env.ELESEND_PRIVATE_OSRM_URL;
if(!endpoint)throw Error('ELESEND_PRIVATE_OSRM_URL required: cannot validate roads without ELESEND private motorcycle OSRM');
const pickup=point('PICKUP'),destination=point('DROP');
const routing=osrmRouting({endpoint,profiles:{motorcycle:process.env.ELESEND_PRIVATE_OSRM_PROFILE||'driving'}});
const leg=await routing.route(pickup,destination,{vehicle:'motorcycle',steps:true,billing:true});
if(leg.source!=='routing-provider'||!Array.isArray(leg.geometry?.coordinates)||
 leg.geometry.coordinates.length<2)throw Error('Private OSRM did not provide connected road geometry');
const gps={quality:'good',usable:true};
const eta=calculateStageEta({state:'IN_TRANSIT',gps,riderToDropoffSeconds:leg.durationSeconds});
const etaMinutes=eta.status==='estimated'?etaRange(eta.remainingSeconds,{confidence:eta.confidence}):null;
let quote=null;
if(process.env.ELESEND_TARIFF_JSON){
 const policy=JSON.parse(process.env.ELESEND_TARIFF_JSON);
 quote=calculateQuote(policy,leg.distanceMeters,{durationSeconds:leg.durationSeconds});
}
const result={source:'ELESEND private motorcycle OSRM',simulatedDelivery:true,
 roadDistanceMeters:leg.distanceMeters,roadDistanceKm:leg.distanceMeters/1000,
 roadDurationSeconds:leg.durationSeconds,etaMinutes,
 pricingSource:quote?'explicit tariff environment':'not supplied',
 quote,roadSteps:leg.steps,geometry:leg.geometry,
 pickup,destination,trafficObservation:'not measured',gpsObservation:'not measured',
 recipientHandover:'not performed'};
if(process.env.ROUTE_EVIDENCE_PATH){
 await writeFile(process.env.ROUTE_EVIDENCE_PATH,JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify(result,null,2));
