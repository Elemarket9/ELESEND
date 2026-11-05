import {DatabaseSync} from 'node:sqlite';
import {osrmRouting} from '../../services/api/dispatch-routing.mjs';
import {haversine} from '../../services/api/dispatch-geometry.mjs';
import {GHANA_GAZETTEER as G} from '../../services/api/infrastructure/maps/ghana-geocoder.mjs';
import {hasArrived,locateOnRoute,metersBetween,rerouteCheck,upcomingStep,voicePrompt} from '../../apps/mobile/src/rider/navigation-logic.mjs';
const routing=osrmRouting({vehicleRoutes:{car:{endpoint:'http://127.0.0.1:5000',profile:'driving'},motorcycle:{endpoint:'http://127.0.0.1:5001',profile:'motorcycle'}},timeoutMs:8000,maxInFlight:8});
let seed=20261105;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};
const pct=(a,p)=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return +s[Math.min(s.length-1,Math.floor(s.length*p))].toFixed(1);};
const pool=async(items,n,fn)=>{let i=0;await Promise.all(Array.from({length:n},async()=>{while(i<items.length){const k=i++;await fn(items[k]);}}));};
const regions=[...new Set(G.map(g=>g.region))];
// 1. Snap: how far each gazetteer record sits from a motorbike road, by region.
for(const region of regions){
 const rows=G.filter(g=>g.region===region),sample=rows.length>400?Array.from({length:400},()=>rows[Math.floor(rnd()*rows.length)]):rows,d=[];let err=0;
 await pool(sample,8,async g=>{try{d.push(await routing.nearestRoadMeters(g,{vehicle:'motorcycle'}));}catch{err++;}});
 console.log('SNAP',region,'n',d.length,'err',err,'p50',pct(d,.5),'p90',pct(d,.9),'p99',pct(d,.99),'over500m%',(100*d.filter(x=>x>500).length/Math.max(1,d.length)).toFixed(1),'over2500m%',(100*d.filter(x=>x>2500).length/Math.max(1,d.length)).toFixed(1));
}
// 2. Connectivity and detour: random nearby pairs.
const big=regions.filter(r=>G.filter(g=>g.region===r).length>500);
for(const region of big){
 const rows=G.filter(g=>g.region===region&&!['settlement'].includes(g.category)),pairs=[];
 for(let t=0;t<20000&&pairs.length<200;t++){const a=rows[Math.floor(rnd()*rows.length)],b=rows[Math.floor(rnd()*rows.length)],s=haversine(a,b);if(s>500&&s<20000)pairs.push([a,b,s]);}
 let noRoute=0,other=0,same=0,both=0;const det=[],mins=[],spd=[],ratio=[],odd=[];
 await pool(pairs,6,async([a,b,s])=>{try{const m=await routing.route(a,b,{vehicle:'motorcycle'});det.push(m.distanceMeters/s);mins.push(m.durationSeconds/60);spd.push(m.distanceMeters/1000/(m.durationSeconds/3600));
   if(m.distanceMeters/s>4)odd.push(`${a.name}>${b.name} ${(s/1000).toFixed(1)}km straight ${(m.distanceMeters/1000).toFixed(1)}km road`);
   try{const c=await routing.route(a,b,{vehicle:'car'});both++;ratio.push(m.distanceMeters/Math.max(1,c.distanceMeters));if(Math.abs(m.distanceMeters-c.distanceMeters)<5)same++;}catch{}
  }catch(e){if(e.status===422)noRoute++;else other++;}});
 console.log('ROUTES',region,'pairs',pairs.length,'noRoute',noRoute,'errors',other,'detour p50',pct(det,.5),'p95',pct(det,.95),'p99',pct(det,.99),'kmh p50',pct(spd,.5),'p95',pct(spd,.95),'samePathAsCar%',(100*same/Math.max(1,both)).toFixed(0),'bike/car dist p50',pct(ratio,.5),'p05',pct(ratio,.05));
 console.log('ODD',region,odd.slice(0,4).join(' | '));
}
// 3. Named difficult trips, with steps and replay of voice logic on the real route.
const trips=[['Kasoa New Market to Tip Toe Lane',[5.5547244,-0.4341409],[5.5731408,-0.2152024]],['Kasoa to Terminal 3',[5.5346,-0.428],[5.6052,-0.1698]],['Circle to East Legon',[5.5699,-0.213],[5.635,-0.161]],['Madina to Achimota',[5.676,-0.165],[5.623,-0.224]],['Tema to Accra',[5.67,0.006],[5.556,-0.1969]],['Kumasi Kejetia area',[6.696,-1.624],[6.673,-1.573]],['Cape Coast',[5.1053,-1.2466],[5.116,-1.29]],['Sunyani',[7.3349,-2.3123],[7.36,-2.33]],['Buduburam to KAAF',[5.5220648,-0.4745987],[5.5124671,-0.4931931]],['Tamale',[9.4072,-0.8392],[9.43,-0.85]]];
for(const [name,a,b] of trips){
 const from={latitude:a[0],longitude:a[1]},to={latitude:b[0],longitude:b[1]};
 try{
  const r=await routing.route(from,to,{vehicle:'motorcycle',steps:true}),pts=r.geometry.coordinates.map(([longitude,latitude])=>({latitude,longitude}));
  let geo=0;for(let i=0;i<pts.length-1;i++)geo+=metersBetween(pts[i],pts[i+1]);
  const types={};for(const s of r.steps)types[s.type]=(types[s.type]||0)+1;
  const unnamed=r.steps.filter(s=>!s.name&&s.type!=='arrive'&&s.type!=='depart').length,sum=r.steps.reduce((x,s)=>x+s.distanceMeters,0);
  let voice={},rs={},spoken=[],reroutes=0,arrived=false,prog=null,back=0,last=0,local=seed;const R=()=>{local=(local*1664525+1013904223)>>>0;return local/2**32;},g=()=>Math.sqrt(-2*Math.log(R()||1e-9))*Math.cos(2*Math.PI*R());
  let walked=0,now=1e6;for(let i=0;i<pts.length-1;i++){const d=metersBetween(pts[i],pts[i+1]);for(let m=0;m<d;m+=10){const t=m/d,p={latitude:pts[i].latitude+t*(pts[i+1].latitude-pts[i].latitude)+g()*15/111320,longitude:pts[i].longitude+t*(pts[i+1].longitude-pts[i].longitude)+g()*15/111320};now+=1000;
     const place=locateOnRoute(p,pts,{after:prog});if(place.offRouteMeters<=60)prog=place.traveledMeters;if(last-place.traveledMeters>100){back++;if(back<=3)console.log('JUMP',name,'at',Math.round(last),'to',Math.round(place.traveledMeters),'off',Math.round(place.offRouteMeters));}last=Math.max(last,place.traveledMeters);
     const q=rerouteCheck(rs,{offRouteMeters:place.offRouteMeters,accuracy:20,now});rs=q;if(q.reroute)reroutes++;
     const n=upcomingStep(r.steps,place.traveledMeters,place.routeMeters),v=voicePrompt(voice,{index:n.index,metersToStep:n.metersToStep,step:n.step,speed:10});voice=v.state;if(v.say)spoken.push(v.say);if(hasArrived(place))arrived=true;}}
  const manoeuvres=r.steps.length-1,announced=new Set(spoken.map(s=>s.replace(/^In [^,]+, /,'').toLowerCase())).size;
  console.log('TRIP',name,'km',(r.distanceMeters/1000).toFixed(2),'min',(r.durationSeconds/60).toFixed(1),'geomKm',(geo/1000).toFixed(2),'stepsKm',(sum/1000).toFixed(2),'steps',r.steps.length,'unnamed',unnamed,JSON.stringify(types),'| replay: reroutes',reroutes,'jumpsBack',back,'arrived',arrived,'prompts',spoken.length,'distinctInstr',announced,'of',manoeuvres);
  console.log('SAY',name,r.steps.slice(0,6).map(s=>s.instruction).join(' / ').slice(0,240));
 }catch(e){console.log('TRIP',name,'FAILED',e.message);}
}
// 4. Tiles.
try{const db=new DatabaseSync(process.env.GHANA_MBTILES,{readOnly:true});
 for(const row of db.prepare('SELECT zoom_level z,count(*) n,avg(length(tile_data)) a,max(length(tile_data)) m,sum(length(tile_data)) t FROM tiles GROUP BY zoom_level ORDER BY zoom_level').all())console.log('TILES z',row.z,'n',row.n,'avgKB',(row.a/1024).toFixed(1),'maxKB',(row.m/1024).toFixed(0),'totalMB',(row.t/1048576).toFixed(0));
 for(const row of db.prepare("SELECT name,value FROM metadata WHERE name IN ('format','minzoom','maxzoom','bounds')").all())console.log('META',row.name,row.value);
}catch(e){console.log('TILES ERR',e.message);}
process.exit(0);
