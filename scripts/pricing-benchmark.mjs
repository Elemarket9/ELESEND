#!/usr/bin/env node
// Runs Ghana benchmark routes through the routing graphs and the tariff, and compares with real observations only.
// Usage: OSRM_MOTORCYCLE_URL=http://host:5000 OSRM_CAR_URL=http://host:5000 TARIFFS_JSON='{"motorcycle":{...}}' node scripts/pricing-benchmark.mjs
import {readFileSync} from 'node:fs';
import {osrmRouting} from '../services/api/dispatch-routing.mjs';
import {calculateQuote} from '../services/api/pricing.mjs';

const {routes}=JSON.parse(readFileSync(new URL('../benchmarks/ghana-routes.json',import.meta.url)));
const {OSRM_MOTORCYCLE_URL:moto,OSRM_CAR_URL:car,TARIFFS_JSON:tariffs}=process.env;
if(!moto||!car)throw Error('Set OSRM_MOTORCYCLE_URL and OSRM_CAR_URL to running road graphs');
const routing=osrmRouting({vehicleRoutes:{motorcycle:{endpoint:moto,profile:'driving'},car:{endpoint:car,profile:'driving'}},timeoutMs:8000});
const tariff=tariffs?JSON.parse(tariffs):null;
const errors=[];
for(const route of routes){
 const point=([latitude,longitude])=>({latitude,longitude});
 for(const vehicle of ['motorcycle','car']){
  let leg;try{leg=await routing.route(point(route.from),point(route.to),{vehicle});}catch(e){console.log(`${route.name} ${vehicle}: no route (${e.message})`);continue;}
  const km=leg.distanceMeters/1000,minutes=leg.durationSeconds/60;
  const fare=tariff?.[vehicle]?calculateQuote(tariff[vehicle],leg.distanceMeters,{durationSeconds:leg.durationSeconds}):null;
  const refs=route.reference.filter(r=>r.vehicle===vehicle);
  for(const ref of refs)errors.push(Math.abs(minutes-ref.minutes));
  console.log(`${route.name} ${vehicle}: ${km.toFixed(1)} km, ${minutes.toFixed(0)} min road graph${fare?`, GHS ${(fare.amountMinor/100).toFixed(2)}, rider ${(fare.riderEarningsMinor/100).toFixed(2)}`:''}${refs.map(r=>` | observed ${r.distanceKm??'?'} km, ${r.minutes} min (${r.source})`).join('')}`);
 }
}
if(errors.length){const sorted=[...errors].sort((a,b)=>a-b);console.log(`Observed comparisons: ${errors.length}. Mean absolute error ${(errors.reduce((a,b)=>a+b)/errors.length).toFixed(1)} min, median ${sorted[Math.floor(sorted.length/2)].toFixed(1)} min. Too few to claim accuracy.`);}
else console.log('No real observations to compare against yet.');
