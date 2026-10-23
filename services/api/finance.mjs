import {validatePayer} from './payment-provider.mjs';
import {validatedCheckoutUrl} from './checkout-policy.mjs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check} from './security.mjs';
import {featureService} from './algorithms/features.mjs';
import {detectFraudSignals} from './algorithms/fraud.mjs';
import {decideCommissionExposure} from './algorithms/exposure.mjs';
import {verifyBalancedJournal} from './algorithms/reconciliation.mjs';
import {
 getGhanaWeekKey,
 evaluateRiderWeeklyEligibility,
 getRiderWeeklyBalance,
 generateReceiptNumber,
 normalizeMomoNetwork,
 normalizeGhanaPhone,
 recordSettlementNotification
} from './weekly-settlement.mjs';
import {getWalletPolicy,recoverDebtFromEarnings,debtState,emitDebtTransition} from './rider-wallet.mjs';
const UUID=z.string().uuid();
const positive=z.number().int().min(1).max(1000000000);
const amount=z.number().int().min(0).max(1000000000);
const idem=z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);

function withTimeout(promise,ms){
 let timer;
 return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Provider verification timed out'),{code:'provider_timeout'})),ms);})]).finally(()=>clearTimeout(timer));
}
async function pool(items,limit,fn){
 const out=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;out[i]=await fn(items[i]);}}));
 return out;
}
const reasonText=e=>String(e?.message||e||'unknown').slice(0,500);
const defaultReference=intentId=>'escomm_'+String(intentId).replaceAll('-','');

