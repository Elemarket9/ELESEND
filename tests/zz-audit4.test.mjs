import test from 'node:test';
import {randomInt,randomUUID,createHmac} from 'node:crypto';
const url=process.env.TEST_DATABASE_URL;
const log=(n,d)=>console.log('AUDIT '+n+' :: '+JSON.stringify(d).slice(0,950));
test('audit four',{skip:!url},async()=>{
 process.env.NODE_ENV='production';process.env.OTP_KEY??='d'.repeat(64);
 const I=m=>import(m);
 const {database}=await I('../services/api/db.mjs'),{migrate}=await I('../scripts/migrate.mjs'),{platform}=await I('../services/api/platform.mjs'),{httpServer}=await I('../services/api/http.mjs'),{dispatchEngine}=await I('../services/api/dispatch.mjs');
 const {checkoutService,financeService,moneyOperations,paymentWebhook}=await I('../services/api/modules/payments/index.mjs'),{restaurantOrderService}=await I('../services/api/restaurant-orders.mjs'),{paystackCheckout}=await I('../services/api/modules/payments/paystack-checkout-adapter.mjs'),{promotionEngine}=await I('../services/api/promotion-engine.mjs'),{backgroundJobs}=await I('../services/api/background-jobs.mjs'),{notificationWorker}=await I('../services/api/notifications.mjs');
 const db=database(url);await migrate(db);
 const texts=[];const sms={async send(m){texts.push(m);return {accepted:true};},async sendNotification(m){texts.push(m);return {accepted:true};}};
 const meters=(a,b)=>Math.max(1,Math.round(Math.hypot((a.latitude-b.latitude)*111000,(a.longitude-b.longitude)*111000)));
 const routing={async route(a,b){const m=meters(a,b);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};},async matrix(o,d){return o.map(x=>{const m=meters(x,d);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};});}};
 const dispatch=dispatchEngine(db,{routing});
 const secret='sk_live_audit4';const PS={tx:{},refunds:{},transfers:{},calls:[]};
 const ok=d=>({ok:true,status:200,json:async()=>({status:true,data:d})});
 const fetchImpl=async(u,o={})=>{const url2=new URL(u),p=url2.pathname,b=o.body?JSON.parse(o.body):null;PS.calls.push(o.method==='POST'?'POST '+p:'GET '+p.split('/').slice(0,2).join('/'));
  if(p==='/transaction/initialize'){PS.tx[b.reference]={id:randomInt(1e9),amount:Number(b.amount)};return ok({authorization_url:'https://checkout.paystack.com/x',reference:b.reference});}
  if(p.startsWith('/transaction/verify/')){const r=decodeURIComponent(p.split('/').pop()),t=PS.tx[r];return ok({id:t.id,reference:r,status:'success',domain:'live',amount:t.amount,currency:'GHS',channel:'mobile_money',paid_at:new Date().toISOString()});}
  if(p==='/refund'&&o.method==='POST'){const id=randomInt(1e9),t=PS.tx[b.transaction];PS.refunds[id]={id,amount:Number(b.amount),currency:'GHS',status:PS.refundStatus||'pending',domain:'live',transaction:t.id,merchant_note:b.merchant_note};return ok(PS.refunds[id]);}
  if(p.startsWith('/refund/'))return ok(PS.refunds[p.split('/').pop()]);
  if(p==='/bank')return ok([{name:'MTN',code:'MTN',type:'mobile_money',active:true,slug:'mtn'}]);
  if(p==='/transferrecipient'){const code='RCP_'+randomInt(1e9);PS.rec=PS.rec||{};PS.rec[code]={recipient_code:code,active:true,domain:'live',metadata:b.metadata,details:{account_number:b.account_number}};return ok(PS.rec[code]);}
  if(p.startsWith('/transferrecipient/'))return ok(PS.rec[p.split('/').pop()]);
  if(p==='/transfer'){PS.transfers[b.reference]={id:randomInt(1e9),reference:b.reference,amount:b.amount,currency:'GHS',status:PS.transferStatus||'pending',recipient:b.recipient,domain:'live'};return ok(PS.transfers[b.reference]);}
  if(p.startsWith('/transfer/verify/')){const r=decodeURIComponent(p.split('/').pop());return ok(PS.transfers[r]);}
  return {ok:false,status:404,json:async()=>({status:false,message:'not found'})};};
 const provider=paystackCheckout({secretKey:secret,production:true,fetchImpl});
 const app=platform(db,{otpKey:process.env.OTP_KEY,routing,dispatch,sms});
 const checkout=checkoutService(db,{provider,sms,dispatch,routing}),finance=financeService(db,{provider}),money=moneyOperations(db,{provider}),rest=restaurantOrderService(db,{platform:app,dispatcher:dispatch,routing,sms});
 const server=httpServer(db,app,dispatch,finance,checkout,{restaurantOrders:rest,moneyOperations:money,paymentsWebhook:paymentWebhook({db,provider,checkout,finance,money,moneyOperations:money})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const api=async(t,m,p,b,h={})=>{const res=await fetch(base+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{}),...h},body:b===undefined?undefined:JSON.stringify(b)});return {status:res.status,data:await res.json().catch(()=>null)};};
 const brief=x=>[x.status,x.data?.error??null];
 const phone=()=>'+2332'+String(randomInt(0,1e8)).padStart(8,'0');const PW='mango river lantern';
 const code=()=>[...texts].reverse().find(m=>m.code)?.code;
 const P={address:'Accra Mall, Tetteh Quarshie',latitude:5.6221,longitude:-0.1735},D={address:'Osu Oxford Street, Accra',latitude:5.5571,longitude:-0.1817},N={address:'Airport Residential, Accra',latitude:5.6050,longitude:-0.1800};
 const trip=o=>({pickup:P,destination:D,vehicle:'motorcycle',recipientPhone:phone(),weightG:1000,description:'Documents',paymentMethod:'MOMO',...o});
 const signUp=async(k,e={})=>{const number=phone();await api(null,'POST','/api/v1/auth/register',{phone:number,password:PW,kind:k,...e});const l=await api(null,'POST','/api/v1/auth/login',{phone:number,password:PW});return {number,token:l.data.token,id:l.data.user.id};};
 const verify=async a=>{const ch=await api(a.token,'POST','/api/v1/me/phone-challenge',{});await api(a.token,'POST','/api/v1/me/phone-verify',{challengeId:ch.data.challengeId,code:code()});};
 const person=async k=>{const a=await signUp(k);await verify(a);return a;};
 const gps=(r,at=P)=>api(r.token,'POST','/api/v1/rider/location',{latitude:at.latitude,longitude:at.longitude,accuracyMeters:15,observedAt:new Date().toISOString()});
 const clean=async()=>{await db.query("UPDATE shipments SET state='CANCELLED' WHERE state='AWAITING_ASSIGNMENT'");await db.query("UPDATE dispatch_offers SET status='expired' WHERE status='offered'");await db.query('UPDATE riders SET online=false');};
 const rider=async()=>{await clean();const r=await signUp('rider',{vehicle:'motorcycle',maxWeightG:20000});await verify(r);await db.query("UPDATE riders SET status='approved' WHERE id=$1",[r.id]);await api(r.token,'POST','/api/v1/rider/availability',{online:true});await gps(r);return r;};
 const webhook=body=>{const raw=JSON.stringify(body);return fetch(base+'/api/v1/payments/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-paystack-signature':createHmac('sha512',secret).update(raw).digest('hex')},body:raw}).then(async r=>[r.status,await r.json().catch(()=>({}))]);};
 const paid=async(c,o)=>{const q=await api(c.token,'POST','/api/v1/quotes',trip(o));const key='a4-'+randomInt(1e9);const s=await api(c.token,'POST','/api/v1/shipments',{quoteId:q.data.id},{'Idempotency-Key':key});const p=await api(c.token,'POST','/api/v1/shipments/'+s.data.id+'/checkout',{idempotencyKey:key,email:'a@example.com'});await webhook({event:'charge.success',data:{reference:p.data.reference}});return s.data.id;};
 const assign=async(r,id)=>{await dispatch.tick();const o=(await api(r.token,'GET','/api/v1/rider/offers')).data?.find?.(x=>x.id===id);return brief(await api(r.token,'POST','/api/v1/shipments/'+id+'/accept',{offerId:o?.offerId}));};
 const handover=async(r,id,kind)=>{const c=await api(r.token,'POST','/api/v1/shipments/'+id+'/'+kind+'-challenge',{});return [brief(c),brief(await api(r.token,'POST','/api/v1/shipments/'+id+'/verify',{challengeId:c.data?.challengeId,code:code()}))];};
 const finish=async(r,id)=>{await handover(r,id,'pickup');await api(r.token,'POST','/api/v1/shipments/'+id+'/transition',{action:'start'});await gps(r,D);return handover(r,id,'delivery');};
 const state=async id=>(await db.query('SELECT state,paid FROM shipments WHERE id=$1',[id])).rows[0];
 const scene=async(n,f)=>{log('START '+n,{});try{await Promise.race([f(),new Promise((_,rej)=>setTimeout(()=>rej(new Error('STUCK after 120s')),120000).unref())]);}catch(e){log(n+' CRASHED',{m:e.message,at:e.stack?.split('\n').slice(1,3)});}};
 const admin=randomUUID();await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'x','admin',now())",[admin,phone()]);for(const p of ['verification:write','promotions:manage','finance:configure','dispatch:configure'])await db.query('INSERT INTO permissions(user_id,permission) VALUES($1,$2) ON CONFLICT DO NOTHING',[admin,p]);const A={id:admin,kind:'admin'};

 await scene('refund through Paystack code',async()=>{
  const c=await person('customer');const id=await paid(c);
  const cancel=await api(c.token,'POST','/api/v1/shipments/'+id+'/transition',{action:'cancel',reason:'Changed my mind'});
  await money.syncRefunds();const out=await money.refundUncollectedOrders({limit:50});
  const op=()=>db.query('SELECT status,amount_minor::int a,failure_reason FROM refund_operations WHERE shipment_id=$1',[id]).then(x=>x.rows[0]);
  const first=await op();
  for(const r of Object.values(PS.refunds))r.status='processed';
  await new Promise(r=>setTimeout(r,3000));await money.reconcileDue({olderThanSeconds:0});const second=await op();
  log('refund',{cancel:brief(cancel),submitted:out.filter(x=>x.status!=='error').length,errors:out.filter(x=>x.status==='error').slice(0,2),first,second,customerTold:(await db.query("SELECT count(*)::int n FROM notification_jobs WHERE recipient_id=$1",[c.id])).rows[0].n});
 });
 await scene('withdrawal through Paystack code',async()=>{
  const c=await person('customer');const r=await rider();const jobs=[];
  for(let i=0;i<8;i++){const id=await paid(c);const a=await assign(r,id);if(a[0]!==200){log('job',a);break;}await finish(r,id);await gps(r,P);jobs.push(id);}
  const ben=await api(r.token,'POST','/api/v1/me/payout-beneficiary',{momoNetwork:'MTN',accountName:'Kofi'});
  await db.query('UPDATE payout_beneficiaries SET destination_changed_at=NULL WHERE user_id=$1',[r.id]);
  await db.query("UPDATE shipments SET completed_at=now()-interval '2 days' WHERE id=ANY($1)",[jobs]);
  const w=await api(r.token,'POST','/api/v1/rider/wallet/withdraw',{idempotencyKey:'wd-'+randomInt(1e9),password:PW});
  const ref=Object.keys(PS.transfers).at(-1);const before=(await db.query('SELECT status FROM payout_withdrawals WHERE beneficiary_id=$1',[r.id])).rows[0];
  if(ref){PS.transfers[ref].status='success';await webhook({event:'transfer.success',data:{reference:ref}});}
  const paidRow=(await db.query('SELECT status FROM payout_withdrawals WHERE beneficiary_id=$1',[r.id])).rows[0];
  if(ref){PS.transfers[ref].status='reversed';await webhook({event:'transfer.reversed',data:{reference:ref}});}
  const after=(await db.query('SELECT status FROM payout_withdrawals WHERE beneficiary_id=$1',[r.id])).rows[0];
  const sum=(await api(r.token,'GET','/api/v1/rider/wallet/summary')).data;
  const dup=await webhook({event:'transfer.success',data:{reference:ref}}).catch(e=>e.message);log('withdrawal',{dup,calls:[...new Set(PS.calls)].slice(0,12),jobs:jobs.length,ben:brief(ben),w:[w.status,w.data?.error,w.data?.amountMinor],before,paidRow,after,availableAfterReversal:sum?.availableNowMinor});
 });
 if(false)await scene('company suspended through admin, rider carrying parcel',async()=>{
  const co=await signUp('company',{name:'Audit4 Co',services:['riders']});await db.query("UPDATE companies SET status='approved' WHERE owner_id=$1",[co.id]);await verify(co);
  const r=await rider();await api(co.token,'POST','/api/v1/company/invitations',{phone:r.number});const inv=await api(r.token,'GET','/api/v1/rider/invitations');await api(r.token,'POST','/api/v1/rider/invitations/accept',{invitationId:inv.data[0].id});await api(r.token,'POST','/api/v1/rider/availability',{online:true});await gps(r);
  const c=await person('customer');const id=await paid(c);const a=await assign(r,id);await handover(r,id,'pickup');
  const coId=(await db.query('SELECT id FROM companies WHERE owner_id=$1',[co.id])).rows[0].id;
  await app.approve(A,'companies',coId,'suspended');
  const old=await api(r.token,'GET','/api/v1/me');const again=await api(null,'POST','/api/v1/auth/login',{phone:r.number,password:PW});
  const me=await api(again.data?.token,'GET','/api/v1/me');await api(again.data?.token,'POST','/api/v1/shipments/'+id+'/transition',{action:'start'});
  r.token=again.data?.token;const d=await handover(r,id,'delivery');
  const bal=(await db.query("SELECT coalesce(sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END),0)::int v FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.shipment_id=$1 AND l.account='rider_payable'",[id])).rows[0].v;
  log('company suspended',{a,old:old.status,login:again.status,custody:me.data?.custodyOnly,d,state:await state(id),companyEarned:bal,companyDel:brief(await api(co.token,'GET','/api/v1/company/profile'))});
 });
 if(false)await scene('promo budget under load',async()=>{
  const owner=await person('business');const made=await api(owner.token,'POST','/api/v1/restaurants',{name:'Budget Kitchen '+randomInt(1e6),phone:'0241234567',address:'Oxford Street, Osu',latitude:P.latitude,longitude:P.longitude});
  await db.query("UPDATE restaurants SET status='approved',is_open=true,is_paused=false WHERE id=$1",[made.data.id]);
  const item=await api(owner.token,'POST','/api/v1/restaurants/'+made.data.id+'/items',{name:'Jollof',priceMinor:4000});
  const cd='BUDGET'+randomInt(1e6);const camp=await promotionEngine(db).createAdminCampaign(A,{name:'Budget promo',ownerType:'elesend',discountType:'percentage',discountBps:5000,code:cd,startsAt:new Date(Date.now()-6e4).toISOString(),endsAt:new Date(Date.now()+864e5).toISOString(),totalBudgetMinor:4000,perCustomerLimit:1,eligibleRestaurantIds:[made.data.id]}).catch(e=>({error:e.message}));
  const people=[];for(let i=0;i<8;i++)people.push(await person('customer'));
  const order={restaurantId:made.data.id,items:[{itemId:item.data.id,quantity:1}],deliveryAddress:D.address,deliveryLatitude:D.latitude,deliveryLongitude:D.longitude,customerPhone:'0241234567',promoCode:cd};
  const out=await Promise.all(people.map(c=>api(c.token,'POST','/api/v1/food-orders',{...order,paymentMethod:'MOMO'},{'Idempotency-Key':'b-'+randomInt(1e9)})));
  const spent=(await db.query("SELECT coalesce(sum(discount_minor),0)::int v,count(*)::int n FROM promotion_redemptions WHERE campaign_id=$1 AND status IN ('reserved','applied')",[camp.id]).catch(e=>({rows:[e.message]}))).rows[0];
  log('budget',{camp:camp.error||camp.status,statuses:out.map(x=>x.status),errors:[...new Set(out.map(x=>x.data?.error).filter(Boolean))].slice(0,3),spent});
 });
 if(false)await scene('kitchen ignores a paid order',async()=>{
  const owner=await person('business');const made=await api(owner.token,'POST','/api/v1/restaurants',{name:'Quiet '+randomInt(1e6),phone:'0241234567',address:'Oxford Street, Osu',latitude:P.latitude,longitude:P.longitude});await db.query("UPDATE restaurants SET status='approved',is_open=true,is_paused=false WHERE id=$1",[made.data.id]);
  const item=await api(owner.token,'POST','/api/v1/restaurants/'+made.data.id+'/items',{name:'Rice',priceMinor:3000});const c=await person('customer');
  const o=await api(c.token,'POST','/api/v1/food-orders',{restaurantId:made.data.id,items:[{itemId:item.data.id,quantity:1}],deliveryAddress:D.address,deliveryLatitude:D.latitude,deliveryLongitude:D.longitude,customerPhone:'0241234567',paymentMethod:'MOMO'},{'Idempotency-Key':'k-'+randomInt(1e9)});
  const sid=o.data.shipment_id;const p=await api(c.token,'POST','/api/v1/shipments/'+sid+'/checkout',{idempotencyKey:'kp-'+randomInt(1e9),email:'a@example.com'});await webhook({event:'charge.success',data:{reference:p.data.reference}});
  await db.query("UPDATE shipment_checkout_intents SET confirmed_at=now()-interval '2 hours' WHERE shipment_id=$1",[sid]);await db.query("UPDATE food_orders SET created_at=now()-interval '2 hours' WHERE id=$1",[o.data.id]);
  const r=await rest.expireUnfulfilledOrders({limit:50}).catch(e=>e.message);
  log('kitchen silent',{food:(await db.query('SELECT state FROM food_orders WHERE id=$1',[o.data.id])).rows[0],ship:await state(sid),refund:(await db.query('SELECT status,amount_minor::int a FROM checkout_refund_requests WHERE shipment_id=$1',[sid])).rows[0],alerts:(await db.query('SELECT kind FROM notification_jobs WHERE recipient_id=$1',[c.id])).rows.map(x=>x.kind)});
 });
 if(false)await scene('two parcels on one rider',async()=>{
  const c=await person('customer');const r=await rider();const opt=await api(r.token,'POST','/api/v1/rider/multi-stop',{enabled:true}).catch(e=>e);
  const a=await paid(c);const first=await assign(r,a);await gps(r,P);const b=await paid(c,{destination:N});const second=await assign(r,b);
  const m=await api(r.token,'GET','/api/v1/rider/manifest');
  log('multi stop',{opt:brief(opt),first,second,stops:m.data?.stops?.map(s=>s.kind),jobs:m.data?.shipments?.length});
 });
 await scene('chat',async()=>{
  const c=await person('customer');const r=await rider();const id=await paid(c);await assign(r,id);
  const conv=await api(c.token,'POST','/api/v1/chat/conversations',{conversationType:'CUSTOMER_RIDER',shipmentId:id});
  const cid=conv.data?.id??conv.data?.conversationId;
  const s1=await api(c.token,'POST','/api/v1/chat/conversations/'+cid+'/messages',{bodyText:'Hello, I am at the gate. Call 0241234567',clientMessageId:randomUUID()});
  const list=await api(r.token,'GET','/api/v1/chat/conversations/'+cid+'/messages');
  const stranger=await api((await person('customer')).token,'GET','/api/v1/chat/conversations/'+cid+'/messages');
  await finish(r,id);const after=await api(c.token,'POST','/api/v1/chat/conversations/'+cid+'/messages',{bodyText:'one more',clientMessageId:randomUUID()});
  log('chat',{conv:brief(conv),s1:brief(s1),riderReads:[list.status,JSON.stringify(list.data).slice(0,160)],stranger:stranger.status,afterDelivery:brief(after)});
 });
 if(false)await scene('every background job once',async()=>{
  const out={};const w=process.stderr.write.bind(process.stderr);const warns=[];process.stderr.write=(s,...a)=>{if(/warn|error/i.test(String(s)))warns.push(String(s).slice(0,200));return w(s,...a);};
  const notifications=notificationWorker(db,{transport:null,sms});
  const b=backgroundJobs({db,dispatch,notifications,restOrders:rest,money,checkout,finance,paymentProvider:provider,routing});
  for(const [n,f] of Object.entries(b.jobs)){const s=Date.now();out[n]=[await Promise.race([f(),new Promise(r=>setTimeout(()=>r('STUCK'),60000))]),Date.now()-s];}
  process.stderr.write=w;log('jobs',{out});log('job warnings',[...new Set(warns)].slice(0,8));
 });
 log('ALL DONE',{});setTimeout(()=>process.exit(0),300);await new Promise(()=>{});
});
