import test from 'node:test';
import assert from 'node:assert/strict';
import {hasArrived,locateOnRoute,metersBetween,rerouteCheck,upcomingStep,usableFix,voicePrompt} from '../apps/mobile/src/rider/navigation-logic.mjs';
import {osrmRouting,stepInstruction} from '../services/api/dispatch-routing.mjs';
import {ghanaReverseGeocode,ghanaSearch} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';

const METER=1/111320;
const east=m=>({latitude:5.6,longitude:-0.2+m*METER});
const line=(...metres)=>metres.map(east);
function seeded(seed){let s=seed;return ()=>{s=(s*1664525+1013904223)>>>0;return s/2**32;};}
const gauss=rand=>Math.sqrt(-2*Math.log(rand()||1e-9))*Math.cos(2*Math.PI*rand());
const legRoute=()=>{ // An L-shaped route of 3 km with turns, in metres.
 const pts=[];for(let m=0;m<=1500;m+=50)pts.push({latitude:5.6,longitude:-0.2+m*METER});
 for(let m=50;m<=1500;m+=50)pts.push({latitude:5.6+m*METER,longitude:-0.2+1500*METER});
 const steps=[{distanceMeters:1500,instruction:'Head out'},{distanceMeters:1000,instruction:'Turn left onto Ring Road'},{distanceMeters:500,instruction:'Turn right onto Oxford Street'},{distanceMeters:0,type:'arrive',instruction:'You have arrived'}];
 return {pts,steps};
};
const along=(pts,target)=>{let run=0;for(let i=0;i<pts.length-1;i++){const d=metersBetween(pts[i],pts[i+1]);if(run+d>=target){const t=(target-run)/d;return {latitude:pts[i].latitude+t*(pts[i+1].latitude-pts[i].latitude),longitude:pts[i].longitude+t*(pts[i+1].longitude-pts[i].longitude)};}run+=d;}return pts.at(-1);};

