import {createServer} from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {calculateQuote} from './services/api/pricing.mjs';

const VEHICLES=['motorcycle','car','van'];
const MAX_STOPS=10,MAX_BODY=16384,MAX_PROVIDER_BODY=1048576;
const COMMISSION_BPS=2000n;
// Approximate city zones for the scheduled surcharge, not legal city boundaries.
const CITIES=[{lat:5.6037,lng:-0.1870,radiusM:45000},{lat:6.6885,lng:-1.6244,radiusM:35000}];
export class FareError extends Error {
 constructor(status,message){super(message);this.status=status;}
}
const fail=(status,message)=>{throw new FareError(status,message);};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const strict=(x,keys)=>{if(!object(x)||Object.keys(x).some(k=>!keys.includes(k)))fail(400,'Unexpected object or field');};

/** Rough envelope only: includes some ocean and neighboring territory. */
export function validateGhanaBoundary(lat,lng){
 if(!Number.isFinite(lat)||!Number.isFinite(lng)||lat<4.7||lat>11.2||lng< -3.3||lng>1.2)
  fail(422,'Location is outside the configured Ghana envelope');
 return true;
}
function point(x){strict(x,['lat','lng']);validateGhanaBoundary(x.lat,x.lng);return {lat:x.lat,lng:x.lng};}
function distanceMeters(a,b){
 const radians=x=>x*Math.PI/180,dlat=radians(b.lat-a.lat),dlng=radians(b.lng-a.lng);
 const h=Math.sin(dlat/2)**2+Math.cos(radians(a.lat))*Math.cos(radians(b.lat))*Math.sin(dlng/2)**2;
 return 6371008.8*2*Math.atan2(Math.sqrt(Math.min(1,h)),Math.sqrt(Math.max(0,1-h)));
}
/** Scheduled local-time surcharge; this does not measure supply or demand. */
export function getSurgeMultiplier(pickupLat,pickupLng,currentHour){
 validateGhanaBoundary(pickupLat,pickupLng);
 if(!Number.isInteger(currentHour)||currentHour<0||currentHour>23)fail(400,'Invalid local hour');
 const rush=(currentHour>=7&&currentHour<9)||(currentHour>=16&&currentHour<19);
 const inCity=CITIES.some(c=>distanceMeters({lat:pickupLat,lng:pickupLng},c)<=c.radiusM);
 return rush&&inCity?1.4:1;
}
function tariffFor(tariffs,vehicle){
 const tariff=tariffs?.[vehicle];
 if(!object(tariff))fail(503,'Vehicle tariff is not configured');
 const result={};
 for(const field of ['baseMinor','perKmMinor','perMinuteMinor','perExtraStopMinor','minimumMinor']){
  const value=tariff[field]??(field==='baseMinor'||field==='perKmMinor'?undefined:0);
  if(!Number.isSafeInteger(value)||value<0||value>100000000)fail(503,'Invalid tariff configuration');
  result[field]=BigInt(value);
 }
 return result;
}
async function providerJson(response){
 const reader=response.body?.getReader();if(!reader)fail(503,'Empty routing response');
 const chunks=[];let bytes=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;
  if(bytes>MAX_PROVIDER_BODY)fail(503,'Routing response is too large');chunks.push(Buffer.from(value));
 }}catch(error){try{await reader.cancel();}catch{}throw error;}finally{reader.releaseLock();}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}
