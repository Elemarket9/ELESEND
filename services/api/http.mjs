import {createServer} from 'node:http';
import {ZodError} from 'zod';
import {check,limit,equal} from './security.mjs';
import {network} from './network.mjs';
import {vehicleService} from './vehicle.mjs';
import {clientIp} from './client-ip.mjs';
import {marketService} from './markets.mjs';
export function httpServer(db,app,dispatcher,finance,checkout=null){const net=network(db),vehicles=vehicleService(db),markets=marketService(db);return createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
 const send=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
 try{
  const path=new URL(req.url,'http://localhost').pathname,method=req.method;

  if(path==='/health'&&method==='GET'){send(200,{status:'alive',service:'elesend'});return;}
  if(path==='/ready'&&method==='GET'){
   const secret=process.env.READINESS_PROBE_TOKEN;
   check(secret&&secret.length>=32&&equal(req.headers['x-elesend-health-token'],secret),404,'Endpoint not found');
   await db.query('SELECT 1');send(200,{status:'ready'});return;
  }
  await limit(db,'http:'+clientIp(req),300,60);
  let body={},rawBody=Buffer.alloc(0);if(method==='POST'){
   check((req.headers['content-type']??'').split(';')[0]==='application/json',415,'JSON required');let size=0;const parts=[];
   for await(const part of req){size+=part.length;check(size<=32768,413,'Request too large');parts.push(part);}
   rawBody=Buffer.concat(parts);try{body=JSON.parse(rawBody.toString()||'{}');}catch{check(false,400,'Invalid JSON');}
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
  else if(method==='POST'&&path==='/api/v1/quotes')result=await app.quote(actor,body);
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
  else if(method==='POST'&&path==='/api/v1/admin/pricing')result=await app.setPricing(actor,body);
  else if(method==='POST'&&/^\/api\/v1\/admin\/(riders|companies)\/[^/]+$/.test(path)){const seg=path.split('/');check(Object.keys(body).length===1,400);result=await app.approve(actor,seg[4],seg[5],body.status);}
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
 }catch(e){const status=e instanceof ZodError?400:e.status??(e.code==='23505'?409:500);send(status,{error:status===500?'Internal server error':e instanceof ZodError?'Invalid input':e.message});
  if(status===500)process.stderr.write(JSON.stringify({level:'error',code:e.code??'internal',time:new Date().toISOString()})+'\n');
 }
});}
