import test from 'node:test';
import {randomInt,randomUUID,createHmac} from 'node:crypto';
const url=process.env.TEST_DATABASE_URL;
const log=(n,d)=>console.log('AUDIT '+n+' :: '+JSON.stringify(d).slice(0,1100));
const pick=a=>a[randomInt(a.length)];
test('a day',{skip:!url},async()=>{
 process.env.NODE_ENV='production';process.env.OTP_KEY??='d'.repeat(64);
 const I=m=>import(m);
 const {database}=await I('../services/api/db.mjs'),{migrate}=await I('../scripts/migrate.mjs'),{platform}=await I('../services/api/platform.mjs'),{httpServer}=await I('../services/api/http.mjs'),{dispatchEngine}=await I('../services/api/dispatch.mjs');
 const {checkoutService,financeService,moneyOperations,paymentWebhook}=await I('../services/api/modules/payments/index.mjs'),{restaurantOrderService}=await I('../services/api/restaurant-orders.mjs'),{paystackCheckout}=await I('../services/api/modules/payments/paystack-checkout-adapter.mjs'),{backgroundJobs}=await I('../services/api/background-jobs.mjs'),{notificationWorker,queueNotification}=await I('../services/api/notifications.mjs');
 const db=database(url);await migrate(db);
 // Start from an empty day: leave out everything other tests created.
 const startedAt=(await db.query('SELECT now() AS t')).rows[0].t;
 await db.query("UPDATE shipments SET state='CANCELLED' WHERE state='AWAITING_ASSIGNMENT'");await db.query("UPDATE dispatch_offers SET status='expired' WHERE status='offered'");await db.query('UPDATE riders SET online=false');
 const texts=[];const notes=[];const sms={async send(m){texts.push(m);return {accepted:true,messageId:'m'+texts.length};},async sendNotification(m){notes.push(m);return {accepted:true,messageId:'n'+notes.length};}};
 const meters=(a,b)=>Math.max(1,Math.round(Math.hypot((a.latitude-b.latitude)*111000,(a.longitude-b.longitude)*111000)));
 const routing={async route(a,b){const m=meters(a,b);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};},async matrix(o,d){return o.map(x=>{const m=meters(x,d);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};});}};
 const dispatch=dispatchEngine(db,{routing});
 const secret='sk_live_audit5';const PS={tx:{},refunds:{}};
 const ok=d=>({ok:true,status:200,json:async()=>({status:true,data:d})});
 const fetchImpl=async(u,o={})=>{const p=new URL(u).pathname,b=o.body?JSON.parse(o.body):null;
  if(p==='/transaction/initialize'){PS.tx[b.reference]={id:randomInt(1e9),amount:Number(b.amount)};return ok({authorization_url:'https://checkout.paystack.com/x',reference:b.reference});}
  if(p.startsWith('/transaction/verify/')){const r=decodeURIComponent(p.split('/').pop()),t=PS.tx[r];return ok({id:t.id,reference:r,status:'success',domain:'live',amount:t.amount,currency:'GHS',channel:'mobile_money',paid_at:new Date().toISOString()});}
  if(p==='/refund'&&o.method==='POST'){const id=randomInt(1e9),t=PS.tx[b.transaction];PS.refunds[id]={id,amount:Number(b.amount),currency:'GHS',status:'processed',domain:'live',transaction:t.id,merchant_note:b.merchant_note};return ok(PS.refunds[id]);}
  if(p.startsWith('/refund/'))return ok(PS.refunds[p.split('/').pop()]);
  return {ok:false,status:404,json:async()=>({status:false,message:'not found'})};};
 const provider=paystackCheckout({secretKey:secret,production:true,fetchImpl});
 const app=platform(db,{otpKey:process.env.OTP_KEY,routing,dispatch,sms});
 const checkout=checkoutService(db,{provider,sms,dispatch,routing}),finance=financeService(db,{provider}),money=moneyOperations(db,{provider,notify:queueNotification}),rest=restaurantOrderService(db,{platform:app,dispatcher:dispatch,routing,sms});
 const server=httpServer(db,app,dispatch,finance,checkout,{restaurantOrders:rest,moneyOperations:money,paymentsWebhook:paymentWebhook({db,provider,checkout,finance,money,moneyOperations:money})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const errors={};const seen=(what,r)=>{if(r.status>=400){const k=what+' '+r.status+' '+(r.data?.error??'');errors[k]=(errors[k]||0)+1;}return r;};
 const api=async(t,m,p,b,h={})=>{const res=await fetch(base+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{}),...h},body:b===undefined?undefined:JSON.stringify(b)});return {status:res.status,data:await res.json().catch(()=>null)};};
 const phone=()=>'+2332'+String(randomInt(0,1e8)).padStart(8,'0');const PW='mango river lantern';
 const lastCodeFor=(ph,purpose)=>[...texts].reverse().find(m=>m.phone===ph&&(!purpose||m.purpose===purpose))?.code;
 const signUp=async(k,e={})=>{const number=phone();await api(null,'POST','/api/v1/auth/register',{phone:number,password:PW,kind:k,...e});const l=await api(null,'POST','/api/v1/auth/login',{phone:number,password:PW});const a={number,token:l.data.token,id:l.data.user.id};const ch=await api(a.token,'POST','/api/v1/me/phone-challenge',{});await api(a.token,'POST','/api/v1/me/phone-verify',{challengeId:ch.data.challengeId,code:lastCodeFor(number,'account')});return a;};
 const webhook=body=>{const raw=JSON.stringify(body);return fetch(base+'/api/v1/payments/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-paystack-signature':createHmac('sha512',secret).update(raw).digest('hex')},body:raw}).then(r=>r.status);};
 const PLACES=[['Accra Mall',5.6221,-0.1735],['Osu Oxford Street',5.5571,-0.1817],['Airport Residential',5.6050,-0.1800],['Madina Market',5.6700,-0.1660],['Kaneshie Market',5.5560,-0.2350],['East Legon',5.6350,-0.1600],['Tema Community 1',5.6698,-0.0166],['Dansoman',5.5420,-0.2600],['Labadi',5.5620,-0.1450],['Achimota',5.6170,-0.2290]].map(([n,a,o])=>({address:n+', Accra, Ghana',latitude:a,longitude:o}));
 const gps=(r,at)=>{r.at=at;return api(r.token,'POST','/api/v1/rider/location',{latitude:at.latitude,longitude:at.longitude,accuracyMeters:15,observedAt:new Date().toISOString()});};
 const riders=[];for(let i=0;i<10;i++){const r=await signUp('rider',{vehicle:'motorcycle',maxWeightG:20000});await db.query("UPDATE riders SET status='approved' WHERE id=$1",[r.id]);await api(r.token,'POST','/api/v1/rider/availability',{online:true});await gps(r,pick(PLACES));if(i%2)await api(r.token,'POST','/api/v1/rider/multi-stop',{enabled:true});riders.push(r);}
 const customers=[];for(let i=0;i<25;i++)customers.push(await signUp('customer'));
 const owners=[],menus=[];for(let i=0;i<3;i++){const o=await signUp('business');const at=pick(PLACES);const made=await api(o.token,'POST','/api/v1/restaurants',{name:'Day Kitchen '+randomInt(1e7),phone:'024'+String(randomInt(0,1e7)).padStart(7,'0'),address:at.address,latitude:at.latitude,longitude:at.longitude});await db.query("UPDATE restaurants SET status='approved',is_open=true,is_paused=false WHERE id=$1",[made.data.id]);const it=await api(o.token,'POST','/api/v1/restaurants/'+made.data.id+'/items',{name:'Waakye',priceMinor:3000+randomInt(4000)});owners.push(o);menus.push({rid:made.data.id,item:it.data.id,owner:o});}
 const orders=[];
 const pay=async(c,sid)=>{const p=seen('checkout',await api(c.token,'POST','/api/v1/shipments/'+sid+'/checkout',{idempotencyKey:'d5-'+randomInt(1e9),email:'a@example.com'}));if(p.data?.reference)return seen('webhook',{status:await webhook({event:'charge.success',data:{reference:p.data.reference}})});};
 const newOrder=async()=>{const c=pick(customers),kind=randomInt(10);
  if(kind<2){const m=pick(menus),d=pick(PLACES);const o=seen('food order',await api(c.token,'POST','/api/v1/food-orders',{restaurantId:m.rid,items:[{itemId:m.item,quantity:1+randomInt(3)}],deliveryAddress:d.address,deliveryLatitude:d.latitude,deliveryLongitude:d.longitude,customerPhone:'0241234567',paymentMethod:'MOMO'},{'Idempotency-Key':'f-'+randomInt(1e9)}));if(o.status!==200)return;await pay(c,o.data.shipment_id);orders.push({id:o.data.shipment_id,food:o.data.id,m,c});return;}
  const from=pick(PLACES);let to=pick(PLACES);while(to===from)to=pick(PLACES);
  const cash=kind===9;
  const q=seen('quote',await api(c.token,'POST','/api/v1/quotes',{pickup:from,destination:to,vehicle:'motorcycle',recipientPhone:phone(),weightG:500+randomInt(5000),description:pick(['Documents','Phone','Shoes','Cake']),paymentMethod:cash?'CASH':'MOMO',...(cash?{cashPayer:'sender'}:{})}));if(q.status!==200)return;
  const s=seen('book',await api(c.token,'POST','/api/v1/shipments',{quoteId:q.data.id},{'Idempotency-Key':'b-'+randomInt(1e9)}));if(s.status!==200)return;
  const o={id:s.data.id,c,from,to,cash,amount:s.data.amount_minor};
  if(!cash&&kind!==1)await pay(c,s.data.id);orders.push(o);
 };
 const act=async o=>{const s=(await db.query('SELECT s.*,q.request FROM shipments s JOIN quotes q ON q.id=s.quote_id WHERE s.id=$1',[o.id])).rows[0];if(!s)return;
  if(o.food&&!o.kitchen&&s.paid){o.kitchen=1;const f=o.m.owner.token;if(randomInt(10)===0){seen('kitchen reject',await api(f,'POST','/api/v1/food-orders/'+o.food+'/reject',{reason:'Out of stock'}));return;}seen('kitchen accept',await api(f,'POST','/api/v1/food-orders/'+o.food+'/accept',{}));seen('kitchen prepare',await api(f,'POST','/api/v1/food-orders/'+o.food+'/prepare',{}));seen('kitchen ready',await api(f,'POST','/api/v1/food-orders/'+o.food+'/ready',{}));return;}
  if(['AWAITING_ASSIGNMENT','AWAITING_PAYMENT'].includes(s.state)&&!o.food&&randomInt(25)===0){seen('customer cancel',await api(o.c.token,'POST','/api/v1/shipments/'+o.id+'/transition',{action:'cancel',reason:'Changed my mind'}));return;}
  const r=riders.find(x=>x.id===s.rider_id);if(!r)return;
  if(s.state==='RIDER_ASSIGNED'&&!o.food&&randomInt(15)===0){seen('cancel with rider',await api(o.c.token,'POST','/api/v1/shipments/'+o.id+'/transition',{action:'cancel',reason:'Changed my mind'}));return;}
  if(s.state==='RIDER_ASSIGNED'&&randomInt(20)===0){seen('rider release',await api(r.token,'POST','/api/v1/rider/assignments/release',{shipmentId:o.id,reason:'Bike broke down'}));return;}
  const man=(await api(r.token,'GET','/api/v1/rider/manifest')).data;const next=man?.stops?.[0];if(!next||next.shipmentId!==o.id)return;
  const kind=next.kind==='pickup'?'pickup':'delivery';
  if(kind==='pickup'&&s.payment_method==='CASH'&&s.cash_payer==='sender')seen('cash report',await api(r.token,'POST','/api/v1/rider/cash-report',{shipmentId:o.id,reportedMinor:Number(s.amount_minor),cashPayer:'sender',idempotencyKey:'cr-'+randomInt(1e9)}));
  await gps(r,{latitude:next.latitude,longitude:next.longitude});
  if(kind==='delivery'&&randomInt(12)===0){seen('rider fail',await api(r.token,'POST','/api/v1/shipments/'+o.id+'/transition',{action:'fail',reason:'Recipient unreachable'}));o.failed=true;return;}
  const ch=seen(kind+' challenge',await api(r.token,'POST','/api/v1/shipments/'+o.id+'/'+kind+'-challenge',{}));if(ch.status!==200)return;
  const code=[...texts].reverse().find(m=>m.challengeId===ch.data.challengeId)?.code;
  seen(kind+' verify',await api(r.token,'POST','/api/v1/shipments/'+o.id+'/verify',{challengeId:ch.data.challengeId,code}));
  if(kind==='pickup')seen('start',await api(r.token,'POST','/api/v1/shipments/'+o.id+'/transition',{action:'start'}));
 };
 const returns=async o=>{const s=(await db.query('SELECT state,rider_id FROM shipments WHERE id=$1',[o.id])).rows[0];const r=riders.find(x=>x.id===s?.rider_id);if(!r)return;
  if(s.state==='FAILED'&&!o.food){seen('return',await api(r.token,'POST','/api/v1/shipments/'+o.id+'/transition',{action:'return',reason:'Taking it back'}));return;}
  if(s.state==='RETURN_REQUESTED'&&!o.food){const ch=seen('return challenge',await api(r.token,'POST','/api/v1/shipments/'+o.id+'/return-challenge',{}));if(ch.status!==200)return;const code=[...texts].reverse().find(m=>m.challengeId===ch.data.challengeId)?.code;seen('return verify',await api(r.token,'POST','/api/v1/shipments/'+o.id+'/verify',{challengeId:ch.data.challengeId,code}));}
 };
 const c1=customers[0],c2=customers[1];const r=riders[1];
 await db.query('UPDATE riders SET online=false WHERE id<>$1',[r.id]);
 const P=PLACES[0];await gps(r,P);
 const mk=async(c,from,to)=>{const q=await api(c.token,'POST','/api/v1/quotes',{pickup:from,destination:to,vehicle:'motorcycle',recipientPhone:phone(),weightG:1000,description:'Docs',paymentMethod:'MOMO'});const s=await api(c.token,'POST','/api/v1/shipments',{quoteId:q.data.id},{'Idempotency-Key':'m-'+randomInt(1e9)});await pay(c,s.data.id);await dispatch.tick(20);const o=(await api(r.token,'GET','/api/v1/rider/offers')).data.find(x=>x.id===s.data.id);const a=await api(r.token,'POST','/api/v1/shipments/'+s.data.id+'/accept',{offerId:o?.offerId});return {id:s.data.id,offer:!!o,accept:a.status};};
 const A=await mk(c1,P,PLACES[1]);const B=await mk(c2,{address:'Tetteh Quarshie, Accra, Ghana',latitude:5.62,longitude:-0.174},PLACES[2]);
 const man=async()=>(await api(r.token,'GET','/api/v1/rider/manifest')).data.stops.map(s=>[s.shipmentId===A.id?'A':'B',s.kind]);
 log('plan',{A,B,stops:await man()});
 const step=async(id,kind)=>{const ch=await api(r.token,'POST','/api/v1/shipments/'+id+'/'+kind+'-challenge',{});const code=[...texts].reverse().find(m=>m.challengeId===ch.data?.challengeId)?.code;const v=await api(r.token,'POST','/api/v1/shipments/'+id+'/verify',{challengeId:ch.data?.challengeId,code});return [ch.status,ch.data?.error,v.status];};
 const first=(await api(r.token,'GET','/api/v1/rider/manifest')).data.stops;const pa=await step(first[0].shipmentId,'pickup');const pb=await step(first[1].shipmentId,'pickup');
 for(const x of [A,B])await api(r.token,'POST','/api/v1/shipments/'+x.id+'/transition',{action:'start'});
 const order=(await api(r.token,'GET','/api/v1/rider/manifest')).data.stops;const firstDrop=order[0].shipmentId,secondDrop=order[1].shipmentId;
 const fail=await api(r.token,'POST','/api/v1/shipments/'+firstDrop+'/transition',{action:'fail',reason:'Recipient unreachable'});
 const afterFail=(await api(r.token,'GET','/api/v1/rider/manifest')).data.stops.map(s=>[s.shipmentId===firstDrop?'failed':'other',s.kind]);
 const other=await step(secondDrop,'delivery');
 const ret=await api(r.token,'POST','/api/v1/shipments/'+firstDrop+'/transition',{action:'return',reason:'Taking it back'});
 const other2=await step(secondDrop,'delivery');
 log('first parcel fails while second is on board',{pa,pb,fail:fail.status,afterFail,otherDelivery:other,ret:[ret.status,ret.data?.error],otherAfterReturnRequest:other2,afterStops:(await api(r.token,'GET','/api/v1/rider/manifest')).data.stops.map(s=>[s.shipmentId===firstDrop?'failed':'other',s.kind])});
 log('ALL DONE',{});setTimeout(()=>process.exit(0),300);await new Promise(()=>{});
});
