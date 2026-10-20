import {createServer} from 'node:http';
import {ZodError} from 'zod';
import {check,limit,equal} from './security.mjs';
import {network} from './network.mjs';
import {vehicleService} from './vehicle.mjs';
import {clientIp,resolveVerifiedHost} from './client-ip.mjs';
import {marketService} from './markets.mjs';
import {ghanaSearch,ghanaReverseGeocode} from './infrastructure/maps/ghana-geocoder.mjs';
import {getPublicTracking,renderTrackingHtml} from './infrastructure/maps/web-tracker.mjs';
import {renderAdminPortalHtml} from './admin-web/admin-portal.mjs';
import {restaurantService} from './restaurant.mjs';
import {restaurantOrderService} from './restaurant-orders.mjs';
import {commissionEngine} from './commission-engine.mjs';
export function httpServer(db,app,dispatcher,finance,checkout=null,{ghanaPostGps=null,restaurant=null,restaurantOrders=null}={}){
  const net=network(db),vehicles=vehicleService(db),markets=marketService(db);
  const restaurants=restaurant||restaurantService(db);
  const restOrders=restaurantOrders||restaurantOrderService(db,{platform:app,dispatcher,routing:app?.routing});
  const commissions=commissionEngine(db);
  return createServer({headersTimeout:5000,requestTimeout:20000,maxHeaderSize:8192},async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Content-Security-Policy',"default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
 const send=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
 try{
  const path=new URL(req.url,'http://localhost').pathname,method=req.method;

  if(method==='OPTIONS'){
   res.setHeader('Access-Control-Allow-Origin','*');
   res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
   res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, Idempotency-Key');
   res.writeHead(204).end();return;
  }
  if(path==='/health'&&method==='GET'){send(200,{status:'alive',service:'elesend'});return;}
  if(path==='/ready'&&method==='GET'){
   const secret=process.env.READINESS_PROBE_TOKEN;
   check(secret&&secret.length>=32&&equal(req.headers['x-elesend-health-token'],secret),404,'Endpoint not found');
   await db.query('SELECT 1');send(200,{status:'ready'});return;
  }
  await limit(db,'http:'+clientIp(req),300,60);
  if(method==='GET'&&/^\/track\/[0-9a-f-]{36}$/i.test(path)){
   const data=await getPublicTracking(db,path.split('/')[2]);
   if(!data){res.writeHead(404,{'Content-Type':'text/html'});res.end('<!DOCTYPE html><html><body style="background:#0c1324;color:#fff;font-family:sans-serif;padding:30px;text-align:center;"><h2>Tracking link not found or expired</h2></body></html>');return;}
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(renderTrackingHtml(data));return;
  }
  if(method==='GET'&&/^\/api\/v1\/public-track\/[0-9a-f-]{36}$/i.test(path)){
   const data=await getPublicTracking(db,path.split('/')[4]);
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
  if(!path.startsWith('/api/v1/'))check(false,404,'Endpoint not found');
  let body={},rawBody=Buffer.alloc(0);if(method==='POST'){
   check((req.headers['content-type']??'').split(';')[0]==='application/json',415,'JSON required');let size=0;const parts=[];
   for await(const part of req.iterator({destroyOnReturn:false})){size+=part.length;if(size>32768){res.setHeader('Connection','close');req.resume();check(false,413,'Request too large');}parts.push(part);}
   rawBody=Buffer.concat(parts);try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rawBody)||'{}');}catch{check(false,400,'Invalid JSON');}
  }
  if(method==='POST'&&path==='/api/v1/payments/checkout-webhook'){
   check(checkout,503,'Checkout unavailable');send(200,await checkout.webhook(rawBody,req.headers));return;
  }
  if(method==='POST'&&path==='/api/v1/payments/commission-webhook'){
   check(finance,503,'Commission settlement unavailable');
   send(200,await finance.handleWebhook(rawBody,req.headers));return;
  }
  if(method==='POST'&&path==='/api/v1/auth/register'){await limit(db,'registration-ip:'+clientIp(req),12,3600);send(201,await app.register(body));return;}
  if(method==='POST'&&path==='/api/v1/auth/login'){await limit(db,'login-ip:'+clientIp(req),40,900);send(200,await app.login(body));return;}
  const token=req.headers.authorization?.replace(/^Bearer /,'');const actor=token?.startsWith('es_live_')?await net.authenticateKey(token):await app.authenticate(token);
  net.authorizeKey(actor,method,path);
  await limit(db,'user:'+actor.id,150,60);
  if(path.startsWith('/api/v1/admin/'))check(actor?.kind==='admin',403,'Administrator required');
  let result;
  if(method==='POST'&&path==='/api/v1/auth/logout')result=await app.logout(token);
  else if(method==='GET'&&path==='/api/v1/me/phone')result=await app.phoneStatus(actor);
  else if(method==='POST'&&path==='/api/v1/me/phone-challenge')result=await app.phoneChallenge(actor);
  else if(method==='POST'&&path==='/api/v1/me/phone-verify')result=await app.verifyPhone(actor,body);
  else if(method==='GET'&&path==='/api/v1/payments/methods'){check(checkout,503);result=await checkout.methods();}
  else if(method==='GET'&&path==='/api/v1/admin/payments/methods'){check(checkout,503);check(actor.kind==='admin',403);result=await checkout.methods();}
  else if(method==='POST'&&path==='/api/v1/admin/payments/methods'){check(checkout,503);result=await checkout.configure(actor,body);}
  else if(method==='GET'&&path==='/api/v1/admin/payments/exceptions'){check(checkout,503);result=await checkout.exceptionQueue(actor);}
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
  else if(method==='POST'&&path==='/api/v1/quotes')result=await app.quote(actor,body);
  else if(method==='POST'&&path==='/api/v1/calculate-fare')result=await app.quote(actor,body);
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
  else if(method==='POST'&&path==='/api/v1/rider/assignments/release'){check(dispatcher,503);result=await dispatcher.release(actor,body.shipmentId,body.reason);}
  else if(method==='POST'&&path==='/api/v1/delivery/availability'){check(dispatcher,503,'Dispatch unavailable');check(['customer','business'].includes(actor.kind),403);result=await dispatcher.availability(body);}
  else if(method==='GET'&&path==='/api/v1/admin/dispatch-policy'){check(dispatcher,503);result=await dispatcher.getPolicy(actor);}
  else if(method==='POST'&&path==='/api/v1/admin/dispatch-policy'){check(dispatcher,503);result=await dispatcher.configure(actor,body);}
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
  else if(method==='POST'&&path==='/api/v1/rider/cash-report'){check(finance,503);result=await finance.reportCash(actor,body.shipmentId,{reportedMinor:body.reportedMinor,cashPayer:body.cashPayer,idempotencyKey:body.idempotencyKey});}
  else if(method==='GET'&&path==='/api/v1/admin/finance/aging'){check(finance,503);result=await finance.aging(actor);}
  else if(method==='POST'&&/^\/api\/v1\/admin\/finance\/riders\/[0-9a-f-]+\/policy$/.test(path)){check(finance,503);result=await finance.policy(actor,path.split('/')[6],body);}
  else if(method==='GET'&&path==='/api/v1/admin/finance/adjustments'){check(finance,503);result=await finance.adjustmentQueue(actor);}
  else if(method==='POST'&&path==='/api/v1/admin/finance/adjustments'){check(finance,503);result=await finance.adjustmentRequest(actor,body);}
  else if(method==='POST'&&/^\/api\/v1\/admin\/finance\/adjustments\/[0-9a-f-]+\/approve$/.test(path)){check(finance,503);result=await finance.approveAdjustment(actor,path.split('/')[6]);}
  else if(method==='GET'&&path==='/api/v1/admin/review')result=await app.reviewQueue(actor);
  else if(method==='GET'&&path==='/api/v1/company/riders')result=await net.fleet(actor);
  else if(method==='POST'&&path==='/api/v1/company/invitations')result=await net.invite(actor,body);
  else if(method==='POST'&&path==='/api/v1/rider/invitations/accept')result=await net.acceptInvitation(actor,body);
  else if(method==='POST'&&/^\/api\/v1\/company\/riders\/[^/]+\/remove$/.test(path))result=await net.removeRider(actor,path.split('/')[5]);
  else if(method==='POST'&&path==='/api/v1/business/api-keys')result=await net.createKey(actor,body);
  else if(method==='POST'&&/^\/api\/v1\/business\/api-keys\/[^/]+\/revoke$/.test(path))result=await net.revokeKey(actor,path.split('/')[5]);
  else if(method==='GET'&&path==='/api/v1/admin/pricing')result=await app.getPricing(actor);
  else if(method==='POST'&&path==='/api/v1/admin/pricing/commission')result=await app.configureCommission(actor,body);
  else if(method==='POST'&&path==='/api/v1/admin/pricing')result=await app.setPricing(actor,body);
  else if(method==='POST'&&/^\/api\/v1\/admin\/(riders|companies)\/[^/]+$/.test(path)){const seg=path.split('/');check(Object.keys(body).length===1,400);result=await app.approve(actor,seg[4],seg[5],body.status);}
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
  // Restaurant Marketplace Endpoints
  else if(method==='POST'&&path==='/api/v1/restaurants')result=await restaurants.createRestaurant(actor,body);
  else if(method==='GET'&&path==='/api/v1/restaurants'){
    const u=new URL(req.url,'http://localhost').searchParams;
    result=await restaurants.listRestaurants({
      latitude:u.get('lat')?Number(u.get('lat')):null,
      longitude:u.get('lon')?Number(u.get('lon')):null,
      limit:u.get('limit')?Number(u.get('limit')):50,
      cuisine:u.get('cuisine'),
      search:u.get('q')
    });
  }
  else if(method==='GET'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+$/.test(path))result=await restaurants.getRestaurant(path.split('/')[4]);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+$/.test(path))result=await restaurants.updateRestaurant(actor,path.split('/')[4],body);
  else if(method==='GET'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/menu$/.test(path))result=await restaurants.getMenu(path.split('/')[4]);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/categories$/.test(path))result=await restaurants.createCategory(actor,path.split('/')[4],body);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/categories\/[0-9a-f-]+$/.test(path))result=await restaurants.updateCategory(actor,path.split('/')[6],body);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/categories\/[0-9a-f-]+\/delete$/.test(path))result=await restaurants.deleteCategory(actor,path.split('/')[6]);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/items$/.test(path))result=await restaurants.createMenuItem(actor,path.split('/')[4],body);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/items\/[0-9a-f-]+$/.test(path))result=await restaurants.updateMenuItem(actor,path.split('/')[6],body);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/items\/[0-9a-f-]+\/delete$/.test(path))result=await restaurants.deleteMenuItem(actor,path.split('/')[6]);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/items\/[0-9a-f-]+\/modifiers$/.test(path))result=await restaurants.createModifier(actor,path.split('/')[6],body);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/modifiers\/[0-9a-f-]+\/options$/.test(path))result=await restaurants.createModifierOption(actor,path.split('/')[6],body);
  else if(method==='GET'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/settlements$/.test(path))result=await restOrders.getRestaurantSettlements(actor,path.split('/')[4]);
  else if(method==='POST'&&/^\/api\/v1\/restaurants\/[0-9a-f-]+\/batch-dispatch$/.test(path))result=await restOrders.evaluateBatchDispatch(actor,path.split('/')[4],body);
  // Food Ordering Endpoints
  else if(method==='POST'&&path==='/api/v1/food-orders/quote')result=await restOrders.quoteFoodOrder(actor,body);
  else if(method==='POST'&&path==='/api/v1/food-orders')result=await restOrders.createFoodOrder(actor,body,{paymentMethod:body.paymentMethod,specialInstructions:body.specialInstructions});
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
});}
