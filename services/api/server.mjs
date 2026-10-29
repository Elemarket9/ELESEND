import {createPaymentProvider,paymentWebhook} from './payment-provider.mjs';
import {assertRequiredSchema,assertPaymentOperations} from './startup-guards.mjs';
import {moneyOperations} from './money-operations.mjs';
import {database} from './db.mjs';
import {platform} from './platform.mjs';
import {httpServer} from './http.mjs';
import {dispatchEngine} from './dispatch.mjs';
import {osrmRouting} from './dispatch-routing.mjs';
import {privateRoutingPriority} from './infrastructure/maps/PrivateRoutingPolicy.mjs';
import {configuredGhanaPostGps} from './providers/ghanapostgps.mjs';
import {financeService} from './finance.mjs';
import {checkoutService} from './checkout.mjs';
import {httpsSmsGateway} from './sms-gateway.mjs';
import {hubtelSmsGateway} from './providers/hubtel-sms.mjs';
import {restaurantOrderService} from './restaurant-orders.mjs';
import {enforcePatchedNodeRuntime} from './runtime-enforce.mjs';
import {reconcileAndEnforceWeeklyRestrictions} from './weekly-settlement.mjs';
import {loadConfig} from './config.mjs';
import {notificationGateway,notificationWorker} from './notifications.mjs';
import {backgroundJobs} from './background-jobs.mjs';

enforcePatchedNodeRuntime();
const config = loadConfig(process.env);

const db = database(config.database.url, config.database.ssl);
await db.query('SELECT 1');
await assertRequiredSchema(db);
await reconcileAndEnforceWeeklyRestrictions(db).catch(e=>process.stderr.write(JSON.stringify({level:'warn',component:'weekly_settlement_boot',code:e.code??'internal'})+'\n'));

// Only self-hosted OSRM is registered; paid routing keys cannot become a fallback.
privateRoutingPriority();
const routing = (config.routing.vehicleRoutes || config.routing.osrmUrl)
  ? osrmRouting({
      endpoint: config.routing.osrmUrl,
      profiles: config.routing.profiles,
      vehicleRoutes: config.routing.vehicleRoutes
    })
  : null;

// Routing absence disables quote and dispatch, not authentication/history.
const dispatch = routing ? dispatchEngine(db, {routing}) : null;

const sms = config.sms.provider === 'hubtel' && config.sms.hubtel
  ? hubtelSmsGateway(config.sms.hubtel)
  : config.sms.provider === 'https_gateway' && config.sms.httpsGateway
  ? httpsSmsGateway(config.sms.httpsGateway)
  : null;

const notifications=notificationWorker(db,{transport:config.notifications.endpoint?notificationGateway(config.notifications):null,sms});

const app = platform(db, {
  otpKey: config.security.otpKey,
  routing,
  dispatch,
  sms
});

const paymentProvider=createPaymentProvider(config.payment);
assertPaymentOperations(paymentProvider,{production:config.isProduction});
const finance=financeService(db,{provider:paymentProvider});
const checkout=checkoutService(db,{provider:paymentProvider,sms,dispatch,routing});
const money=moneyOperations(db,{provider:paymentProvider});
const restOrders = restaurantOrderService(db, {platform: app, dispatcher: dispatch, routing, sms, ...config.food});

const scheduler = config.server.backgroundJobsEnabled
  ? backgroundJobs({db,dispatch,notifications,restOrders,money,checkout,finance,paymentProvider}).start({unref:true})
  : null;

const server = httpServer(db, app, dispatch, finance, checkout, {
  ghanaPostGps: configuredGhanaPostGps(),
  restaurantOrders: restOrders,
  paymentsWebhook:paymentWebhook({db,provider:paymentProvider,checkout,finance,money,moneyOperations:money}),
  moneyOperations:money
});

const port = config.server.port;
const host = config.server.host;
server.listen(port, host, () => console.log(`ELESEND listening on ${host}:${port}; dispatch ${dispatch?'enabled':'disabled'}; SMS ${sms?'configured':'disabled'}; digital checkout ${paymentProvider?'configured':'disabled'}; background jobs ${config.server.backgroundJobsEnabled?'enabled':'disabled'}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    scheduler?.stop();
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
