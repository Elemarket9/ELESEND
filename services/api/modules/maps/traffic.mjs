/** Road speeds learned from riders' GPS. Works with no setup: with no data, routes are unchanged. */
import {haversine} from '../../shared/dispatch-geometry.mjs';

const MIN_LEG_SECONDS=5,MAX_LEG_SECONDS=300,MIN_LEG_METERS=30,MIN_KMH=3,MAX_KMH=110,MIN_CONFIDENCE=0.5;
const LIVE_MINUTES=30,LIVE_MIN_OBSERVATIONS=3,TYPICAL_MIN_SAMPLES=5,TYPICAL_SAMPLE_CAP=200,KEEP_HOURS=2;
const MAX_TRAFFIC_ROUTE_METERS=60000,CHUNK=40,WINDOW_MS=300000,MAX_WINDOWS_PER_RUN=6,GIVE_UP_MS=1800000,MAX_CATCH_UP_MS=7200000;

/** Turns a map-matched trip into segment speeds. Stops and implausible speeds are left out. */
export function segmentSpeeds(match,points){
 const out=[];
 (match?.matchings||[]).forEach((matching,mi)=>{
  if((matching.confidence??0)<MIN_CONFIDENCE)return;
  const order=[];
  (match.tracepoints||[]).forEach((tp,i)=>{if(tp&&tp.matchings_index===mi)order[tp.waypoint_index]=i;});
  (matching.legs||[]).forEach((leg,li)=>{
   const a=points[order[li]],b=points[order[li+1]];if(!a||!b)return;
   const seconds=(Date.parse(b.observedAt)-Date.parse(a.observedAt))/1000,kmh=leg.distance/seconds*3.6;
   if(!(seconds>=MIN_LEG_SECONDS&&seconds<=MAX_LEG_SECONDS&&leg.distance>=MIN_LEG_METERS&&kmh>=MIN_KMH&&kmh<=MAX_KMH))return;
   const nodes=leg.annotation?.nodes||[];
   for(let i=0;i<nodes.length-1;i++)out.push({fromNode:nodes[i],toNode:nodes[i+1],speedKmh:kmh,observedAt:b.observedAt});
  });
 });
 return out;
}

/** Route time using measured speeds where they exist and the road graph's time elsewhere. */
export function adjustedSeconds(route,speeds){
 const seg=route.segments;
 if(!seg?.nodes?.length)return {durationSeconds:route.durationSeconds,measuredMeters:0};
 let seconds=0,measuredMeters=0;
 for(let i=0;i<seg.nodes.length-1;i++){
  const speed=speeds.get(`${seg.nodes[i]}:${seg.nodes[i+1]}`),meters=seg.distances[i]??0;
  if(speed){seconds+=meters/speed*3.6;measuredMeters+=meters;}else seconds+=seg.durations[i]??0;
 }
 return {durationSeconds:Math.ceil(seconds),measuredMeters:Math.round(measuredMeters)};
}

const ghanaHourOfWeek=at=>{const d=new Date(at);return d.getUTCDay()*24+d.getUTCHours();};

