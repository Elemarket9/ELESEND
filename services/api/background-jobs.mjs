import {trafficService} from './traffic.mjs';
import {suspendExpiredDocuments} from './rider-documents.mjs';
import {suspendExpiredLicences,syncOpenIdentityChecks,requireIdentityRefresh} from './rider-licence.mjs';
import {enforceDrivingLimits,flagUnusualStops,offlineSignedOutRiders,settleRiderRewards} from './rider-tools.mjs';
import {flagOverdueParcels} from './custody-incidents.mjs';
import {webhookService} from './api-webhooks.mjs';
/**
 * Shared background job scheduling for the API process and the dedicated worker.
 * Food deadlines never wait on payment-provider calls: expiry and financial
 * reconciliation run as independent jobs with independent locks.
 */
import {reconcileAndEnforceWeeklyRestrictions} from './modules/payments/index.mjs';
import {runScheduledRecovery} from './modules/payments/index.mjs';
import {runGeographicLearningCycle} from './infrastructure/maps/egia/background-learner.mjs';
import {chatEngine} from './chat-engine.mjs';

export const LOCKS={traffic:839291,dispatchPruning:839201,corridors:839202,paymentRecon:839203,foodExpiry:839204,maintenance:839205,moneyRecon:839206,walletRecon:839207,geoLearning:839208,deliveryWatchdog:839209,etaRefresh:839210,businessPayouts:839211,parcelCustody:839213,riderSafety:839214};

const warn=(component,code,extra={})=>process.stderr.write(JSON.stringify({level:'warn',component,code,...extra})+'\n');

/** Session advisory locks must be taken and released on the SAME connection. */
export async function withAdvisoryLock(db,lockId,task){
 const client=db.pool?await db.pool.connect():null;
 const q=client?(...a)=>client.query(...a):(...a)=>db.query(...a);
 try{
  const res=await q('SELECT pg_try_advisory_lock($1) AS acquired',[lockId]);
  if(!res.rows?.[0]?.acquired)return false;
  try{await task();return true;}
  finally{await q('SELECT pg_advisory_unlock($1)',[lockId]).catch(()=>{});}
 }catch(err){warn('advisory_lock','lock_failed',{lockId,err:err.message});return false;}
 finally{client?.release();}
}