async function roadMatrix(points,vehicle,vehicleRoutes,fetchImpl){
 const config=vehicleRoutes?.[vehicle];if(!config)fail(503,'Vehicle road graph is not configured');
 let url;try{url=new URL(config.endpoint);}catch{fail(503,'Invalid routing configuration');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||
  !/^[a-zA-Z0-9_-]{1,32}$/.test(config.profile??''))fail(503,'Invalid routing configuration');
 url.pathname=url.pathname.replace(/\/$/,'')+`/table/v1/${config.profile}/${points.map(p=>`${p.lng},${p.lat}`).join(';')}`;
 url.search='annotations=distance,duration';
 const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Accept:'application/json'}});
 if(!response.ok)fail(503,'Road routing is unavailable');
 const body=await providerJson(response);
 if(['NoRoute','NoTable'].includes(body.code))fail(422,'No connected road route');
 if(body.code!=='Ok')fail(503,'Invalid road routing response');
 const size=points.length;
 for(const grid of [body.distances,body.durations]){
  if(!Array.isArray(grid)||grid.length!==size||grid.some(row=>!Array.isArray(row)||row.length!==size||
   row.some(value=>value!==null&&(!Number.isFinite(value)||value<0||value>100000000))))fail(503,'Invalid routing matrix');
 }
 return {distances:body.distances,durations:body.durations};
}
function estimatedMatrix(points){
 // No guessed speed or invented traffic duration for the straight-line fallback.
 return {distances:points.map(a=>points.map(b=>distanceMeters(a,b))),durations:null};
}
function greedyTour(matrix,dropoffCount){
 const remaining=new Set(Array.from({length:dropoffCount},(_,i)=>i+1));
 const order=[];let current=0,meters=0,seconds=0;
 while(remaining.size){
  let best=null,bestDistance=Infinity;
  for(const next of remaining){const d=matrix.distances[current][next],t=matrix.durations?.[current]?.[next];
   if(d!==null&&(matrix.durations===null||t!==null)&&d<bestDistance){best=next;bestDistance=d;}}
  if(best===null)fail(422,'No connected route through all drop-offs');
  meters+=bestDistance;if(matrix.durations)seconds+=matrix.durations[current][best];
  order.push(best-1);remaining.delete(best);current=best;
 }
 return {order,meters:Math.ceil(meters),seconds:matrix.durations?Math.ceil(seconds):null};
}
const ceilDivide=(value,divisor)=>(value+divisor-1n)/divisor;

/** Read-only fare preview. Persist an authorized immutable quote before booking. */
export async function calculateDeliveryPrice(input,{tariffs,vehicleRoutes={},allowEstimatedFallback=false,now=new Date(),fetchImpl=fetch}={}){
 strict(input,['pickup','dropoffs','vehicle']);
 if(!VEHICLES.includes(input.vehicle))fail(400,'Vehicle must be motorcycle, car or van');
 if(!Array.isArray(input.dropoffs)||input.dropoffs.length<1||input.dropoffs.length>MAX_STOPS)fail(400,'Provide 1 to 10 drop-offs');
 const pickup=point(input.pickup),dropoffs=input.dropoffs.map(point),points=[pickup,...dropoffs];
 const tariff=tariffFor(tariffs,input.vehicle);
 let matrix,source='osrm';
 try{matrix=await roadMatrix(points,input.vehicle,vehicleRoutes,fetchImpl);}
 catch(error){
  // An authoritative disconnected road result must not become an aerial quote.
  if(!allowEstimatedFallback||error.status===422)throw new FareError(error.status??503,error instanceof FareError?error.message:'Road routing is unavailable');
  matrix=estimatedMatrix(points);source='haversine';
 }
 const tour=greedyTour(matrix,dropoffs.length);
 if(tour.seconds===null&&tariff.perMinuteMinor>0n)fail(503,'Cannot price route time without road-duration evidence');
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Accra',hour:'2-digit',hourCycle:'h23'}).format(now));
 const multiplier=getSurgeMultiplier(pickup.lat,pickup.lng,hour),surgeBps=multiplier===1.4?14000n:10000n;
 const distanceCharge=ceilDivide(BigInt(tour.meters)*tariff.perKmMinor,1000n);
 const timeCharge=ceilDivide(BigInt(tour.seconds??0)*tariff.perMinuteMinor,60n);
 const stopCharge=BigInt(dropoffs.length-1)*tariff.perExtraStopMinor;
 let price;try{price=calculateQuote({base_minor:Number(tariff.baseMinor),per_km_minor:Number(tariff.perKmMinor),per_minute_minor:Number(tariff.perMinuteMinor),per_extra_stop_minor:Number(tariff.perExtraStopMinor),minimum_minor:Number(tariff.minimumMinor),commission_bps:Number(COMMISSION_BPS)},tour.meters,{durationSeconds:tour.seconds??0,extraStops:dropoffs.length-1,surgeBps:Number(surgeBps)});}catch{fail(422,'Fare is outside supported bounds');}
 const total=BigInt(price.amountMinor),commission=BigInt(price.commissionMinor),driver=BigInt(price.riderEarningsMinor);
 return {
  pricingStatus:'preview',currency:'GHS',vehicle:input.vehicle,routeSource:source,
  estimateOnly:source==='haversine',trafficAware:false,requiresBookingQuote:true,
  boundaryValidation:'rough_bounding_box_only',optimization:'greedy_nearest_neighbor_open_tour',
  orderedDropoffIndexes:tour.order,totalDistanceMeters:tour.meters,durationSeconds:tour.seconds,
  surgeMultiplier:multiplier,surgeReason:multiplier===1.4?'scheduled_city_rush_hour':'none',commissionBps:2000,
  totalMinor:Number(total),driverEarningMinor:Number(driver),platformCommissionMinor:Number(commission),
  totalPriceGhs:Number(total)/100,driverEarningGhs:Number(driver)/100,platformCommissionGhs:Number(commission)/100,
  componentsMinor:{base:Number(tariff.baseMinor),distance:Number(distanceCharge),time:Number(timeCharge),extraStops:Number(stopCharge)}
 };
}

