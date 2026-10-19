import {database} from './db.mjs';
import {platform} from './platform.mjs';
import {httpServer} from './http.mjs';
import {dispatchEngine} from './dispatch.mjs';
import {osrmRouting} from './dispatch-routing.mjs';
import {privateRoutingPriority} from './infrastructure/maps/PrivateRoutingPolicy.mjs';
import {configuredGhanaPostGps} from './providers/ghanapostgps.mjs';
import {financeService} from './finance.mjs';
import {checkoutService} from './checkout.mjs';
import {paystackCheckout} from './paystack-checkout-adapter.mjs';
import {httpsSmsGateway} from './sms-gateway.mjs';
if(process.env.NODE_ENV==='production'){
 if(!/^[a-fA-F0-9]{64}$/.test(process.env.ADMIN_MFA_ENCRYPTION_KEY??''))throw Error('Production requires a 32-byte admin MFA encryption key');
 if(process.env.ADMIN_MFA_ENCRYPTION_KEY.toLowerCase()===(process.env.OTP_KEY??'').toLowerCase())throw Error('OTP and admin MFA master keys must be independent');
}
const db=database();await db.query('SELECT 1');
// Only self-hosted OSRM is registered; paid routing keys cannot become a fallback.
privateRoutingPriority();
const routing=process.env.ROUTING_OSRM_URL?osrmRouting({endpoint:process.env.ROUTING_OSRM_URL,profiles:JSON.parse(process.env.ROUTING_OSRM_PROFILES_JSON??'{"car":"driving"}') }):null;
// Routing absence disables quote and dispatch, not authentication/history.
const dispatch=routing?dispatchEngine(db,{routing}):null;
const sms=process.env.SMS_GATEWAY_ENDPOINT?httpsSmsGateway({endpoint:process.env.SMS_GATEWAY_ENDPOINT,allowedHost:process.env.SMS_GATEWAY_ALLOWED_HOST,token:process.env.SMS_GATEWAY_TOKEN}):null;
const app=platform(db,{otpKey:process.env.OTP_KEY,routing,dispatch,sms});
const paymentProvider=process.env.PAYSTACK_SECRET_KEY?paystackCheckout({secretKey:process.env.PAYSTACK_SECRET_KEY,allowedMethods:(process.env.PAYSTACK_ENABLED_METHODS??'MOMO,CARD').split(',').map(s=>s.trim())}):null;
const finance=financeService(db,{provider:paymentProvider});
const checkout=checkoutService(db,{provider:paymentProvider});
const server=httpServer(db,app,dispatch,finance,checkout,{ghanaPostGps:configuredGhanaPostGps()});
const port=Number(process.env.PORT??3090);
server.listen(port,process.env.HOST??'127.0.0.1',()=>console.log(`ELESEND listening port ${port}; dispatch ${dispatch?'enabled':'disabled'}; SMS ${sms?'configured':'disabled'}; digital checkout ${paymentProvider?'configured':'disabled'}`));
// Polling worker is safe under multiple processes: PostgreSQL unique indexes,
// row locks and rejection of expired offers arbitrate every assignment.
const polling=dispatch?setInterval(()=>dispatch.tick().then(rows=>{const errors=rows.filter(r=>r.status==='error');if(errors.length)process.stderr.write(JSON.stringify({level:'warn',component:'dispatch',errors})+'\n');}).catch(e=>process.stderr.write(JSON.stringify({level:'error',component:'dispatch',code:e.code??'internal'})+'\n')),3000):null;
polling?.unref();
const paymentRecon=paymentProvider?setInterval(()=>checkout.reconcileDue().then(r=>{const problems=r.filter(x=>x.errorCode);if(problems.length)process.stderr.write(JSON.stringify({level:'warn',component:'payment_reconciliation',problems})+'\n');}).catch(e=>process.stderr.write(JSON.stringify({level:'error',component:'payment_reconciliation',code:e.code??'internal'})+'\n')),120000):null;paymentRecon?.unref();
const pruning=dispatch?setInterval(()=>dispatch.pruneSamples().catch(e=>process.stderr.write(JSON.stringify({level:'error',component:'location_retention',code:e.code??'internal'})+'\n')),3600000):null;pruning?.unref();
const corridors=dispatch?setInterval(()=>dispatch.refreshCorridors().catch(e=>process.stderr.write(JSON.stringify({level:'warn',component:'corridor_refresh',code:e.code??'unavailable'})+'\n')),60000):null;corridors?.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(polling)clearInterval(polling);if(paymentRecon)clearInterval(paymentRecon);if(pruning)clearInterval(pruning);if(corridors)clearInterval(corridors);server.close(async()=>{await db.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();});