export function backgroundJobs({db,dispatch=null,notifications=null,restOrders=null,money=null,checkout=null,finance=null,paymentProvider=null,chat=null,routing=null,eta=null}){
 const chatSvc=chat||(db&&typeof db.query==='function'?chatEngine(db):null);
 const busy=new Set();
 const guarded=(name,lockId,fn)=>async()=>{
  if(busy.has(name))return false;busy.add(name);
  try{return lockId?await withAdvisoryLock(db,lockId,fn):(await fn(),true);}
  catch(e){warn(name,e.code??'failed');return false;}
  finally{busy.delete(name);}
 };
 const jobs={
  notifications:guarded('notifications',null,async()=>{await notifications?.tick();}),
  chatOutbox:guarded('chat_outbox',null,async()=>{await chatSvc?.flushRealtimeOutbox();}),
  apiWebhooks:guarded('api_webhooks',null,async()=>{await webhookService(db).tick();}),
  foodExpiry:guarded('food_expiry',LOCKS.foodExpiry,async()=>{await restOrders?.expireUnfulfilledOrders();await restOrders?.alertUnconfirmedReturns?.();}),
  deliveryWatchdog:guarded('delivery_watchdog',LOCKS.deliveryWatchdog,async()=>{
   if(restOrders&&typeof restOrders.monitorAssignedDeliveries==='function')await restOrders.monitorAssignedDeliveries({onlyDueReviews:true});
   if(dispatch&&typeof dispatch.watchdog==='function')await dispatch.watchdog({onlyDueReviews:true});
  }),
  moneyRecon:guarded('money_reconciliation',LOCKS.moneyRecon,async()=>{if(!money)return;await money.syncRefunds();await money.refundUncollectedOrders();await money.reconcileDue();}),
  businessPayouts:guarded('business_payouts',LOCKS.businessPayouts,async()=>{await money?.settleBusinessesDue?.();}),
  riderSafety:guarded('rider_safety',LOCKS.riderSafety,async()=>{await enforceDrivingLimits(db);await flagUnusualStops(db);await offlineSignedOutRiders(db);}),
  parcelCustody:guarded('parcel_custody',LOCKS.parcelCustody,async()=>{await flagOverdueParcels(db);}),
  dispatch:guarded('dispatch',null,async()=>{if(!dispatch)return;const rows=await dispatch.tick();const errors=rows.filter(r=>r.status==='error');if(errors.length)warn('dispatch','tick_errors',{errors});}),
  paymentRecon:guarded('payment_reconciliation',LOCKS.paymentRecon,async()=>{
   if(!paymentProvider)return;
   if(checkout&&typeof checkout.reconcileDue==='function'){
    const r=await checkout.reconcileDue();
    const problems=r.filter(x=>x.errorCode);
    if(problems.length)warn('payment_reconciliation','checkout_problems',{problems});
   }
   if(finance&&typeof finance.reconcileDue==='function'){
    const s=await finance.reconcileDue();
    const problems=s.filter(x=>x.errorCode||x.status==='verification_unavailable');
    if(problems.length)warn('payment_reconciliation','settlement_problems',{problems});
   }
  }),
  // Read-only ledger checks + idempotent catch-up debt recovery; alerts are structured, never auto-corrections of history.
  walletRecon:guarded('wallet_reconciliation',LOCKS.walletRecon,async()=>{
   const {report,results}=await runScheduledRecovery(db);
   const serious=report.anomalies.filter(a=>a.severity==='critical'||a.severity==='high');
   if(serious.length)warn('wallet_reconciliation','ledger_anomalies',{anomalies:serious.map(a=>({code:a.code,severity:a.severity,count:a.count}))});
   const recovered=results.filter(r=>r.recoveredMinor>0);
   if(recovered.length)process.stdout.write(JSON.stringify({level:'info',component:'wallet_reconciliation',msg:'catch_up_recovery',riders:recovered.length})+'\n');
  }),
  // Records each stage's estimate even when no customer is watching, so accuracy can be measured.
  etaRefresh:guarded('eta_refresh',LOCKS.etaRefresh,async()=>{await eta?.refreshActive();}),
  traffic:guarded('road_traffic',LOCKS.traffic,async()=>{if(dispatch&&routing)await trafficService(db,{routing}).ingest(dispatch.recentRiderTraces);}),
  pruning:guarded('location_retention',LOCKS.dispatchPruning,async()=>{await dispatch?.pruneSamples();}),
   geoLearning:guarded('geo_learning',LOCKS.geoLearning,async()=>{await runGeographicLearningCycle(db,{routing});}),
  corridors:guarded('corridor_refresh',LOCKS.corridors,async()=>{await dispatch?.refreshCorridors();}),
  maintenance:guarded('maintenance',LOCKS.maintenance,async()=>{
   await db.query("DELETE FROM rate_limits WHERE expires_at<now()-interval '1 hour'");
   await db.query("DELETE FROM sessions WHERE expires_at<now()-interval '24 hours'");
   await db.query("DELETE FROM account_phone_challenges WHERE expires_at<now()-interval '24 hours'");
   await db.query("DELETE FROM account_recovery_challenges WHERE expires_at<now()-interval '24 hours'");
   const notifDays = parseInt(process.env.NOTIFICATION_RETENTION_DAYS || '14', 10);
   if (notifDays > 0) {
     await db.query("DELETE FROM notification_jobs WHERE state IN ('sent','expired') AND created_at < now() - ($1::int * interval '1 day')", [notifDays]);
   }
   const riskDays = parseInt(process.env.RISK_SIGNAL_RETENTION_DAYS || '90', 10);
   if (riskDays > 0) {
     await db.query("DELETE FROM operational_risk_signals WHERE review_status IN ('reviewed','dismissed') AND created_at < now() - ($1::int * interval '1 day')", [riskDays]);
   }
   // Financial checkout intents, transactions, journals, and audit logs are permanently retained under legal and financial audit requirements.
   await reconcileAndEnforceWeeklyRestrictions(db);
   await suspendExpiredLicences(db);
   await suspendExpiredDocuments(db);
   await syncOpenIdentityChecks(db);
   await requireIdentityRefresh(db);
   await settleRiderRewards(db);
  })
 };
 const timers=[];
 function start({unref=false}={}){
  const every=(fn,ms,enabled=true)=>{if(!enabled)return;const t=setInterval(()=>{fn();},ms);if(unref)t.unref();timers.push(t);};
  every(jobs.notifications,3000,!!notifications);
  every(jobs.chatOutbox,3000,!!chatSvc);
  every(jobs.apiWebhooks,5000);
  every(jobs.foodExpiry,15000,!!restOrders);
  every(jobs.deliveryWatchdog,15000,!!restOrders||!!dispatch);
  every(jobs.moneyRecon,30000,!!money&&!!paymentProvider);
  every(jobs.businessPayouts,3600000,!!money&&!!paymentProvider);
  every(jobs.parcelCustody,900000);
  every(jobs.riderSafety,300000);
  every(jobs.dispatch,3000,!!dispatch);
  every(jobs.paymentRecon,30000,!!paymentProvider&&(!!checkout||!!finance));
  every(jobs.etaRefresh,60000,!!eta);
  every(jobs.traffic,300000,!!dispatch&&!!routing);
  every(jobs.pruning,3600000,!!dispatch);
  every(jobs.corridors,60000,!!dispatch);
  every(jobs.maintenance,3600000);
  every(jobs.walletRecon,900000);
   every(jobs.geoLearning,1800000);
  return api;
 }
 function stop(){while(timers.length)clearInterval(timers.pop());}
 const api={jobs,start,stop};
 return api;
}
