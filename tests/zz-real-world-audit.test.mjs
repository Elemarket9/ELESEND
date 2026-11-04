import test from 'node:test';
import {randomInt} from 'node:crypto';
const url=process.env.TEST_DATABASE_URL;
const log=(name,detail)=>console.log('AUDIT '+name+' :: '+JSON.stringify(detail,(k,v)=>typeof v==='string'&&v.length>160?v.slice(0,160)+'…':v).slice(0,700));
test('real world walk-through',{skip:!url},async()=>{
 process.env.NODE_ENV='production';
 process.env.OTP_KEY='d'.repeat(64);
 const {database}=await import('../services/api/db.mjs');
 const {migrate}=await import('../scripts/migrate.mjs');
 const {platform}=await import('../services/api/platform.mjs');
 const {httpServer}=await import('../services/api/http.mjs');
 const {dispatchEngine}=await import('../services/api/dispatch.mjs');
 const {checkoutService,financeService,moneyOperations}=await import('../services/api/modules/payments/index.mjs');
 const {restaurantOrderService}=await import('../services/api/restaurant-orders.mjs');
 const db=database(url);await migrate(db);
 const texts=[];let smsWorks=true;
 const sms={async send(m){if(!smsWorks)return {accepted:false};texts.push(m);return {accepted:true,providerId:'x'};},async sendNotification(m){texts.push(m);return {accepted:true};}};
 const routing={async route(a,b){const m=Math.round(Math.hypot((a.latitude-b.latitude)*111000,(a.longitude-b.longitude)*111000));return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8),distance:m,duration:m/8,geometry:{type:'LineString',coordinates:[[a.longitude,a.latitude],[b.longitude,b.latitude]]}};},async matrix(o,d){return o.map(x=>d.map(y=>{const m=Math.round(Math.hypot((x.latitude-y.latitude)*111000,(x.longitude-y.longitude)*111000));return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8),distance:m,duration:m/8};}));}};
 const dispatch=dispatchEngine(db,{routing});
 const payments=[];
 const provider={name:'audit_fx',methods:['MOMO','CARD','DIGITAL'],allowedCheckoutHosts:['checkout.test'],async createPayment(x){payments.push(x);return {reference:x.reference,checkoutUrl:'https://checkout.test/'+x.reference};},async verifyPayment(ref){return {verified:true,status:'pending',reference:ref};},commissionIntentId:()=>null,async parseVerifiedWebhook(){return null;},async createPayout(x){return {providerId:'po_'+x.requestId};},async verifyPayout(){return {verified:true,status:'pending'};},async verifyBeneficiary({beneficiaryId,recipientReference}){return {verified:true,beneficiaryId,recipientReference};},async createBeneficiary(){return {recipientReference:'RCP_x'};}};
 const app=platform(db,{otpKey:process.env.OTP_KEY,routing,dispatch,sms});
 const checkout=checkoutService(db,{provider,sms,dispatch,routing});
 const finance=financeService(db,{provider});
 const money=moneyOperations(db,{provider});
 const server=httpServer(db,app,dispatch,finance,checkout,{restaurantOrders:restaurantOrderService(db,{platform:app,dispatcher:dispatch,routing,sms}),moneyOperations:money});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const api=async(token,method,path,body,headers={})=>{const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});const data=await res.json().catch(()=>null);return {status:res.status,data};};
 const phone=()=>'+23324'+String(randomInt(0,10000000)).padStart(7,'0');
 const PW='mango river lantern';
 const lastCode=()=>{for(let i=texts.length-1;i>=0;i--){const m=/\b(\d{6})\b/.exec(JSON.stringify(texts[i]));if(m)return m[1];}return null;};
 async function account(kind,extra={}){
  const number=phone();
  const reg=await api(null,'POST','/api/v1/auth/register',{phone:number,password:PW,kind,...extra});
  const login=await api(null,'POST','/api/v1/auth/login',{phone:number,password:PW});
  const token=login.data?.token,id=login.data?.user?.id;
  // What a brand new, unapproved account can actually reach.
  if(kind==='rider'||kind==='company'){
   const probes={};
   for(const [m,path,body] of [['GET','/api/v1/me'],['GET','/api/v1/me/phone'],['POST','/api/v1/me/phone-challenge',{}],...(kind==='rider'?[['GET','/api/v1/rider/licence'],['POST','/api/v1/rider/licence',{}],['POST','/api/v1/rider/licence/identity-check',{}]]:[['GET','/api/v1/company/profile']])]){const x=await api(token,m,path,body);probes[m+' '+path]=[x.status,x.data?.error];}
   log('brand new '+kind+' can reach',probes);
   if(kind==='rider')await db.query("UPDATE riders SET status='approved' WHERE id=$1",[id]);
   else await db.query("UPDATE companies SET status='approved' WHERE owner_id=$1",[id]);
  }
  const ch=await api(token,'POST','/api/v1/me/phone-challenge',{});
  const ver=await api(token,'POST','/api/v1/me/phone-verify',{challengeId:ch.data?.challengeId,code:lastCode()});
  if(kind==='rider')await db.query("UPDATE riders SET status='pending' WHERE id=$1",[id]);
  return {number,token,id,reg:reg.status,verified:ver.status,kind};
 }
 const P={address:'Accra Mall, Tetteh Quarshie',latitude:5.6221,longitude:-0.1735},D={address:'Osu Oxford Street, Accra',latitude:5.5571,longitude:-0.1817};
 const booking=(over={})=>({pickup:P,destination:D,vehicle:'motorcycle',recipientPhone:phone(),weightG:1000,description:'Documents',paymentMethod:'MOMO',...over});
 const gps=async(r,lat=P.latitude,lng=P.longitude)=>api(r.token,'POST','/api/v1/rider/location',{latitude:lat,longitude:lng,accuracyMeters:15,speedMps:0,observedAt:new Date().toISOString()});
 async function goOnline(r){await db.query("UPDATE riders SET status='approved' WHERE id=$1",[r.id]);const a=await api(r.token,'POST','/api/v1/rider/availability',{online:true});const g=await gps(r);return {online:a.status,onlineErr:a.data?.error,gps:g.status,gpsErr:g.data?.error};}
 async function bookAndPay(c,over){
  const q=await api(c.token,'POST','/api/v1/quotes',booking(over));
  if(q.status!==200&&q.status!==201)return {q};
  const key='audit-'+randomInt(1e9);
  const s=await api(c.token,'POST','/api/v1/shipments',{quoteId:q.data.id},{'Idempotency-Key':key});
  const again=await api(c.token,'POST','/api/v1/shipments',{quoteId:q.data.id},{'Idempotency-Key':key});
  const pay=await api(c.token,'POST','/api/v1/shipments/'+s.data?.id+'/checkout',{idempotencyKey:key});
  let confirm=null;
  if(pay.data?.reference){try{const row=(await db.query('SELECT amount_minor,processing_fee_minor FROM shipment_checkout_intents WHERE reference=$1',[pay.data.reference])).rows[0];confirm=await checkout.confirmVerified({verified:true,status:'success',reference:pay.data.reference,amountMinor:Number(pay.data.amountMinor)+Number(pay.data.processingFeeMinor||0),currency:'GHS',eventId:'ev'+randomInt(1e9),method:'MOMO',row});}catch(e){confirm={error:e.message};}}
  return {q,s,sameBooking:again.data?.id===s.data?.id,pay,confirm,id:s.data?.id};
 }
 async function deliver(r,id){
  const offers=await api(r.token,'GET','/api/v1/rider/offers');
  const offer=(offers.data||[]).find?.(o=>o.shipment_id===id||o.shipmentId===id||o.id===id);
  log('offer seen by rider',{count:offers.data?.length,keys:offer?Object.keys(offer):offers.data});
  const acc=await api(r.token,'POST','/api/v1/shipments/'+id+'/accept',{offerId:offer?.offer_id??offer?.offerId??offer?.id});
  log('accept',{status:acc.status,err:acc.data?.error});
  const steps={};
  const pc=await api(r.token,'POST','/api/v1/shipments/'+id+'/pickup-challenge',{});steps.pickupChallenge=[pc.status,pc.data?.error];
  const bad=await api(r.token,'POST','/api/v1/shipments/'+id+'/verify',{challengeId:pc.data?.challengeId,code:'000000'});steps.wrongCode=[bad.status,bad.data?.error];
  const pv=await api(r.token,'POST','/api/v1/shipments/'+id+'/verify',{challengeId:pc.data?.challengeId,code:lastCode()});steps.pickupVerify=[pv.status,pv.data?.error];
  const st=await api(r.token,'POST','/api/v1/shipments/'+id+'/transition',{action:'start'});steps.start=[st.status,st.data?.error];
  await gps(r,D.latitude,D.longitude);
  await api(r.token,'POST','/api/v1/shipments/'+id+'/location',{latitude:D.latitude,longitude:D.longitude,accuracyMeters:15,observedAt:new Date().toISOString()});
  const dc=await api(r.token,'POST','/api/v1/shipments/'+id+'/delivery-challenge',{});steps.deliveryChallenge=[dc.status,dc.data?.error];
  const dv=await api(r.token,'POST','/api/v1/shipments/'+id+'/verify',{challengeId:dc.data?.challengeId,code:lastCode()});steps.deliveryVerify=[dv.status,dv.data?.error];
  const state=(await db.query('SELECT state,paid,company_id FROM shipments WHERE id=$1',[id])).rows[0];
  log('delivery steps',{steps,state});
  return state;
 }
 const scene=async(name,fn)=>{try{await fn();}catch(e){log(name+' CRASHED',{message:e.message,stack:e.stack?.split('\n')[1]});}};

 await scene('customer parcel',async()=>{
  const c=await account('customer');log('customer account',{reg:c.reg,verified:c.verified});
  const r=await account('rider',{vehicle:'motorcycle',maxWeightG:20000});log('rider account',{reg:r.reg,verified:r.verified});
  const before=await api(r.token,'POST','/api/v1/rider/availability',{online:true});log('rider online before approval',{status:before.status,err:before.data?.error});
  log('rider online after approval',await goOnline(r));
  const b=await bookAndPay(c);log('customer booking',{quote:b.q.status,quoteErr:b.q.data?.error,amount:b.q.data?.amount_minor,book:b.s?.status,bookErr:b.s?.data?.error,sameBooking:b.sameBooking,pay:b.pay?.status,payErr:b.pay?.data?.error,fee:b.pay?.data?.processingFeeMinor,confirm:b.confirm});
  if(!b.id)return;
  const t=await dispatch.tick();log('dispatch',t);
  await deliver(r,b.id);
  await dispatch.tick();
  const wallet=await api(r.token,'GET','/api/v1/rider/finance');log('rider finance route',{status:wallet.status,keys:wallet.data&&Object.keys(wallet.data)});
  const lines=(await db.query(`SELECT j.kind,l.account,l.side,l.amount_minor FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.shipment_id=$1`,[b.id])).rows;
  log('ledger',{balanced:lines.reduce((s,l)=>s+(l.side==='debit'?1:-1)*Number(l.amount_minor),0),lines});
  const texted=texts.slice(-6).map(m=>String(m.body??m.message??m.text??JSON.stringify(m)).replace(/\d{6}/g,'CODE').slice(0,110));log('texts sent',texted);
 });

 await scene('two riders one offer',async()=>{
  const c=await account('customer');const a=await account('rider',{vehicle:'motorcycle',maxWeightG:20000}),b=await account('rider',{vehicle:'motorcycle',maxWeightG:20000});
  await goOnline(a);await goOnline(b);
  const k=await bookAndPay(c);await dispatch.tick();
  const oa=await api(a.token,'GET','/api/v1/rider/offers'),ob=await api(b.token,'GET','/api/v1/rider/offers');
  log('offers split',{a:oa.data?.length,b:ob.data?.length});
  await db.query("UPDATE riders SET online=false WHERE id=ANY($1)",[[a.id,b.id]]);
  await db.query("UPDATE dispatch_offers SET status='expired' WHERE shipment_id=$1",[k.id]);
 });

 await scene('no rider available',async()=>{
  await db.query("UPDATE riders SET online=false");
  const c=await account('customer');const k=await bookAndPay(c);
  const results=[];for(let i=0;i<30;i++){const x=await db.query("UPDATE shipments SET next_dispatch_at=now() WHERE id=$1",[k.id]);const out=await dispatch.dispatchShipment(k.id).catch(e=>({error:e.message}));results.push(out.status||out.error);if(out.status==='manual_review_required')break;}
  const row=(await db.query('SELECT state,paid,dispatch_attempts FROM shipments WHERE id=$1',[k.id])).rows[0];
  const seen=await api(c.token,'GET','/api/v1/shipments/'+k.id+'/dispatch');
  const cancel=await api(c.token,'POST','/api/v1/shipments/'+k.id+'/transition',{action:'cancel',reason:'No rider came'});
  const refunds=(await db.query('SELECT status,amount_minor FROM checkout_refund_requests WHERE shipment_id=$1',[k.id]).catch(e=>({rows:[e.message]}))).rows;
  log('no rider',{attempts:results.length,last:results.at(-1),row,customerSees:seen.data,cancel:[cancel.status,cancel.data?.error],refunds,alerts:(await db.query("SELECT count(*)::int n FROM notification_jobs WHERE recipient_id=$1",[c.id])).rows[0].n});
 });

 await scene('SMS down at handover',async()=>{
  const c=await account('customer');const r=await account('rider',{vehicle:'motorcycle',maxWeightG:20000});await goOnline(r);
  const k=await bookAndPay(c);await dispatch.tick();
  const offers=await api(r.token,'GET','/api/v1/rider/offers');const o=offers.data?.[0];
  await api(r.token,'POST','/api/v1/shipments/'+k.id+'/accept',{offerId:o?.offer_id??o?.offerId??o?.id});
  smsWorks=false;
  const pc=await api(r.token,'POST','/api/v1/shipments/'+k.id+'/pickup-challenge',{});
  smsWorks=true;
  log('SMS down',{status:pc.status,err:pc.data?.error,state:(await db.query('SELECT state FROM shipments WHERE id=$1',[k.id])).rows[0]?.state});
  await db.query("UPDATE riders SET online=false WHERE id=$1",[r.id]);
 });

 await scene('session ends mid shift',async()=>{
  const r=await account('rider',{vehicle:'motorcycle',maxWeightG:20000});await goOnline(r);
  const row=(await db.query('SELECT expires_at-now() AS left FROM sessions WHERE user_id=$1',[r.id])).rows[0];
  await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",[r.id]);
  const res=await api(r.token,'GET','/api/v1/rider/manifest');
  const still=(await db.query('SELECT online FROM riders WHERE id=$1',[r.id])).rows[0];
  log('session end',{lifetime:row.left,status:res.status,riderStillOnlineForDispatch:still.online});
  await db.query("UPDATE riders SET online=false WHERE id=$1",[r.id]);
 });

 await scene('company both ways',async()=>{
  const co=await account('company',{name:'Audit Logistics',services:['delivery','riders']});log('company account',{reg:co.reg,verified:co.verified});
  await db.query("UPDATE companies SET status='approved' WHERE owner_id=$1",[co.id]);
  const r=await account('rider',{vehicle:'motorcycle',maxWeightG:20000});await db.query("UPDATE riders SET status='approved' WHERE id=$1",[r.id]);
  const inv=await api(co.token,'POST','/api/v1/company/invitations',{phone:r.number});log('invite',{status:inv.status,err:inv.data?.error});
  const seen=await api(r.token,'GET','/api/v1/rider/invitations');
  const acc=await api(r.token,'POST','/api/v1/rider/invitations/accept',{invitationId:seen.data?.[0]?.id});log('rider joins',{seen:seen.data?.length,accept:acc.status,err:acc.data?.error,notifiedRider:(await db.query('SELECT count(*)::int n FROM notification_jobs WHERE recipient_id=$1',[r.id])).rows[0].n});
  log('company rider online',await goOnline(r));
  const b=await bookAndPay(co);log('company booking',{quote:b.q.status,quoteErr:b.q.data?.error,book:b.s?.status,bookErr:b.s?.data?.error,pay:b.pay?.status,payErr:b.pay?.data?.error,confirm:b.confirm});
  if(!b.id)return;
  await dispatch.tick();
  const state=await deliver(r,b.id);
  const profile=await api(co.token,'GET','/api/v1/company/profile');
  const list=await api(co.token,'GET','/api/v1/company/deliveries');
  const fleetJobs=await api(co.token,'GET','/api/v1/shipments');
  const finance=await api(r.token,'GET','/api/v1/rider/finance');
  log('company after job',{state,balance:profile.data?.balance,deliveries:list.data?.length,fleetJobs:fleetJobs.data?.length,riderFinanceStatus:finance.status});
  const pay=await api(co.token,'POST','/api/v1/me/payout-beneficiary',{momoNetwork:'MTN',accountName:'Audit Logistics'});
  log('company payout account',{status:pay.status,err:pay.data?.error});
  log('automatic payout',await money.settleBusinessesDue().catch(e=>({error:e.message})));
  const keyR=await api(co.token,'POST','/api/v1/business/api-keys',{name:'Warehouse',scopes:['quotes:write','shipments:write','shipments:read','payments:write']});
  const q=await api(keyR.data?.key,'POST','/api/v1/quotes',booking());
  const s=await api(keyR.data?.key,'POST','/api/v1/shipments',{quoteId:q.data?.id},{'Idempotency-Key':'audit-key-'+randomInt(1e9)});
  const p=await api(keyR.data?.key,'POST','/api/v1/shipments/'+s.data?.id+'/checkout',{idempotencyKey:'audit-key-pay-'+randomInt(1e9)});
  const list2=await api(keyR.data?.key,'GET','/api/v1/shipments');
  log('API key flow',{key:keyR.status,quote:[q.status,q.data?.error],book:[s.status,s.data?.error],pay:[p.status,p.data?.error],url:!!p.data?.checkoutUrl,listed:list2.data?.length});
  const removed=await api(co.token,'POST','/api/v1/company/riders/'+r.id+'/remove',{});
  log('rider removed',{status:removed.status,err:removed.data?.error,rider:(await db.query('SELECT status,company_id,online FROM riders WHERE id=$1',[r.id])).rows[0]});
 });

 await scene('rider sees earnings it cannot withdraw',async()=>{
  const row=(await db.query("SELECT count(*)::int n FROM riders WHERE company_id IS NOT NULL")).rows[0];log('company riders left',row);
 });
 await new Promise(r=>server.close(r));server.closeAllConnections?.();
 await db.close();
 process.env.NODE_ENV='test';
});
