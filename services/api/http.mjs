import {createServer} from 'node:http';
import {ZodError} from 'zod';
import {check,limit,equal} from './security.mjs';
import {haversine} from './dispatch-geometry.mjs';
import {network} from './network.mjs';
import {vehicleService} from './vehicle.mjs';
import {clientIp,resolveVerifiedHost} from './client-ip.mjs';
import {marketService} from './markets.mjs';
import {ghanaSearch,ghanaReverseGeocode} from './infrastructure/maps/ghana-geocoder.mjs';
import {searchInformalLocation} from './infrastructure/maps/egia/informal-geocoder.mjs';
import {createTemporaryDeliveryReference,getTemporaryDeliveryReference} from './infrastructure/maps/egia/temporary-reference.mjs';
import {submitRiderMapReport,getRiderMapFeedbackCategories} from './infrastructure/maps/egia/rider-map-reporter.mjs';
import {buildUnmappedCommunityRoute} from './infrastructure/maps/egia/unmapped-navigation.mjs';
import {createMapLifecycleService} from './infrastructure/maps/egia/map-lifecycle-service.mjs';
import {getPublicTracking,renderTrackingHtml} from './infrastructure/maps/web-tracker.mjs';
import {renderAdminPortalHtml} from './admin-web/admin-portal.mjs';
import {renderRestaurantPortalHtml,renderRestaurantManifestJson} from './restaurant-web/restaurant-portal.mjs';
import {restaurantService} from './restaurant.mjs';
import {restaurantOrderService} from './restaurant-orders.mjs';
import {commissionEngine} from './commission-engine.mjs';
import {promotionEngine} from './promotion-engine.mjs';
import {chatEngine,registerRealtimeConnection,upgradeToChatWebSocket,disconnectRealtimeSession,disconnectRealtimeUser} from './chat-engine.mjs';
import {
  getRiderWeeklySummary,
  getRiderWeeklyHistory,
  getAdminSettlementOverview,
  reconcileAndEnforceWeeklyRestrictions,
  evaluateRiderWeeklyEligibility,
  getWeeklySettlementSettings,
  updateWeeklySettlementSettings
} from './weekly-settlement.mjs';
import {walletSummary,walletDebt,walletTransactions,adminWalletOverview,adminWalletReconciliation,walletPolicyView,updateWalletPolicy} from './rider-wallet.mjs';
import {getSystemHealthReport} from './infrastructure/monitoring/system-health.mjs';
export function httpServer(db,app,dispatcher,finance,checkout=null,{ghanaPostGps=null,restaurant=null,restaurantOrders=null,paymentsWebhook=null,moneyOperations=null,readinessToken=null}={}){
  const net=network(db),vehicles=vehicleService(db),markets=marketService(db);
  const restaurants=restaurant||restaurantService(db);
  const restOrders=restaurantOrders||restaurantOrderService(db,{platform:app,dispatcher,routing:app?.routing,sms:app?.sms});
  const commissions=commissionEngine(db);
  const promos=promotionEngine(db);
  const chat=chatEngine(db);
  const mapLifecycle=createMapLifecycleService(db);
  const server=createServer({headersTimeout:5000,requestTimeout:20000,maxHeaderSize:8192},async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Content-Security-Policy',"default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
 const send=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
 try{
  check(!req.url.includes('\0')&&!(req.headers.host??'').includes('\0'),400,'Invalid request characters');
  if(req.headers['content-encoding']&&req.headers['content-encoding'].toLowerCase()!=='identity')check(false,415,'Content-Encoding not supported');
  const path=new URL(req.url,'http://localhost').pathname,method=req.method;

  if(method==='OPTIONS'){
   res.setHeader('Access-Control-Allow-Origin','*');
   res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
   res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, Idempotency-Key');
   res.writeHead(204).end();return;
  }
  if(path==='/health'&&method==='GET'){send(200,{status:'alive',service:'elesend'});return;}
  if(method==='GET'&&['/checkout/complete','/checkout/cancelled','/settlement/complete','/settlement/cancelled'].includes(path)){
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
   res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Return to ELESEND</title></head><body><h1>Return to ELESEND</h1><p>The app will verify your payment status. This page does not confirm a charge or cancellation.</p><p><a href="elesend://payments">Open ELESEND</a></p></body></html>');return;
  }
  if((path==='/ready'||path==='/readyz')&&method==='GET'){
   const secret=readinessToken!==null?readinessToken:(process.env.READINESS_PROBE_TOKEN||'');
   const hdr=req.headers['x-elesend-health-token']||req.headers['x-readiness-token'];
   const remote=req.socket?.remoteAddress||'';
   const isContainerLoopback=path==='/readyz'&&(remote==='127.0.0.1'||remote==='::1'||remote==='::ffff:127.0.0.1')&&!req.headers['x-forwarded-for'];
   const authorized=(secret.length>0&&equal(hdr,secret))||(secret.length===0&&isContainerLoopback);
   check(authorized,404,'Endpoint not found');
   await db.query('SELECT 1');send(200,{status:'ready'});return;
  }
  await limit(db,'http:'+clientIp(req),300,60);
  if(method==='GET'&&/^\/track\/[0-9a-f.-]{36,100}$/i.test(path)){
   await limit(db,'public-track:'+clientIp(req),60,60);
   const rawTok=path.split('/')[2];
   const data=await getPublicTracking(db,rawTok);
   if(!data){res.writeHead(404,{'Content-Type':'text/html'});res.end('<!DOCTYPE html><html><body style="background:#0c1324;color:#fff;font-family:sans-serif;padding:30px;text-align:center;"><h2>Tracking link not found or expired</h2></body></html>');return;}
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(renderTrackingHtml(data,rawTok));return;
  }
  if(method==='GET'&&/^\/api\/v1\/public-track\/[0-9a-f.-]{36,100}$/i.test(path)){
   await limit(db,'public-track:'+clientIp(req),60,60);
   const rawTok=path.split('/')[4];
   const bearer=req.headers.authorization?.replace(/^Bearer /,'');
   let optActor=null;
   if(bearer){try{optActor=bearer.startsWith('es_live_')?await net.authenticateKey(bearer):await app.authenticate(bearer);}catch{}}
   const data=await getPublicTracking(db,rawTok,{actor:optActor});
   if(!data){send(404,{error:'Tracking not found'});return;}
   send(200,data);return;
  }
  const adminHost=process.env.ADMIN_HOST?process.env.ADMIN_HOST.split(':')[0].toLowerCase():null;
  const reqHost=resolveVerifiedHost(req);
  const isAdminPath=path==='/admin'||path==='/admin/'||path==='/admin/index.html'||path.startsWith('/admin/')||path.startsWith('/api/v1/admin/');
  if(isAdminPath&&adminHost&&reqHost!==adminHost)check(false,404,'Endpoint not found');
  if(method==='GET'&&(path==='/admin'||path==='/admin/'||path==='/admin/index.html')){
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
   res.end(renderAdminPortalHtml());
   return;
  }
  if(method==='GET'&&(path==='/restaurant'||path==='/restaurant/'||path==='/restaurant/index.html')){
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
   res.end(renderRestaurantPortalHtml());
   return;
  }
  if(method==='GET'&&path==='/restaurant/manifest.json'){
   res.writeHead(200,{'Content-Type':'application/manifest+json; charset=utf-8'});
   res.end(renderRestaurantManifestJson());
   return;
  }
  if(!path.startsWith('/api/v1/'))check(false,404,'Endpoint not found');
  let body={},rawBody=Buffer.alloc(0);if(method==='POST'){
   check((req.headers['content-type']??'').split(';')[0]==='application/json',415,'JSON required');let size=0;const parts=[];
   for await(const part of req.iterator({destroyOnReturn:false})){size+=part.length;if(size>32768){res.setHeader('Connection','close');req.resume();check(false,413,'Request too large');}parts.push(part);}
   rawBody=Buffer.concat(parts);try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rawBody)||'{}');}catch{check(false,400,'Invalid JSON');}
  }
  if(method==='POST'&&['/api/v1/payments/webhook','/api/v1/payments/checkout-webhook','/api/v1/payments/commission-webhook'].includes(path)&&paymentsWebhook){send(200,await paymentsWebhook(rawBody,req.headers));return;}
  if(method==='POST'&&path==='/api/v1/payments/checkout-webhook'){
   check(checkout,503,'Checkout unavailable');send(200,await checkout.webhook(rawBody,req.headers));return;
  }
  if(method==='POST'&&path==='/api/v1/payments/commission-webhook'){
   check(finance,503,'Commission settlement unavailable');
   send(200,await finance.handleWebhook(rawBody,req.headers));return;
  }
  if(method==='POST'&&path==='/api/v1/auth/register'){await limit(db,'registration-ip:'+clientIp(req),12,3600);send(201,await app.register(body));return;}
  if(method==='POST'&&path==='/api/v1/auth/login'){await limit(db,'login-ip:'+clientIp(req),40,900);send(200,await app.login(body));return;}
  if(method==='POST'&&path==='/api/v1/auth/password-recovery'){await limit(db,'pw-recovery-ip:'+clientIp(req),10,900);send(200,await app.passwordRecoveryChallenge(body));return;}
  if(method==='POST'&&path==='/api/v1/auth/password-reset'){await limit(db,'pw-reset-ip:'+clientIp(req),15,900);send(200,await app.resetPassword(body));return;}
  const token=req.headers.authorization?.replace(/^Bearer /,'')||(path==='/api/v1/chat/stream'?new URL(req.url,'http://localhost').searchParams.get('token'):null);const actor=token?.startsWith('es_live_')?await net.authenticateKey(token):await app.authenticate(token);
  net.authorizeKey(actor,method,path);
  await limit(db,'user:'+actor.id,150,60);
  if(path.startsWith('/api/v1/admin/'))check(actor?.kind==='admin',403,'Administrator required');
  let result;
  if(method==='POST'&&path==='/api/v1/auth/logout'){result=await app.logout(token,body,actor);disconnectRealtimeSession(token,'logged_out');}
  else if(method==='GET'&&path==='/api/v1/me/phone')result=await app.phoneStatus(actor);
  else if(method==='POST'&&path==='/api/v1/me/phone-challenge')result=await app.phoneChallenge(actor);
  else if(method==='POST'&&path==='/api/v1/me/phone-verify')result=await app.verifyPhone(actor,body);
  else if(method==='POST'&&path==='/api/v1/me/push-token')result=await app.registerPushToken(actor,body,{sessionToken:token});
  else if(method==='GET'&&path==='/api/v1/me/push-tokens')result=await app.listPushTokens(actor);
  else if(method==='GET'&&path==='/api/v1/payments/methods'){check(checkout,503);result=await checkout.methods();}
  else if(method==='GET'&&path==='/api/v1/admin/payments/methods'){check(checkout,503);check(actor.kind==='admin',403,'Administrator required');check((await db.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission=ANY($2::text[])",[actor.id,['payments:configure','finance:read','finance:approve','finance:configure']])).rowCount,403,'Payment or finance permission required');result=await checkout.methods();}
  else if(method==='POST'&&path==='/api/v1/admin/payments/methods'){check(checkout,503);result=await checkout.configure(actor,body);}
  else if(method==='GET'&&path==='/api/v1/admin/payments/exceptions'){check(checkout,503);result=await checkout.exceptionQueue(actor);}
  else if(method==='GET'&&path==='/api/v1/admin/payments/operation-exceptions'){check(moneyOperations,503);result=await moneyOperations.exceptions(actor);}
  else if(method==='GET'&&(path==='/api/v1/admin/disputes'||path==='/api/v1/admin/payments/disputes')){check(moneyOperations,503);result=await moneyOperations.disputes(actor);}
  else if(method==='POST'&&/^\/api\/v1\/admin\/(?:payments\/)?disputes\/[0-9a-f-]+\/(?:resolve|refund)$/.test(path)){check(moneyOperations,503);const parts=path.split('/');const did=parts[parts.length-2];result=await moneyOperations.resolveDispute(actor,did,body);}
  else if(method==='GET'&&path==='/api/v1/admin/payments/refunds'){check(moneyOperations,503);result=await moneyOperations.refunds(actor);}
  else if(method==='POST'&&/^\/api\/v1\/admin\/payments\/refunds\/[0-9a-f-]+\/submit$/.test(path)){check(moneyOperations,503);result=await moneyOperations.submitRefund(actor,path.split('/')[6]);}
  else if(method==='POST'&&/^\/api\/v1\/admin\/payments\/refunds\/[0-9a-f-]+\/reconcile$/.test(path)){check(moneyOperations,503);result=await moneyOperations.reconcileRefund(actor,path.split('/')[6]);}
  else if(method==='POST'&&/^\/api\/v1\/admin\/payments\/refunds\/[0-9a-f-]+\/retry$/.test(path)){check(moneyOperations,503);result=await moneyOperations.retryRefund(actor,path.split('/')[6]);}
  else if(method==='POST'&&path==='/api/v1/me/payout-beneficiary'){check(moneyOperations,503);result=await moneyOperations.verifyBeneficiary(actor,body);}
  else if(method==='GET'&&path==='/api/v1/admin/payments/payouts'){check(moneyOperations,503);result=await moneyOperations.payouts(actor);}
  else if(method==='POST'&&path==='/api/v1/admin/payments/payouts'){check(moneyOperations,503);result=await moneyOperations.proposePayout(actor,body);}
  else if(method==='POST'&&/^\/api\/v1\/admin\/payments\/payouts\/[0-9a-f-]+\/approve$/.test(path)){check(moneyOperations,503);result=await moneyOperations.approvePayout(actor,path.split('/')[6]);}
  else if(method==='POST'&&/^\/api\/v1\/admin\/payments\/payouts\/[0-9a-f-]+\/reconcile$/.test(path)){check(moneyOperations,503);result=await moneyOperations.reconcilePayout(actor,path.split('/')[6]);}
  else if(method==='POST'&&/^\/api\/v1\/admin\/payments\/payouts\/[0-9a-f-]+\/retry$/.test(path)){check(moneyOperations,503);result=await moneyOperations.retryPayout(actor,path.split('/')[6]);}
  else if(method==='GET'&&path==='/api/v1/admin/restaurants'){check((await db.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission='verification:write'",[actor.id])).rowCount,403);result=await restaurants.listRestaurants({includePending:true});}
  else if(method==='POST'&&/^\/api\/v1\/shipments\/[0-9a-f-]+\/checkout$/.test(path)){check(checkout,503);result=await checkout.initiate(actor,path.split('/')[4],body);}
  else if(method==='GET'&&/^\/api\/v1\/shipments\/[0-9a-f-]+\/checkout$/.test(path)){check(checkout,503);result=await checkout.status(actor,path.split('/')[4]);}
  else if(method==='GET'&&path==='/api/v1/me')result=actor;
  else if(method==='GET'&&path==='/api/v1/maps/config')result={renderer:'private',routing:'osrm',ghanaPostGpsLookup:Boolean(ghanaPostGps)};
  else if(method==='POST'&&path==='/api/v1/maps/ghana-address'){
   check(ghanaPostGps,503,'GhanaPostGPS address lookup is disabled');
   check(['customer','business'].includes(actor.kind)&&!actor.api_client_id,403,'Customer or business account required');
   check(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===1&&typeof body.address==='string',400,'Provide only a GhanaPostGPS address');
   await limit(db,'ghana-address:user:'+actor.id,5,60);await limit(db,'ghana-address:global',100,3600);
   result=await ghanaPostGps(body.address);
  }
  else if(method==='GET'&&path==='/api/v1/maps/search'){
   const q=new URL(req.url,'http://localhost').searchParams.get('q')??'';
   check(q.length>=2,400,'Enter at least 2 characters to search');
   await limit(db,'maps-search:'+actor.id,60,60);
   result=ghanaSearch(q);
  }
  else if(method==='GET'&&path==='/api/v1/maps/reverse'){
   const u=new URL(req.url,'http://localhost').searchParams;
   const lat=Number(u.get('lat')),lon=Number(u.get('lon'));
   check(Number.isFinite(lat)&&Number.isFinite(lon),400,'Valid lat and lon required');
   await limit(db,'maps-reverse:'+actor.id,60,60);
   result=ghanaReverseGeocode(lat,lon);
  }
  else if(method==='GET'&&path==='/api/v1/maps/restaurants/viewport'){
   await limit(db,'maps-viewport:'+actor.id,120,60);
   const u=new URL(req.url,'http://localhost').searchParams;
   const bboxStr=u.get('bbox')||'-3.3,4.7,1.3,11.2';
   const [minLon,minLat,maxLon,maxLat]=bboxStr.split(',').map(Number);
   check(Number.isFinite(minLon)&&Number.isFinite(minLat)&&Number.isFinite(maxLon)&&Number.isFinite(maxLat)&&minLon<maxLon&&minLat<maxLat&&(maxLon-minLon)<=20&&(maxLat-minLat)<=20,400,'Valid bbox required: minLon,minLat,maxLon,maxLat (max 20 degree span)');
   const category=u.get('category');
   const categoryGroup=u.get('category_group');
   const searchQ=(u.get('q')||'').trim();
   const preparedFoodOnly=u.get('prepared_food_only')==='true';
   const registeredOnly=u.get('registered_only')==='true';
   const zoom=Number.isFinite(Number(u.get('zoom')))?Number(u.get('zoom')):14;
   const limitVal=Math.min(Math.max(parseInt(u.get('limit')||'50',10),1),250);
   const offsetVal=Math.max(0,Math.min(10000,parseInt(u.get('offset')||'0',10)||0));

   let whereClause='WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)';
   const params=[minLon,minLat,maxLon,maxLat];
   let pIdx=5;

   if(category){
     whereClause+=` AND category = $${pIdx++}`;
     params.push(category);
   }
   if(categoryGroup){
     whereClause+=` AND category_group = $${pIdx++}`;
     params.push(categoryGroup);
   }
   if(searchQ){
     whereClause+=` AND (name ILIKE $${pIdx} OR COALESCE(community, '') ILIKE $${pIdx} OR COALESCE(cuisine, '') ILIKE $${pIdx})`;
     params.push(`%${searchQ}%`);
     pIdx++;
   }
   if(preparedFoodOnly){
     whereClause+=` AND category_group NOT IN ('drinking_only_venues', 'other_food_landmarks')`;
   }
   if(registeredOnly){
     whereClause+=` AND is_registered_merchant = TRUE`;
   }

   const sql=`
     SELECT restaurant_id, name, alternative_names, category, subcategory, category_group, cuisine,
            latitude, longitude, region, district, community, street_address,
            phone_number, opening_hours, operating_status,
            source_name, source_license, coordinate_kind, verification_status,
            confidence_score, is_registered_merchant, registered_merchant_id
     FROM mapped_restaurants
     ${whereClause}
     ORDER BY is_registered_merchant DESC, confidence_score DESC, restaurant_id ASC
     LIMIT $${pIdx++} OFFSET $${pIdx++}
   `;
   params.push(limitVal, offsetVal);

   const qRes=await db.query(sql,params);
   const mappedRows=qRes.rows.map(r=>({
     restaurant_id: r.restaurant_id,
     name: r.name,
     alternative_names: r.alternative_names,
     category: r.category,
     subcategory: r.subcategory,
     category_group: r.category_group || 'restaurants_and_chop_bars',
     cuisine: r.cuisine,
     latitude: Number(r.latitude),
     longitude: Number(r.longitude),
     region: r.region,
     district: r.district,
     community: r.community,
     street_address: r.street_address,
     phone_number: r.phone_number,
     opening_hours: r.opening_hours,
     operating_status: r.operating_status,
     source_name: r.source_name,
     source_license: r.source_license,
     coordinate_kind: r.coordinate_kind || 'mapped_point',
     verification_status: r.verification_status || 'source_coordinates_not_field_verified',
     confidence_score: Number(r.confidence_score),
     is_registered_merchant: Boolean(r.is_registered_merchant),
     registered_merchant_id: r.registered_merchant_id,
     selectable_as_destination: true,
     can_order_menu: Boolean(r.is_registered_merchant && r.registered_merchant_id),
     delivery_mode: r.is_registered_merchant ? 'direct_merchant_order' : 'errand_courier_pickup'
   }));

   // Build MapLibre-compatible clustering when zoom < 13
   const clusters=[];
   if(zoom<13 && mappedRows.length>0){
     const cellDeg = Math.max(0.01, 0.35 / Math.pow(2, Math.max(0, zoom - 6)));
     const buckets = new Map();
     for(const r of mappedRows){
       const gx = Math.floor(r.longitude / cellDeg);
       const gy = Math.floor(r.latitude / cellDeg);
       const key = `${gx}:${gy}`;
       let b = buckets.get(key);
       if(!b){
         b = { count: 0, sumLat: 0, sumLon: 0, registeredCount: 0, sampleNames: [], items: [] };
         buckets.set(key, b);
       }
       b.count++;
       b.sumLat += r.latitude;
       b.sumLon += r.longitude;
       if(r.is_registered_merchant) b.registeredCount++;
       if(b.sampleNames.length < 3) b.sampleNames.push(r.name);
       b.items.push(r);
     }
     let cIdx = 1;
     for(const b of buckets.values()){
       clusters.push({
         cluster_id: `cluster_${cIdx++}`,
         cluster: b.count > 1,
         point_count: b.count,
         point_count_abbreviated: b.count >= 1000 ? `${(b.count/1000).toFixed(1)}k` : String(b.count),
         latitude: Number((b.sumLat / b.count).toFixed(6)),
         longitude: Number((b.sumLon / b.count).toFixed(6)),
         registered_merchant_count: b.registeredCount,
         sample_names: b.sampleNames
       });
     }
   }

   result={
     total: mappedRows.length,
     limit: limitVal,
     offset: offsetVal,
     bbox: [minLon,minLat,maxLon,maxLat],
     zoom,
     clustering_active: zoom < 13,
     clusters,
     attribution: '© OpenStreetMap contributors (ODbL-1.0) | Overture Maps Foundation (CDLA-Permissive-2.0)',
     restaurants: mappedRows
   };
  }
     else if(method==='POST'&&path==='/api/v1/maps/egia/search'){
    await limit(db,'maps-egia:'+actor.id,100,60);
    const egiaQuery=typeof body?.query==='string'?body.query:'';
    check(egiaQuery.trim().length>=2&&egiaQuery.length<=150,400,'Search text must be 2-150 characters');
    const egiaLimit=Math.min(30,Math.max(1,Number.parseInt(body?.limit,10)||10));
    result=await searchInformalLocation(egiaQuery,{db,userCoordinates:body?.coordinates,limit:egiaLimit});
   }
   else if(method==='POST'&&path==='/api/v1/maps/egia/temporary-reference'){
    await limit(db,'temp-ref:'+actor.id,40,60);
    result=await createTemporaryDeliveryReference(db,actor,body);
   }
   else if(method==='GET'&&/^\/api\/v1\/maps\/egia\/temporary-reference\/[0-9a-f-]{36}$/.test(path)){
    result=await getTemporaryDeliveryReference(db,actor,path.split('/')[6]);
   }
   else if(method==='POST'&&path==='/api/v1/rider/map-report'){
    await limit(db,'rider-rep:'+actor.id,20,60);
    result=await submitRiderMapReport(db,actor,body);
   }
   else if(method==='GET'&&path==='/api/v1/rider/map-report/categories'){
    result=getRiderMapFeedbackCategories();
   }
   else if(method==='GET'&&/^\/api\/v1\/shipments\/[0-9a-f-]{36}\/unmapped-navigation$/.test(path)){
    const sid=path.split('/')[4];
    const s=(await db.query('SELECT s.*,q.request AS quote_request,ST_Y(l.coordinates::geometry) as dest_lat,ST_X(l.coordinates::geometry) as dest_lon FROM shipments s LEFT JOIN quotes q ON q.id=s.quote_id LEFT JOIN temporary_delivery_references l ON l.shipment_id=s.id WHERE s.id=$1',[sid])).rows[0];
    check(s,404,'Shipment not found');
    check(actor?.kind==='rider'&&s.rider_id===actor.id,403,'Assigned rider required');
    const r=(await db.query('SELECT ST_Y(current_position::geometry) as lat,ST_X(current_position::geometry) as lon FROM riders WHERE id=$1',[actor.id])).rows[0];
    check(r&&Number.isFinite(Number(r.lat))&&Number.isFinite(Number(r.lon)),400,'Rider position unavailable');
    const qDest=s.quote_request?.destination||s.quote_request?.dropoff||null;
    const qLat=Number(qDest?.latitude),qLon=Number(qDest?.longitude),refLat=Number(s.dest_lat),refLon=Number(s.dest_lon);
    if(Number.isFinite(refLat)&&Number.isFinite(refLon)&&Number.isFinite(qLat)&&Number.isFinite(qLon)){
     check(haversine({latitude:refLat,longitude:refLon},{latitude:qLat,longitude:qLon})<=5,409,'Temporary delivery reference coordinates diverge from quoted destination');
    }
    const destLat=Number.isFinite(qLat)?qLat:refLat;
    const destLon=Number.isFinite(qLon)?qLon:refLon;
    check(Number.isFinite(destLat)&&Number.isFinite(destLon),422,'Confirmed destination coordinates required for navigation');
    const destCoords={
     latitude:destLat,
     longitude:destLon
    };
    // dispatchEngine closes over routing and does not expose dispatcher.routing.
    // Authoritative road geometry comes from platform routing (same OSRM adapter as quotes).
    result=await buildUnmappedCommunityRoute({
      routingAdapter:app?.routing||{route:async()=>null},
      riderPosition:{latitude:Number(r.lat),longitude:Number(r.lon)},
      confirmedDestination:destCoords,
      vehicle:s.vehicle||'motorcycle',
      db
    });
   }
   else if(method==='GET'&&path==='/api/v1/admin/geo-intelligence/dashboard'){
    result=await mapLifecycle.getAdminGeoDashboard(actor);
   }
   else if(method==='POST'&&path==='/api/v1/admin/geo-intelligence/publish-road'){
    result=await mapLifecycle.publishRoad(actor,body?.roadId,body?.notes);
   }
   else if(method==='POST'&&path==='/api/v1/admin/geo-intelligence/rollback-road'){
    result=await mapLifecycle.rollbackRoad(actor,body?.versionTag);
   }
   else if(method==='POST'&&path==='/api/v1/admin/geo-intelligence/publish-landmark'){
    result=await mapLifecycle.publishLandmark(actor,body?.landmarkId,body?.notes);
   }
   else if(method==='POST'&&path==='/api/v1/admin/geo-intelligence/reject'){
    result=await mapLifecycle.rejectCandidate(actor,body);
   }
   else if(method==='POST'&&path==='/api/v1/quotes'){await limit(db,'quote:'+actor.id,30,60);result=await app.quote(actor,body);}
  else if(method==='POST'&&path==='/api/v1/calculate-fare'){await limit(db,'quote:'+actor.id,30,60);result=await app.quote(actor,body);}
  else if(method==='GET'&&path==='/api/v1/pricing/vehicles')result=await app.vehicleTariffs(actor);
  else if(method==='POST'&&path==='/api/v1/admin/pricing/vehicles')result=await app.configureVehicleTariff(actor,body);
  else if(method==='POST'&&path==='/api/v1/admin/pricing/surge-zones')result=await app.configureSurgeZone(actor,body);
  else if(method==='POST'&&path==='/api/v1/shipments')result=await app.book(actor,body,req.headers['idempotency-key']);
  else if(method==='GET'&&path==='/api/v1/shipments')result=await app.list(actor);
  else if(method==='GET'&&path==='/api/v1/rider/offers')result=await app.offers(actor);
  else if(method==='GET'&&path==='/api/v1/rider/dispatch-settings'){check(dispatcher,503);result=await dispatcher.trackingSettings(actor);}
  else if(method==='GET'&&path==='/api/v1/rider/vehicle')result=await vehicles.profile(actor);
  else if(method==='POST'&&path==='/api/v1/rider/vehicle')result=await vehicles.submit(actor,body);
  else if(method==='GET'&&path==='/api/v1/rider/manifest'){check(dispatcher,503);result=await dispatcher.manifest(actor);}
  else if(method==='POST'&&path==='/api/v1/rider/multi-stop'){check(dispatcher,503);result=await dispatcher.optIn(actor,body);}
  else if(method==='POST'&&path==='/api/v1/rider/location'){check(dispatcher,503,'Dispatch unavailable');result=await dispatcher.riderPosition(actor,body);}
  else if(method==='POST'&&path==='/api/v1/rider/offers/decline'){check(dispatcher,503,'Dispatch unavailable');result=await dispatcher.decline(actor,body.shipmentId,body.offerId);}
  else if(method==='POST'&&path==='/api/v1/rider/assignments/release'){check(dispatcher,503);result=await dispatcher.release(actor,body.shipmentId,body.reason);await chat.revokeRiderConversations(db,{shipmentId:body.shipmentId,oldRiderUserId:actor.id,reason:'rider_released'});}
  else if(method==='POST'&&path==='/api/v1/delivery/availability'){check(dispatcher,503,'Dispatch unavailable');check(['customer','business'].includes(actor.kind),403);result=await dispatcher.availability(body);}
  else if(method==='GET'&&path==='/api/v1/admin/dispatch-policy'){check(dispatcher,503);result=await dispatcher.getPolicy(actor);}
  else if(method==='POST'&&path==='/api/v1/admin/dispatch-policy'){check(dispatcher,503);result=await dispatcher.configure(actor,body);}
  else if(method==='POST'&&path==='/api/v1/admin/dispatch/watchdog'){
   check(actor.kind==='admin',403,'Administrator required');
   check((await db.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission=ANY($2::text[])",[actor.id,['dispatch:configure','verification:write','support:moderate']])).rowCount,403,'Dispatch permission required');
   const shipRes=dispatcher?.watchdog?await dispatcher.watchdog(body):[];
   const foodRes=restOrders?.monitorAssignedDeliveries?await restOrders.monitorAssignedDeliveries(body):[];
   const shipActions=Array.isArray(shipRes)?shipRes:(shipRes?.actions||[]);
   const foodActions=Array.isArray(foodRes)?foodRes:(foodRes?.actions||[]);
   for(const act of [...shipActions,...foodActions]){
    if((act.reassigned||act.status==='reassigned_pre_pickup')&&act.shipmentId)await chat.revokeRiderConversations(db,{shipmentId:act.shipmentId,oldRiderUserId:act.previousRiderId,reason:'watchdog_reassigned'});
   }
   result={shipments:shipRes,foodOrders:foodRes};
  }
  else if(method==='GET'&&path==='/api/v1/admin/markets')result=await markets.list(actor);
  else if(method==='POST'&&path==='/api/v1/admin/markets/stage')result=await markets.stage(actor,body);
  else if(method==='POST'&&path==='/api/v1/admin/markets/activate')result=await markets.activate(actor,body);
  else if(method==='GET'&&path==='/api/v1/admin/fleet-batch-preview'){check(dispatcher,503);result=await dispatcher.previewFleetBatch(actor);}
  else if(method==='POST'&&path==='/api/v1/admin/risk-signals/review'){check(dispatcher,503);result=await dispatcher.reviewRisk(actor,body);}
  else if(method==='GET'&&path==='/api/v1/admin/risk-signals'){check(dispatcher,503);result=await dispatcher.riskSignals(actor);}
  else if(method==='GET'&&path==='/api/v1/admin/algorithm-features'){check(dispatcher,503);result=await dispatcher.algorithmFeatures(actor);}
  else if(method==='POST'&&path==='/api/v1/admin/algorithm-features'){check(dispatcher,503);result=await dispatcher.setAlgorithmFeature(actor,body);}
  else if(method==='GET'&&path==='/api/v1/admin/vehicle-policy'){check(dispatcher,503);result=await dispatcher.vehiclePolicy(actor);}
  else if(method==='POST'&&/^\/api\/v1\/admin\/vehicles\/[0-9a-f-]+\/review$/.test(path))result=await vehicles.review(actor,path.split('/')[5],body);
  else if(method==='POST'&&path==='/api/v1/admin/vehicle-policy'){check(dispatcher,503);result=await dispatcher.setVehiclePolicy(actor,body);}
  else if(method==='POST'&&path==='/api/v1/rider/availability')result=await app.availability(actor,body);
  else if(method==='GET'&&path==='/api/v1/earnings')result=await app.earnings(actor);
  else if(method==='GET'&&path==='/api/v1/rider/finance'){check(finance,503);result=await finance.snapshot(actor);}
  else if(method==='POST'&&path==='/api/v1/rider/finance/settle'){check(finance,503);result=await finance.initiate(actor,body);}
  else if(method==='GET'&&path==='/api/v1/rider/commissions/summary'){check(actor?.kind==='rider',403,'Rider required');result=await getRiderWeeklySummary(db,actor.id);}
  else if(method==='GET'&&path==='/api/v1/rider/commissions/weeks'){check(actor?.kind==='rider',403,'Rider required');result=await getRiderWeeklyHistory(db,actor.id);}
  else if(method==='GET'&&path==='/api/v1/rider/commissions/entries'){check(actor?.kind==='rider',403,'Rider required');result=(await getRiderWeeklySummary(db,actor.id)).recentDeliveries;}
  else if(method==='GET'&&path==='/api/v1/rider/eligibility'){check(actor?.kind==='rider',403,'Rider required');result=await evaluateRiderWeeklyEligibility(db,actor.id);}
  // Rider wallet: available to debt-restricted/suspended riders (authentication only) so repayment is never blocked.
  else if(method==='GET'&&path==='/api/v1/rider/wallet/summary')result=await walletSummary(db,actor);
  else if(method==='GET'&&path==='/api/v1/rider/wallet/debt')result=await walletDebt(db,actor);
  else if(method==='GET'&&path==='/api/v1/rider/wallet/transactions')result=await walletTransactions(db,actor,{limit:new URL(req.url,'http://localhost').searchParams.get('limit')??100});
  else if(method==='POST'&&path==='/api/v1/rider/wallet/topups'){check(actor?.kind==='rider',403,'Rider required');check(finance,503);result=await finance.initiate(actor,{...body,kind:'commission_repayment'});}
  else if(method==='GET'&&/^\/api\/v1\/rider\/wallet\/topups\/[0-9a-f-]{36}$/.test(path)){check(actor?.kind==='rider',403,'Rider required');check(finance,503);result=await finance.paymentStatus(actor,path.split('/')[6]);}
  else if(method==='GET'&&path==='/api/v1/admin/finance/wallet-overview')result=await adminWalletOverview(db,actor);
  else if((method==='GET'||method==='POST')&&path==='/api/v1/admin/finance/reconciliation'){
   const u=new URL(req.url,'http://localhost').searchParams;
   const repair=method==='POST'?body?.repair!==false:u.get('repair')==='true';
   result=await adminWalletReconciliation(db,actor,{repair});
  }
  else if(method==='GET'&&path==='/api/v1/admin/finance/wallet-policy')result=await walletPolicyView(db,actor);
  else if(method==='POST'&&path==='/api/v1/admin/finance/wallet-policy')result=await updateWalletPolicy(db,actor,body);
  else if(method==='POST'&&path==='/api/v1/rider/commissions/payments'){check(actor?.kind==='rider',403,'Rider required');check(finance,503);result=await finance.initiate(actor,{...body,kind:'commission_repayment'});}
  else if(method==='GET'&&/^\/api\/v1\/rider\/commissions\/payments\/[0-9a-f-]+$/.test(path)){
   check(actor?.kind==='rider',403,'Rider required');
   const intentId=path.split('/')[5];
   if(finance&&typeof finance.paymentStatus==='function'){
    result=await finance.paymentStatus(actor,intentId);
   }else{
    const row=(await db.query('SELECT id, provider, provider_reference, amount_minor, status, receipt_number, momo_network, momo_phone, confirmed_at, created_at FROM settlement_intents WHERE id=$1 AND rider_id=$2',[intentId,actor.id])).rows[0];
    check(row,404,'Settlement intent not found');
    result={...row,intentId:row.id,reference:row.provider_reference,amountMinor:Number(row.amount_minor)};
   }
  }
  else if(method==='POST'&&/^\/api\/v1\/rider\/commissions\/payments\/[0-9a-f-]+\/reconcile$/.test(path)){
   check(actor?.kind==='rider',403,'Rider required');check(finance,503);
   result=await finance.reconcileIntent(path.split('/')[5],{actor});
  }
  else if(method==='GET'&&path==='/api/v1/admin/rider-settlements'){
   const u=new URL(req.url,'http://localhost').searchParams;
   result=await getAdminSettlementOverview(db,{actor,filter:u.get('filter')||'all'});
  }
  else if(method==='POST'&&path==='/api/v1/admin/rider-settlements/reconcile'){
   check(actor?.kind==='admin',403,'Administrator required');
   check((await db.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission=ANY($2::text[])",[actor.id,['finance:configure','finance:approve']])).rowCount,403,'Finance permission required');
   if(finance&&typeof finance.reconcileDue==='function')await finance.reconcileDue({olderThanSeconds:0});
   result=await reconcileAndEnforceWeeklyRestrictions(db);
  }
  else if(method==='GET'&&path==='/api/v1/admin/rider-settlements/settings'){
   check(actor?.kind==='admin',403,'Administrator required');
   check((await db.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission=ANY($2::text[])",[actor.id,['finance:read','finance:approve','finance:configure']])).rowCount,403,'Finance permission required');
   result=await getWeeklySettlementSettings(db);
  }
  else if(method==='POST'&&path==='/api/v1/admin/rider-settlements/settings'){
   result=await updateWeeklySettlementSettings(db,actor,body);
  }
  else if(method==='POST'&&path==='/api/v1/rider/cash-report'){check(finance,503);result=await finance.reportCash(actor,body.shipmentId,{reportedMinor:body.reportedMinor,cashPayer:body.cashPayer,idempotencyKey:body.idempotencyKey});}
  else if(method==='GET'&&path==='/api/v1/admin/finance/aging'){check(finance,503);result=await finance.aging(actor);}
  else if(method==='GET'&&path==='/api/v1/admin/finance/settlement-exceptions'){check(finance,503);result=await finance.settlementExceptions(actor);}
  else if(method==='POST'&&/^\/api\/v1\/admin\/finance\/riders\/[0-9a-f-]+\/policy$/.test(path)){check(finance,503);result=await finance.policy(actor,path.split('/')[6],body);}
  else if(method==='GET'&&path==='/api/v1/admin/finance/adjustments'){check(finance,503);result=await finance.adjustmentQueue(actor);}
  else if(method==='POST'&&path==='/api/v1/admin/finance/adjustments'){check(finance,503);result=await finance.adjustmentRequest(actor,body);}
  else if(method==='POST'&&/^\/api\/v1\/admin\/finance\/adjustments\/[0-9a-f-]+\/approve$/.test(path)){check(finance,503);result=await finance.approveAdjustment(actor,path.split('/')[6]);}
  else if(method==='GET'&&path==='/api/v1/admin/review')result=await app.reviewQueue(actor);
  else if(method==='GET'&&path==='/api/v1/admin/system-health'){
   check(actor?.kind==='admin',403,'Administrator required');
   result=await getSystemHealthReport(db);
  }
  else if(method==='GET'&&path==='/api/v1/company/riders')result=await net.fleet(actor);
  else if(method==='POST'&&path==='/api/v1/company/invitations')result=await net.invite(actor,body);
  else if(method==='POST'&&path==='/api/v1/rider/invitations/accept')result=await net.acceptInvitation(actor,body);
  else if(method==='POST'&&/^\/api\/v1\/company\/riders\/[^/]+\/remove$/.test(path))result=await net.removeRider(actor,path.split('/')[5]);
  else if(method==='POST'&&path==='/api/v1/business/api-keys')result=await net.createKey(actor,body);
  else if(method==='POST'&&/^\/api\/v1\/business\/api-keys\/[^/]+\/revoke$/.test(path))result=await net.revokeKey(actor,path.split('/')[5]);
  else if(method==='GET'&&path==='/api/v1/admin/pricing')result=await app.getPricing(actor);
  else if(method==='POST'&&path==='/api/v1/admin/pricing/commission')result=await app.configureCommission(actor,body);
  else if(method==='POST'&&path==='/api/v1/admin/pricing')result=await app.setPricing(actor,body);
  else if(method==='POST'&&/^\/api\/v1\/admin\/(riders|companies)\/[^/]+$/.test(path)){const seg=path.split('/');check(Object.keys(body).length===1,400);result=await app.approve(actor,seg[4],seg[5],body.status);if(seg[4]==='riders'&&body.status!=='approved')disconnectRealtimeUser(seg[5],'account_'+body.status);}
   // Dynamic Commission Rules & Precedence Endpoints
   else if(method==='GET'&&path==='/api/v1/admin/commission/rules'){
     const u=new URL(req.url,'http://localhost').searchParams;
     result=await commissions.listRules(actor,{category:u.get('category'),scopeType:u.get('scopeType'),status:u.get('status')});
   }
   else if(method==='POST'&&path==='/api/v1/admin/commission/rules')result=await commissions.createRule(actor,body);
   else if(method==='POST'&&path==='/api/v1/admin/commission/founding-rider')result=await commissions.enrollFoundingRider(actor,body);
   else if(method==='POST'&&/^\/api\/v1\/admin\/commission\/rules\/[0-9a-f-]+\/pause$/.test(path))result=await commissions.pauseRule(actor,path.split('/')[6],body.rationale);
   else if(method==='POST'&&/^\/api\/v1\/admin\/commission\/rules\/[0-9a-f-]+\/resume$/.test(path))result=await commissions.resumeRule(actor,path.split('/')[6],body.rationale);
   else if(method==='POST'&&/^\/api\/v1\/admin\/commission\/rules\/[0-9a-f-]+\/revoke$/.test(path))result=await commissions.revokeRule(actor,path.split('/')[6],body.rationale);
   else if(method==='POST'&&/^\/api\/v1\/admin\/commission\/rules\/[0-9a-f-]+\/update$/.test(path))result=await commissions.updateRule(actor,path.split('/')[6],body);
   else if(method==='GET'&&path==='/api/v1/admin/commission/audit-logs'){
     const u=new URL(req.url,'http://localhost').searchParams;
     result=await commissions.getAuditLogs(actor,u.get('ruleId'));
   }
   else if(method==='GET'&&path==='/api/v1/admin/commission/restaurant-settings')result=await commissions.getRestaurantCommissionSettings(actor);
   else if(method==='POST'&&path==='/api/v1/admin/commission/restaurant-settings')result=await commissions.updateRestaurantCommissionSettings(actor,body);
   else if(method==='POST'&&/^\/api\/v1\/admin\/restaurants\/[0-9a-f-]+\/commission-agreement$/.test(path))result=await commissions.setRestaurantAgreement(actor,path.split('/')[5],body);
   else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/commission-preview$/.test(path))result=await commissions.previewRestaurantCommission(actor,{...body,restaurantId:path.split('/')[4]});
   // Promotions & Campaign Partnerships Endpoints
   else if(method==='GET'&&path==='/api/v1/admin/promotions'){
     const u=new URL(req.url,'http://localhost').searchParams;
     result=await promos.listAdminCampaigns(actor,{ownerType:u.get('ownerType'),status:u.get('status')});
   }
   else if(method==='POST'&&path==='/api/v1/admin/promotions')result=await promos.createAdminCampaign(actor,body);
   else if(method==='POST'&&/^\/api\/v1\/admin\/promotions\/[0-9a-f-]+\/invite-restaurants$/.test(path))result=await promos.inviteRestaurantsToCampaign(actor,path.split('/')[5],body);
   else if(method==='POST'&&/^\/api\/v1\/admin\/promotions\/[0-9a-f-]+\/status$/.test(path))result=await promos.setCampaignStatus(actor,path.split('/')[5],body);
   else if(method==='GET'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/promotions$/.test(path))result=await promos.listRestaurantCampaigns(actor,path.split('/')[4]);
   else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/promotions$/.test(path))result=await promos.createRestaurantCampaign(actor,path.split('/')[4],body);
   else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/promotions\/preview$/.test(path))result=await promos.previewCampaignFinancialImpact(actor,path.split('/')[4],body);
   else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/promotions\/[0-9a-f-]+\/status$/.test(path))result=await promos.setCampaignStatus(actor,path.split('/')[6],body);
   else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/promotions\/[0-9a-f-]+\/consent$/.test(path))result=await promos.respondToJointCampaignInvitation(actor,path.split('/')[4],path.split('/')[6],body);
   else if(method==='GET'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/promotions\/analytics$/.test(path))result=await promos.getRestaurantPromotionAnalytics(actor,path.split('/')[4]);
   else if(method==='GET'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/offers$/.test(path))result=await promos.getPublicPromotionsForRestaurant(path.split('/')[4]);
   // Order-Scoped Real-Time Chat & Messaging Endpoints
   else if(method==='GET'&&path==='/api/v1/chat/stream'){
     const u=new URL(req.url,'http://localhost').searchParams;
     const convId=u.get('conversationId');
     if(convId)await chat.authorizeConversationAccess(db,actor,convId,{supportJustification:u.get('justification')||'SSE stream'});
     res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});
     const expiresAt=actor?.expires_at?new Date(actor.expires_at).getTime():(actor?.expiresAt?new Date(actor.expiresAt).getTime():null);const conn={expiresAt,
       sessionToken:token||null,
       conversationIds:convId?new Set([convId]):new Set(),
       singleConversationId:convId||null,
       send(event,data){if(!res.writableEnded){const idLine=data?.eventId?`id: ${data.eventId}\n`:'';res.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);}},
       close(){if(!res.writableEnded)res.end();}
     };
     const unregister=registerRealtimeConnection(actor.id,conn,{expiresAt,deduplicate:true});
     req.on('close',unregister);
     conn.send('connected',{userId:actor.id,role:actor.kind,conversationId:convId||null});
     return;
   }
   else if(method==='POST'&&path==='/api/v1/chat/conversations')result=await chat.openOrCreateConversation(actor,body);
   else if(method==='GET'&&path==='/api/v1/chat/conversations'){
     const u=new URL(req.url,'http://localhost').searchParams;
     result=await chat.listMyConversations(actor,{shipmentId:u.get('shipmentId'),foodOrderId:u.get('foodOrderId'),restaurantId:u.get('restaurantId'),includeClosed:u.get('includeClosed')==='true'});
   }
   else if(method==='GET'&&/^\/api\/v1\/chat\/conversations\/[0-9a-f-]+\/messages$/.test(path)){
     const u=new URL(req.url,'http://localhost').searchParams;
     result=await chat.listMessages(actor,path.split('/')[5],{afterSeq:u.get('afterSeq'),beforeSeq:u.get('beforeSeq'),limit:u.get('limit'),supportJustification:u.get('justification')||req.headers['x-support-justification']||null});
   }
   else if(method==='POST'&&/^\/api\/v1\/chat\/conversations\/[0-9a-f-]+\/messages$/.test(path))result=await chat.sendMessage(actor,path.split('/')[5],body);
   else if(method==='POST'&&/^\/api\/v1\/chat\/conversations\/[0-9a-f-]+\/delivered$/.test(path))result=await chat.acknowledgeDelivered(actor,path.split('/')[5],body);
   else if(method==='POST'&&/^\/api\/v1\/chat\/conversations\/[0-9a-f-]+\/read$/.test(path))result=await chat.markRead(actor,path.split('/')[5],body);
   else if(method==='POST'&&/^\/api\/v1\/chat\/conversations\/[0-9a-f-]+\/typing$/.test(path))result=await chat.sendTypingIndicator(actor,path.split('/')[5],body);
   else if(method==='POST'&&/^\/api\/v1\/chat\/conversations\/[0-9a-f-]+\/mute$/.test(path))result=await chat.setConversationMute(actor,path.split('/')[5],body);
   else if(method==='POST'&&/^\/api\/v1\/chat\/conversations\/[0-9a-f-]+\/report$/.test(path))result=await chat.reportAbuse(actor,path.split('/')[5],body);
   else if(method==='POST'&&/^\/api\/v1\/chat\/conversations\/[0-9a-f-]+\/escalate$/.test(path))result=await chat.escalateToSupport(actor,path.split('/')[5],body);
   else if(method==='GET'&&path==='/api/v1/admin/chat/support-queue'){
     const u=new URL(req.url,'http://localhost').searchParams;
     result=await chat.listSupportQueue(actor,{status:u.get('status')});
   }
   else if(method==='POST'&&/^\/api\/v1\/admin\/chat\/abuse-reports\/[0-9a-f-]+\/moderate$/.test(path))result=await chat.moderateAbuseReport(actor,path.split('/')[6],body);
   else if(method==='GET'&&path==='/api/v1/admin/chat/policy')result=await chat.getMessagingPolicy(actor);
   else if(method==='POST'&&path==='/api/v1/admin/chat/policy')result=await chat.updateMessagingPolicy(actor,body);
  // Restaurant Marketplace Endpoints
  else if(method==='POST'&&path==='/api/v1/restaurants')result=await restaurants.createRestaurant(actor,body);
  else if(method==='GET'&&path==='/api/v1/restaurants'){
    const u=new URL(req.url,'http://localhost').searchParams;
    const isMine = u.get('mine')==='true' && ['business','admin'].includes(actor?.kind);
    result=await restaurants.listRestaurants({
      latitude:u.get('lat')?Number(u.get('lat')):null,
      longitude:u.get('lon')?Number(u.get('lon')):null,
      limit:u.get('limit')?Number(u.get('limit')):50,
      cuisine:u.get('cuisine'),
      search:u.get('q'),
      ownerId: isMine ? actor.id : null
    });
  }
  else if(method==='GET'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+$/.test(path))result=await restaurants.getRestaurant(path.split('/')[4]);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+$/.test(path))result=await restaurants.updateRestaurant(actor,path.split('/')[4],body);
  else if(method==='GET'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/menu$/.test(path))result=await restaurants.getMenu(path.split('/')[4]);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/categories$/.test(path))result=await restaurants.createCategory(actor,path.split('/')[4],body);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/categories\/[0-9a-f-]+$/.test(path))result=await restaurants.updateCategory(actor,path.split('/')[6],body,path.split('/')[4]);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/categories\/[0-9a-f-]+\/delete$/.test(path))result=await restaurants.deleteCategory(actor,path.split('/')[6],path.split('/')[4]);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/items$/.test(path))result=await restaurants.createMenuItem(actor,path.split('/')[4],body);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/items\/[0-9a-f-]+$/.test(path))result=await restaurants.updateMenuItem(actor,path.split('/')[6],body,path.split('/')[4]);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/items\/[0-9a-f-]+\/delete$/.test(path))result=await restaurants.deleteMenuItem(actor,path.split('/')[6],path.split('/')[4]);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/items\/[0-9a-f-]+\/modifiers$/.test(path))result=await restaurants.createModifier(actor,path.split('/')[6],body,path.split('/')[4]);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/modifiers\/[0-9a-f-]+\/options$/.test(path))result=await restaurants.createModifierOption(actor,path.split('/')[6],body,path.split('/')[4]);
  else if(method==='GET'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/settlements$/.test(path))result=await restOrders.getRestaurantSettlements(actor,path.split('/')[4]);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/batch-dispatch$/.test(path))result=await restOrders.evaluateBatchDispatch(actor,path.split('/')[4],body);
  // Food Ordering Endpoints
  else if(method==='POST'&&path==='/api/v1/food-orders/quote'){await limit(db,'quote:'+actor.id,30,60);result=await restOrders.quoteFoodOrder(actor,body);}
  else if(method==='POST'&&path==='/api/v1/food-orders')result=await restOrders.createFoodOrder(actor,body,{paymentMethod:body.paymentMethod,specialInstructions:body.specialInstructions,promoCode:body.promoCode,promoCodes:body.promoCodes,campaignIds:body.campaignIds,idempotencyKey:req.headers['idempotency-key']});
  else if(method==='GET'&&path==='/api/v1/food-orders'){
    const u=new URL(req.url,'http://localhost').searchParams;
    result=await restOrders.listFoodOrders(actor,{restaurantId:u.get('restaurantId'),state:u.get('state'),limit:u.get('limit')});
  }
  else if(method==='GET'&&/^\/api\/v1\/food-orders\/[0-9a-f-]+$/.test(path))result=await restOrders.getFoodOrder(actor,path.split('/')[4]);
  else if(method==='POST'&&/^\/api\/v1\/food-orders\/[0-9a-f-]+\/accept$/.test(path))result=await restOrders.acceptOrder(actor,path.split('/')[4],body);
  else if(method==='POST'&&/^\/api\/v1\/food-orders\/[0-9a-f-]+\/prepare$/.test(path))result=await restOrders.startPreparing(actor,path.split('/')[4]);
  else if(method==='POST'&&/^\/api\/v1\/food-orders\/[0-9a-f-]+\/ready$/.test(path))result=await restOrders.markReadyForPickup(actor,path.split('/')[4]);
  else if(method==='POST'&&/^\/api\/v1\/food-orders\/[0-9a-f-]+\/reject$/.test(path))result=await restOrders.rejectOrder(actor,path.split('/')[4],body);
  else if(method==='POST'&&/^\/api\/v1\/food-orders\/[0-9a-f-]+\/cancel$/.test(path))result=await restOrders.cancelOrder(actor,path.split('/')[4],body);
  else if(method==='POST'&&/^\/api\/v1\/food-orders\/[0-9a-f-]+\/resolve$/.test(path)){
   const orderId=path.split('/')[4];
   result=await restOrders.resolveOrder(actor,orderId,body);
   if(body?.action==='reassign'){
    const fo=(await db.query('SELECT shipment_id FROM food_orders WHERE id=$1',[orderId])).rows[0];
    if(fo?.shipment_id)await chat.revokeRiderConversations(db,{shipmentId:fo.shipment_id,reason:'food_order_reassigned'});
   }
  }
  else {
   const m=path.match(/^\/api\/v1\/shipments\/([^/]+)(?:\/(accept|pickup-challenge|delivery-challenge|verify|transition|location|tracking|dispatch|disputes))?$/);check(m,404,'Endpoint not found');const [,sid,action]=m;
   if(method==='GET'&&!action)result=await app.get(actor,sid);
   else if(method==='GET'&&action==='tracking')result=await app.tracking(actor,sid);
   else if(method==='GET'&&action==='dispatch'){const shipment=await app.get(actor,sid);result={shipmentId:sid,state:shipment.state,confirmedRider:!!shipment.rider_id,guaranteed:!!shipment.rider_id,attempts:shipment.dispatch_attempts,dispatchStatus:shipment.state==='AWAITING_ASSIGNMENT'?'searching_or_awaiting_offer':shipment.state};}
   else if(method==='POST'&&action==='accept')result=await app.accept(actor,sid,body.offerId);
   else if(method==='POST'&&action==='pickup-challenge')result=await app.challenge(actor,sid,'pickup');
   else if(method==='POST'&&action==='delivery-challenge')result=await app.challenge(actor,sid,'delivery');
   else if(method==='POST'&&action==='verify')result=await app.verify(actor,sid,body);
   else if(method==='POST'&&action==='transition')result=await app.transition(actor,sid,body);
   else if(method==='POST'&&action==='location')result=await app.location(actor,sid,body);
   else if(method==='POST'&&action==='disputes')result=await app.dispute(actor,sid,body);
   else check(false,404,'Endpoint not found');
  }send(200,result);
 }catch(e){const status=e instanceof ZodError?400:e.status??(e.code==='23505'?409:500);
  const clientError=status===500?'Internal server error':e.code==='23505'?'Unique resource already exists':e instanceof ZodError?'Invalid input':e.message;
  send(status,{error:clientError});
  if(status===500)process.stderr.write(JSON.stringify({level:'error',code:e.code??'internal',time:new Date().toISOString()})+'\n');
 }
});
  server.on('upgrade',async(req,socket,head)=>{
    try{
      const u=new URL(req.url,'http://localhost');
      if(u.pathname!=='/api/v1/chat/ws'){socket.write('HTTP/1.1 404 Not Found\r\n\r\n');socket.destroy();return;}
      const token=req.headers.authorization?.replace(/^Bearer /,'')||u.searchParams.get('token');
      if(!token){socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');socket.destroy();return;}
      const actor=token.startsWith('es_live_')?await net.authenticateKey(token):await app.authenticate(token);
      const initialConvId=u.searchParams.get('conversationId');
      if(initialConvId){
        await chat.authorizeConversationAccess(db,actor,initialConvId,{supportJustification:u.searchParams.get('justification')||'WebSocket subscription'});
      }
      const expiresAt=actor?.expires_at?new Date(actor.expires_at).getTime():(actor?.expiresAt?new Date(actor.expiresAt).getTime():null);upgradeToChatWebSocket(req,socket,head,{expiresAt,
        actor,
        sessionToken:token,
        initialConversationId:initialConvId||null,
        onClientMessage:async(msg,conn)=>{
          let liveActor;
          try{
            liveActor=token.startsWith('es_live_')?await net.authenticateKey(token):await app.authenticate(token);
          }catch{
            conn.send('session.revoked',{reason:'unauthorized',timestamp:new Date().toISOString()});
            conn.close();
            return;
          }
          const action=msg?.action;
          const convId=msg?.conversationId||initialConvId;
          if(action==='subscribe'){
            check(convId,400,'conversationId required');
            await chat.authorizeConversationAccess(db,liveActor,convId,{supportJustification:msg.justification||'WebSocket subscribe'});
            conn.conversationIds.add(convId);
            conn.send('subscribed',{conversationId:convId});
          }else if(action==='send'){
            check(convId,400,'conversationId required');
            const sent=await chat.sendMessage(liveActor,convId,{
              clientMessageId:msg.clientMessageId,
              messageType:msg.messageType||'text',
              body:msg.body,
              quickReplyKey:msg.quickReplyKey,
              locationPin:msg.locationPin
            });
            conn.send('ack',{requestId:msg.requestId||null,message:sent});
          }else if(action==='typing'){
            check(convId,400,'conversationId required');
            await chat.sendTypingIndicator(liveActor,convId,{isTyping:Boolean(msg.isTyping)});
          }else if(action==='delivered'){
            check(convId,400,'conversationId required');
            await chat.acknowledgeDelivered(liveActor,convId,{upToSeq:msg.upToSeq});
          }else if(action==='read'){
            check(convId,400,'conversationId required');
            await chat.markRead(liveActor,convId,{upToSeq:msg.upToSeq});
          }
        }
      });
    }catch(err){
      const code=err?.status===403?'403 Forbidden':err?.status===404?'404 Not Found':'401 Unauthorized';
      try{socket.write(`HTTP/1.1 ${code}\r\n\r\n`);socket.destroy();}catch{}
    }
  });
  return server;
}
