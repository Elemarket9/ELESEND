import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check} from './security.mjs';
import {featureService} from './algorithms/features.mjs';
import {detectFraudSignals} from './algorithms/fraud.mjs';
import {decideCommissionExposure} from './algorithms/exposure.mjs';
import {verifyBalancedJournal} from './algorithms/reconciliation.mjs';
const UUID=z.string().uuid();
const positive=z.number().int().min(1).max(1000000000);
const amount=z.number().int().min(0).max(1000000000);
const idem=z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);
const commissionEntries = {
 cash_commission:(v)=>[['rider_receivable','debit',v],['platform_revenue','credit',v]],
 credit_purchase:(v)=>[['provider_clearing','debit',v],['prepaid_liability','credit',v]],
 credit_apply:(v)=>[['prepaid_liability','debit',v],['rider_receivable','credit',v]],
 commission_repayment:(v)=>[['provider_clearing','debit',v],['rider_receivable','credit',v]],
 commission_overpayment:(v)=>[['provider_clearing','debit',v],['unapplied_provider_funds','credit',v]],
 waive:(v)=>[['commission_adjustment','debit',v],['rider_receivable','credit',v]],
 reinstate:(v)=>[['rider_receivable','debit',v],['commission_adjustment','credit',v]]
};
export async function journal(c,{eventKey,riderId,shipmentId=null,kind,value}){
 check(positive.safeParse(value).success,400,'Invalid journal amount');
 const found=await c.query('SELECT id FROM finance_journals WHERE event_key=$1',[eventKey]);
 if(found.rowCount)return {id:found.rows[0].id,duplicate:true};
 check(typeof commissionEntries[kind]==='function',400,'Unsupported journal kind');
 const entries=commissionEntries[kind](value);
 verifyBalancedJournal(entries.map(([ledger_code,side,amount_minor])=>({ledger_code,side,amount_minor})));
 const id=randomUUID();
 await c.query('INSERT INTO finance_journals(id,event_key,rider_id,shipment_id,kind) VALUES($1,$2,$3,$4,$5)',[id,eventKey,riderId,shipmentId,kind]);
 for(const [i,[account,side,minor]] of entries.entries())
  await c.query('INSERT INTO finance_lines(journal_id,line_no,ledger_code,side,amount_minor) VALUES($1,$2,$3,$4,$5)',[id,i+1,account,side,minor]);
 return {id,duplicate:false};
}
export async function balance(c,riderId){
 const {rows}=await c.query(`SELECT
  coalesce(sum(CASE WHEN l.ledger_code='rider_receivable' AND l.side='debit' THEN l.amount_minor WHEN l.ledger_code='rider_receivable' AND l.side='credit' THEN -l.amount_minor ELSE 0 END),0)::bigint AS due,
  coalesce(sum(CASE WHEN l.ledger_code='prepaid_liability' AND l.side='credit' THEN l.amount_minor WHEN l.ledger_code='prepaid_liability' AND l.side='debit' THEN -l.amount_minor ELSE 0 END),0)::bigint AS credit,
  coalesce(sum(CASE WHEN l.ledger_code='unapplied_provider_funds' AND l.side='credit' THEN l.amount_minor WHEN l.ledger_code='unapplied_provider_funds' AND l.side='debit' THEN -l.amount_minor ELSE 0 END),0)::bigint AS unapplied
 FROM finance_journals j JOIN finance_lines l ON l.journal_id=j.id WHERE j.rider_id=$1`,[riderId]);
 return {dueMinor:Number(rows[0].due),creditMinor:Number(rows[0].credit),unappliedProviderMinor:Number(rows[0].unapplied)};
}
async function lockAccount(c,riderId){const a=(await c.query('SELECT * FROM commission_accounts WHERE rider_id=$1 FOR UPDATE',[riderId])).rows[0];check(a,403,'Commission account missing');return a;}
async function outstandingObligations(c,riderId){
 const rows=(await c.query(`SELECT o.id,o.original_minor,o.due_at,o.created_at,
   coalesce(sum(a.amount_minor),0)::bigint AS allocated_minor
  FROM commission_obligations o LEFT JOIN commission_allocations a ON a.obligation_id=o.id
  WHERE o.rider_id=$1 GROUP BY o.id ORDER BY o.due_at,o.created_at,o.id`,[riderId])).rows;
 return rows.map(r=>({...r,remainingMinor:Number(r.original_minor)-Number(r.allocated_minor)})).filter(r=>r.remainingMinor>0);
}
async function allocateFifo(c,riderId,journalId,value){
 let remaining=value;
 for(const row of await outstandingObligations(c,riderId)){
  if(remaining<=0)break;
  const chunk=Math.min(remaining,row.remainingMinor);
  await c.query('INSERT INTO commission_allocations(journal_id,obligation_id,amount_minor) VALUES($1,$2,$3)',[journalId,row.id,chunk]);
  remaining-=chunk;
 }
 check(remaining===0,409,'Allocation evidence insufficient for requested repayment');
}
export async function cashEligible(c,riderId,newCommission=0,{includeActive=true}={}){
 const account=await lockAccount(c,riderId);check(!account.blocked,403,'Commission account restricted');
 const b=await balance(c,riderId);
 const pending=(await c.query(`SELECT coalesce(sum(commission_minor),0)::bigint AS amount,count(*)::integer AS jobs
  FROM shipments WHERE rider_id=$1 AND payment_method='CASH' AND state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP')`,[riderId])).rows[0];
 const reserved=includeActive?Number(pending.amount):0;
 const obligations=await outstandingObligations(c,riderId);
 const unpaid=obligations.length;
 const graceMs=Number(account.grace_days??0)*86400000;
 check(!obligations.some(o=>new Date(o.due_at).getTime()+graceMs<Date.now()),409,'Overdue commission must be settled before new cash offers');
 const decision=decideCommissionExposure({dueMinor:b.dueMinor,reservedMinor:reserved,newCommissionMinor:newCommission,
  creditMinor:b.creditMinor,limitMinor:Number(account.max_outstanding_minor),unpaidJobs:unpaid,
  activeCashJobs:includeActive?Number(pending.jobs):0,maxUnpaidJobs:account.max_unpaid_jobs,
  postpaidEnabled:account.postpaid_enabled,blocked:account.blocked});
 check(decision.eligible,409,`Rider commission eligibility: ${decision.reason}`);
 return {...decision,creditMinor:b.creditMinor};
}
export async function postCashCommission(c,shipment){
 check(shipment.payment_method==='CASH'&&shipment.rider_id,409,'Cash commission requires assigned rider');
 const account=await lockAccount(c,shipment.rider_id);
 if(shipment.commission_minor===0)return {zeroCommission:true};
 const base=await journal(c,{eventKey:'shipment:'+shipment.id+':cash-commission',riderId:shipment.rider_id,shipmentId:shipment.id,kind:'cash_commission',value:shipment.commission_minor});
 if(base.duplicate)return base;
 const obligationId=randomUUID();
 await c.query("INSERT INTO commission_obligations(id,shipment_id,rider_id,original_minor,due_at) VALUES($1,$2,$3,$4,now()+($5::int*interval '1 day'))",[obligationId,shipment.id,shipment.rider_id,shipment.commission_minor,account.settlement_due_days]);
 const b=await balance(c,shipment.rider_id);
 const applied=Math.min(shipment.commission_minor,b.creditMinor);
 if(applied>0){
  const allocation=await journal(c,{eventKey:'shipment:'+shipment.id+':credit-applied',riderId:shipment.rider_id,shipmentId:shipment.id,kind:'credit_apply',value:applied});
  await c.query('INSERT INTO commission_allocations(journal_id,obligation_id,amount_minor) VALUES($1,$2,$3)',[allocation.id,obligationId,applied]);
 }
 return {...base,creditAppliedMinor:applied};
}
export function financeService(db,{provider=null}={}){
 const requireRider=actor=>check(actor?.kind==='rider',403,'Rider account required');
 async function permit(c,actor,p){check(actor?.kind==='admin',403,'Administrator required');check((await c.query('SELECT 1 FROM permissions WHERE user_id=$1 AND permission=$2',[actor.id,p])).rowCount,403,'Finance permission required');}
 return {
  /** Each adapter verifies its OWN webhook authentication and provider transaction. */
  async handleWebhook(rawBody,headers){
   check(provider&&typeof provider.verifyEvent==='function',503,'Commission payment webhooks disabled');
   const verified=await provider.verifyEvent({rawBody,headers});
   check(verified&&verified.providerName===provider.name&&verified.verified===true,403,'Provider evidence not verified');
   return this.confirmed({providerName:verified.providerName,eventId:verified.eventId,intentId:verified.intentId,amountMinor:verified.amountMinor,currency:verified.currency});
  },
  async reportCash(actor,sid,input){requireRider(actor);UUID.parse(sid);
   const v=z.object({reportedMinor:amount,cashPayer:z.enum(['sender','recipient']),idempotencyKey:idem}).strict().parse(input);
   return db.tx(async c=>{
    const s=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[sid])).rows[0];check(s,404,'Shipment missing');
    check(s.rider_id===actor.id&&s.payment_method==='CASH',403,'Only assigned cash collector may report cash');
    check(s.cash_payer===v.cashPayer&&v.reportedMinor<=s.amount_minor,400,'Collection does not match booking');
    const old=(await c.query('SELECT * FROM cash_collections WHERE shipment_id=$1',[sid])).rows[0];
    if(old){check(Number(old.reported_minor)===v.reportedMinor&&old.cash_payer===v.cashPayer,409,'Cash report already recorded; open a dispute to correct');return {status:old.reported_status,reportedMinor:Number(old.reported_minor),duplicate:true};}
    check(s.cash_payer==='sender' ? s.state==='RIDER_ASSIGNED' : ['IN_TRANSIT','AWAITING_DELIVERY_OTP'].includes(s.state),409,'Cash report must occur at payer handover');
    const status=v.reportedMinor===0?'uncollected':v.reportedMinor===s.amount_minor?'reported_full':'reported_partial';
    await c.query('INSERT INTO cash_collections(shipment_id,rider_id,cash_payer,reported_minor,reported_status,report_idempotency_key) VALUES($1,$2,$3,$4,$5,$6)',[sid,actor.id,v.cashPayer,v.reportedMinor,status,v.idempotencyKey]);
    await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,'cash.rider_reported',sid]);
    if(v.reportedMinor<s.amount_minor&&await featureService(c).enabled('fraud_signals')){
     const indicators=detectFraudSignals({cashShortfallMinor:s.amount_minor-v.reportedMinor});
     for(const signal of indicators.signals)await c.query(
      'INSERT INTO operational_risk_signals(rider_id,shipment_id,signal_code,severity,evidence) VALUES($1,$2,$3,$4,$5)',
      [actor.id,sid,signal.code,signal.severity,JSON.stringify({shortfallMinor:s.amount_minor-v.reportedMinor})]);
    }
    return {status,reportedMinor:v.reportedMinor,cashVerifiedByPlatform:false};
   });
  },
  async snapshot(actor){requireRider(actor);const b=await balance(db,actor.id);
   const a=(await db.query('SELECT postpaid_enabled,max_outstanding_minor,max_unpaid_jobs,settlement_due_days,grace_days,blocked FROM commission_accounts WHERE rider_id=$1',[actor.id])).rows[0];check(a,404);
   const lines=(await db.query(`SELECT j.id,j.kind,j.shipment_id,j.created_at,l.ledger_code,l.side,l.amount_minor FROM finance_journals j JOIN finance_lines l ON l.journal_id=j.id WHERE j.rider_id=$1 ORDER BY j.created_at DESC,j.id,l.line_no LIMIT 120`,[actor.id])).rows;
   const cash=(await db.query(`SELECT coalesce(sum(reported_minor),0)::bigint AS cash_reported,count(*)::integer AS jobs FROM cash_collections WHERE rider_id=$1`,[actor.id])).rows[0];
   const obligations=await outstandingObligations(db,actor.id);
   return {...b,postpaidEnabled:a.postpaid_enabled,maxOutstandingMinor:Number(a.max_outstanding_minor),maxUnpaidJobs:a.max_unpaid_jobs,dueDays:a.settlement_due_days,graceDays:a.grace_days,blocked:a.blocked,cashReportedMinor:Number(cash.cash_reported),reportedCashJobs:cash.jobs,unpaidJobs:obligations.length,nextDueAt:obligations[0]?.due_at??null,lines,warning:'Cash reports are rider assertions, not independently verified receipts. Unapplied provider funds require reconciliation, not automatic rider credit.'};
  },
  async initiate(actor,input){requireRider(actor);
   const v=z.object({kind:z.enum(['commission_repayment','credit_purchase']),amountMinor:positive,idempotencyKey:idem,email:z.email().max(254).optional()}).strict().parse(input);
   check(provider&&typeof provider.createPayment==='function',503,'Authorized payment provider not configured');
   if(v.kind==='credit_purchase')check(process.env.ENABLE_PREPAID_CREDITS==='true',403,'Prepaid commission credits require legal and operating approval');
   const intent=await db.tx(async c=>{await lockAccount(c,actor.id);
    const old=(await c.query('SELECT * FROM settlement_intents WHERE rider_id=$1 AND idempotency_key=$2',[actor.id,v.idempotencyKey])).rows[0];
    if(old){check(old.kind===v.kind&&Number(old.amount_minor)===v.amountMinor,409,'Idempotency key reused');return old;}
    if(v.kind==='commission_repayment'){const b=await balance(c,actor.id);check(v.amountMinor<=b.dueMinor,409,'Payment exceeds outstanding commission');}
    const id=randomUUID();return (await c.query('INSERT INTO settlement_intents(id,rider_id,provider,amount_minor,kind,idempotency_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,actor.id,provider.name,v.amountMinor,v.kind,v.idempotencyKey])).rows[0];
   });
   if(intent.status==='confirmed')return {intentId:intent.id,status:'confirmed'};
   // Only a payment-provider checkout; never turn an initiation into ledger collection.
   const response=await provider.createPayment({intentId:intent.id,amountMinor:Number(intent.amount_minor),currency:'GHS',riderId:actor.id,idempotencyKey:intent.id,email:v.email});
   return {intentId:intent.id,status:'pending',provider:provider.name,paymentInstructions:response};
  },
  // INTERNAL adapter entry after cryptographic provider verification; NEVER expose as an unsigned API.
  async confirmed({providerName,eventId,intentId,amountMinor,currency='GHS'}){UUID.parse(intentId);check(provider?.name===providerName&&typeof eventId==='string'&&eventId.length>=4,403,'Unrecognized provider');check(positive.safeParse(amountMinor).success&&currency==='GHS',400);
   return db.tx(async c=>{
    const intent=(await c.query('SELECT * FROM settlement_intents WHERE id=$1 FOR UPDATE',[intentId])).rows[0];check(intent&&intent.provider===providerName&&Number(intent.amount_minor)===amountMinor,409,'Payment evidence does not match intent');
    const old=(await c.query('SELECT * FROM settlement_provider_events WHERE provider=$1 AND event_id=$2',[providerName,eventId])).rows[0];
    if(old){check(old.intent_id===intentId&&Number(old.amount_minor)===amountMinor,409,'Conflicting provider event');return {duplicate:true,status:intent.status};}
    check(intent.status==='pending',409,'Intent not pending');await lockAccount(c,intent.rider_id);
    // A genuine provider payment can arrive after another concurrent repayment or
    // an approved waiver lowered the debt. Record 100% of VERIFIED value; only the
    // amount supported by obligations reduces receivables. Residual is a distinct
    // suspense liability requiring refund/reconciliation, NEVER stealth wallet credit.
    const due=intent.kind==='commission_repayment'?(await balance(c,intent.rider_id)).dueMinor:0;
    const applied=intent.kind==='commission_repayment'?Math.min(amountMinor,Math.max(0,due)):0;
    const unapplied=intent.kind==='commission_repayment'?amountMinor-applied:0;
    await c.query('INSERT INTO settlement_provider_events(provider,event_id,intent_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5)',[providerName,eventId,intentId,amountMinor,currency]);
    if(applied){const posting=await journal(c,{eventKey:'psp:'+providerName+':'+eventId,riderId:intent.rider_id,kind:'commission_repayment',value:applied});await allocateFifo(c,intent.rider_id,posting.id,applied);}
    if(unapplied)await journal(c,{eventKey:'psp:'+providerName+':'+eventId+':unapplied',riderId:intent.rider_id,kind:'commission_overpayment',value:unapplied});
    if(intent.kind==='credit_purchase')await journal(c,{eventKey:'psp:'+providerName+':'+eventId,riderId:intent.rider_id,kind:'credit_purchase',value:amountMinor});
    await c.query("UPDATE settlement_intents SET status='confirmed',confirmed_at=now() WHERE id=$1",[intentId]);
    return {status:'confirmed',collectedMinor:applied,creditPurchasedMinor:intent.kind==='credit_purchase'?amountMinor:0,unappliedProviderMinor:unapplied,requiresReconciliation:unapplied>0};
   });
  },
  async policy(actor,riderId,input){UUID.parse(riderId);
   const v=z.object({postpaidEnabled:z.boolean(),maxOutstandingMinor:amount,maxUnpaidJobs:z.number().int().min(0).max(100000),dueDays:z.number().int().min(1).max(365),graceDays:z.number().int().min(0).max(30).optional(),blocked:z.boolean()}).strict().parse(input);
   return db.tx(async c=>{await permit(c,actor,'finance:configure');const r=await c.query('UPDATE commission_accounts SET postpaid_enabled=$2,max_outstanding_minor=$3,max_unpaid_jobs=$4,settlement_due_days=$5,blocked=$6,grace_days=COALESCE($7,grace_days),updated_at=now() WHERE rider_id=$1 RETURNING rider_id',[riderId,v.postpaidEnabled,v.maxOutstandingMinor,v.maxUnpaidJobs,v.dueDays,v.blocked,v.graceDays??null]);check(r.rowCount,404);await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,'finance.policy_updated',riderId]);return {ok:true};});
  },
  async adjustmentRequest(actor,input){const v=z.object({riderId:UUID,direction:z.enum(['waive','reinstate']),amountMinor:positive,reason:z.string().min(12).max(1000)}).strict().parse(input);
   return db.tx(async c=>{await permit(c,actor,'finance:adjust');const id=randomUUID();await c.query('INSERT INTO finance_adjustment_requests(id,rider_id,requested_by,direction,amount_minor,reason) VALUES($1,$2,$3,$4,$5,$6)',[id,v.riderId,actor.id,v.direction,v.amountMinor,v.reason]);await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,'finance.adjustment_requested',id]);return {id,status:'pending'};});
  },
  async approveAdjustment(actor,requestId){UUID.parse(requestId);return db.tx(async c=>{await permit(c,actor,'finance:approve');const a=(await c.query('SELECT * FROM finance_adjustment_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];check(a&&a.status==='pending',409,'Adjustment already decided');check(a.requested_by!==actor.id,403,'Second independent approver required');await lockAccount(c,a.rider_id);
   if(a.direction==='waive'){const b=await balance(c,a.rider_id);check(Number(a.amount_minor)<=b.dueMinor,409,'Waiver exceeds actual debt');}
   const posting=await journal(c,{eventKey:'finance-adjustment:'+a.id,riderId:a.rider_id,kind:a.direction,value:Number(a.amount_minor)});
   if(a.direction==='waive')await allocateFifo(c,a.rider_id,posting.id,Number(a.amount_minor));
   if(a.direction==='reinstate'){
    const pol=await lockAccount(c,a.rider_id);
    await c.query("INSERT INTO commission_obligations(id,shipment_id,rider_id,original_minor,due_at) VALUES($1,NULL,$2,$3,now()+($4::int*interval '1 day'))",[randomUUID(),a.rider_id,a.amount_minor,pol.settlement_due_days]);
   }
   await c.query("UPDATE finance_adjustment_requests SET status='approved',approved_by=$2,decided_at=now() WHERE id=$1",[requestId,actor.id]);await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,'finance.adjustment_approved',a.id]);return {status:'approved'};
  });},
  async adjustmentQueue(actor){return db.tx(async c=>{await permit(c,actor,'finance:read');return (await c.query('SELECT id,rider_id,direction,amount_minor,reason,requested_by,status,created_at FROM finance_adjustment_requests ORDER BY created_at DESC LIMIT 100')).rows;});},
  async aging(actor){return db.tx(async c=>{await permit(c,actor,'finance:read');return (await c.query(`SELECT ca.rider_id,ca.max_outstanding_minor,ca.blocked,
   coalesce(sum(CASE WHEN l.ledger_code='rider_receivable' AND l.side='debit' THEN l.amount_minor WHEN l.ledger_code='rider_receivable' AND l.side='credit' THEN -l.amount_minor ELSE 0 END),0)::bigint AS outstanding_minor
 FROM commission_accounts ca LEFT JOIN finance_journals j ON j.rider_id=ca.rider_id LEFT JOIN finance_lines l ON l.journal_id=j.id
 GROUP BY ca.rider_id ORDER BY outstanding_minor DESC LIMIT 100`)).rows;});}
 };
}
