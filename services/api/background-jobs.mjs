/**
 * Shared background job scheduling for the API process and the dedicated worker.
 * Food deadlines never wait on payment-provider calls: expiry and financial
 * reconciliation run as independent jobs with independent locks.
 */
import {reconcileAndEnforceWeeklyRestrictions} from './weekly-settlement.mjs';
import {runScheduledRecovery} from './rider-wallet.mjs';

export const LOCKS={dispatchPruning:839201,corridors:839202,paymentRecon:839203,foodExpiry:839204,maintenance:839205,moneyRecon:839206,walletRecon:839207};

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

export function backgroundJobs({db,dispatch=null,notifications=null,restOrders=null,money=null,checkout=null,finance=null,paymentProvider=null}){
 const busy=new Set();
 const guarded=(name,lockId,fn)=>async()=>{
  if(busy.has(name))return false;busy.add(name);
  try{return lockId?await withAdvisoryLock(db,lockId,fn):(await fn(),true);}
  catch(e){warn(name,e.code??'failed');return false;}
  finally{busy.delete(name);}
 };
 const jobs={
  notifications:guarded('notifications',null,async()=>{await notifications?.tick();}),
  foodExpiry:guarded('food_expiry',LOCKS.foodExpiry,async()=>{await restOrders?.expireUnfulfilledOrders();}),
  moneyRecon:guarded('money_reconciliation',LOCKS.moneyRecon,async()=>{if(!money)return;await money.syncRefunds();await money.reconcileDue();}),
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
  pruning:guarded('location_retention',LOCKS.dispatchPruning,async()=>{await dispatch?.pruneSamples();}),
  corridors:guarded('corridor_refresh',LOCKS.corridors,async()=>{await dispatch?.refreshCorridors();}),
  maintenance:guarded('maintenance',LOCKS.maintenance,async()=>{
   await db.query("DELETE FROM rate_limits WHERE expires_at<now()-interval '1 hour'");
   await db.query("DELETE FROM sessions WHERE expires_at<now()-interval '24 hours'");
   await db.query("DELETE FROM account_phone_challenges WHERE expires_at<now()-interval '24 hours'");
   await reconcileAndEnforceWeeklyRestrictions(db);
  })
 };
 const timers=[];
 function start({unref=false}={}){
  const every=(fn,ms,enabled=true)=>{if(!enabled)return;const t=setInterval(()=>{fn();},ms);if(unref)t.unref();timers.push(t);};
  every(jobs.notifications,3000,!!notifications);
  every(jobs.foodExpiry,15000,!!restOrders);
  every(jobs.moneyRecon,30000,!!money&&!!paymentProvider);
  every(jobs.dispatch,3000,!!dispatch);
  every(jobs.paymentRecon,30000,!!paymentProvider&&(!!checkout||!!finance));
  every(jobs.pruning,3600000,!!dispatch);
  every(jobs.corridors,60000,!!dispatch);
  every(jobs.maintenance,3600000);
  every(jobs.walletRecon,900000);
  return api;
 }
 function stop(){while(timers.length)clearInterval(timers.pop());}
 const api={jobs,start,stop};
 return api;
}