export function trafficService(db,{routing,now=()=>Date.now()}={}){
 /** Reads new rider trips once each, and stores segment speeds without any rider id. */
 async function ingest(tracesSince){
  let segments=0;
  for(let run=0;run<MAX_WINDOWS_PER_RUN;run++){
   const latest=now()-60000;
   const stored=(await db.query('SELECT processed_until FROM traffic_cursor WHERE id=1')).rows[0]?.processed_until;
   const since=Math.max(stored?new Date(stored).getTime():latest-WINDOW_MS,latest-MAX_CATCH_UP_MS);
   if(since>=latest||typeof routing?.matchTrace!=='function')break;
   const end=Math.min(since+WINDOW_MS,latest);
   const read=await tracesSince(new Date(since),new Date(end));
   let tried=0,failed=0;const rows=[];
   for(const trace of read.traces){
    for(let start=0;start<trace.points.length-1;start+=CHUNK-1){
     const points=trace.points.slice(start,start+CHUNK);if(points.length<3)continue;
     tried++;
     try{const match=await routing.matchTrace(points,{vehicle:trace.vehicle});rows.push(...segmentSpeeds(match,points).map(r=>({...r,vehicle:trace.vehicle})));}catch{failed++;}
    }
   }
   // If nothing could be read, routing is likely down: try this stretch again, while it is recent.
   if(tried&&failed===tried&&latest-since<GIVE_UP_MS)break;
   await store(rows);segments+=rows.length;
   await db.query('INSERT INTO traffic_cursor(id,processed_until) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET processed_until=EXCLUDED.processed_until',[read.until]);
   if(new Date(read.until).getTime()>=latest)break;
  }
  await db.query(`DELETE FROM traffic_observations WHERE observed_at<now()-interval '${KEEP_HOURS} hours'`);
  return {segments};
 }
 async function store(rows){
  if(!rows.length)return;
  await db.query(`INSERT INTO traffic_observations(vehicle,from_node,to_node,speed_kmh,observed_at)
    SELECT v,f,t,s,o FROM unnest($1::text[],$2::bigint[],$3::bigint[],$4::real[],$5::timestamptz[]) AS x(v,f,t,s,o)`,[rows.map(r=>r.vehicle),rows.map(r=>r.fromNode),rows.map(r=>r.toNode),rows.map(r=>r.speedKmh),rows.map(r=>r.observedAt)]);
  for(const r of rows)await db.query(`INSERT INTO traffic_typical_speeds(vehicle,from_node,to_node,hour_of_week,speed_kmh,samples) VALUES($1,$2,$3,$4,$5,1)
    ON CONFLICT(vehicle,from_node,to_node,hour_of_week) DO UPDATE SET speed_kmh=(traffic_typical_speeds.speed_kmh*traffic_typical_speeds.samples+EXCLUDED.speed_kmh)/(traffic_typical_speeds.samples+1),samples=LEAST(traffic_typical_speeds.samples+1,${TYPICAL_SAMPLE_CAP})`,[r.vehicle,r.fromNode,r.toNode,ghanaHourOfWeek(r.observedAt),r.speedKmh]);
 }
 /** Live speed where enough riders passed recently, otherwise the usual speed for this hour. */
 async function speedsFor(vehicle,nodes){
  const from=nodes.slice(0,-1),to=nodes.slice(1),speeds=new Map();if(!from.length)return speeds;
  const typical=await db.query(`SELECT t.from_node,t.to_node,t.speed_kmh FROM traffic_typical_speeds t JOIN unnest($2::bigint[],$3::bigint[]) AS x(f,n) ON t.from_node=x.f AND t.to_node=x.n
    WHERE t.vehicle=$1 AND t.hour_of_week=$4 AND t.samples>=${TYPICAL_MIN_SAMPLES}`,[vehicle,from,to,ghanaHourOfWeek(now())]);
  for(const r of typical.rows)speeds.set(`${r.from_node}:${r.to_node}`,Number(r.speed_kmh));
  const live=await db.query(`SELECT o.from_node,o.to_node,percentile_cont(0.5) WITHIN GROUP(ORDER BY o.speed_kmh) AS speed_kmh FROM traffic_observations o JOIN unnest($2::bigint[],$3::bigint[]) AS x(f,n) ON o.from_node=x.f AND o.to_node=x.n
    WHERE o.vehicle=$1 AND o.observed_at>=$4 GROUP BY 1,2 HAVING count(*)>=${LIVE_MIN_OBSERVATIONS}`,[vehicle,from,to,new Date(now()-LIVE_MINUTES*60000)]);
  for(const r of live.rows)speeds.set(`${r.from_node}:${r.to_node}`,Number(r.speed_kmh));
  return speeds;
 }
 return {ingest,speedsFor};
}

const publicLeg=({segments,alternatives,...leg})=>leg;

/** Same routing, except `traffic:true` picks the fastest option using measured road speeds. */
export function trafficRouting(routing,traffic){
 if(typeof routing?.route!=='function'||!traffic)return routing;
 return {...routing,async route(from,to,opts={}){
  const {traffic:wanted,...rest}=opts;
  if(!wanted||haversine(from,to)>MAX_TRAFFIC_ROUTE_METERS)return routing.route(from,to,rest);
  try{
   const first=await routing.route(from,to,{...rest,annotations:true,alternatives:true});
   const options=[first,...(first.alternatives||[])],vehicle=rest.vehicle??'car';
   let best=null;
   for(const option of options){
    const speeds=await traffic.speedsFor(vehicle,option.segments?.nodes||[]),adjusted=adjustedSeconds(option,speeds);
    if(!best||adjusted.durationSeconds<best.adjusted.durationSeconds)best={option,adjusted};
   }
   return {...publicLeg(best.option),durationSeconds:best.adjusted.durationSeconds,trafficAware:best.adjusted.measuredMeters>0};
  }catch{return routing.route(from,to,rest);}
 }};
}
