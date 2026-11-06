import {chromium} from 'playwright';import {readFileSync,mkdirSync} from 'node:fs';
const js=readFileSync('ui-out/app.js','utf8');mkdirSync('shots',{recursive:true});
const R={id:'11111111-1111-4111-8111-111111111111',latitude:5.5547,longitude:-0.4341};
const rest={id:'r1',name:'Cheezzy Pizza',cuisine_category:'Pizza',address:'Near Fire Service, Buduburam',latitude:5.522,longitude:-0.4746,status:'approved',is_open:true,rating:4.3,delivery_fee_minor:2436,distance_m:2900};
const ship={id:R.id,state:'IN_TRANSIT',amount_minor:10148,payment_method:'MOMO',created_at:new Date().toISOString(),details:{pickup:{address:'Kasoa New Market',latitude:5.5547,longitude:-0.4341},destination:{address:'Tip Toe Lane, Accra',latitude:5.5731,longitude:-0.2152},description:'Documents',vehicle:'motorcycle'},pickup:{address:'Kasoa New Market',latitude:5.5547,longitude:-0.4341},destination:{address:'Tip Toe Lane, Accra',latitude:5.5731,longitude:-0.2152}};
function reply(u,kind,rider){const p=new URL(u).pathname;
 if(p==='/api/v1/me')return {id:R.id,kind,name:kind==='rider'?'Kofi Mensah':'Ama Boateng',phone:'+233241234567'};
 if(p==='/api/v1/me/phone')return {verified:true,phone:'+233241234567'};
 if(p==='/api/v1/payments/methods')return {methods:[{id:'MOMO',label:'Mobile Money',enabled:true},{id:'CASH',label:'Cash',enabled:true}]};
 if(p==='/api/v1/pricing/vehicles')return [{vehicle:'motorcycle',base_minor:700,per_km_minor:170,per_minute_minor:90,minimum_minor:2000},{vehicle:'car',base_minor:1500,per_km_minor:320,per_minute_minor:40,minimum_minor:3500}];
 if(p==='/api/v1/shipments')return rider?[]:[ship];if(p==='/api/v1/food-orders')return [];
 if(p.startsWith('/api/v1/restaurants')&&p.endsWith('/menu'))return {restaurant:rest,categories:[{id:'c',name:'Pizza',items:[{id:'i1',name:'Meat Lovers, large',description:'Beef, sausage and chicken',price_minor:14000,available:true}]}]};
 if(p==='/api/v1/restaurants')return [rest];
 if(p==='/api/v1/maps/search')return {results:[{name:'Kasoa New Market',address:'Kasoa, Central Region',latitude:5.5547,longitude:-0.4341}]};
 if(p==='/api/v1/maps/reverse')return {address:'Kasoa New Market, Kasoa',latitude:5.5547,longitude:-0.4341};
 if(p.startsWith('/api/v1/public-track/'))return {shipmentId:R.id,trackingToken:'t',state:'IN_TRANSIT',statusLabel:'On the way',vehicle:'motorcycle',pickup:ship.pickup,destination:ship.destination,courier:{latitude:5.56,longitude:-0.33,name:'Kofi'},courierStale:false,riderPhone:'+233241234567',deliveryEta:{status:'estimated',minMinutes:18,maxMinutes:26,message:'Arriving in about 18–26 minutes.',confidence:'medium'}};
 if(p==='/api/v1/rider/offers')return rider==='offer'?[{offerId:'o1',id:R.id,expiresAt:new Date(Date.now()+25000).toISOString(),pickupEtaSeconds:180,pickupRoadMeters:1200,distance_m:12620,entitlement_minor:3388,amount_minor:3894,commission_minor:506,estimatedDropoffSeconds:900,payment_method:'MOMO',vehicle:'motorcycle',description:'Food order',pickup:ship.pickup,destination:ship.destination,existingParcels:0}]:[];
 if(p==='/api/v1/rider/manifest')return {stops:[],shipments:[]};
 if(p==='/api/v1/rider/wallet/summary')return {availableMinor:45200,pendingMinor:3388,withdrawnTodayMinor:0,minWithdrawalMinor:10000,feeMinor:100};
 if(p==='/api/v1/rider/commissions/summary')return {dueMinor:2400,maxOutstandingMinor:15000,blocked:false,lines:[]};
 if(p==='/api/v1/rider/dispatch-settings')return {online:rider==='offer'};if(p==='/api/v1/rider/vehicle')return {vehicle:'motorcycle',maxWeightG:20000};
 if(p==='/api/v1/rider/licence')return {status:'verified'};if(p==='/api/v1/rider/documents')return [];
 if(p==='/api/v1/rider/location'||p==='/api/v1/rider/availability')return {ok:true,online:true,pendingOffers:rider==='offer'?reply('http://a/api/v1/rider/offers',kind,rider):[]};
 return {};
}
const b=await chromium.launch();const out=[];
async function run(name,{app,signedIn=false,rider=null,steps=[],w=390,h=844}){
 const c=await b.newContext({viewport:{width:w,height:h},deviceScaleFactor:1,hasTouch:true,isMobile:w<500});const p=await c.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
 if(signedIn)await c.addInitScript(()=>localStorage.setItem('elesend.session','t'));
 await p.route('**/*',r=>{const u=r.request().url();if(u.startsWith('http://app.test/')&&!u.includes('/api/')){if(u.includes('app.js'))return r.fulfill({contentType:'text/javascript',body:js});return r.fulfill({contentType:'text/html',body:'<!doctype html><html style="height:100%"><body style="height:100%;margin:0"><div id="root" style="height:100%;display:flex"></div><script src="/app.js"></script></body></html>'});}
  if(u.includes('/api/'))return r.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*'},body:JSON.stringify(reply(u,app==='rider'?'rider':'customer',rider))});return r.abort();});
 await p.goto(`http://app.test/?app=${app}`);await p.waitForTimeout(2500);
 for(const s of steps){try{if(s.tap)await p.getByText(s.tap,{exact:s.exact??false}).first().click({timeout:3000});if(s.fill)await p.getByPlaceholder(s.fill[0]).first().fill(s.fill[1],{timeout:2000});await p.waitForTimeout(s.wait??900);}catch(e){out.push(`${name}: step ${JSON.stringify(s)} failed`);}}
 const m=await p.evaluate(()=>{const v=[...document.querySelectorAll('[role=button],button,a,[tabindex="0"],input,textarea')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.top<innerHeight});const small=v.filter(e=>{const r=e.getBoundingClientRect();return r.height<44||r.width<44}).map(e=>(e.innerText||e.placeholder||e.ariaLabel||'?').trim().slice(0,24));const tiny=[...document.querySelectorAll('div,span')].filter(e=>e.childElementCount===0&&e.innerText?.trim()&&parseFloat(getComputedStyle(e).fontSize)<12).length;return {sw:document.documentElement.scrollWidth,iw:innerWidth,tap:v.length,small:small.slice(0,10),smallN:small.length,tinyText:tiny,text:document.body.innerText.replace(/\s+/g,' ').slice(0,260)};});
 console.log('SCREEN',name,JSON.stringify(m),'ERRORS',errs.length,errs.slice(0,2).join('|').slice(0,200));
 await p.screenshot({path:`shots/${name}.png`});await c.close();
}
await run('c1-signin',{app:'customer'});
await run('c2-home',{app:'customer',signedIn:true});
await run('c3-send',{app:'customer',signedIn:true,steps:[{tap:'Send'}]});
await run('c4-food',{app:'customer',signedIn:true,steps:[{tap:'Food'}]});
await run('c5-activity',{app:'customer',signedIn:true,steps:[{tap:'Activity'}]});
await run('c6-profile',{app:'customer',signedIn:true,steps:[{tap:'Profile'}]});
await run('r1-signin',{app:'rider'});
await run('r2-jobs',{app:'rider',signedIn:true,rider:'home'});
await run('r3-offer',{app:'rider',signedIn:true,rider:'offer',steps:[{wait:2500}]});
await run('r4-earnings',{app:'rider',signedIn:true,rider:'home',steps:[{tap:'Earnings'}]});
await run('r5-profile',{app:'rider',signedIn:true,rider:'home',steps:[{tap:'Profile'}]});
await run('c2-home-small',{app:'customer',signedIn:true,w:320,h:568});
console.log('NOTES',out.join(' ; '));await b.close();
