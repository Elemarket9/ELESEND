import {haversine} from '../dispatch-geometry.mjs';
/** Decode Google's documented polyline encoding; preserve [longitude,latitude] for GeoJSON. */
export function decodePolyline(encoded){
 if(typeof encoded!=='string'||encoded.length>1000000)throw Error('Invalid encoded polyline');
 let idx=0,lat=0,lon=0;const out=[];
 function integer(){let shift=0,value=0,byte;do{if(idx>=encoded.length||shift>30)throw Error('Invalid encoded polyline');byte=encoded.charCodeAt(idx++)-63;if(byte<0||byte>63)throw Error('Invalid encoded polyline');value|=(byte&31)<<shift;shift+=5;}while(byte>=32);return value&1?~(value>>1):(value>>1);}
 while(idx<encoded.length){lat+=integer();lon+=integer();const p=[lon/1e5,lat/1e5];if(Math.abs(p[0])>180||Math.abs(p[1])>90)throw Error('Invalid route point');out.push(p);}
 return out;
}
export function roadGeometry(route){
 const geometry=route?.geometry;
 let points;try{points=geometry?.type==='LineString'?geometry.coordinates:geometry?.encodedPolyline?decodePolyline(geometry.encodedPolyline):null;}catch{return null;}
 if(!Array.isArray(points)||points.length<2||points.length>20000||points.some(p=>!Array.isArray(p)||p.length<2||![p[0],p[1]].every(Number.isFinite)||Math.abs(p[0])>180||Math.abs(p[1])>90))return null;
 return points.map(p=>[p[0],p[1]]);
}
/** Never invent road geometry when the route provider did not supply it. */
export async function buildRemainingRoadCorridor(routing,start,stops,{vehicle,maxPoints=20000}={}){
 if(!Array.isArray(stops)||stops.length===0||stops.length>30)return null;
 let prev=start,coords=[];
 for(const stop of stops){const route=await routing.route(prev,stop,{vehicle});const line=roadGeometry(route);if(!line)return null;
  coords.push(...(coords.length?line.slice(1):line));if(coords.length>maxPoints)return null;prev=stop;
 }
 return coords.length>=2?{type:'LineString',coordinates:coords}:null;
}
/** Fast approximate corridor hint, never a replacement for actual driving-time feasibility. */
export function aheadOnRoute(coords,current,pickup,{radiusMeters=1000}={}){
 if(!Array.isArray(coords)||coords.length<2||![current?.latitude,current?.longitude,pickup?.latitude,pickup?.longitude].every(Number.isFinite))return {eligible:false,reason:'missing_geometry'};
 function projection(p){let best={distanceMeters:Infinity,index:-1};for(let i=0;i<coords.length-1;i++){
  const [ax,ay]=coords[i],[bx,by]=coords[i+1];const latitude=(ay+by)/2*Math.PI/180;
  const x=(p.longitude-ax)*Math.cos(latitude),y=p.latitude-ay;
  const dx=(bx-ax)*Math.cos(latitude),dy=by-ay;
  const t=Math.max(0,Math.min(1,(x*dx+y*dy)/(dx*dx+dy*dy||1)));
  const near={longitude:ax+(bx-ax)*t,latitude:ay+(by-ay)*t};
  const distanceMeters=haversine(p,near);
  if(distanceMeters<best.distanceMeters)best={distanceMeters,index:i+t};
 }return best;}
 const rider=projection(current),order=projection(pickup);
 return {eligible:order.distanceMeters<=radiusMeters&&order.index>=rider.index-.005,remainingRouteProgress:order.index-rider.index,pickupCorridorMeters:Math.ceil(order.distanceMeters),riderCorridorMeters:Math.ceil(rider.distanceMeters)};
}