async function readJson(req){
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))fail(415,'Use application/json');
 if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')fail(415,'Compressed bodies are not supported');
 const length=req.headers['content-length'];
 if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>MAX_BODY))fail(413,'Request body is too large');
 const chunks=[];let size=0;
 for await(const chunk of req.iterator({destroyOnReturn:false})){
  size+=chunk.length;if(size>MAX_BODY){req.resume();fail(413,'Request body is too large');}chunks.push(chunk);
 }
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
 catch{fail(400,'Malformed JSON');}
}
export function createFareHandler({apiToken,...engineConfig}){
 if(typeof apiToken!=='string'||apiToken.length<32)throw Error('Configure a fare API token of at least 32 characters');
 const digest=value=>createHash('sha256').update(value).digest(),expected=digest(`Bearer ${apiToken}`);
 let inFlight=0;
 return async(req,res)=>{
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');let admitted=false;
  try{
   if(req.url!=='/api/v1/calculate-fare')fail(404,'Not found');
   if(req.method!=='POST'){res.setHeader('Allow','POST');fail(405,'Use POST');}
   if(!timingSafeEqual(expected,digest(req.headers.authorization??'')))fail(401,'Unauthorized');
   if(inFlight>=8){res.setHeader('Retry-After','2');fail(429,'Fare service is busy');}
   inFlight++;admitted=true;
   const result=await calculateDeliveryPrice(await readJson(req),engineConfig);
   res.writeHead(200);res.end(JSON.stringify(result));
  }catch(error){
   res.setHeader('Connection','close');res.writeHead(error instanceof FareError?error.status:500);
   res.end(JSON.stringify({error:error instanceof FareError?error.message:'Unable to calculate fare'}));
  }finally{if(admitted)inFlight--;}
 };
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const handler=createFareHandler({apiToken:process.env.FARE_API_TOKEN,
   tariffs:JSON.parse(process.env.FARE_TARIFFS_JSON??readFileSync(new URL('./config/vehicle-tariffs.json',import.meta.url),'utf8')),vehicleRoutes:JSON.parse(process.env.FARE_ROUTES_JSON??'{}'),
   allowEstimatedFallback:process.env.FARE_ALLOW_ESTIMATES==='true'});
  const server=createServer({maxHeaderSize:8192,requestTimeout:10000,headersTimeout:5000},handler);
  server.keepAliveTimeout=5000;
  server.listen(Number(process.env.FARE_PORT??3091),'127.0.0.1',()=>console.log('Fare preview API listening on loopback'));
 }catch{console.error('Fare API configuration invalid; check token and JSON configuration');process.exitCode=1;}
}