test('progress stays on the current stretch when a route uses a road twice',()=>{
 const out=line(0,500,1000),back=line(1000,500,0),route=[...out,...back.slice(1)];
 const here=east(600);
 assert.ok(Math.abs(locateOnRoute(here,route,{after:1300}).traveledMeters-1393)<10,'on the way back');
 assert.ok(Math.abs(locateOnRoute(here,route,{after:550}).traveledMeters-597)<10,'on the way out');
 assert.ok(locateOnRoute(here,route).traveledMeters<700,'without history it is the closest point');
});
test('a noisy fix on a road that doubles back does not skip ahead',()=>{
 const side=20*METER,route=[east(0),east(300),{...east(300),latitude:5.6+side},{...east(0),latitude:5.6+side}];
 const here={...east(100),latitude:5.6+16*METER};
 const place=locateOnRoute(here,route,{after:90});
 assert.ok(place.traveledMeters<150,String(place.traveledMeters));
});
test('a jump far from the expected stretch falls back to the closest point',()=>{
 const route=line(0,1000,2000,3000);
 assert.ok(Math.abs(locateOnRoute(east(2500),route,{after:100}).traveledMeters-2488)<10);
});
test('being level with the end from another road is not arriving',()=>{
 const route=line(0,1000);
 const beside={latitude:5.6+200*METER,longitude:east(1000).longitude};
 const place=locateOnRoute(beside,route);
 assert.ok(place.remainingMeters<=30);
 assert.equal(hasArrived(place),false);
 assert.equal(hasArrived(locateOnRoute(east(990),route)),true);
});
test('voice cannot crash on an empty instruction and warns earlier at speed',()=>{
 assert.equal(voicePrompt({},{index:0,metersToStep:100,step:{instruction:''}}).say,null);
 assert.equal(voicePrompt({},{index:0,metersToStep:500,step:{instruction:'Turn left'}}).say,null);
 assert.equal(voicePrompt({},{index:0,metersToStep:500,step:{instruction:'Turn left'},speed:28}).say,'In 500 m, turn left');
 assert.equal(voicePrompt({},{index:0,metersToStep:280,step:{type:'arrive',instruction:'You have arrived'}}).say,'Your destination is in 280 m');
});
test('old, unreadable and impossible GPS fixes are refused; a parked heading is ignored',()=>{
 const now=1000000,fix=(lat,over={})=>({timestamp:now,coords:{latitude:lat,longitude:-0.2,accuracy:10,speed:10,heading:90,...over}});
 assert.equal(usableFix(null,{coords:{latitude:NaN,longitude:0}},now),null);
 assert.equal(usableFix(null,{...fix(5.6),timestamp:now-60000},now),null);
 const first=usableFix(null,fix(5.6),now);assert.equal(first.heading,90);
 assert.equal(usableFix({...first,at:now-2000},fix(5.7),now),null,'11 km in 2 seconds');
 const parked=usableFix({...first,at:now-2000},fix(5.6,{speed:0,heading:-1}),now);
 assert.equal(parked.heading,90,'keeps the last heading');
 assert.equal(usableFix({...first,at:now},fix(5.6),now),null,'out of order');
});
test('GPS replay: full trip, every turn once far and once near, no false reroute',()=>{
 const {pts,steps}=legRoute(),total=3000;
 for(const [noise,accuracy,seed] of [[5,8,1],[15,20,2],[30,40,3]]){
  const rand=seeded(seed);let progress=null,voice={},reroute={},spoken=[],reroutes=0,back=0,last=-1,arrived=false;
  for(let m=0,now=1e6;m<=total;m+=12,now+=1000){
   const p=along(pts,m),here={latitude:p.latitude+gauss(rand)*noise*METER,longitude:p.longitude+gauss(rand)*noise*METER};
   const place=locateOnRoute(here,pts,{after:progress});
   if(place.offRouteMeters<=60)progress=place.traveledMeters;
   if(last-place.traveledMeters>noise*4+20)back+=1;last=Math.max(last,place.traveledMeters);
   const r=rerouteCheck(reroute,{offRouteMeters:place.offRouteMeters,accuracy,now});reroute=r;if(r.reroute)reroutes+=1;
   const next=upcomingStep(steps,place.traveledMeters);
   const v=voicePrompt(voice,{index:next.index,metersToStep:next.metersToStep,step:next.step,speed:12});voice=v.state;if(v.say)spoken.push(v.say);
   if(hasArrived(place))arrived=true;
  }
  assert.equal(reroutes,0,`no reroute at ${noise} m noise`);
  assert.equal(back,0,'progress only moves back by GPS noise');
  assert.equal(arrived,true);
  for(const words of ['turn left onto ring road','turn right onto oxford street'])assert.equal(spoken.filter(s=>s.toLowerCase().includes(words)).length,2,spoken.join(' | '));
  assert.equal(new Set(spoken).size>=4,true);
 }
});
test('GPS replay: a genuine wrong turn reroutes within a few fixes, then stops',()=>{
 const {pts}=legRoute();let reroute={},fired=[];
 for(let i=0,now=1e6;i<20;i++,now+=2000){
  const here={latitude:5.6-(i*15)*METER,longitude:-0.2+500*METER};
  const place=locateOnRoute(here,pts,{after:500});
  reroute=rerouteCheck(reroute,{offRouteMeters:place.offRouteMeters,accuracy:10,now});
  if(reroute.reroute)fired.push(i);
 }
 assert.ok(fired[0]<=6,String(fired));
 assert.ok(fired.length<=2,'cooldown holds');
});
test('a weak fix must be further off before it counts',()=>{
 assert.equal(rerouteCheck({},{offRouteMeters:70,accuracy:50,now:1}).strikes,0);
 assert.equal(rerouteCheck({},{offRouteMeters:70,accuracy:10,now:1}).strikes,1);
});
test('a roundabout without an exit number does not name one',()=>{
 assert.equal(stepInstruction({maneuver:{type:'roundabout'},name:'Ring Road'}),'Enter the roundabout onto Ring Road');
 assert.equal(stepInstruction({maneuver:{type:'roundabout',exit:3}}),'At the roundabout, take exit 3');
});
test('reroutes start in the direction of travel, and survive a bad heading',async()=>{
 const urls=[];let refuse=false;
 const routing=osrmRouting({endpoint:'http://osrm.test',profiles:{motorcycle:'driving'},fetchImpl:async url=>{urls.push(String(url));const hinted=String(url).includes('bearings');return {ok:true,status:200,json:async()=>refuse&&hinted?{code:'NoSegment'}:{code:'Ok',routes:[{distance:1000,duration:60,geometry:{type:'LineString',coordinates:[]},legs:[]}],waypoints:[{distance:1},{distance:1}]}};}});
 const a={latitude:5.6,longitude:-0.2},b={latitude:5.6,longitude:-0.19};
 await routing.route(a,b,{vehicle:'motorcycle',bearing:271.4});
 assert.match(urls[0],/bearings=271,60;&/);
 await routing.route(a,b,{vehicle:'motorcycle'});
 assert.doesNotMatch(urls[1],/bearings/);
 refuse=true;urls.length=0;
 assert.equal((await routing.route(a,b,{vehicle:'motorcycle',bearing:10})).distanceMeters,1000);
 assert.equal(urls.length,2,'retries without the heading');
});
test('search: towns outrank namesakes, exact names come first, repeats collapse',()=>{
 const first=q=>ghanaSearch(q)[0];
 assert.equal(first('Tamale').region,'Northern');
 assert.equal(first('Tarkwa').region,'Western');
 assert.equal(first('Bolga').region,'Upper East');
 assert.equal(first('Cape Coast castle').name,'Cape Coast Castle');
 assert.equal(first('Kasoa').region,'Central');
 for(const q of ['Circle','Mallam junction','kaneshie market','Korle Bu']){
  const rows=ghanaSearch(q);
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++)assert.ok(!(rows[i].name===rows[j].name&&metersBetween(rows[i],rows[j])<=250),q);
 }
});
test('reverse lookup does not describe a pin by something 88 km away',()=>{
 assert.match(ghanaReverseGeocode(8,-3).address,/^Ghana \(/);
 assert.ok(ghanaReverseGeocode(5.6,-0.17).distanceMeters<10000);
});
