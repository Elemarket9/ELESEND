import {createPaymentProvider,paymentWebhook} from './modules/payments/index.mjs';
import {assertRequiredSchema,assertPaymentOperations,warnIfOwnerDatabaseLogin} from './shared/startup-guards.mjs';
import {moneyOperations} from './modules/payments/index.mjs';
import {database} from './shared/db.mjs';
import {platform,warnPlaceholderTariffs} from './modules/orders/index.mjs';
import {httpServer} from './http.mjs';
import {dispatchEngine} from './modules/orders/index.mjs';
import {createRouting} from './modules/maps/index.mjs';
import {configuredGhanaPostGps} from './modules/maps/index.mjs';
import {financeService} from './modules/payments/index.mjs';
import {checkoutService} from './modules/payments/index.mjs';
import {httpsSmsGateway} from './shared/sms-gateway.mjs';
import {hubtelSmsGateway} from './shared/providers/hubtel-sms.mjs';
import {restaurantOrderService} from './modules/food/index.mjs';
import {enforcePatchedNodeRuntime} from './shared/runtime-enforce.mjs';
import {reconcileAndEnforceWeeklyRestrictions} from './modules/payments/index.mjs';
import {loadConfig} from './config.mjs';
import {notificationGateway,notificationWorker,queueNotification} from './modules/orders/index.mjs';
import {backgroundJobs} from './background-jobs.mjs';
import {firebasePush} from './modules/orders/index.mjs';
import {etaService} from './modules/orders/index.mjs';
import {trafficRouting,trafficService} from './modules/maps/index.mjs';
import {installProcessGuards} from './shared/process-guards.mjs';

installProcessGuards('api');
enforcePatchedNodeRuntime();
const config = loadConfig(process.env);

const db = database(config.database.url, config.database.ssl);
await db.query('SELECT 1');
await assertRequiredSchema(db);
await warnPlaceholderTariffs(db);
await warnIfOwnerDatabaseLogin(db,{production:process.env.NODE_ENV==='production'});
await reconcileAndEnforceWeeklyRestrictions(db).catch(e=>process.stderr.write(JSON.stringify({level:'warn',component:'weekly_settlement_boot',code:e.code??'internal'})+'\n'));

// Self-hosted OSRM unless ROUTING_PROVIDER_PRIORITY=google is chosen; never a silent fallback between them.
const routing = createRouting(config);

// Routing absence disables quote and dispatch, not authentication/history.
const dispatch = routing ? dispatchEngine(db, {routing}) : null;

const sms = config.sms.provider === 'hubtel' && config.sms.hubtel
  ? hubtelSmsGateway(config.sms.hubtel)
  : config.sms.provider === 'https_gateway' && config.sms.httpsGateway
  ? httpsSmsGateway(config.sms.httpsGateway)
  : null;

const notifications=notificationWorker(db,{transport:config.notifications.firebaseAccount?firebasePush(config.notifications.firebaseAccount):config.notifications.endpoint?notificationGateway(config.notifications):null,sms});

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
const money=moneyOperations(db,{provider:paymentProvider,notify:queueNotification});
const restOrders = restaurantOrderService(db, {platform: app, dispatcher: dispatch, routing, sms, ...config.food});

const scheduler = config.server.backgroundJobsEnabled
  ? backgroundJobs({db,dispatch,notifications,restOrders,money,checkout,finance,paymentProvider,routing,eta:etaService(db,{routing:trafficRouting(routing,trafficService(db)),baselineFactors:config.routing.etaBaselineFactors})}).start({unref:true})
  : null;

const server = httpServer(db, app, dispatch, finance, checkout, {
  ghanaPostGps: configuredGhanaPostGps(),
  restaurantOrders: restOrders,
  paymentsWebhook:paymentWebhook({db,provider:paymentProvider,checkout,finance,money,moneyOperations:money}),
  moneyOperations:money,
  etaBaselineFactors:config.routing.etaBaselineFactors
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
    server.closeIdleConnections();
    // Chat streams never finish by themselves, so end them while there is still time to exit cleanly.
    setTimeout(() => server.closeAllConnections(), 5000).unref();
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
