import {randomUUID} from 'node:crypto';
import {decryptAdminSecret,verifyAdminTotp} from './admin-mfa.mjs';
import {z} from 'zod';
import {check,phone,hash,passwordHash,passwordMatches,newToken,newCode,mac,equal,limit} from './security.mjs';
import {carRegistration,registerVehicleInTx} from './vehicle.mjs';
import {removeStop,removeShipment} from './multi-parcel.mjs';
import {postCashCommission} from './finance.mjs';
import {digitalDeliveryCompleted} from './checkout-accounting.mjs';
import {calculateQuote} from './pricing.mjs';
import {getSurgeMultiplier,validateGhanaBoundary} from '../../deliveryEngine.mjs';
import {measuredSurge} from './pricing-surge.mjs';
import {featureService} from './algorithms/features.mjs';
import {detectFraudSignals} from './algorithms/fraud.mjs';
import {marketService} from './markets.mjs';
const id=()=>randomUUID();
const uuid=z.string().uuid();
const registration=z.object({phone:z.string().max(30),password:z.string().min(12).max(128),kind:z.enum(['customer','business','rider','company']),name:z.string().min(2).max(160).optional(),vehicle:z.enum(['bicycle','motorcycle','tricycle','car','pickup','van','truck']).optional(),maxWeightG:z.number().int().min(1).max(10000000).optional(),car:carRegistration.optional()}).strict();
const address=z.object({address:z.string().min(5).max(400),latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180)}).strict();
const quoteSchema=z.object({pickup:address,destination:address,vehicle:z.enum(['motorcycle','car','van']).optional(),recipientPhone:z.string().max(30),weightG:z.number().int().min(1).max(10000000),description:z.string().min(2).max(500),parcelCategory:z.enum(['general','documents','fragile','food']).default('general'),parcelSize:z.enum(['small','medium','large']).default('small'),paymentMethod:z.enum(['CASH','MOMO','CARD','QR','DIGITAL']).default('DIGITAL'),cashPayer:z.enum(['sender','recipient']).default('recipient')}).strict();
const audit=(c,actor,action,entity)=>c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor,action,entity]);
export function platform(db,{otpKey,sms,dispatch,routing,adminMfaKey=process.env.ADMIN_MFA_ENCRYPTION_KEY}={}){
 check(/^[a-f0-9]{64}$/i.test(otpKey??''),500,'OTP_KEY must be 32 random bytes encoded as hex');
 async function event(c,s,kind){await c.query('INSERT INTO outbox(shipment_id,kind,payload) VALUES($1,$2,$3)',[s,kind,JSON.stringify({shipmentId:s,kind})]);}
 async function permission(c,actor,p){check((await c.query('SELECT 1 FROM permissions WHERE user_id=$1 AND permission=$2',[actor.id,p])).rowCount,403,'Permission required');}
 async function rider(c,actor){
  // Lock company before rider, serializing verification with company suspension.
  const pre=(await c.query('SELECT company_id FROM riders WHERE id=$1',[actor.id])).rows[0];
  check(pre,403,'Rider required');
  if(pre.company_id)check((await c.query("SELECT id FROM companies WHERE id=$1 AND status='approved' FOR UPDATE",[pre.company_id])).rowCount,403,'Company not approved');
  const r=(await c.query("SELECT * FROM riders WHERE id=$1 AND status='approved' FOR UPDATE",[actor.id])).rows[0];
  check(r,403,'Approved rider required');return r;
 }
 async function locked(c,sid){uuid.parse(sid);const s=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[sid])).rows[0];check(s,404,'Shipment not found');return s;}
 async function access(c,actor,s){
  if(s.customer_id===actor.id||s.rider_id===actor.id)return;
  if(s.company_id&&(await c.query('SELECT 1 FROM companies WHERE id=$1 AND owner_id=$2',[s.company_id,actor.id])).rowCount)return;
  await permission(c,actor,'shipments:read');
 }
 async function requireVerifiedPhone(c,actor){
  const r=(await c.query('SELECT phone_verified_at FROM users WHERE id=$1',[actor.id])).rows[0];
  check(r?.phone_verified_at,403,'Verify your registered phone number before using delivery services');
 }
 return {
 async phoneStatus(actor){const u=(await db.query('SELECT phone,phone_verified_at FROM users WHERE id=$1',[actor.id])).rows[0];check(u,401);return {phone:u.phone,verified:!!u.phone_verified_at};},
 async phoneChallenge(actor){check(sms&&typeof sms.send==='function',503,'Phone SMS verification unavailable');
  check(['customer','business','rider','company'].includes(actor.kind),403);
  const cid=id(),code=newCode(),to=await db.tx(async c=>{
   const u=(await c.query('SELECT phone,phone_verified_at FROM users WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];
   check(u&&!u.phone_verified_at,409,'Phone already verified or account unavailable');
   await limit(c,'phone-challenge:'+actor.id,3,900);
   check(!(await c.query('SELECT 1 FROM account_phone_challenges WHERE user_id=$1 AND expires_at>now() AND consumed_at IS NULL',[actor.id])).rowCount,409,'A phone verification code is already active');
   const digest=mac(otpKey,['account-phone-v1',cid,actor.id,u.phone,code]);
   await c.query("INSERT INTO account_phone_challenges(id,user_id,phone,digest,expires_at) VALUES($1,$2,$3,$4,now()+interval '5 minutes')",[cid,actor.id,u.phone,digest]);
   await audit(c,actor.id,'auth.phone_challenge_requested',actor.id);return u.phone;
  });
  try{await sms.send({phone:to,code,purpose:'account',challengeId:cid});
   await db.tx(async c=>{
    const u=(await c.query('SELECT phone,phone_verified_at FROM users WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];
    check(u?.phone===to&&!u.phone_verified_at,409,'Phone verification is no longer required');
    check((await c.query('UPDATE account_phone_challenges SET sent=true WHERE id=$1 AND user_id=$2 AND expires_at>now() AND consumed_at IS NULL RETURNING id',[cid,actor.id])).rowCount,409,'Phone challenge expired before provider acceptance');
   });
  }catch{
   await db.tx(async c=>{await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor.id]);await c.query('UPDATE account_phone_challenges SET expires_at=now() WHERE id=$1 AND sent=false',[cid]);});
   check(false,503,'Phone verification message unavailable');
  }
  return {challengeId:cid,expiresInSeconds:300};
 },
 async verifyPhone(actor,input){
  check(['customer','business','rider','company'].includes(actor.kind),403);
  const v=z.object({challengeId:uuid,code:z.string().regex(/^\d{6}$/)}).strict().parse(input);
  const result=await db.tx(async c=>{
   const u=(await c.query('SELECT phone,phone_verified_at FROM users WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];
   check(u&&!u.phone_verified_at,409,'Phone already verified or account unavailable');
   const ch=(await c.query('SELECT *,expires_at>now() AS live FROM account_phone_challenges WHERE id=$1 AND user_id=$2 FOR UPDATE',[v.challengeId,actor.id])).rows[0];
   check(ch&&ch.sent&&ch.live&&!ch.consumed_at&&ch.attempts<5&&ch.phone===u.phone,409,'Phone verification challenge unavailable');
   if(!equal(ch.digest,mac(otpKey,['account-phone-v1',ch.id,actor.id,u.phone,v.code]))){
    await c.query('UPDATE account_phone_challenges SET attempts=attempts+1 WHERE id=$1',[ch.id]);
    await audit(c,actor.id,'auth.phone_verification_rejected',actor.id);return {invalid:true};
   }
   await c.query('UPDATE account_phone_challenges SET consumed_at=now() WHERE id=$1',[ch.id]);
   await c.query('UPDATE users SET phone_verified_at=now() WHERE id=$1',[actor.id]);
   await audit(c,actor.id,'auth.phone_verified',actor.id);return {verified:true};
  });
  check(!result.invalid,400,'Incorrect verification code');return result;
 },
 async register(input){const v=registration.parse(input);const uid=id(),p=phone(v.phone),pw=await passwordHash(v.password);
  await db.tx(async c=>{await c.query('INSERT INTO users(id,phone,password_hash,kind) VALUES($1,$2,$3,$4)',[uid,p,pw,v.kind]);
   if(v.kind==='rider'){
    const type=v.vehicle??'motorcycle';check(type!=='car'||v.car,400,'Car registration details required');
    await c.query('INSERT INTO riders(id,vehicle,max_weight_g) VALUES($1,$2,$3)',[uid,type,v.maxWeightG??20000]);
    await c.query('INSERT INTO commission_accounts(rider_id) VALUES($1)',[uid]);
    if(type==='car')await registerVehicleInTx(c,uid,{vehicle:type,maxWeightG:v.maxWeightG??20000,car:v.car});
   }
   if(v.kind==='company'){check(v.name,400,'Company name required');await c.query('INSERT INTO companies(id,owner_id,name) VALUES($1,$2,$3)',[id(),uid,v.name]);}
   await audit(c,uid,'registered',uid);
  });return {id:uid,kind:v.kind,phone:p,phoneVerified:false};
 },
 async login(input){const v=z.object({phone:z.string().max(30),password:z.string().max(128),totpCode:z.string().regex(/^\d{6}$/).optional()}).strict().parse(input);const p=phone(v.phone);await limit(db,'login:'+hash(p),10,900);
  const u=(await db.query('SELECT * FROM users WHERE phone=$1',[p])).rows[0];
  // Spend equivalent password derivation work for unknown identities.
  const ok=await passwordMatches(v.password,u?.password_hash??('0'.repeat(32)+':'+ '0'.repeat(128)));check(u&&ok,401,'Invalid credentials');
  const token=newToken();
  if(u.kind==='admin'){
   check(v.totpCode,401,'Administrator authenticator code required');
   return db.tx(async c=>{
    // FOR UPDATE serializes counter consumption across concurrent mobile logins.
    const factor=(await c.query('SELECT * FROM admin_mfa_credentials WHERE user_id=$1 FOR UPDATE',[u.id])).rows[0];
    check(factor,403,'Administrator MFA provisioning required');
    const secret=decryptAdminSecret(factor.secret_encrypted,u.id,adminMfaKey);
    const step=verifyAdminTotp(secret,v.totpCode,{lastUsedStep:factor.last_used_step});
    check(step!==null,401,'Invalid or reused authenticator code');
    await c.query('UPDATE admin_mfa_credentials SET last_used_step=$2 WHERE user_id=$1',[u.id,step]);
    await c.query("INSERT INTO sessions(token_hash,user_id,expires_at,admin_mfa_verified) VALUES($1,$2,now()+interval '4 hours',true)",[hash(token),u.id]);
    await audit(c,u.id,'auth.admin_mfa_login',u.id);
    return {token,user:{id:u.id,kind:u.kind}};
   });
  }
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')",[hash(token),u.id]);return {token,user:{id:u.id,kind:u.kind}};
 },
 async authenticate(token){check(token&&typeof token==='string'&&token.length===64,401,'Authentication required');const u=(await db.query("SELECT u.id,u.kind FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND (u.kind<>'admin' OR s.admin_mfa_verified=true)",[hash(token)])).rows[0];check(u,401,'Session expired or administrator MFA required');return u;},
 async logout(token){await db.query('DELETE FROM sessions WHERE token_hash=$1',[hash(token)]);return {ok:true};},
 async setPricing(actor,input){const v=z.object({baseMinor:z.number().int().min(1).max(1000000),perKmMinor:z.number().int().min(1).max(100000),commissionBps:z.number().int().min(0).max(10000).default(300),commissionMode:z.enum(['percentage','fixed','hybrid']).default('percentage'),commissionFixedMinor:z.number().int().min(0).max(1000000).default(0),commissionCapMinor:z.number().int().min(0).max(1000000).nullable().default(null),perMinuteMinor:z.number().int().min(0).max(100000).default(0),waitPerMinuteMinor:z.number().int().min(0).max(100000).default(0),perExtraStopMinor:z.number().int().min(0).max(1000000).default(0)}).strict().parse(input);
  return db.tx(async c=>{await permission(c,actor,'pricing:write');await c.query('SELECT pg_advisory_xact_lock(617290113)');await c.query('UPDATE pricing_policies SET active=false WHERE active AND vehicle IS NULL');const pid=id();await c.query('INSERT INTO pricing_policies(id,base_minor,per_km_minor,commission_bps,commission_mode,commission_fixed_minor,commission_cap_minor,per_minute_minor,wait_per_minute_minor,per_extra_stop_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[pid,v.baseMinor,v.perKmMinor,v.commissionBps,v.commissionMode,v.commissionFixedMinor,v.commissionCapMinor,v.perMinuteMinor,v.waitPerMinuteMinor,v.perExtraStopMinor]);await audit(c,actor.id,'pricing.created',pid);return {id:pid};});
 },
 async configureVehicleTariff(actor,input){
  const v=z.object({vehicle:z.enum(['motorcycle','car','van']),baseMinor:z.number().int().min(1).max(1000000),perKmMinor:z.number().int().min(0).max(100000),perMinuteMinor:z.number().int().min(0).max(100000).default(0),minimumMinor:z.number().int().min(0).max(100000000).default(0),rushHourEnabled:z.boolean().default(false),supplyDemandEnabled:z.boolean().default(false),commissionBps:z.number().int().min(0).max(10000).default(2000)}).strict().parse(input);
  return db.tx(async c=>{await permission(c,actor,'pricing:write');await c.query('SELECT pg_advisory_xact_lock(617290113)');
   await c.query('UPDATE pricing_policies SET active=false WHERE active AND vehicle=$1',[v.vehicle]);const pid=id();
   await c.query('INSERT INTO pricing_policies(id,vehicle,base_minor,per_km_minor,per_minute_minor,minimum_minor,rush_hour_enabled,supply_demand_enabled,commission_bps) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[pid,v.vehicle,v.baseMinor,v.perKmMinor,v.perMinuteMinor,v.minimumMinor,v.rushHourEnabled,v.supplyDemandEnabled,v.commissionBps]);
   await audit(c,actor.id,'pricing.vehicle_version_created',pid);return {id:pid,...v};
  });
 },
 async vehicleTariffs(actor){check(['customer','business','admin'].includes(actor.kind),403);return (await db.query('SELECT id,vehicle,base_minor,per_km_minor,per_minute_minor,minimum_minor,rush_hour_enabled FROM pricing_policies WHERE active AND vehicle IS NOT NULL ORDER BY vehicle')).rows;},
 async getPricing(actor){check(['customer','business','admin'].includes(actor.kind),403);return (await db.query('SELECT * FROM pricing_policies WHERE active ORDER BY vehicle NULLS FIRST')).rows;},
 async configureCommission(actor,input){
  const v=z.object({vehicle:z.enum(['motorcycle','car','van']).nullable().optional(),commissionBps:z.number().int().min(0).max(10000),commissionMode:z.enum(['percentage','fixed','hybrid']).default('percentage'),commissionFixedMinor:z.number().int().min(0).max(1000000).default(0),commissionCapMinor:z.number().int().min(0).max(1000000).nullable().default(null)}).strict().parse(input);
  return db.tx(async c=>{
   await permission(c,actor,'pricing:write');await c.query('SELECT pg_advisory_xact_lock(617290113)');
   let targets;
   if(v.vehicle){targets=(await c.query('SELECT * FROM pricing_policies WHERE active AND vehicle=$1',[v.vehicle])).rows;}
   else{targets=(await c.query('SELECT * FROM pricing_policies WHERE active')).rows;}
   check(targets.length>0,404,'No active policy found');
   const created=[];
   for(const cur of targets){
    await c.query('UPDATE pricing_policies SET active=false WHERE id=$1',[cur.id]);
    const pid=id();
    await c.query('INSERT INTO pricing_policies(id,vehicle,base_minor,per_km_minor,per_minute_minor,minimum_minor,rush_hour_enabled,supply_demand_enabled,commission_bps,commission_mode,commission_fixed_minor,commission_cap_minor,wait_per_minute_minor,per_extra_stop_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[pid,cur.vehicle,cur.base_minor,cur.per_km_minor,cur.per_minute_minor??0,cur.minimum_minor??0,cur.rush_hour_enabled??false,cur.supply_demand_enabled??false,v.commissionBps,v.commissionMode,v.commissionFixedMinor,v.commissionCapMinor,cur.wait_per_minute_minor??0,cur.per_extra_stop_minor??0]);
    await audit(c,actor.id,'pricing.commission_configured',pid);
    created.push({id:pid,vehicle:cur.vehicle,commissionBps:v.commissionBps,commissionMode:v.commissionMode,commissionFixedMinor:v.commissionFixedMinor,commissionCapMinor:v.commissionCapMinor});
   }
   return {ok:true,policies:created};
  });
 },
 async configureSurgeZone(actor,input){
  const v=z.object({name:z.string().trim().min(2).max(80),latitude:z.number().finite(),longitude:z.number().finite(),radiusM:z.number().int().min(500).max(50000),enabled:z.boolean().default(false),replaceId:uuid.optional()}).strict().parse(input);validateGhanaBoundary(v.latitude,v.longitude);
  return db.tx(async c=>{await permission(c,actor,'pricing:write');await c.query('SELECT pg_advisory_xact_lock(617290113)');
   if(v.replaceId){check((await c.query('UPDATE pricing_surge_zones SET enabled=false WHERE id=$1 RETURNING id',[v.replaceId])).rowCount,404,'Zone not found');await audit(c,actor.id,'pricing.surge_zone_retired',v.replaceId);}
   const zoneId=id();await c.query('INSERT INTO pricing_surge_zones(id,name,center,radius_m,enabled) VALUES($1,$2,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,$5,$6)',[zoneId,v.name,v.longitude,v.latitude,v.radiusM,v.enabled]);
   await audit(c,actor.id,'pricing.surge_zone_created',zoneId);return {id:zoneId,...v};
  });
 },
 async approve(actor,type,target,status){check(['riders','companies'].includes(type),400);uuid.parse(target);check(['approved','suspended','rejected'].includes(status),400);
  return db.tx(async c=>{await permission(c,actor,'verification:write');const result=await c.query(`UPDATE ${type} SET status=$2 WHERE id=$1 RETURNING id`,[target,status]);check(result.rowCount,404);await audit(c,actor.id,type+'.'+status,target);return {ok:true};});
 },
 async availability(actor,input){const v=z.object({online:z.boolean()}).strict().parse(input);return db.tx(async c=>{const r=await rider(c,actor);
   if(v.online&&process.env.NODE_ENV==='production')await requireVerifiedPhone(c,actor);
   if(v.online&&r.vehicle==='car')check((await c.query("SELECT 1 FROM rider_vehicle_registrations WHERE rider_id=$1 AND vehicle='car' AND verification_status='approved'",[actor.id])).rowCount,403,'Car must be manually verified before going online');
   await c.query('UPDATE riders SET online=$2 WHERE id=$1',[actor.id,v.online]);if(!v.online)await c.query("UPDATE dispatch_offers SET status='invalidated' WHERE rider_id=$1 AND status='offered'",[actor.id]);return v;});},
 async quote(actor,input){check(['customer','business'].includes(actor.kind),403);
  // Do not accept live bookings when an essential custody-verification provider is absent.
  if(process.env.NODE_ENV==='production'){
   check(sms&&typeof sms.send==='function'&&dispatch,503,'Delivery booking paused: dispatch or SMS verification unavailable');
   await requireVerifiedPhone(db,actor);
  }
  await marketService(db).assertGhanaOperating();const v=quoteSchema.parse(input);v.recipientPhone=phone(v.recipientPhone);
  if(process.env.NODE_ENV==='production')check(v.vehicle,400,'Select a vehicle before requesting a fare');
  // Preserve prior API clients' implicit DIGITAL method in existing tests/migrations.
  // Native clients explicitly choose CASH/MOMO/CARD/QR. Legacy DIGITAL cannot
  // initiate public checkout or self-report payment success.
  if(v.paymentMethod!=='DIGITAL'){const allowed=(await db.query('SELECT enabled FROM checkout_method_policies WHERE method=$1',[v.paymentMethod])).rows[0];check(allowed?.enabled,503,'Payment method is not active');}
  for(const location of [v.pickup,v.destination])validateGhanaBoundary(location.latitude,location.longitude);
  const p=(await db.query('SELECT * FROM pricing_policies WHERE active AND vehicle IS NOT DISTINCT FROM $1',[v.vehicle??null])).rows[0];check(p,503,'Pricing not configured for selected vehicle');
  check(routing,503,'Road routing not configured; prices cannot be estimated safely');
  const route=await routing.route(v.pickup,v.destination,{vehicle:v.vehicle??'car'});
  check(route.source==='routing-provider'||(process.env.NODE_ENV!=='production'&&route.source==='fixture'),503,'Unsupported road estimate');
  const meters=route.distanceMeters;
  check(Number.isSafeInteger(meters)&&meters>=0,503,'Invalid road distance');
  check(Number.isSafeInteger(route.durationSeconds)&&route.durationSeconds>=0,503,'Invalid road duration');
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Accra',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
  const scheduledMultiplier=p.rush_hour_enabled?getSurgeMultiplier(v.pickup.latitude,v.pickup.longitude,hour):1;
  const surgeObservation=p.supply_demand_enabled&&v.vehicle?await measuredSurge(db,v.pickup,v.vehicle):{multiplierBps:10000,reason:'disabled'};
  const surgeBps=Math.max(scheduledMultiplier===1.4?14000:10000,surgeObservation.multiplierBps);
  const surgeMultiplier=surgeBps/10000;
  const {amountMinor,commissionMinor,riderEarningsMinor}=calculateQuote(p,meters,{durationSeconds:route.durationSeconds,surgeBps});const qid=id();
  const evidence={policyId:p.id,vehicle:v.vehicle??'legacy_unspecified',routeVehicle:v.vehicle??'car',distanceMeters:meters,durationSeconds:route.durationSeconds,source:route.source,surgeBps,scheduledMultiplier,surgeObservation,quotedAt:new Date().toISOString(),commissionBps:p.commission_bps,minimumMinor:p.minimum_minor};
  const r=await db.query("INSERT INTO quotes(id,customer_id,policy_id,request,amount_minor,commission_minor,expires_at,payment_method,pricing_evidence) VALUES($1,$2,$3,$4,$5,$6,now()+interval '15 minutes',$7,$8) RETURNING id,amount_minor,commission_minor,expires_at,payment_method",[qid,actor.id,p.id,JSON.stringify(v),amountMinor,commissionMinor,v.paymentMethod,JSON.stringify(evidence)]);
  const capacity=dispatch?await dispatch.availability({pickup:v.pickup,weightG:v.weightG,vehicle:v.vehicle,parcelCategory:v.parcelCategory,parcelSize:v.parcelSize}):{status:'unknown',guaranteed:false};
  return {...r.rows[0],currency:'GHS',vehicle:v.vehicle??null,pricingEvidence:evidence,surgeMultiplier,riderEarningsMinor,driverEarningGhs:riderEarningsMinor/100,platformCommissionGhs:commissionMinor/100,distanceMeters:meters,distanceMethod:route.source==='fixture'?'synthetic road routing fixture':'provider road routing',travelSeconds:route.durationSeconds,trafficAware:route.trafficAware===true,availability:capacity};
 },
 async book(actor,input,key){await marketService(db).assertGhanaOperating();const v=z.object({quoteId:uuid}).strict().parse(input);check(typeof key==='string'&&/^[\w-]{8,128}$/.test(key),400,'Idempotency-Key required');check(['customer','business'].includes(actor.kind),403);
  return db.tx(async c=>{if(process.env.NODE_ENV==='production')await requireVerifiedPhone(c,actor);await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[actor.id+key]);
   const old=(await c.query('SELECT * FROM shipments WHERE customer_id=$1 AND idempotency_key=$2',[actor.id,key])).rows[0];if(old){check(old.quote_id===v.quoteId,409,'Idempotency key reused with different request');return old;}
   const q=(await c.query('SELECT * FROM quotes WHERE id=$1 AND customer_id=$2 AND expires_at>now() FOR UPDATE',[v.quoteId,actor.id])).rows[0];check(q,409,'Quote unavailable or expired');
   const sid=id();const result=await c.query("INSERT INTO shipments(id,customer_id,quote_id,idempotency_key,state,recipient_phone,amount_minor,commission_minor,payment_method,cash_payer) VALUES($1,$2,$3,$4,$8,$5,$6,$7,$9,$10) RETURNING *",[sid,actor.id,q.id,key,q.request.recipientPhone,q.amount_minor,q.commission_minor,q.payment_method==='CASH'?'AWAITING_ASSIGNMENT':'AWAITING_PAYMENT',q.payment_method,q.payment_method==='CASH'?(q.request.cashPayer??'recipient'):null]);await audit(c,actor.id,'shipment.booked',sid);await event(c,sid,'booked');return result.rows[0];
  });
 },
 async paymentConfirmed({provider,eventId,shipmentId,amountMinor,currency}){
  // Internal adapter entry only. Never mounted as an unsigned public route.
  check(typeof provider==='string'&&provider.length>0&&typeof eventId==='string'&&eventId.length>0,400);uuid.parse(shipmentId);check(Number.isSafeInteger(amountMinor)&&currency==='GHS',400);
  return db.tx(async c=>{const s=await locked(c,shipmentId);check(s.amount_minor===amountMinor,409,'Payment amount mismatch');
   const previous=(await c.query('SELECT * FROM payment_events WHERE provider=$1 AND event_id=$2',[provider,eventId])).rows[0];
   if(previous){check(previous.shipment_id===shipmentId&&previous.amount_minor===amountMinor,409,'Event conflict');return {duplicate:true};}
   check(s.payment_method==='DIGITAL'&&s.state==='AWAITING_PAYMENT'&&!s.paid,409,'Shipment cannot receive provider payment');
   await c.query('INSERT INTO payment_events(provider,event_id,shipment_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5)',[provider,eventId,shipmentId,amountMinor,currency]);
   await c.query("UPDATE shipments SET paid=true,state='AWAITING_ASSIGNMENT' WHERE id=$1",[shipmentId]);await event(c,shipmentId,'payment_confirmed');return {ok:true};
  });
 },
 async offers(actor){check(dispatch,503,'Dispatch engine unavailable');return dispatch.offers(actor);},
 async accept(actor,sid,offerId){check(dispatch,503,'Dispatch engine unavailable');return dispatch.accept(actor,sid,offerId);},
 async get(actor,sid){uuid.parse(sid);const s=(await db.query('SELECT * FROM shipments WHERE id=$1',[sid])).rows[0];check(s,404);await access(db,actor,s);const q=(await db.query('SELECT request FROM quotes WHERE id=$1',[s.quote_id])).rows[0];return {...s,details:q.request};},
 async list(actor){
  if(['customer','business'].includes(actor.kind))return (await db.query('SELECT * FROM shipments WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[actor.id])).rows;
  if(actor.kind==='rider')return (await db.query('SELECT * FROM shipments WHERE rider_id=$1 ORDER BY created_at DESC LIMIT 100',[actor.id])).rows;
  if(actor.kind==='company')return (await db.query('SELECT s.* FROM shipments s JOIN companies c ON c.id=s.company_id WHERE c.owner_id=$1 ORDER BY s.created_at DESC LIMIT 100',[actor.id])).rows;
  await permission(db,actor,'shipments:read');return (await db.query('SELECT * FROM shipments ORDER BY created_at DESC LIMIT 100')).rows;
 },
 async challenge(actor,sid,purpose){check(['pickup','delivery'].includes(purpose),400);check(sms,503,'SMS adapter unavailable');
  const code=newCode(),cid=id();
  const target=await db.tx(async c=>{await rider(c,actor);const s=await locked(c,sid);check(s.rider_id===actor.id,403,'Assigned rider required');check(s.verification_authority==='elesend',409,'External verification not enabled');
   check((purpose==='pickup'?['RIDER_ASSIGNED']:['IN_TRANSIT','AWAITING_DELIVERY_OTP']).includes(s.state),409,'Shipment not eligible for challenge');
   const manifest=(await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE',[actor.id])).rows[0];
   if(manifest?.stops.length)check(manifest.stops[0].shipmentId===sid&&manifest.stops[0].kind===(purpose==='pickup'?'pickup':'dropoff'),409,'Complete the next verified route stop first');
   await limit(c,'otp:'+sid+':'+purpose,3,900);
   check(!(await c.query('SELECT 1 FROM challenges WHERE shipment_id=$1 AND purpose=$2 AND expires_at>now() AND consumed_at IS NULL',[sid,purpose])).rowCount,409,'Challenge still active');
   const destination=purpose==='delivery'?s.recipient_phone:(await c.query('SELECT phone FROM users WHERE id=$1',[s.customer_id])).rows[0].phone;
   const digest=mac(otpKey,[purpose,cid,sid,actor.id,destination,code]);
   await c.query("INSERT INTO challenges(id,shipment_id,rider_id,purpose,phone,digest,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '5 minutes')",[cid,sid,actor.id,purpose,destination,digest]);
   if(purpose==='delivery')await c.query("UPDATE shipments SET state='AWAITING_DELIVERY_OTP' WHERE id=$1",[sid]);await audit(c,actor.id,purpose+'.challenge_requested',sid);return destination;
  });
  try{await sms.send({phone:target,code,purpose,challengeId:cid});await db.tx(async c=>{
    const current=await locked(c,sid);
    check(current.rider_id===actor.id&&current.verification_authority==='elesend',409,'Shipment verification authority changed');
    check((await c.query('UPDATE challenges SET sent=true WHERE id=$1 AND rider_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING id',[cid,actor.id])).rowCount,409,'OTP challenge expired before SMS acceptance');
   });}
  catch {await db.tx(async c=>{await locked(c,sid);await c.query('UPDATE challenges SET expires_at=now() WHERE id=$1',[cid]);if(purpose==='delivery'){
    // A failed SMS cannot be marked sent; operator must use failure flow, no status bypass.
    await audit(c,actor.id,'delivery.sms_failed',sid);
   }});check(false,503,'SMS delivery unavailable; shipment requires recovery');}
  return {challengeId:cid,expiresInSeconds:300};
 },
 async verify(actor,sid,input){const v=z.object({challengeId:uuid,code:z.string().regex(/^\d{6}$/)}).strict().parse(input);
  const result=await db.tx(async c=>{await rider(c,actor);const s=await locked(c,sid);check(s.rider_id===actor.id,403,'Assigned rider required');
   const ch=(await c.query('SELECT *,expires_at>now() AS live FROM challenges WHERE id=$1 AND shipment_id=$2 AND rider_id=$3 FOR UPDATE',[v.challengeId,sid,actor.id])).rows[0];
   check(ch&&ch.sent&&ch.live&&!ch.consumed_at&&ch.attempts<5,409,'Challenge unavailable');
   check(s.state===(ch.purpose==='pickup'?'RIDER_ASSIGNED':'AWAITING_DELIVERY_OTP'),409,'Wrong delivery state');
   const pending=(await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE',[actor.id])).rows[0];
   if(pending?.stops.length)check(pending.stops[0].shipmentId===sid&&pending.stops[0].kind===(ch.purpose==='pickup'?'pickup':'dropoff'),409,'Stop order changed; verification blocked');
   if(!equal(ch.digest,mac(otpKey,[ch.purpose,ch.id,sid,actor.id,ch.phone,v.code]))){await c.query('UPDATE challenges SET attempts=attempts+1 WHERE id=$1',[ch.id]);await audit(c,actor.id,'otp.rejected',sid);
    if(ch.attempts+1>=5&&await featureService(c).enabled('fraud_signals')){
     const signals=detectFraudSignals({otpFailures:ch.attempts+1});
     for(const risk of signals.signals)await c.query('INSERT INTO operational_risk_signals(rider_id,shipment_id,signal_code,severity,evidence) VALUES($1,$2,$3,$4,$5)',[actor.id,sid,risk.code,risk.severity,JSON.stringify({challengeId:ch.id,attempts:ch.attempts+1})]);
    }return {invalid:true};}
   await c.query('UPDATE challenges SET consumed_at=now() WHERE id=$1',[ch.id]);
   // Each parcel has its own custody and recipient OTP. Advancing one stop never advances another.
   const plan=(await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE',[actor.id])).rows[0];
   if(plan){const updated=removeStop(plan.stops,sid,ch.purpose==='pickup'?'pickup':'dropoff');
    check(updated.length===plan.stops.length-1,409,'Route manifest stop missing');
    await c.query('UPDATE rider_dispatch_plans SET stops=$2,revision=revision+1,updated_at=now() WHERE rider_id=$1',[actor.id,JSON.stringify(updated)]);
   }
   if(ch.purpose==='pickup'){
    if(s.payment_method==='CASH'&&s.cash_payer==='sender')check((await c.query("SELECT 1 FROM cash_collections WHERE shipment_id=$1 AND cash_payer='sender' AND reported_status='reported_full' AND reported_minor=$2",[sid,s.amount_minor])).rowCount,409,'Full sender cash collection required before normal pickup; report shortfall and use dispute/exception flow');
    await c.query("UPDATE shipments SET state='PICKUP_VERIFIED' WHERE id=$1",[sid]);
   }
   else {
    if(s.payment_method==='CASH'){
     const collection=(await c.query('SELECT * FROM cash_collections WHERE shipment_id=$1 AND rider_id=$2',[sid,actor.id])).rows[0];
     check(collection&&collection.reported_status==='reported_full'&&Number(collection.reported_minor)===Number(s.amount_minor),409,'Full cash collection report required for normal handover. Open a payment dispute or exception/return flow for unpaid or partial cash.');
    }else check(s.paid,409,'Digital payment must be verified');
    await c.query("UPDATE shipments SET state='COMPLETED',completed_at=now() WHERE id=$1",[sid]);
    await c.query('INSERT INTO financial_entries(shipment_id,beneficiary_id,customer_charge_minor,commission_minor,entitlement_minor,payout_status) VALUES($1,$2,$3,$4,$5,$6)',[sid,s.company_id??actor.id,s.amount_minor,s.commission_minor,s.amount_minor-s.commission_minor,s.payment_method==='CASH'?'cash_rider_reported':'held']);
    if(s.payment_method!=='CASH')await digitalDeliveryCompleted(c,s);
    if(s.payment_method==='CASH')await postCashCommission(c,s);
   }
   await audit(c,actor.id,ch.purpose+'.verified',sid);await event(c,sid,ch.purpose==='delivery'?'completed':'pickup_verified');return {ok:true};
  });check(!result.invalid,400,'Incorrect code');return result;
 },
 async transition(actor,sid,input){const v=z.object({action:z.enum(['start','fail','return','returned','cancel']),reason:z.string().min(3).max(1000).optional()}).strict().parse(input);
  return db.tx(async c=>{if(actor.kind==='rider')await rider(c,actor);const s=await locked(c,sid);
   const transitions={start:['PICKUP_VERIFIED','IN_TRANSIT'],fail:[['RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP'],'FAILED'],return:['FAILED','RETURN_REQUESTED'],returned:['RETURN_REQUESTED','RETURNED'],cancel:[['AWAITING_PAYMENT','AWAITING_ASSIGNMENT'],'CANCELLED']};
   const [from,to]=transitions[v.action];check([from].flat().includes(s.state),409,'Invalid transition');
   if(v.action==='cancel')check(s.customer_id===actor.id,403);else check(s.rider_id===actor.id,403,'Assigned rider required');
   if(v.action!=='start')check(v.reason,400,'Reason required');
   await c.query('UPDATE shipments SET state=$2 WHERE id=$1',[sid,to]);
   if(v.action==='returned'){
    const plan=(await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE',[actor.id])).rows[0];
    if(plan)await c.query('UPDATE rider_dispatch_plans SET stops=$2,revision=revision+1,updated_at=now() WHERE rider_id=$1',[actor.id,JSON.stringify(removeShipment(plan.stops,sid))]);
   }
   await audit(c,actor.id,'shipment.'+v.action,sid);await event(c,sid,to);return {state:to,refundReviewRequired:v.action==='cancel'&&s.paid};
  });
 },
 async location(actor,sid,input){const v=z.object({latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180)}).strict().parse(input);return db.tx(async c=>{await rider(c,actor);const s=await locked(c,sid);check(s.rider_id===actor.id&&['RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP'].includes(s.state),403);await c.query('INSERT INTO locations(shipment_id,rider_id,latitude,longitude) VALUES($1,$2,$3,$4) ON CONFLICT(shipment_id) DO UPDATE SET latitude=$3,longitude=$4,updated_at=now()',[sid,actor.id,v.latitude,v.longitude]);return {ok:true};});},
 async tracking(actor,sid){await this.get(actor,sid);return (await db.query("SELECT latitude,longitude,updated_at FROM locations WHERE shipment_id=$1 AND updated_at>now()-interval '24 hours'",[sid])).rows[0]??null;},
 async dispute(actor,sid,input){const v=z.object({category:z.enum(['lost','damaged','payment','misconduct','address','other']),detail:z.string().min(5).max(2000)}).strict().parse(input);await this.get(actor,sid);return db.tx(async c=>{await locked(c,sid);const did=id();await c.query('INSERT INTO disputes(id,shipment_id,reporter_id,category,detail) VALUES($1,$2,$3,$4,$5)',[did,sid,actor.id,v.category,v.detail]);await audit(c,actor.id,'dispute.opened',sid);return {id:did};});},
 async earnings(actor){return (await db.query('SELECT f.* FROM financial_entries f WHERE f.beneficiary_id=$1 OR f.beneficiary_id IN (SELECT id FROM companies WHERE owner_id=$1) ORDER BY f.created_at DESC LIMIT 100',[actor.id])).rows;},
 async reviewQueue(actor){await permission(db,actor,'verification:write');return {riders:(await db.query('SELECT id,company_id,status,vehicle,max_weight_g FROM riders ORDER BY id LIMIT 100')).rows,companies:(await db.query('SELECT id,name,status FROM companies ORDER BY name LIMIT 100')).rows,vehicles:(await db.query('SELECT * FROM rider_vehicle_registrations ORDER BY submitted_at DESC LIMIT 100')).rows};}
 };
}
