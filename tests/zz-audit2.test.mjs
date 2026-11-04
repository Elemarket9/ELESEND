import test from 'node:test';
import {randomInt,randomUUID} from 'node:crypto';
const url=process.env.TEST_DATABASE_URL;
const log=(n,d)=>console.log('AUDIT '+n+' :: '+JSON.stringify(d).slice(0,800));
test('audit two',{skip:!url},async()=>{
 const prev=process.env.NODE_ENV;process.env.NODE_ENV='production';process.env.OTP_KEY??='d'.repeat(64);
 const I=m=>import(m);
 const {database}=await I('../services/api/db.mjs'),{migrate}=await I('../scripts/migrate.mjs'),{platform}=await I('../services/api/platform.mjs'),{httpServer}=await I('../services/api/http.mjs'),{dispatchEngine}=await I('../services/api/dispatch.mjs');
 const {checkoutService,financeService,moneyOperations}=await I('../services/api/modules/payments/index.mjs'),{restaurantOrderService}=await I('../services/api/restaurant-orders.mjs');
 const db=database(url);await migrate(db);
 const texts=[];const sms={async send(m){texts.push(m);return {accepted:true};},async sendNotification(m){texts.push(m);return {accepted:true};}};
 const meters=(a,b)=>Math.max(1,Math.round(Math.hypot((a.latitude-b.latitude)*111000,(a.longitude-b.longitude)*111000)));
 const routing={async route(a,b){const m=meters(a,b);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};},async matrix(o,d){return o.map(x=>{const m=meters(x,d);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};});}};
 const dispatch=dispatchEngine(db,{routing});
 const payouts=[],refunds=[];
 const provider={name:'audit2',methods:['MOMO','CARD'],allowedCheckoutHosts:['checkout.test'],async createCheckout(x){return {reference:x.reference,checkoutUrl:'https://checkout.test/'+x.reference};},async verifyPayment(r){return {verified:true,status:'pending',reference:r};},commissionIntentId:()=>null,async parseVerifiedWebhook(){return null;},async createPayout(x){payouts.push(x);return {providerId:'po_'+x.requestId,reference:x.requestId};},async verifyPayout(){return {verified:true,status:'pending'};},async verifyBeneficiary({beneficiaryId,recipientReference}){return {verified:true,beneficiaryId,recipientReference};},async createBeneficiary(){return {recipientReference:'RCP_'+randomInt(1e9)};},async createRefund(x){refunds.push(x);return {providerId:'rf'};}};
 const app=platform(db,{otpKey:process.env.OTP_KEY,routing,dispatch,sms});
 const checkout=checkoutService(db,{provider,sms,dispatch,routing}),money=moneyOperations(db,{provider}),rest=restaurantOrderService(db,{platform:app,dispatcher:dispatch,routing,sms});
 const server=httpServer(db,app,dispatch,financeService(db,{provider}),checkout,{restaurantOrders:rest,moneyOperations:money});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const api=async(t,m,p,b,h={})=>{const res=await fetch(base+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{}),...h},body:b===undefined?undefined:JSON.stringify(b)});return {status:res.status,data:await res.json().catch(()=>null)};};
 const brief=x=>[x.status,x.data?.error??null];
 const phone=()=>'+23324'+String(randomInt(0,1e7)).padStart(7,'0');const PW='mango river lantern';
 const code=()=>[...texts].reverse().find(m=>m.code)?.code;
 const P={address:'Accra Mall, Tetteh Quarshie',latitude:5.6221,longitude:-0.1735},D={address:'Osu Oxford Street, Accra',latitude:5.5571,longitude:-0.1817};
 const trip=o=>({pickup:P,destination:D,vehicle:'motorcycle',recipientPhone:phone(),weightG:1000,description:'Documents',paymentMethod:'MOMO',...o});
 const signUp=async(kind,extra={})=>{const number=phone();await api(null,'POST','/api/v1/auth/register',{phone:number,password:PW,kind,...extra});const l=await api(null,'POST','/api/v1/auth/login',{phone:number,password:PW});return {number,token:l.data.token,id:l.data.user.id};};
 const verify=async a=>{const ch=await api(a.token,'POST','/api/v1/me/phone-challenge',{});await api(a.token,'POST','/api/v1/me/phone-verify',{challengeId:ch.data.challengeId,code:code()});};
 const person=async k=>{const a=await signUp(k);await verify(a);return a;};
 const gps=(r,at=P)=>api(r.token,'POST','/api/v1/rider/location',{latitude:at.latitude,longitude:at.longitude,accuracyMeters:15,observedAt:new Date().toISOString()});
 const rider=async()=>{await db.query('UPDATE riders SET online=false');const r=await signUp('rider',{vehicle:'motorcycle',maxWeightG:20000});await verify(r);await db.query("UPDATE riders SET status='approved' WHERE id=$1",[r.id]);await api(r.token,'POST','/api/v1/rider/availability',{online:true});await gps(r);return r;};
 const payOrder=async(c,o)=>{const q=await api(c.token,'POST','/api/v1/quotes',trip(o));const key='a2-'+randomInt(1e9);const s=await api(c.token,'POST','/api/v1/shipments',{quoteId:q.data.id},{'Idempotency-Key':key});const p=await api(c.token,'POST','/api/v1/shipments/'+s.data.id+'/checkout',{idempotencyKey:key,email:'a@example.com'});const a=(await db.query('SELECT amount_minor FROM shipment_checkout_intents WHERE reference=$1',[p.data.reference])).rows[0];const ev={status:'success',reference:p.data.reference,amountMinor:Number(a.amount_minor),currency:'GHS',eventId:'ev'+randomInt(1e9),channel:'mobile_money'};await checkout.confirmVerified(ev);return {id:s.data.id,ev,amount:Number(a.amount_minor)};};
 const assign=async(r,id)=>{await dispatch.tick();const o=(await api(r.token,'GET','/api/v1/rider/offers')).data?.find?.(x=>x.id===id);const acc=await api(r.token,'POST','/api/v1/shipments/'+id+'/accept',{offerId:o?.offerId});return {offer:o?.offerId,acc:brief(acc)};};
 const pickup=async(r,id)=>{const c=await api(r.token,'POST','/api/v1/shipments/'+id+'/pickup-challenge',{});return [brief(c),brief(await api(r.token,'POST','/api/v1/shipments/'+id+'/verify',{challengeId:c.data?.challengeId,code:code()}))];};
 const drop=async(r,id)=>{await api(r.token,'POST','/api/v1/shipments/'+id+'/transition',{action:'start'});await gps(r,D);const c=await api(r.token,'POST','/api/v1/shipments/'+id+'/delivery-challenge',{});return [brief(c),brief(await api(r.token,'POST','/api/v1/shipments/'+id+'/verify',{challengeId:c.data?.challengeId,code:code()}))];};
 const ledger=async id=>(await db.query('SELECT j.kind,l.account,l.side,l.amount_minor::int a FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.shipment_id=$1 ORDER BY j.created_at',[id])).rows.map(l=>`${l.kind}:${l.account}:${l.side}:${l.a}`);
 const state=async id=>(await db.query('SELECT state,paid,rider_id IS NOT NULL AS has_rider FROM shipments WHERE id=$1',[id])).rows[0];
 const scene=async(n,f)=>{try{await f();}catch(e){log(n+' CRASHED',{m:e.message,at:e.stack?.split('\n')[1]});}};
 const admin=randomUUID();await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'x','admin',now())",[admin,phone()]);
 for(const p of ['verification:write','dispatch:configure','payments:refund','shipments:read'])await db.query('INSERT INTO permissions(user_id,permission) VALUES($1,$2) ON CONFLICT DO NOTHING',[admin,p]);
 const adminActor={id:admin,kind:'admin'};
 const JPEG=Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.alloc(3000,7)]).toString('base64');

 await scene('full approval',async()=>{
  const r=await signUp('rider',{vehicle:'motorcycle',maxWeightG:20000});await verify(r);
  const early=await app.approve(adminActor,'riders',r.id,'approved').catch(e=>e.message);
  const lic=await api(r.token,'POST','/api/v1/rider/licence',{legalName:'Ama Serwaa',licenceNumber:'GH-'+randomInt(1e8),licenceClass:'A',expiresOn:`${new Date().getUTCFullYear()+1}-01-31`,vehiclePlate:'GR 1234-26'});
  const link=await api(r.token,'POST','/api/v1/rider/documents/upload-link',{});
  const page=link.data?.url??link.data?.link;
  const tokenFromLink=link.data?.token??(page?new URL(page,base).searchParams.get('token')??new URL(page,base).hash.replace(/^#(token=)?/,''):null);
  const up={};for(const [kind,exp] of [['profile_photo'],['licence_photo'],['insurance',1],['roadworthiness',1]]){const u=await api(null,'POST','/api/v1/rider-documents/upload',{token:tokenFromLink,kind,imageBase64:JPEG,...(exp?{expiresOn:`${new Date().getUTCFullYear()+1}-06-30`}:{})});up[kind]=brief(u);}
  const page2=await fetch(base+'/rider-documents');
  const done=await app.approve(adminActor,'riders',r.id,'approved').catch(e=>e.message);
  log('full approval',{early,lic:brief(lic),linkKeys:Object.keys(link.data||{}),host:page&&new URL(page,base).pathname,up,uploadPage:page2.status,done,status:(await db.query('SELECT status FROM riders WHERE id=$1',[r.id])).rows[0].status,awaiting:(await api(r.token,'GET','/api/v1/me')).data?.awaitingApproval??false});
 });

 await scene('money races',async()=>{
  const c=await person('customer');const r=await rider();
  const k=await payOrder(c);
  const replay=await checkout.confirmVerified(k.ev).then(x=>x?.status).catch(e=>e.message);
  const secondEvent=await checkout.confirmVerified({...k.ev,eventId:'other'+randomInt(1e9)}).then(x=>x?.status).catch(e=>e.message);
  const payLines=(await ledger(k.id)).filter(l=>l.startsWith('psp_verified')).length;
  await dispatch.tick();const o=(await api(r.token,'GET','/api/v1/rider/offers')).data.find(x=>x.id===k.id);
  const taps=await Promise.all([1,2,3].map(()=>api(r.token,'POST','/api/v1/shipments/'+k.id+'/accept',{offerId:o.offerId})));
  const p=await pickup(r,k.id);const d=await drop(r,k.id);
  const again=await api(r.token,'POST','/api/v1/shipments/'+k.id+'/verify',{code:code()});
  log('money races',{replay,secondEvent,payLines,taps:taps.map(t=>t.status),p,d,afterAgain:brief(again),ledger:await ledger(k.id),balance:await money.adminWalletOverview?.(adminActor).then(()=>'ok').catch(e=>e.message)});
 });

 await scene('withdrawal',async()=>{
  const c=await person('customer');const r=await rider();
  const jobs=[];for(let i=0;i<8;i++){const k=await payOrder(c);const a=await assign(r,k.id);if(!a.offer){log('withdrawal no offer',a);break;}await pickup(r,k.id);await drop(r,k.id);await gps(r,P);jobs.push(k.id);}
  const summary=await api(r.token,'GET','/api/v1/rider/wallet/summary');
  const noAcct=await api(r.token,'POST','/api/v1/rider/wallet/withdraw',{idempotencyKey:'wd-'+randomInt(1e9),password:PW});
  const ben=await api(r.token,'POST','/api/v1/me/payout-beneficiary',{momoNetwork:'MTN',accountName:'Kofi'});
  const held=await api(r.token,'POST','/api/v1/rider/wallet/withdraw',{idempotencyKey:'wd-'+randomInt(1e9),password:PW});
  await db.query('UPDATE payout_beneficiaries SET destination_changed_at=NULL WHERE user_id=$1',[r.id]);
  await db.query("UPDATE shipments SET completed_at=now()-interval '2 days' WHERE id=ANY($1)",[jobs]);
  const sum2=await api(r.token,'GET','/api/v1/rider/wallet/summary');
  const wrong=await api(r.token,'POST','/api/v1/rider/wallet/withdraw',{idempotencyKey:'wd-'+randomInt(1e9),password:'wrong password here'});
  const race=await Promise.all([1,2,3].map(()=>api(r.token,'POST','/api/v1/rider/wallet/withdraw',{idempotencyKey:'wd-'+randomInt(1e9),password:PW})));
  const rows=(await db.query('SELECT status,amount_minor::int a,fee_minor::int f FROM payout_withdrawals WHERE beneficiary_id=$1',[r.id])).rows;
  log('withdrawal',{jobs:jobs.length,available:summary.data?.availableNowMinor,onHold:summary.data?.onHoldMinor,noAcct:brief(noAcct),ben:brief(ben),held:brief(held),afterHold:sum2.data?.availableNowMinor,wrong:brief(wrong),race:race.map(brief),rows,providerCalls:payouts.length,amounts:payouts.map(p=>p.amountMinor)});
 });

 await scene('failed parcel',async()=>{
  const c=await person('customer');const r=await rider();const k=await payOrder(c);await assign(r,k.id);await pickup(r,k.id);
  await api(r.token,'POST','/api/v1/shipments/'+k.id+'/transition',{action:'start'});
  const fail=await api(r.token,'POST','/api/v1/shipments/'+k.id+'/transition',{action:'fail',reason:'Recipient not answering'});
  const custRefund=await api(c.token,'POST','/api/v1/shipments/'+k.id+'/transition',{action:'cancel',reason:'I want my money'});
  const ret=await api(r.token,'POST','/api/v1/shipments/'+k.id+'/transition',{action:'return',reason:'Taking it back'});
  const ch=await api(r.token,'POST','/api/v1/shipments/'+k.id+'/return-challenge',{});
  const v=await api(r.token,'POST','/api/v1/shipments/'+k.id+'/verify',{challengeId:ch.data?.challengeId,code:code()});
  const newJob=await api(r.token,'GET','/api/v1/rider/manifest');
  log('failed parcel',{fail:brief(fail),custRefund:brief(custRefund),ret:brief(ret),ch:brief(ch),v:brief(v),state:await state(k.id),ledger:await ledger(k.id),refunds:(await db.query('SELECT status,amount_minor::int a FROM checkout_refund_requests WHERE shipment_id=$1',[k.id])).rows,manifest:newJob.status});
 });

 await scene('cancel after pickup and after delivery',async()=>{
  const c=await person('customer');const r=await rider();const k=await payOrder(c);await assign(r,k.id);
  const before=await api(c.token,'POST','/api/v1/shipments/'+k.id+'/transition',{action:'cancel',reason:'Changed my mind'});
  const st1=await state(k.id);
  const k2=await payOrder(c);await assign(r,k2.id);await pickup(r,k2.id);
  const mid=await api(c.token,'POST','/api/v1/shipments/'+k2.id+'/transition',{action:'cancel',reason:'Changed my mind'});
  await drop(r,k2.id);
  const after=await api(c.token,'POST','/api/v1/shipments/'+k2.id+'/transition',{action:'cancel',reason:'Changed my mind'});
  const dis=await api(c.token,'POST','/api/v1/shipments/'+k2.id+'/disputes',{reason:'Parcel damaged',category:'damaged',description:'Parcel arrived damaged'});
  log('cancel',{before:brief(before),st1,riderBusyAfterCancel:(await api(r.token,'GET','/api/v1/rider/manifest')).data?.stops?.length,mid:brief(mid),after:brief(after),dis:brief(dis),final:await state(k2.id),refunds:(await db.query('SELECT count(*)::int n FROM checkout_refund_requests WHERE shipment_id=$1',[k2.id])).rows[0].n});
 });

 await scene('other people data',async()=>{
  const owner=await person('customer'),stranger=await person('customer');const r=await rider(),r2=await signUp('rider',{vehicle:'motorcycle',maxWeightG:20000});await verify(r2);await db.query("UPDATE riders SET status='approved' WHERE id=$1",[r2.id]);
  const k=await payOrder(owner);await assign(r,k.id);
  const probes={};for(const [who,t,m,p,b] of [['stranger read',stranger.token,'GET','/api/v1/shipments/'+k.id],['stranger track',stranger.token,'GET','/api/v1/shipments/'+k.id+'/tracking'],['stranger pay',stranger.token,'GET','/api/v1/shipments/'+k.id+'/checkout'],['stranger cancel',stranger.token,'POST','/api/v1/shipments/'+k.id+'/transition',{action:'cancel',reason:'mine now'}],['other rider verify',r2.token,'POST','/api/v1/shipments/'+k.id+'/verify',{code:'123456'}],['other rider challenge',r2.token,'POST','/api/v1/shipments/'+k.id+'/pickup-challenge',{}],['customer admin',owner.token,'GET','/api/v1/admin/review'],['rider admin',r.token,'GET','/api/v1/admin/dispatch/exceptions'],['customer company',owner.token,'GET','/api/v1/company/profile'],['no token',null,'GET','/api/v1/shipments/'+k.id]]){probes[who]=(await api(t,m,p,b)).status;}
  const riderView=await api(r.token,'GET','/api/v1/shipments/'+k.id);
  log('other people',{probes,riderSees:Object.keys(riderView.data||{}).filter(x=>/phone|hash|digest|token|secret|otp/i.test(x)),customerSees:Object.keys((await api(owner.token,'GET','/api/v1/shipments/'+k.id)).data||{}).filter(x=>/hash|digest|token|secret|otp|commission/i.test(x))});
 });

 await scene('cash',async()=>{
  const c=await person('customer');const r=await rider();
  const q=await api(c.token,'POST','/api/v1/quotes',trip({paymentMethod:'CASH',cashPayer:'sender'}));
  const s=await api(c.token,'POST','/api/v1/shipments',{quoteId:q.data.id},{'Idempotency-Key':'cash-'+randomInt(1e9)});const id=s.data.id;
  const a=await assign(r,id);
  const rep=await api(r.token,'POST','/api/v1/rider/cash-report',{shipmentId:id,reportedMinor:s.data.amount_minor,cashPayer:'sender',idempotencyKey:'cash-rep-'+randomInt(1e9)});
  const p=await pickup(r,id),d=await drop(r,id);
  const w=await api(r.token,'GET','/api/v1/rider/wallet/debt');
  log('cash',{a,rep:brief(rep),p,d,state:await state(id),amount:s.data.amount_minor,debt:w.data,ledger:await ledger(id)});
  // Debt limit: keep taking cash until refused.
  await db.query("UPDATE commission_accounts SET debt_limit_minor=1 WHERE rider_id=$1",[r.id]).catch(e=>log('no debt column',e.message));
  await gps(r,P);
  const q2=await api(c.token,'POST','/api/v1/quotes',trip({paymentMethod:'CASH',cashPayer:'sender'}));
  const s2=await api(c.token,'POST','/api/v1/shipments',{quoteId:q2.data.id},{'Idempotency-Key':'cash-'+randomInt(1e9)});
  log('cash over limit',await assign(r,s2.data.id));
  await db.query("UPDATE shipments SET state='CANCELLED' WHERE id=$1 AND state='AWAITING_ASSIGNMENT'",[s2.data.id]).catch(()=>{});
 });

 await scene('food',async()=>{
  const owner=await person('business');const c=await person('customer');const r=await rider();
  const made=await api(owner.token,'POST','/api/v1/restaurants',{name:'Audit Kitchen '+randomInt(1e6),phone:phone().replace('+233','0'),address:'Oxford Street, Osu',latitude:P.latitude,longitude:P.longitude});
  log('restaurant',{made:brief(made),keys:made.data&&['status','is_open','is_paused'].map(k=>made.data[k])});
  const rid=made.data.id;
  await db.query('UPDATE restaurants SET is_open=true,is_paused=false WHERE id=$1',[rid]);
  const item=await api(owner.token,'POST','/api/v1/restaurants/'+rid+'/items',{name:'Jollof',priceMinor:4000});
  const fq={restaurantId:rid,items:[{itemId:item.data?.id,quantity:2}],deliveryAddress:D.address,deliveryLatitude:D.latitude,deliveryLongitude:D.longitude,customerPhone:'0241234567'};
  const quote=await api(c.token,'POST','/api/v1/food-orders/quote',fq);
  const order=await api(c.token,'POST','/api/v1/food-orders',{...fq,paymentMethod:'MOMO',idempotencyKey:'food-'+randomInt(1e9)});
  log('food order',{item:brief(item),quote:brief(quote),order:brief(order),keys:order.data&&Object.keys(order.data).slice(0,12)});
  const f=order.data;const sid=f.shipment_id??f.shipmentId;const fid=f.id;
  const pay=await api(c.token,'POST','/api/v1/shipments/'+sid+'/checkout',{idempotencyKey:'fp-'+randomInt(1e9),email:'a@example.com'});
  const a=(await db.query('SELECT amount_minor FROM shipment_checkout_intents WHERE reference=$1',[pay.data?.reference])).rows[0];
  await checkout.confirmVerified({status:'success',reference:pay.data.reference,amountMinor:Number(a.amount_minor),currency:'GHS',eventId:'ev'+randomInt(1e9),channel:'mobile_money'});
  const early=await dispatch.tick();
  const acc=await api(owner.token,'POST','/api/v1/food-orders/'+fid+'/accept',{});
  const prep=await api(owner.token,'POST','/api/v1/food-orders/'+fid+'/prepare',{});
  const ready=await api(owner.token,'POST','/api/v1/food-orders/'+fid+'/ready',{});
  const as=await assign(r,sid);
  const pk=await pickup(r,sid),dr=await drop(r,sid);
  const after=await api(c.token,'POST','/api/v1/food-orders/'+fid+'/resolve',{action:'refund',reason:'Food was cold'});
  log('food delivery',{pay:brief(pay),early:early.filter(x=>x.shipmentId===sid),acc:brief(acc),prep:brief(prep),ready:brief(ready),as,pk,dr,state:await state(sid),food:(await db.query('SELECT state,payment_status FROM food_orders WHERE id=$1',[fid])).rows[0],ledger:await ledger(sid),settle:(await db.query('SELECT status,net_payable_minor FROM restaurant_settlements WHERE order_id=$1',[fid]).catch(e=>({rows:[e.message]}))).rows,refundAfterDelivery:brief(after)});
  const o2=await api(c.token,'POST','/api/v1/food-orders',{...fq,paymentMethod:'MOMO',idempotencyKey:'food-'+randomInt(1e9)});
  const pay2=await api(c.token,'POST','/api/v1/shipments/'+(o2.data.shipment_id??o2.data.shipmentId)+'/checkout',{idempotencyKey:'fp-'+randomInt(1e9),email:'a@example.com'});
  const a2=(await db.query('SELECT amount_minor FROM shipment_checkout_intents WHERE reference=$1',[pay2.data.reference])).rows[0];
  await checkout.confirmVerified({status:'success',reference:pay2.data.reference,amountMinor:Number(a2.amount_minor),currency:'GHS',eventId:'ev'+randomInt(1e9),channel:'mobile_money'});
  const rej=await api(owner.token,'POST','/api/v1/food-orders/'+o2.data.id+'/reject',{reason:'Out of stock'});
  log('kitchen rejects',{rej:brief(rej),refunds:(await db.query('SELECT status,amount_minor::int a FROM checkout_refund_requests WHERE shipment_id=$1',[o2.data.shipment_id??o2.data.shipmentId])).rows,state:await state(o2.data.shipment_id??o2.data.shipmentId)});
 });

 await scene('refund submit',async()=>{
  const list=await money.refunds(adminActor).catch(e=>e.message);
  log('refund queue',{count:Array.isArray(list)?list.length:list,first:Array.isArray(list)?Object.keys(list[0]||{}).slice(0,8):null});
 });
 const rate=await (async()=>{const out=[];const a=await person('customer');for(let i=0;i<160;i++){out.push((await api(a.token,'GET','/api/v1/me')).status);}return {ok:out.filter(s=>s===200).length,limited:out.filter(s=>s===429).length};})();
 log('one user in one minute',rate);
 process.env.NODE_ENV=prev;server.closeAllConnections?.();await new Promise(r=>server.close(r));await db.close();
});
