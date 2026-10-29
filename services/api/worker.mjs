/**
 * ELESEND Dedicated Background Worker Service
 * 
 * Runs background dispatch ticks, notification retries, corridor refreshes,
 * payment reconciliation, sample pruning, and maintenance in a dedicated process.
 * 
 * In multi-instance production environments, run this as a standalone background
 * worker separate from stateless HTTP API instances.
 */

import { database } from './db.mjs';
import {assertRequiredSchema,assertPaymentOperations} from './startup-guards.mjs';
import { loadConfig } from './config.mjs';
import { dispatchEngine } from './dispatch.mjs';
import { osrmRouting } from './dispatch-routing.mjs';
import { privateRoutingPriority } from './infrastructure/maps/PrivateRoutingPolicy.mjs';
import { financeService } from './finance.mjs';
import { checkoutService } from './checkout.mjs';
import { moneyOperations } from './money-operations.mjs';
import { platform } from './platform.mjs';
import { restaurantOrderService } from './restaurant-orders.mjs';
import { reconcileAndEnforceWeeklyRestrictions } from './weekly-settlement.mjs';
import { createPaymentProvider } from './payment-provider.mjs';
import { hubtelSmsGateway } from './providers/hubtel-sms.mjs';
import { httpsSmsGateway } from './sms-gateway.mjs';
import { notificationGateway, notificationWorker } from './notifications.mjs';
import { enforcePatchedNodeRuntime } from './runtime-enforce.mjs';
import { backgroundJobs, LOCKS, withAdvisoryLock as sharedAdvisoryLock } from './background-jobs.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Advisory lock IDs to coordinate background jobs across multiple instances
export const LOCK_ID_DISPATCH_PRUNING = LOCKS.dispatchPruning;
export const LOCK_ID_CORRIDORS = LOCKS.corridors;
export const LOCK_ID_PAYMENT_RECON = LOCKS.paymentRecon;
export const LOCK_ID_FOOD_MAINTENANCE = LOCKS.foodExpiry;
export const LOCK_ID_MAINTENANCE = LOCKS.maintenance;
export const LOCK_ID_MONEY_RECON = LOCKS.moneyRecon;

export async function withAdvisoryLock(db, lockId, task) {
  return sharedAdvisoryLock(db, lockId, task);
}

export async function startWorker(options = {}) {
  enforcePatchedNodeRuntime();
  const config = options.config || loadConfig(process.env, { strict: process.env.NODE_ENV === 'production' });
  const db = options.db || database(config.database.url, config.database.ssl);
  if (!options.skipPing) {
    await db.query('SELECT 1');
  }
  await assertRequiredSchema(db);

  privateRoutingPriority();
  const routing = options.routing || ((config.routing.vehicleRoutes || config.routing.osrmUrl)
    ? osrmRouting({
        endpoint: config.routing.osrmUrl,
        profiles: config.routing.profiles,
        vehicleRoutes: config.routing.vehicleRoutes
      })
    : null);

  const dispatch = options.dispatch || (routing ? dispatchEngine(db, { routing }) : null);

  const sms = options.sms || (config.sms.provider === 'hubtel' && config.sms.hubtel
    ? hubtelSmsGateway(config.sms.hubtel)
    : config.sms.provider === 'https_gateway' && config.sms.httpsGateway
    ? httpsSmsGateway(config.sms.httpsGateway)
    : null);

  const notifications = options.notifications || notificationWorker(db, {
    transport: config.notifications.endpoint ? notificationGateway(config.notifications) : null,
    sms
  });

  const app = options.app || platform(db, {
    otpKey: config.security.otpKey,
    routing,
    dispatch,
    sms
  });

  const paymentProvider = options.paymentProvider || createPaymentProvider(config.payment);
  assertPaymentOperations(paymentProvider,{production:config.isProduction});
  const finance = options.finance || financeService(db, { provider: paymentProvider });
  const checkout = options.checkout || checkoutService(db, { provider: paymentProvider });
  const money = options.money || moneyOperations(db, { provider: paymentProvider });
  const restOrders = options.restOrders || restaurantOrderService(db, { platform: app, dispatcher: dispatch, routing, ...config.food });

  console.log(JSON.stringify({
    level: 'info',
    component: 'worker',
    msg: 'ELESEND Dedicated Background Worker started',
    env: config.env,
    routing: routing ? 'configured' : 'disabled',
    dispatch: dispatch ? 'enabled' : 'disabled',
    sms: sms ? config.sms.provider : 'disabled',
    payment: paymentProvider ? config.payment.provider : 'disabled'
  }));

  const scheduler = backgroundJobs({
    db,
    dispatch,
    notifications,
    restOrders,
    money,
    checkout,
    finance,
    paymentProvider
  }).start({ unref: false });

  function stop() {
    scheduler.stop();
  }

  return {
    db,
    config,
    routing,
    dispatch,
    notifications,
    sms,
    app,
    paymentProvider,
    finance,
    checkout,
    money,
    restOrders,
    jobs: scheduler.jobs,
    stop
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startWorker().then(worker => {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        console.log(JSON.stringify({ level: 'info', component: 'worker', msg: `Received ${signal}, shutting down gracefully` }));
        worker.stop();
        worker.db.close().then(() => process.exit(0)).catch(() => process.exit(1));
        setTimeout(() => process.exit(1), 10000).unref();
      });
    }
  }).catch(err => {
    process.stderr.write(JSON.stringify({ level: 'error', component: 'worker', msg: 'Worker boot failed', err: err.message }) + '\n');
    process.exit(1);
  });
}