const commissionEntries = {
 cash_commission:(v)=>[['rider_receivable','debit',v],['platform_revenue','credit',v]],
 credit_purchase:(v)=>[['provider_clearing','debit',v],['prepaid_liability','credit',v]],
 credit_apply:(v)=>[['prepaid_liability','debit',v],['rider_receivable','credit',v]],
 commission_repayment:(v)=>[['provider_clearing','debit',v],['rider_receivable','credit',v]],
 commission_overpayment:(v)=>[['provider_clearing','debit',v],['unapplied_provider_funds','credit',v]],
 waive:(v)=>[['commission_adjustment','debit',v],['rider_receivable','credit',v]],
 reinstate:(v)=>[['rider_receivable','debit',v],['commission_adjustment','credit',v]],
 // Verified digital earnings applied to commission debt (counterpart posted in the shipment ledger).
 earnings_recovery:(v)=>[['rider_earnings_offset_clearing','debit',v],['rider_receivable','credit',v]]
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
export async function outstandingObligations(c,riderId){
 const rows=(await c.query(`SELECT o.id,o.original_minor,o.due_at,o.created_at,
   coalesce(sum(a.amount_minor),0)::bigint AS allocated_minor
  FROM commission_obligations o LEFT JOIN commission_allocations a ON a.obligation_id=o.id
  WHERE o.rider_id=$1 GROUP BY o.id ORDER BY o.due_at,o.created_at,o.id`,[riderId])).rows;
 return rows.map(r=>({...r,remainingMinor:Number(r.original_minor)-Number(r.allocated_minor)})).filter(r=>r.remainingMinor>0);
}
export async function allocateFifo(c,riderId,journalId,value){
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
 const weekly=await evaluateRiderWeeklyEligibility(c,riderId);
 check(weekly.eligible,409,`Rider commission eligibility: ${weekly.reason}`);
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
 const weekKey=getGhanaWeekKey(new Date());
 await c.query("INSERT INTO commission_obligations(id,shipment_id,rider_id,original_minor,due_at,week_key) VALUES($1,$2,$3,$4,now()+($5::int*interval '1 day'),$6)",[obligationId,shipment.id,shipment.rider_id,shipment.commission_minor,account.settlement_due_days,weekKey]);
 const b=await balance(c,shipment.rider_id);
 const applied=Math.min(shipment.commission_minor,b.creditMinor);
 if(applied>0){
  const allocation=await journal(c,{eventKey:'shipment:'+shipment.id+':credit-applied',riderId:shipment.rider_id,shipmentId:shipment.id,kind:'credit_apply',value:applied});
  await c.query('INSERT INTO commission_allocations(journal_id,obligation_id,amount_minor) VALUES($1,$2,$3)',[allocation.id,obligationId,applied]);
 }
 return {...base,creditAppliedMinor:applied,weekKey};
}
export function financeService(db,{provider=null,verifyTimeoutMs=10000,concurrency=4,leaseSeconds=120,submissionLeaseSeconds=60,checkoutExpirySeconds=3600,maxVerifyBackoffSeconds=21600}={}){
 const requireRider=actor=>check(actor?.kind==='rider',403,'Rider account required');
 const inFlightInitiations=new Map();
 const riderReservationLocks=new Map();
 function isSubmissionCallActive(row){
  if(!row||row.status!=='initiating')return false;
  if(inFlightInitiations.has(row.id))return true;
  if(!row.submission_token||!row.submission_lease_until)return false;
  return new Date(row.submission_lease_until).getTime()>Date.now();
 }
 function canCreationStillComplete(row){
  if(!row||row.status!=='initiating')return false;
  if(inFlightInitiations.has(row.id))return true;
  if(!row.submission_lease_until)return false;
  return new Date(row.submission_lease_until).getTime()>Date.now();
 }
 async function withRiderLock(riderId,fn){
  const prev=riderReservationLocks.get(riderId)??Promise.resolve();
  let release;
  const gate=new Promise(r=>{release=r;});
  const chained=prev.then(()=>gate);
  riderReservationLocks.set(riderId,chained);
  await prev;
  try{return await fn();}
  finally{
   release();
   if(riderReservationLocks.get(riderId)===chained)riderReservationLocks.delete(riderId);
  }
 }
 async function permit(c,actor,p){
  const list=Array.isArray(p)?p:[p];
  check(actor?.kind==='admin',403,'Administrator required');
  check((await c.query('SELECT 1 FROM permissions WHERE user_id=$1 AND permission=ANY($2::text[])',[actor.id,list])).rowCount,403,'Finance permission required');
 }
 function formatIntentResult(row){
  if(row.status==='confirmed'){
   return {
    intentId:row.id,
    reference:row.provider_reference??defaultReference(row.id),
    status:'confirmed',
    provider:row.provider,
    receiptNumber:row.receipt_number,
    checkoutUrl:row.checkout_url??null,
    paymentInstructions:row.payment_instructions??null
   };
  }
  return {
   intentId:row.id,
   reference:row.provider_reference??defaultReference(row.id),
   status:row.status,
   provider:row.provider,
   checkoutUrl:row.checkout_url??null,
   paymentInstructions:row.payment_instructions??null
  };
 }
 return {
  /** Each adapter verifies its OWN webhook authentication and provider transaction. */
  async handleWebhook(rawBody,headers){
   check(provider&&typeof provider.verifyEvent==='function',503,'Commission payment webhooks disabled');
   const verified=await provider.verifyEvent({rawBody,headers});
   check(verified&&verified.providerName===provider.name&&verified.verified===true,403,'Provider evidence not verified');
   // Adapters that predate channel reporting only ever accepted mobile money.
   check((await getWalletPolicy(db)).repayment_channels.includes(verified.channel??'mobile_money'),409,'Commission repayment channel not permitted by wallet policy');
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
   const v=z.object({
    kind:z.enum(['commission_repayment','credit_purchase']),
    amountMinor:positive,
    idempotencyKey:idem,
    email:z.string().email().max(254).optional(),
    momoNetwork:z.string().optional(),
    momoPhone:z.string().optional()
   }).strict().parse(input);
   check(provider&&typeof provider.createPayment==='function',503,'Authorized payment provider not configured');
   validatePayer(provider,v);
   if(v.kind==='credit_purchase')check(process.env.ENABLE_PREPAID_CREDITS==='true',403,'Prepaid commission credits require legal and operating approval');
   if(v.momoNetwork!==undefined)check(normalizeMomoNetwork(v.momoNetwork)!==null,400,'Unsupported Mobile Money network');
   if(v.momoPhone!==undefined)check(normalizeGhanaPhone(v.momoPhone)!==null,400,'Invalid Ghana Mobile Money phone number');
   const net=v.momoNetwork?normalizeMomoNetwork(v.momoNetwork):null;
   const phone=v.momoPhone?normalizeGhanaPhone(v.momoPhone):null;
   const email=v.email??null;
   // Administrator-configured repayment limits and channels (provider-neutral channel names).
   const walletPolicy=await getWalletPolicy(db);

   // Serialize reservation per rider so simultaneous same-key or cross-key calls in the same process
   // observe the active/existing intent and share inFlightInitiations cleanly without racing on INSERT.
   const {intent,task}=await withRiderLock(actor.id,async()=>{
    if(typeof provider.verifyPayment==='function'){
     const candidates=(await db.query(
      `SELECT id,status,submission_token,submission_lease_until,last_reconciled_at,updated_at
         FROM settlement_intents
        WHERE rider_id=$1
          AND kind=$2
          AND (
            status IN ('initiating','pending')
            OR (status IN ('expired','failed') AND provider_terminal_at IS NULL)
          )
        ORDER BY created_at DESC
        LIMIT 10`,
      [actor.id,v.kind]
     )).rows;
     for(const cand of candidates){
      if(!isSubmissionCallActive(cand)){
       try{await this.reconcileIntent(cand.id,{silentUnavailable:true});}catch{}
      }
     }
    }

    const submissionToken=randomUUID();
    const reserved=await db.tx(async c=>{
     await lockAccount(c,actor.id);
     const old=(await c.query('SELECT * FROM settlement_intents WHERE rider_id=$1 AND idempotency_key=$2 FOR UPDATE',[actor.id,v.idempotencyKey])).rows[0];
     if(old){
      const sameTerms=old.kind===v.kind
       &&Number(old.amount_minor)===v.amountMinor
       &&(old.momo_network??null)===net
       &&(old.momo_phone??null)===phone
       &&(old.payer_email??null)===email;
      check(sameTerms,409,'Idempotency key reused with different payment terms');
      return {...old,wasExisting:true};
     }
     const active=(await c.query("SELECT * FROM settlement_intents WHERE rider_id=$1 AND kind=$2 AND status IN ('initiating','pending') LIMIT 1",[actor.id,v.kind])).rows[0];
     if(active){
      check(false,409,'An existing commission payment attempt is pending; verify or complete it before starting another');
     }
     if(v.kind==='commission_repayment'){
      const b=await balance(c,actor.id);
      check(v.amountMinor<=b.dueMinor,409,'Payment exceeds outstanding commission');
      // The minimum never prevents settling a smaller remaining balance in full.
      check(v.amountMinor>=Math.min(walletPolicy.repayment_min_minor,b.dueMinor),400,`Minimum commission repayment is ${walletPolicy.repayment_min_minor} pesewas`);
      check(walletPolicy.repayment_max_minor===null||v.amountMinor<=walletPolicy.repayment_max_minor,400,`Maximum commission repayment is ${walletPolicy.repayment_max_minor} pesewas`);
     }
     const id=randomUUID();
     const reference=defaultReference(id);
     const created=(await c.query(
      `INSERT INTO settlement_intents(
         id,rider_id,provider,provider_reference,amount_minor,kind,status,idempotency_key,
         momo_network,momo_phone,payer_email,submission_token,submission_lease_until,submitted_at,updated_at
       ) VALUES($1,$2,$3,$4,$5,$6,'initiating',$7,$8,$9,$10,$11,now()+make_interval(secs=>$12),now(),now())
       ON CONFLICT (rider_id,idempotency_key) DO NOTHING
       RETURNING *`,
      [id,actor.id,provider.name,reference,v.amountMinor,v.kind,v.idempotencyKey,net,phone,email,submissionToken,submissionLeaseSeconds]
     )).rows[0];
     if(!created){
      const concurrent=(await c.query('SELECT * FROM settlement_intents WHERE rider_id=$1 AND idempotency_key=$2',[actor.id,v.idempotencyKey])).rows[0];
      check(concurrent,409,'An existing commission payment attempt is pending; verify or complete it before starting another');
      const sameTerms=concurrent.kind===v.kind
       &&Number(concurrent.amount_minor)===v.amountMinor
       &&(concurrent.momo_network??null)===net
       &&(concurrent.momo_phone??null)===phone
       &&(concurrent.payer_email??null)===email;
      check(sameTerms,409,'Idempotency key reused with different payment terms');
      return {...concurrent,wasExisting:true};
     }
     return {...created,wasExisting:false};
    });

    if(reserved.wasExisting){
     return {intent:reserved,task:null};
    }

    const createTask=(async()=>{
     let response;
     try{
      response=await provider.createPayment({
       intentId:reserved.id,
       reference:reserved.provider_reference,
       amountMinor:Number(reserved.amount_minor),
       currency:'GHS',
       riderId:actor.id,
       idempotencyKey:reserved.id,
       email:v.email,
       momoNetwork:net,
       momoPhone:phone,
       allowedChannels:walletPolicy.repayment_channels
      });
      if(response?.reference!==undefined){
       check(response.reference===reserved.provider_reference,502,'PSP reference disagreement');
      }
      const rawCheckoutUrl=response?.checkoutUrl??response?.authorizationUrl??null;
      let safeCheckoutUrl=rawCheckoutUrl;
      if(typeof rawCheckoutUrl==='string'&&Array.isArray(provider.allowedCheckoutHosts)&&provider.allowedCheckoutHosts.length>0){
       safeCheckoutUrl=validatedCheckoutUrl(rawCheckoutUrl,{allowedHosts:provider.allowedCheckoutHosts});
       if(response.checkoutUrl!==undefined)response.checkoutUrl=safeCheckoutUrl;
       if(response.authorizationUrl!==undefined)response.authorizationUrl=safeCheckoutUrl;
      }
      const finalRow=await db.tx(async c=>{
       await lockAccount(c,actor.id);
       const current=(await c.query('SELECT * FROM settlement_intents WHERE id=$1 FOR UPDATE',[reserved.id])).rows[0];
       check(current,404,'Settlement intent missing');
       if(current.status==='confirmed'){
        return (await c.query(
         `UPDATE settlement_intents
             SET provider_reference=coalesce($2,provider_reference),
                 checkout_url=coalesce($3,checkout_url),
                 payment_instructions=coalesce($4::jsonb,payment_instructions),
                 submission_token=NULL,
                 submission_lease_until=NULL,
                 updated_at=now()
           WHERE id=$1 AND status='confirmed'
           RETURNING *`,
         [reserved.id,response?.reference??reserved.provider_reference,safeCheckoutUrl,JSON.stringify(response??{})]
        )).rows[0]??current;
       }
       // Guarded transition: only transition to 'pending' if still 'initiating', owned by this submission_token,
       // and no overlapping active ('initiating'/'pending') attempt exists for this rider and kind.
       const updated=(await c.query(
        `UPDATE settlement_intents
            SET status='pending',
                provider_reference=coalesce($2,provider_reference),
                checkout_url=$3,
                payment_instructions=$4::jsonb,
                submission_token=NULL,
                submission_lease_until=NULL,
                updated_at=now()
          WHERE id=$1
            AND status='initiating'
            AND submission_token=$5
            AND NOT EXISTS (
              SELECT 1 FROM settlement_intents other
               WHERE other.rider_id=settlement_intents.rider_id
                 AND other.kind=settlement_intents.kind
                 AND other.id<>settlement_intents.id
                 AND other.status IN ('initiating','pending')
            )
          RETURNING *`,
        [reserved.id,response?.reference??reserved.provider_reference,safeCheckoutUrl,JSON.stringify(response??{}),submissionToken]
       )).rows[0];
       if(!updated){
        // Preserve provider_reference for late-payment recovery, but NEVER resurrect a failed/expired/superseded operation.
        await c.query(
         'UPDATE settlement_intents SET provider_reference=coalesce($2,provider_reference),submission_token=NULL,submission_lease_until=NULL,updated_at=now() WHERE id=$1',
         [reserved.id,response?.reference??reserved.provider_reference]
        );
        check(false,409,'Commission payment attempt expired or was superseded before provider initialization returned');
       }
       return updated;
      });
      return formatIntentResult(finalRow);
     }catch(e){
      if(e?.definitiveNoCharge===true){
       await db.tx(async c=>{
        await lockAccount(c,actor.id);
        await c.query(
         `UPDATE settlement_intents
             SET status='failed',
                 failure_reason=$2,
                 failed_at=coalesce(failed_at,now()),
                 provider_terminal_at=now(),
                 provider_last_status='rejected_before_charge',
                 submission_token=NULL,
                 submission_lease_until=NULL,
                 updated_at=now()
           WHERE id=$1
             AND status='initiating'
             AND submission_token=$3`,
         [reserved.id,reasonText(e),submissionToken]
        );
       });
       throw e;
      }
      if(e?.status===409)throw e;
      // Release submission_token so retry/reconciliation can check if payment succeeded,
      // but preserve submission_lease_until so "not_created" is not treated as definitive failure
      // while the remote provider could still be completing the creation request.
      await db.query(
       `UPDATE settlement_intents
           SET failure_reason=$2,
               submission_token=NULL,
               updated_at=now()
         WHERE id=$1
           AND status='initiating'
           AND submission_token=$3`,
       [reserved.id,'Initialization outcome uncertain: '+reasonText(e),submissionToken]
      ).catch(()=>{});
      throw Object.assign(Error('Commission payment initialization unconfirmed; query status before retry'),{status:503});
     }
    })();

    inFlightInitiations.set(reserved.id,createTask);
    return {intent:reserved,task:createTask};
   });

   if(intent.wasExisting){
    if(inFlightInitiations.has(intent.id)){
     try{await inFlightInitiations.get(intent.id);}catch{}
    }else if(!isSubmissionCallActive(intent)&&['initiating','pending','expired','failed','rejected'].includes(intent.status)&&typeof provider.verifyPayment==='function'){
     try{await this.reconcileIntent(intent.id,{silentUnavailable:true});}catch{}
    }
    const refreshed=(await db.query('SELECT * FROM settlement_intents WHERE id=$1',[intent.id])).rows[0]??intent;
    if(refreshed.status==='confirmed')return formatIntentResult(refreshed);
    if(refreshed.status==='pending'&&refreshed.payment_instructions!==null)return formatIntentResult(refreshed);
    if(['failed','rejected','expired'].includes(refreshed.status)){
     check(false,409,'Previous commission payment attempt failed; start a new attempt with a fresh idempotency key');
    }
    throw Object.assign(Error('Commission payment initialization unconfirmed; query status before retry'),{status:503});
   }

   try{
    return await task;
   }finally{
    inFlightInitiations.delete(intent.id);
   }
  },
  // INTERNAL adapter entry after cryptographic provider verification; NEVER expose as an unsigned API.
  async confirmed({providerName,eventId,intentId,amountMinor,currency='GHS'}){UUID.parse(intentId);check(provider?.name===providerName&&typeof eventId==='string'&&eventId.length>=4,403,'Unrecognized provider');check(positive.safeParse(amountMinor).success&&currency==='GHS',400);
   return withRiderLock('confirm:'+intentId,()=>db.tx(async c=>{
    const intent=(await c.query('SELECT * FROM settlement_intents WHERE id=$1 FOR UPDATE',[intentId])).rows[0];check(intent&&intent.provider===providerName&&Number(intent.amount_minor)===amountMinor,409,'Payment evidence does not match intent');
    const old=(await c.query('SELECT * FROM settlement_provider_events WHERE provider=$1 AND event_id=$2',[providerName,eventId])).rows[0];
    if(old){check(old.intent_id===intentId&&Number(old.amount_minor)===amountMinor,409,'Conflicting provider event');return {duplicate:true,status:intent.status,intentId,receiptNumber:intent.receipt_number};}
    if(intent.status==='confirmed')return {duplicate:true,status:'confirmed',intentId,receiptNumber:intent.receipt_number};
    check(intent.status!=='reversed',409,'Reversed intent cannot be confirmed');
    const wasInactive=['failed','rejected','expired'].includes(intent.status);
    await lockAccount(c,intent.rider_id);
    const debtBefore=await debtState(c,intent.rider_id);
    const ev=(await c.query('INSERT INTO settlement_provider_events(provider,event_id,intent_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5) ON CONFLICT (provider,event_id) DO NOTHING RETURNING *',[providerName,eventId,intentId,amountMinor,currency])).rows[0];
    if(!ev){
     const concurrentEv=(await c.query('SELECT * FROM settlement_provider_events WHERE provider=$1 AND event_id=$2',[providerName,eventId])).rows[0];
     check(concurrentEv&&concurrentEv.intent_id===intentId&&Number(concurrentEv.amount_minor)===amountMinor,409,'Conflicting provider event');
     return {duplicate:true,status:'confirmed',intentId,receiptNumber:intent.receipt_number};
    }
    // A genuine provider payment can arrive after an intent expired/failed locally, after another
    // concurrent repayment, or after an approved waiver lowered the debt. Record 100% of VERIFIED
    // value; only the amount supported by open obligations reduces receivables. Residual is a distinct
    // suspense/refund liability (unapplied_provider_funds), NEVER discarded and NEVER stealth wallet credit.
    let applied=0;
    let unapplied=0;
    let creditPurchased=0;
    if(intent.kind==='commission_repayment'){
     const obligations=await outstandingObligations(c,intent.rider_id);
     const allocatableMinor=obligations.reduce((s,r)=>s+r.remainingMinor,0);
     const due=Math.min((await balance(c,intent.rider_id)).dueMinor,allocatableMinor);
     applied=Math.min(amountMinor,Math.max(0,due));
     unapplied=amountMinor-applied;
     if(applied>0){
      const posting=await journal(c,{eventKey:'psp:'+providerName+':'+eventId,riderId:intent.rider_id,kind:'commission_repayment',value:applied});
      await allocateFifo(c,intent.rider_id,posting.id,applied);
     }
     if(unapplied>0){
      await journal(c,{eventKey:'psp:'+providerName+':'+eventId+':unapplied',riderId:intent.rider_id,kind:'commission_overpayment',value:unapplied});
     }
    }else if(intent.kind==='credit_purchase'){
     if(!wasInactive){
      creditPurchased=amountMinor;
      await journal(c,{eventKey:'psp:'+providerName+':'+eventId,riderId:intent.rider_id,kind:'credit_purchase',value:amountMinor});
     }else{
      unapplied=amountMinor;
      await journal(c,{eventKey:'psp:'+providerName+':'+eventId+':unapplied',riderId:intent.rider_id,kind:'commission_overpayment',value:amountMinor});
     }
    }
    const receiptNumber=intent.receipt_number||generateReceiptNumber(intentId);
    await c.query(
     `UPDATE settlement_intents
         SET status='confirmed',
             confirmed_at=coalesce(confirmed_at,now()),
             receipt_number=$2,
             failure_reason=NULL,
             failed_at=NULL,
             provider_terminal_at=now(),
             provider_last_status='success',
             submission_token=NULL,
             submission_lease_until=NULL,
             reconcile_lease_until=NULL,
             last_reconciled_at=now(),
             updated_at=now()
       WHERE id=$1`,
     [intentId,receiptNumber]
    );
    const weekly=await getRiderWeeklyBalance(c,intent.rider_id);
    if(weekly.overdueMinor===0){
     const updated=await c.query("UPDATE riders SET financial_restriction=NULL,financial_restriction_at=NULL WHERE id=$1 AND financial_restriction='OVERDUE_CASH_COMMISSION' RETURNING id",[intent.rider_id]);
     if(updated.rowCount>0){
      await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'rider.restriction_cleared_cash_commission',$1)",[intent.rider_id]);
      await recordSettlementNotification(c,{riderId:intent.rider_id,type:'RESTORATION_NOTICE',weekKey:weekly.currentWeekKey,recipient:intent.rider_id,message:'ELESEND Confirmation: Your overdue cash commission has been settled in full. Your dispatch eligibility is restored!'});
     }
    }
    if(wasInactive){
     await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'commission.late_payment_recovered',$2)",[intent.rider_id,intentId]);
    }
    await recordSettlementNotification(c,{riderId:intent.rider_id,type:'PAYMENT_RECEIPT',weekKey:weekly.currentWeekKey,recipient:intent.rider_id,message:`ELESEND Receipt ${receiptNumber}: Received GH₵${(amountMinor/100).toFixed(2)}. Thank you.`});
    // Debt-limit restriction is a pure function of the ledger: it lifts automatically once repaid below the limit.
    await emitDebtTransition(c,intent.rider_id,debtBefore,await debtState(c,intent.rider_id));
    return {status:'confirmed',duplicate:false,lateRecovery:wasInactive,intentId,receiptNumber,collectedMinor:applied,creditPurchasedMinor:creditPurchased,unappliedProviderMinor:unapplied,requiresReconciliation:unapplied>0};
   }));
  },
  async reconcileIntent(intentId,{actor=null,silentUnavailable=false}={}){
   UUID.parse(intentId);
   if(actor){
    if(actor.kind==='rider'){
     const own=(await db.query('SELECT 1 FROM settlement_intents WHERE id=$1 AND rider_id=$2',[intentId,actor.id])).rowCount;
     check(own,404,'Settlement intent not found');
    }else{
     await permit(db,actor,['finance:read','finance:approve','finance:configure']);
    }
   }
   const intent=(await db.query('SELECT * FROM settlement_intents WHERE id=$1',[intentId])).rows[0];
   check(intent,404,'Settlement intent not found');
   const ref=intent.provider_reference||defaultReference(intent.id);
   if(intent.status==='confirmed'){
    return {status:'confirmed',intentId:intent.id,reference:ref,receiptNumber:intent.receipt_number,duplicate:true};
   }
   if(intent.status==='reversed'){
    return {status:'reversed',intentId:intent.id,reference:ref,failureReason:intent.failure_reason??null};
   }
   if(!provider||provider.name!==intent.provider||typeof provider.verifyPayment!=='function'){
    if(silentUnavailable)return {status:intent.status,intentId:intent.id,reference:ref};
    check(false,503,'Payment provider verification unavailable');
   }
   let verified;
   try{
    verified=await withTimeout(provider.verifyPayment(ref),verifyTimeoutMs);
   }catch(e){
    // Provider timeouts and network failures are uncertain outcomes, never proof of failure.
    // Record the attempt time only for backoff; eligibility is governed by provider_terminal_at.
    await db.query('UPDATE settlement_intents SET last_reconciled_at=now(),reconcile_lease_until=NULL WHERE id=$1',[intent.id]).catch(()=>{});
    return {status:'verification_unavailable',intentStatus:intent.status,intentId:intent.id,reference:ref,error:e.code??reasonText(e)};
   }
   const providerStatus=String(verified?.status??'pending').toLowerCase().slice(0,40);
   if(providerStatus==='success'){
    check(verified.reference===ref,409,'Settlement verification reference mismatch');
    check(Number(verified.amountMinor)===Number(intent.amount_minor)&&verified.currency==='GHS',409,'Settlement verification amount or currency mismatch');
    check((await getWalletPolicy(db)).repayment_channels.includes(verified.channel),409,'Commission repayment channel not permitted by wallet policy');
    check(typeof verified.eventId==='string'&&verified.eventId.length>=4,409,'Settlement verification missing event ID');
    return this.confirmed({
     providerName:provider.name,
     eventId:verified.eventId,
     intentId:intent.id,
     amountMinor:Number(verified.amountMinor),
     currency:verified.currency
    });
   }
   // Only an explicit provider failure (not flagged non-terminal by the adapter) or a verified
   // definitive "never created" response ends verification. 'abandoned', 'pending', 'ongoing' and
   // any unknown status are NON-terminal: the payer may still complete the same transaction.
   const terminalFailure=providerStatus==='failed'&&verified?.terminal!==false;
   const definitiveNotCreated=providerStatus==='not_created'&&verified?.verified===true&&verified?.definitiveNoCharge===true;
   return db.tx(async c=>{
    const locked=(await c.query('SELECT * FROM settlement_intents WHERE id=$1 FOR UPDATE',[intent.id])).rows[0];
    if(locked.status==='confirmed')return {status:'confirmed',intentId:locked.id,reference:ref,receiptNumber:locked.receipt_number,duplicate:true};
    if(locked.status==='reversed')return {status:'reversed',intentId:locked.id,reference:ref};
    const touch=()=>c.query('UPDATE settlement_intents SET last_reconciled_at=now(),reconcile_lease_until=NULL,provider_last_status=$2 WHERE id=$1',[locked.id,providerStatus]);
    if(isSubmissionCallActive(locked)){
     return {status:'initiating',submissionInProgress:true,providerStatus,intentId:locked.id,reference:ref};
    }
    const creationActive=canCreationStillComplete(locked);
    // "not_created" is only meaningful for an attempt whose creation can no longer complete.
    const isTerminal=terminalFailure||(definitiveNotCreated&&!creationActive&&locked.status!=='pending');
    if(isTerminal){
     await lockAccount(c,locked.rider_id);
     const reason=String(verified.failureReason||(terminalFailure?'Provider reported failed':'Provider confirmed payment was never created')).slice(0,500);
     if(['initiating','pending'].includes(locked.status)){
      await c.query(
       `UPDATE settlement_intents
           SET status='failed',failure_reason=$2,failed_at=coalesce(failed_at,now()),
               provider_terminal_at=now(),provider_last_status=$3,
               submission_token=NULL,submission_lease_until=NULL,
               last_reconciled_at=now(),reconcile_lease_until=NULL,updated_at=now()
         WHERE id=$1 AND status IN ('initiating','pending')`,
       [locked.id,reason,providerStatus]
      );
      return {status:'failed',terminal:true,intentId:locked.id,reference:ref,failureReason:reason};
     }
     // Already locally expired/failed: keep local status, record the verified terminal outcome.
     await c.query(
      `UPDATE settlement_intents
          SET provider_terminal_at=now(),provider_last_status=$2,
              failure_reason=coalesce(failure_reason,$3),
              last_reconciled_at=now(),reconcile_lease_until=NULL
        WHERE id=$1 AND provider_terminal_at IS NULL`,
      [locked.id,providerStatus,reason]
     );
     return {status:locked.status,terminal:true,intentId:locked.id,reference:ref,failureReason:reason};
    }
    // Non-terminal outcome. Release the rider's active slot once the checkout window elapses,
    // but keep verifying (provider_terminal_at stays NULL) so late success is still recovered.
    const ageSeconds=(Date.now()-new Date(locked.created_at).getTime())/1000;
    if(['initiating','pending'].includes(locked.status)&&ageSeconds>=checkoutExpirySeconds&&!creationActive){
     await lockAccount(c,locked.rider_id);
     await c.query(
      `UPDATE settlement_intents
          SET status='expired',
              failure_reason='Checkout window elapsed without verified payment; provider verification continues',
              provider_last_status=$2,submission_token=NULL,submission_lease_until=NULL,
              last_reconciled_at=now(),reconcile_lease_until=NULL,updated_at=now()
        WHERE id=$1 AND status IN ('initiating','pending')`,
      [locked.id,providerStatus]
     );
     return {status:'expired',providerStatus,verificationContinues:true,intentId:locked.id,reference:ref};
    }
    if(locked.status==='initiating'&&providerStatus!=='not_created'){
     // Provider knows the transaction, so creation succeeded even if its response was lost.
     await lockAccount(c,locked.rider_id);
     const promoted=(await c.query(
      `UPDATE settlement_intents
          SET status='pending',submission_token=NULL,submission_lease_until=NULL,provider_last_status=$2,
              last_reconciled_at=now(),reconcile_lease_until=NULL,updated_at=now()
        WHERE id=$1
          AND status='initiating'
          AND (submission_token IS NULL OR submission_lease_until IS NULL OR submission_lease_until<=now())
          AND NOT EXISTS (
            SELECT 1 FROM settlement_intents other
             WHERE other.rider_id=settlement_intents.rider_id
               AND other.kind=settlement_intents.kind
               AND other.id<>settlement_intents.id
               AND other.status IN ('initiating','pending')
          )
        RETURNING id`,
      [locked.id,providerStatus]
     )).rows[0];
     if(promoted)return {status:'pending',providerStatus,intentId:locked.id,reference:ref};
    }
    await touch();
    return {status:locked.status,providerStatus,submissionInProgress:creationActive,verificationContinues:true,intentId:locked.id,reference:ref};
   });
  },
  async reconcileDue({olderThanSeconds=2,limit=25}={}){
   check(Number.isInteger(olderThanSeconds)&&olderThanSeconds>=0&&Number.isInteger(limit)&&limit>0&&limit<=100,400);
   if(!provider||typeof provider.verifyPayment!=='function')return [];
   // Every intent without a VERIFIED terminal provider outcome stays eligible, including locally
   // expired/failed ones. Backoff grows with age (age/10, capped) to bound provider load.
   const rows=(await db.query(
    `UPDATE settlement_intents
        SET reconcile_lease_until=now()+make_interval(secs=>$3)
      WHERE id IN (
        SELECT id FROM settlement_intents
         WHERE provider=$1
           AND status IN ('initiating','pending','expired','failed')
           AND provider_terminal_at IS NULL
           AND (reconcile_lease_until IS NULL OR reconcile_lease_until<now())
           AND (status<>'initiating' OR submission_token IS NULL OR submission_lease_until IS NULL OR submission_lease_until<=now())
           AND coalesce(last_reconciled_at,submitted_at,updated_at,created_at)
               < now()-make_interval(secs=>greatest($4::double precision,least(extract(epoch FROM now()-created_at)/10,$5::double precision)))
         ORDER BY coalesce(last_reconciled_at,submitted_at,updated_at,created_at) ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id`,
    [provider.name,limit,leaseSeconds,olderThanSeconds,maxVerifyBackoffSeconds]
   )).rows;
   return pool(rows,concurrency,async r=>{
    try{
     return await this.reconcileIntent(r.id,{silentUnavailable:true});
    }catch(e){
     // Evidence mismatches and verification errors keep the intent eligible (never discard money),
     // but are recorded so finance operators can see them in settlementExceptions().
     await db.query('UPDATE settlement_intents SET last_reconciled_at=now(),provider_last_status=$2 WHERE id=$1',[r.id,('verification_error:'+(e.status??503)).slice(0,40)]).catch(()=>{});
     return {intentId:r.id,status:'verification_unavailable',errorCode:e.status??503,error:reasonText(e)};
    }finally{
     await db.query('UPDATE settlement_intents SET reconcile_lease_until=NULL WHERE id=$1',[r.id]).catch(()=>{});
    }
   });
  },
  async paymentStatus(actor,intentId){
   UUID.parse(intentId);
   if(actor?.kind==='rider'){
    const initial=(await db.query('SELECT * FROM settlement_intents WHERE id=$1 AND rider_id=$2',[intentId,actor.id])).rows[0];
    check(initial,404,'Settlement intent not found');
    if(['initiating','pending','expired','failed','rejected'].includes(initial.status)&&provider&&typeof provider.verifyPayment==='function'&&!isSubmissionCallActive(initial)){
     try{await this.reconcileIntent(intentId,{silentUnavailable:true});}catch{}
    }
   }else{
    await permit(db,actor,['finance:read','finance:approve','finance:configure']);
    const initial=(await db.query('SELECT * FROM settlement_intents WHERE id=$1',[intentId])).rows[0];
    check(initial,404,'Settlement intent not found');
    if(['initiating','pending','expired','failed','rejected'].includes(initial.status)&&provider&&typeof provider.verifyPayment==='function'&&!isSubmissionCallActive(initial)){
     try{await this.reconcileIntent(intentId,{silentUnavailable:true});}catch{}
    }
   }
   const row=(await db.query(
    'SELECT id, provider, provider_reference, amount_minor, status, receipt_number, momo_network, momo_phone, checkout_url, payment_instructions, failure_reason, confirmed_at, created_at FROM settlement_intents WHERE id=$1',
    [intentId]
   )).rows[0];
   return {...row,intentId:row.id,reference:row.provider_reference??defaultReference(row.id),amountMinor:Number(row.amount_minor)};
  },
  async reversed({providerName,eventId,intentId,reason='Provider reversal'}){
   UUID.parse(intentId);check(provider?.name===providerName&&typeof eventId==='string'&&eventId.length>=4,403,'Unrecognized provider');
   return db.tx(async c=>{
    const intent=(await c.query('SELECT * FROM settlement_intents WHERE id=$1 FOR UPDATE',[intentId])).rows[0];
    check(intent&&intent.provider===providerName&&['confirmed','reversed'].includes(intent.status),409,'Only confirmed intent may be reversed');
    await lockAccount(c,intent.rider_id);
    const debtBefore=await debtState(c,intent.rider_id);
    const amountMinor=Number(intent.amount_minor);
    const posting=await journal(c,{eventKey:'psp-reversal:'+providerName+':'+eventId,riderId:intent.rider_id,kind:'reinstate',value:amountMinor});
    if(posting.duplicate){
     const weekly=await getRiderWeeklyBalance(c,intent.rider_id);
     return {status:'reversed',duplicate:true,intentId,riderId:intent.rider_id,overdueMinor:weekly.overdueMinor};
    }
    const reversalDate=new Date(Date.now()-14*86400000);
    const reversalWeekKey=getGhanaWeekKey(reversalDate);
    const reinstatedObligationId=randomUUID();
    await c.query(`
      INSERT INTO commission_obligations(id, shipment_id, rider_id, original_minor, due_at, created_at, week_key)
      VALUES($1, NULL, $2, $3, now() - interval '14 days', now() - interval '14 days', $4)
    `,[reinstatedObligationId, intent.rider_id, amountMinor, reversalWeekKey]);
    await c.query("UPDATE settlement_intents SET status='reversed',failure_reason=$2,updated_at=now() WHERE id=$1",[intentId,String(reason||'Provider reversal').slice(0,500)]);
    await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'payment.reversed',$2)",[intent.rider_id,intent.rider_id]);
    const updatedWeekly=await getRiderWeeklyBalance(c,intent.rider_id);
    if(updatedWeekly.overdueMinor>0){
     await c.query("UPDATE riders SET financial_restriction='OVERDUE_CASH_COMMISSION',financial_restriction_at=now() WHERE id=$1",[intent.rider_id]);
    }
    // Reinstated debt is offset first against the rider's own unpaid verified earnings (never fabricated funds).
    const recovery=await recoverDebtFromEarnings(c,intent.rider_id,{trigger:'new_commission_debt'});
    await emitDebtTransition(c,intent.rider_id,debtBefore,await debtState(c,intent.rider_id));
    const finalWeekly=recovery.recoveredMinor>0?await getRiderWeeklyBalance(c,intent.rider_id):updatedWeekly;
    return {status:'reversed',duplicate:false,intentId,riderId:intent.rider_id,overdueMinor:finalWeekly.overdueMinor,recoveredFromEarningsMinor:recovery.recoveredMinor};
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
    await c.query("INSERT INTO commission_obligations(id,shipment_id,rider_id,original_minor,due_at,week_key) VALUES($1,NULL,$2,$3,now()+($4::int*interval '1 day'),$5)",[randomUUID(),a.rider_id,a.amount_minor,pol.settlement_due_days,getGhanaWeekKey(new Date())]);
    await recoverDebtFromEarnings(c,a.rider_id,{trigger:'new_commission_debt'});
   }
   await c.query("UPDATE finance_adjustment_requests SET status='approved',approved_by=$2,decided_at=now() WHERE id=$1",[requestId,actor.id]);await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,'finance.adjustment_approved',a.id]);
   const weekly=await getRiderWeeklyBalance(c,a.rider_id);
   if(weekly.overdueMinor===0){
    await c.query("UPDATE riders SET financial_restriction=NULL,financial_restriction_at=NULL WHERE id=$1 AND financial_restriction='OVERDUE_CASH_COMMISSION'",[a.rider_id]);
   } else if(weekly.overdueMinor>0){
    await c.query("UPDATE riders SET financial_restriction='OVERDUE_CASH_COMMISSION',financial_restriction_at=now() WHERE id=$1",[a.rider_id]);
   }
   return {status:'approved',overdueMinor:weekly.overdueMinor};
  });},
  async adjustmentQueue(actor){return db.tx(async c=>{await permit(c,actor,['finance:read','finance:approve','finance:configure']);return (await c.query('SELECT id,rider_id,direction,amount_minor,reason,requested_by,status,created_at FROM finance_adjustment_requests ORDER BY created_at DESC LIMIT 100')).rows;});},
  /** Commission payments whose provider outcome is not yet verified terminal, plus recovered
   *  payments that left unapplied provider funds needing refund/reconciliation. */
  async settlementExceptions(actor){return db.tx(async c=>{await permit(c,actor,['finance:read','finance:approve','finance:configure']);
   const unresolved=(await c.query(`SELECT id,rider_id,provider,provider_reference,kind,amount_minor,status,provider_last_status,failure_reason,
      created_at,submitted_at,last_reconciled_at
     FROM settlement_intents
     WHERE provider_terminal_at IS NULL AND status IN ('initiating','pending','expired','failed')
       AND (status IN ('expired','failed') OR created_at<now()-interval '1 hour' OR provider_last_status LIKE 'verification_error:%')
     ORDER BY created_at ASC LIMIT 200`)).rows;
   const unapplied=(await c.query(`SELECT j.rider_id,
      coalesce(sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END),0)::bigint AS unapplied_minor
     FROM finance_journals j JOIN finance_lines l ON l.journal_id=j.id
     WHERE l.ledger_code='unapplied_provider_funds'
     GROUP BY j.rider_id HAVING coalesce(sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END),0)<>0
     ORDER BY 2 DESC LIMIT 200`)).rows;
   return {unresolved,unappliedProviderFunds:unapplied.map(r=>({riderId:r.rider_id,unappliedMinor:Number(r.unapplied_minor)}))};
  });},
  async aging(actor){return db.tx(async c=>{await permit(c,actor,['finance:read','finance:approve','finance:configure']);return (await c.query(`SELECT ca.rider_id,ca.max_outstanding_minor,ca.blocked,
   coalesce(sum(CASE WHEN l.ledger_code='rider_receivable' AND l.side='debit' THEN l.amount_minor WHEN l.ledger_code='rider_receivable' AND l.side='credit' THEN -l.amount_minor ELSE 0 END),0)::bigint AS outstanding_minor
 FROM commission_accounts ca LEFT JOIN finance_journals j ON j.rider_id=ca.rider_id LEFT JOIN finance_lines l ON l.journal_id=j.id
 GROUP BY ca.rider_id ORDER BY outstanding_minor DESC LIMIT 100`)).rows;});}
 };
}
