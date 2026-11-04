import test from 'node:test';
import {randomInt,randomUUID,createHmac,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
const url=process.env.TEST_DATABASE_URL;
const log=(n,d)=>console.log('AUDIT '+n+' :: '+JSON.stringify(d).slice(0,900));
const hex=()=>randomBytes(32).toString('hex');
async function bootReal(file,extra){
 const out=[];const p=spawn(process.execPath,[file],{env:{PATH:process.env.PATH,NODE_ENV:'production',DATABASE_URL:url,DATABASE_SSL:'false',...extra}});
 p.stdout.on('data',d=>out.push(String(d)));p.stderr.on('data',d=>out.push(String(d)));
 let exited=null;p.on('exit',c=>{exited=c;});
 await new Promise(r=>setTimeout(r,5000));
 return {p,out,get exited(){return exited;}};
}
test('audit three',{skip:!url},async()=>{
 const prev=process.env.NODE_ENV;
 const I=m=>import(m);
 const {database}=await I('../services/api/db.mjs'),{migrate}=await I('../scripts/migrate.mjs');
 const db=database(url);await migrate(db);
 process.env.NODE_ENV='production';process.env.OTP_KEY??='d'.repeat(64);
 const {platform}=await I('../services/api/platform.mjs'),{httpServer}=await I('../services/api/http.mjs'),{dispatchEngine}=await I('../services/api/dispatch.mjs');
 const {checkoutService,financeService,moneyOperations,paymentWebhook}=await I('../services/api/modules/payments/index.mjs'),{restaurantOrderService}=await I('../services/api/restaurant-orders.mjs'),{paystackCheckout}=await I('../services/api/modules/payments/paystack-checkout-adapter.mjs');
 const {promotionEngine}=await I('../services/api/promotion-engine.mjs');
 const texts=[];const sms={async send(m){texts.push(m);return {accepted:true};},async sendNotification(m){texts.push(m);return {accepted:true};}};
 const meters=(a,b)=>Math.max(1,Math.round(Math.hypot((a.latitude-b.latitude)*111000,(a.longitude-b.longitude)*111000)));
 const routing={async route(a,b){const m=meters(a,b);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};},async matrix(o,d){return o.map(x=>{const m=meters(x,d);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};});}};
 const dispatch=dispatchEngine(db,{routing});
 const secret='sk_live_audit3';
 const paystackState={};
 const fetchImpl=async(u,o={})=>{const p=new URL(u).pathname;paystackState.calls=(paystackState.calls||0)+1;
  if(p==='/transaction/initialize'){const b=JSON.parse(o.body);paystackState[b.reference]={amount:Number(b.amount)};return {ok:true,status:200,json:async()=>({status:true,data:{authorization_url:'https://checkout.paystack.com/x'+b.reference,reference:b.reference}})};}
  if(p.startsWith('/transaction/verify/')){const r=decodeURIComponent(p.split('/').pop());const a=paystackState[r]?.amount;return {ok:true,status:200,json:async()=>({status:true,data:{id:randomInt(1e9),reference:r,status:'success',domain:'live',amount:paystackState[r]?.tamper??a,currency:'GHS',channel:'mobile_money',paid_at:new Date().toISOString()}})};}
  return {ok:false,status:404,json:async()=>({status:false})};};
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
 const P={address:'Accra Mall, Tetteh Quarshie',latitude:5.6221,longitude:-0.1735},D={address:'Osu Oxford Street, Accra',latitude:5.5571,longitude:-0.1817};
 const trip=o=>({pickup:P,destination:D,vehicle:'motorcycle',recipientPhone:phone(),weightG:1000,description:'Documents',paymentMethod:'MOMO',...o});
 const signUp=async(k,e={})=>{const number=phone();await api(null,'POST','/api/v1/auth/register',{phone:number,password:PW,kind:k,...e});const l=await api(null,'POST','/api/v1/auth/login',{phone:number,password:PW});return {number,token:l.data.token,id:l.data.user.id};};
 const verify=async a=>{const ch=await api(a.token,'POST','/api/v1/me/phone-challenge',{});await api(a.token,'POST','/api/v1/me/phone-verify',{challengeId:ch.data.challengeId,code:code()});};
 const person=async k=>{const a=await signUp(k);await verify(a);return a;};
 const gps=(r,at=P)=>api(r.token,'POST','/api/v1/rider/location',{latitude:at.latitude,longitude:at.longitude,accuracyMeters:15,observedAt:new Date().toISOString()});
 const rider=async()=>{await db.query('UPDATE riders SET online=false');const r=await signUp('rider',{vehicle:'motorcycle',maxWeightG:20000});await verify(r);await db.query("UPDATE riders SET status='approved' WHERE id=$1",[r.id]);await api(r.token,'POST','/api/v1/rider/availability',{online:true});await gps(r);return r;};
 const webhook=(body,sig)=>{const raw=JSON.stringify(body);return fetch(base+'/api/v1/payments/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-paystack-signature':sig??createHmac('sha512',secret).update(raw).digest('hex')},body:raw}).then(async r=>[r.status,(await r.json().catch(()=>({})))]);};
 const book=async(c,o)=>{const q=await api(c.token,'POST','/api/v1/quotes',trip(o));const key='a3-'+randomInt(1e9);const s=await api(c.token,'POST','/api/v1/shipments',{quoteId:q.data.id},{'Idempotency-Key':key});return {id:s.data?.id,key,q,s};};
 const pay=async(c,b)=>{const p=await api(c.token,'POST','/api/v1/shipments/'+b.id+'/checkout',{idempotencyKey:b.key,email:'a@example.com'});const amt=paystackState[p.data?.reference]?.amount;return {p,amt,ev:{event:'charge.success',data:{id:randomInt(1e9),domain:'live',reference:p.data?.reference,status:'success',amount:amt,currency:'GHS',channel:'mobile_money',paid_at:new Date().toISOString()}}};};
 const state=async id=>(await db.query('SELECT state,paid,rider_id IS NOT NULL has_rider FROM shipments WHERE id=$1',[id])).rows[0];
 const scene=async(n,f)=>{const s=Date.now();log('START '+n,{});try{await Promise.race([f(),new Promise((_,rej)=>setTimeout(()=>rej(new Error('STUCK after 150s')),150000).unref())]);log('END '+n,{ms:Date.now()-s});}catch(e){log(n+' CRASHED',{m:e.message,at:e.stack?.split('\n')[1]});}};
 const assign=async(r,id)=>{await dispatch.tick();const o=(await api(r.token,'GET','/api/v1/rider/offers')).data?.find?.(x=>x.id===id);return brief(await api(r.token,'POST','/api/v1/shipments/'+id+'/accept',{offerId:o?.offerId}));};
 const pickup=async(r,id)=>{const c=await api(r.token,'POST','/api/v1/shipments/'+id+'/pickup-challenge',{});return brief(await api(r.token,'POST','/api/v1/shipments/'+id+'/verify',{challengeId:c.data?.challengeId,code:code()}));};
 const paid=async(c)=>{const b=await book(c);const x=await pay(c,b);await webhook(x.ev);return b.id;};

 await scene('real Paystack webhook',async()=>{
  const c=await person('customer');const b=await book(c);const x=await pay(c,b);
  const forged=await webhook(x.ev,'a'.repeat(128));const none=await fetch(base+'/api/v1/payments/webhook',{method:'POST',body:JSON.stringify(x.ev)}).then(r=>r.status);
  const stillUnpaid=await state(b.id);
  const good=await webhook(x.ev);const again=await webhook(x.ev);
  const after=await state(b.id);
  const b2=await book(c);const x2=await pay(c,b2);paystackState[x2.p.data.reference].tamper=1;
  const cheap=await webhook({...x2.ev,data:{...x2.ev.data,amount:1}});
  log('webhook',{pay:brief(x.p),forged,none,stillUnpaid,good,again,after,cheap,cheapState:await state(b2.id),feeOnAmount:[b.q.data.amount_minor,x.amt]});
  const ret=await fetch(base+'/checkout/complete').then(r=>r.status);log('return page',ret);
 });
 if(false)await scene('bad input',async()=>{
  const c=await person('customer'),other=await person('customer');
  const q=await api(c.token,'POST','/api/v1/quotes',trip());
  const stolen=await api(other.token,'POST','/api/v1/shipments',{quoteId:q.data.id},{'Idempotency-Key':'steal-'+randomInt(1e9)});
  await db.query("UPDATE quotes SET expires_at=now()-interval '1 minute' WHERE id=$1",[q.data.id]);
  const expired=await api(c.token,'POST','/api/v1/shipments',{quoteId:q.data.id},{'Idempotency-Key':'exp-'+randomInt(1e9)});
  const cases={extraPrice:trip({amountMinor:1}),zeroWeight:trip({weightG:0}),hugeWeight:trip({weightG:999999999}),outsideGhana:trip({destination:{address:'Lagos Nigeria',latitude:6.5,longitude:3.4}}),samePlace:trip({destination:P}),script:trip({description:'<img src=x onerror=alert(1)>'}),far:trip({destination:{address:'Bolgatanga, Ghana',latitude:10.78,longitude:-0.85}}),foreignPhone:trip({recipientPhone:'+2348012345678'}),ownPhone:trip({recipientPhone:c.number})};
  const out={};for(const [k,v] of Object.entries(cases)){const r=await api(c.token,'POST','/api/v1/quotes',v);out[k]=[r.status,r.data?.error??r.data?.amount_minor];}
  const big=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(100000)}).then(r=>r.status).catch(e=>e.message);
  const badJson=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{oops'}).then(r=>r.status);
  log('bad input',{stolen:brief(stolen),expired:brief(expired),out,big,badJson});
 });
 await scene('wrong codes',async()=>{
  const c=await person('customer');const r=await rider();const id=await paid(c);await assign(r,id);
  const ch=await api(r.token,'POST','/api/v1/shipments/'+id+'/pickup-challenge',{});const tries=[];for(let i=0;i<7;i++)tries.push((await api(r.token,'POST','/api/v1/shipments/'+id+'/verify',{challengeId:ch.data.challengeId,code:'000000'})).status);
  const right=await api(r.token,'POST','/api/v1/shipments/'+id+'/verify',{challengeId:ch.data.challengeId,code:code()});
  const fresh=[];for(let i=0;i<5;i++){const x=await api(r.token,'POST','/api/v1/shipments/'+id+'/pickup-challenge',{});fresh.push(brief(x));if(x.status===200)await db.query('UPDATE challenges SET expires_at=now() WHERE id=$1',[x.data.challengeId]);}
  log('wrong codes',{tries,right:brief(right),fresh});
  await db.query('UPDATE riders SET online=false WHERE id=$1',[r.id]);
 });
 await scene('suspended mid delivery',async()=>{
  const c=await person('customer');const r=await rider();const id=await paid(c);await assign(r,id);await pickup(r,id);await api(r.token,'POST','/api/v1/shipments/'+id+'/transition',{action:'start'});
  const admin=randomUUID();await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'x','admin',now())",[admin,phone()]);await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'verification:write')",[admin]);
  await app.approve({id:admin,kind:'admin'},'riders',r.id,'suspended');
  const finish=await api(r.token,'POST','/api/v1/shipments/'+id+'/delivery-challenge',{});
  const tick=await dispatch.tick().catch(e=>e.message);await db.query('SELECT 1');
  log('rider suspended holding a parcel',{finish:brief(finish),state:await state(id),exceptions:(await db.query('SELECT kind FROM dispatch_exceptions WHERE shipment_id=$1',[id])).rows,customerAlerts:(await db.query('SELECT count(*)::int n FROM notification_jobs WHERE recipient_id=$1',[c.id])).rows[0].n,cust:brief(await api(c.token,'GET','/api/v1/shipments/'+id))});
 });
 await scene('company suspended mid delivery',async()=>{
  const co=await signUp('company',{name:'Audit3 Co',services:['riders']});await db.query("UPDATE companies SET status='approved' WHERE owner_id=$1",[co.id]);await verify(co);
  const r=await rider();await api(co.token,'POST','/api/v1/company/invitations',{phone:r.number});const inv=await api(r.token,'GET','/api/v1/rider/invitations');await api(r.token,'POST','/api/v1/rider/invitations/accept',{invitationId:inv.data[0].id});await api(r.token,'POST','/api/v1/rider/availability',{online:true});await gps(r);
  const c=await person('customer');const id=await paid(c);const a=await assign(r,id);await pickup(r,id);
  await db.query("UPDATE companies SET status='suspended' WHERE owner_id=$1",[co.id]);
  log('company suspended holding a parcel',{a,me:brief(await api(r.token,'GET','/api/v1/me')),state:await state(id),companyLogin:brief(await api(co.token,'GET','/api/v1/company/profile'))});
 });
 await scene('accounts',async()=>{
  const r=await rider();const c=await person('customer');const id=await paid(c);await assign(r,id);await pickup(r,id);await api(r.token,'POST','/api/v1/shipments/'+id+'/transition',{action:'start'});await gps(r,D);const dc=await api(r.token,'POST','/api/v1/shipments/'+id+'/delivery-challenge',{});await api(r.token,'POST','/api/v1/shipments/'+id+'/verify',{challengeId:dc.data.challengeId,code:code()});
  const summary=(await api(r.token,'GET','/api/v1/rider/wallet/summary')).data;
  const del=await api(r.token,'POST','/api/v1/me/delete-account',{password:PW});
  const reuse=await api(null,'POST','/api/v1/auth/register',{phone:r.number,password:PW,kind:'rider',vehicle:'motorcycle',maxWeightG:20000});
  const old=await api(r.token,'GET','/api/v1/me');
  const paidOut=(await db.query('SELECT 1 FROM payout_withdrawals WHERE beneficiary_id=$1',[r.id])).rowCount;
  log('rider deletes with earnings owed',{onHold:summary?.onHoldMinor,available:summary?.availableNowMinor,del:brief(del),reuse:brief(reuse),oldToken:old.status,paidOut});
  const x=await person('customer');const ch=await api(null,'POST','/api/v1/auth/password-recovery',{phone:x.number});
  const reset=await api(null,'POST','/api/v1/auth/password-reset',{phone:x.number,challengeId:ch.data?.challengeId,code:code(),newPassword:'password1234'});
  const reset2=await api(null,'POST','/api/v1/auth/password-reset',{phone:x.number,challengeId:ch.data?.challengeId,code:code(),newPassword:'another mango river'});
  const unknown=await api(null,'POST','/api/v1/auth/password-recovery',{phone:phone()});
  log('password reset',{ch:brief(ch),weak:brief(reset),ok:brief(reset2),oldSession:(await api(x.token,'GET','/api/v1/me')).status,unknownSame:[unknown.status,Object.keys(unknown.data||{}).join(),Object.keys(ch.data||{}).join()]});
 });
 if(false)await scene('public tracking',async()=>{
  const c=await person('customer');const r=await rider();const id=await paid(c);await assign(r,id);
  const t=await api(c.token,'GET','/api/v1/shipments/'+id+'/tracking');const tok=t.data?.trackingToken??t.data?.shareToken??t.data?.publicToken;
  const pub=tok?await fetch(base+'/api/v1/public/track/'+tok).then(async x=>[x.status,await x.json().catch(()=>null)]):null;
  const bad=await fetch(base+'/track/not-a-token').then(x=>x.status);
  log('tracking',{keys:Object.keys(t.data||{}),hasToken:!!tok,pub:pub&&[pub[0],Object.keys(pub[1]||{})],bad});
  await db.query('UPDATE riders SET online=false WHERE id=$1',[r.id]);
 });
 await scene('promotions',async()=>{
  const owner=await person('business');const made=await api(owner.token,'POST','/api/v1/restaurants',{name:'Promo Kitchen '+randomInt(1e6),phone:'0241234567',address:'Oxford Street, Osu',latitude:P.latitude,longitude:P.longitude});
  await db.query("UPDATE restaurants SET status='approved',is_open=true,is_paused=false WHERE id=$1",[made.data.id]);
  const item=await api(owner.token,'POST','/api/v1/restaurants/'+made.data.id+'/items',{name:'Jollof',priceMinor:4000});
  const admin=randomUUID();await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'x','admin',now())",[admin,phone()]);await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'promotions:manage')",[admin]);
  const code2='SAVE'+randomInt(1e6);const start=new Date(Date.now()-60000).toISOString(),end=new Date(Date.now()+864e5).toISOString();
  const camp=await promotionEngine(db).createAdminCampaign({id:admin,kind:'admin'},{name:'Audit promo',ownerType:'elesend',discountType:'percentage',discountBps:10000,code:code2,startsAt:start,endsAt:end,totalBudgetMinor:5000,perCustomerLimit:1,eligibleRestaurantIds:[made.data.id]}).catch(e=>({error:e.message,issues:e.issues?.slice?.(0,4)}));
  log('campaign',camp?.error?camp:{id:camp.id,status:camp.status});
  const order={restaurantId:made.data.id,items:[{itemId:item.data.id,quantity:1}],deliveryAddress:D.address,deliveryLatitude:D.latitude,deliveryLongitude:D.longitude,customerPhone:'0241234567',promoCode:code2};
  const c=await person('customer');
  const q=await api(c.token,'POST','/api/v1/food-orders/quote',order);
  const fake=await api(c.token,'POST','/api/v1/food-orders/quote',{...order,promoCode:'NOPE'});
  const race=await Promise.all([1,2,3].map(()=>api(c.token,'POST','/api/v1/food-orders',{...order,paymentMethod:'MOMO'},{'Idempotency-Key':'p-'+randomInt(1e9)})));
  log('promo',{quote:brief(q),total:q.data?.totalMinor??q.data?.total_minor,keys:q.data&&Object.keys(q.data).filter(k=>/total|discount|commission|subsid/i.test(k)),fake:brief(fake),race:race.map(x=>[x.status,x.data?.error??x.data?.total_minor]),visibleCommission:race[0].data&&Object.keys(race[0].data).filter(k=>/commission/i.test(k))});
 });
 await scene('many people at once',async()=>{
  const people=[];for(let i=0;i<60;i++){people.push(await person('customer'));}
  const t0=Date.now();const res=await Promise.all(people.map(async c=>{const s=Date.now();const r=await api(c.token,'POST','/api/v1/quotes',trip());return [r.status,Date.now()-s];}));
  const times=res.map(x=>x[1]).sort((a,b)=>a-b);
  const logins=await Promise.all(people.slice(0,40).map(async c=>{const s=Date.now();const r=await api(null,'POST','/api/v1/auth/login',{phone:c.number,password:PW});return [r.status,Date.now()-s];}));
  const lt=logins.map(x=>x[1]).sort((a,b)=>a-b);
  log('load',{quotes:{statuses:[...new Set(res.map(x=>x[0]))],p50:times[30],p95:times[57],total:Date.now()-t0},logins:{statuses:[...new Set(logins.map(x=>x[0]))],p50:lt[20],max:lt.at(-1)}});
  await db.query('UPDATE riders SET online=false');
  const riders=[];for(let i=0;i<12;i++){const r=await signUp('rider',{vehicle:'motorcycle',maxWeightG:20000});await verify(r);await db.query("UPDATE riders SET status='approved' WHERE id=$1",[r.id]);await api(r.token,'POST','/api/v1/rider/availability',{online:true});await gps(r);riders.push(r);}
  const c=people[0];const ids=[];for(let i=0;i<12;i++){const k=await book(people[i]);const x=await pay(people[i],k);await webhook(x.ev);ids.push(k.id);}
  const s=Date.now();const a=await Promise.all([dispatch.tick(20),dispatch.tick(20)]);const dup=(await db.query("SELECT shipment_id,count(*)::int n FROM dispatch_offers WHERE shipment_id=ANY($1) AND status='offered' GROUP BY 1 HAVING count(*)>1",[ids])).rows;
  const offers=(await Promise.all(riders.map(async r=>{const o=(await api(r.token,'GET','/api/v1/rider/offers')).data||[];return Promise.all(o.map(x=>api(r.token,'POST','/api/v1/shipments/'+x.id+'/accept',{offerId:x.offerId}).then(y=>y.status)));}))).flat();
  const assigned=(await db.query("SELECT count(*)::int n,count(DISTINCT rider_id)::int riders FROM shipments WHERE id=ANY($1) AND state='RIDER_ASSIGNED'",[ids])).rows[0];
  log('dispatch at once',{ms:Date.now()-s,sameOrderOfferedTwice:dup.length,accepts:offers,assigned});
 });
 process.env.NODE_ENV=prev;server.closeAllConnections?.();log('ALL DONE',{});setTimeout(()=>process.exit(0),500);
});
