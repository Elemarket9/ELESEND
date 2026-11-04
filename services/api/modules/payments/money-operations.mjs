import {payoutSettings} from './payout-settings.mjs';
import {errorText,pool,raceTimeout} from './async-helpers.mjs';
import {recoverCompanyDebt} from './company-commission.mjs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check,passwordMatches} from '../../security.mjs';
import {checkoutJournal} from './checkout-accounting.mjs';
import {recoverDebtFromEarnings,debtState,lockRiderAccount} from './rider-wallet.mjs';
const uuid=z.string().uuid();

const LIVE_REFUND=['initiating','pending','needs_review'];
const LIVE_PAYOUT=['initiating','pending','needs_review'];

const withTimeout=(promise,ms)=>raceTimeout(promise,ms,()=>Object.assign(Error('Provider verification timed out'),{code:'provider_timeout'}));
const reasonText=e=>errorText(e);

/** Receipt must describe exactly this operation. Echoed values are compared,
 * never substituted with our own identifiers. */
function assertRefundReceipt(r,record,providerName){
 check(record&&record.verified===true,409,'Refund is not independently verified');
 check(record.requestId===r.id,409,'Refund evidence mismatch: request ID');
 check(record.provider===undefined||record.provider===r.provider,409,'Refund evidence mismatch: provider');
 check(r.provider===providerName,409,'Refund evidence mismatch: provider');
 check(record.reference===r.reference,409,'Refund evidence mismatch: reference');
 check(Number(r.amount_minor)===record.amountMinor,409,'Refund evidence mismatch: amount');
 check(r.currency===record.currency,409,'Refund evidence mismatch: currency');
 if(r.provider_id&&record.providerId!=null)check(String(record.providerId)===String(r.provider_id),409,'Refund evidence mismatch: provider ID');
}
function assertPayoutReceipt(p,record,providerName){
 check(record&&record.verified===true,409,'Payout is not independently verified');
 check(record.requestId===p.id,409,'Payout evidence mismatch: request ID');
 check(record.provider===undefined||record.provider===p.provider,409,'Payout evidence mismatch: provider');
 check(p.provider===providerName,409,'Payout evidence mismatch: provider');
 check(record.recipientReference===p.recipient_reference,409,'Payout evidence mismatch: recipient');
 check(Number(p.amount_minor)===record.amountMinor,409,'Payout evidence mismatch: amount');
 check(p.currency===record.currency,409,'Payout evidence mismatch: currency');
 if(p.provider_id&&record.providerId!=null)check(String(record.providerId)===String(p.provider_id),409,'Payout evidence mismatch: provider ID');
}

const settings=payoutSettings();
const WITHDRAWAL_SPEND_LOCK=839212,RESUBMIT_AFTER_SECONDS=300,GIVE_UP_AFTER_SECONDS=86400,MAX_DAILY_FAILURES=3;
export function moneyOperations(db,{provider,verifyTimeoutMs=10000,concurrency=4,leaseSeconds=120,
 withdrawalMinMinor=settings.minMinor,
 withdrawalFeeMinor=settings.feeMinor,
 platformDailyLimitMinor=settings.platformDailyLimitMinor,
 earningsHoldHours=settings.earningsHoldHours,
 securityHoldHours=settings.securityHoldHours}={}){
 async function permit(actor,permissions=['finance:configure']){
  check(actor?.kind==='admin',403,'Administrator required');
  check((await db.query('SELECT 1 FROM permissions WHERE user_id=$1 AND permission=ANY($2::text[])',[actor.id,[permissions].flat()])).rowCount,403,'Finance permission required');
 }
 const READ=['finance:read','finance:configure','finance:approve'];
 async function syncRefunds(){
  await db.query(`INSERT INTO refund_operations(id,source_key,shipment_id,provider,reference,amount_minor,currency)
   SELECT gen_random_uuid(),'cancellation:'||r.shipment_id::text,r.shipment_id,i.provider,i.reference,r.amount_minor,i.currency FROM checkout_refund_requests r JOIN shipment_checkout_intents i ON i.id=r.intent_id WHERE r.status<>'refunded'
   ON CONFLICT(source_key) DO NOTHING`);
  await db.query(`INSERT INTO refund_operations(id,source_key,shipment_id,provider,reference,amount_minor,currency)
   SELECT gen_random_uuid(),'dispute:'||dr.dispute_id::text,dr.shipment_id,i.provider,i.reference,dr.amount_minor,i.currency FROM dispute_refund_requests dr JOIN shipment_checkout_intents i ON i.id=dr.intent_id WHERE dr.status<>'refunded'
   ON CONFLICT(source_key) DO NOTHING`);
  await db.query(`INSERT INTO refund_operations(id,source_key,shipment_id,provider,reference,amount_minor,currency)
   SELECT gen_random_uuid(),'unapplied:'||p.provider||':'||p.event_id,p.shipment_id,p.provider,p.provider_reference,p.amount_minor,p.currency FROM checkout_unapplied_payments p ON CONFLICT(source_key) DO NOTHING`);
 }
 async function recordEvent(c,op,kind,record){
  await c.query(`INSERT INTO payment_operation_events(provider,event_id,operation_id,kind,amount_minor,request_id,provider_reference,status,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
   [op.provider,record.eventId,op.id,kind,op.amount_minor,record.requestId,record.providerId!=null?String(record.providerId):null,record.status,JSON.stringify(record)]);
 }
 async function confirmRefund(record){
  check(record?.status==='refunded',409,'Refund is not independently confirmed');
  uuid.parse(record.requestId);
  check(typeof record.eventId==='string'&&record.eventId.length>=4,409,'Refund evidence mismatch: event');
  return db.tx(async c=>{
   const r=(await c.query('SELECT * FROM refund_operations WHERE id=$1 FOR UPDATE',[record.requestId])).rows[0];
   check(r,409,'Refund evidence mismatch');
   assertRefundReceipt(r,record,provider?.name);
   if(r.status==='refunded')return {id:r.id,status:'refunded',duplicate:true};
   check(LIVE_REFUND.includes(r.status),409,'Refund was not submitted');
   const used=(await c.query('SELECT operation_id FROM payment_operation_events WHERE provider=$1 AND event_id=$2',[r.provider,record.eventId])).rows[0];
   check(!used,409,'Provider receipt already applied to another operation');
   await recordEvent(c,r,'refund',record);
   await checkoutJournal(c,{shipmentId:r.shipment_id,eventKey:'refund:'+r.source_key.split(':retry:')[0],kind:'refund_completed',entries:[['customer_refund_liability','debit',record.amountMinor],['provider_receivable','credit',record.amountMinor]]});
   await c.query("UPDATE refund_operations SET status='refunded',provider_id=coalesce(provider_id,$2),updated_at=now() WHERE id=$1",[r.id,record.providerId!=null?String(record.providerId):null]);
   if(r.source_key.startsWith('cancellation:')){
    await c.query("UPDATE checkout_refund_requests SET status='refunded' WHERE shipment_id=$1",[r.shipment_id]);
    await c.query("UPDATE food_orders SET payment_status='REFUNDED',updated_at=now() WHERE shipment_id=$1",[r.shipment_id]);
   }else if(r.source_key.startsWith('dispute:')){
    const disputeId=r.source_key.split(':retry:')[0].slice('dispute:'.length);
    await c.query("UPDATE dispute_refund_requests SET status='refunded' WHERE dispute_id=$1",[disputeId]);
    const totalRefunded=(await c.query("SELECT coalesce(sum(amount_minor),0)::bigint AS total FROM refund_operations WHERE shipment_id=$1 AND status='refunded' AND source_key NOT LIKE 'unapplied:%'",[r.shipment_id])).rows[0]?.total??0;
    await c.query("UPDATE food_orders SET payment_status=CASE WHEN $2::bigint>=total_minor THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END,updated_at=now() WHERE shipment_id=$1",[r.shipment_id,Number(totalRefunded)]);
   }
   return {id:r.id,status:'refunded',duplicate:false};
  });
 }
 async function failOperation(table,op,record){
  // Only a verified, definitive provider failure for this exact operation.
  return db.tx(async c=>{
   const row=(await c.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,[op.id])).rows[0];
   if(row.status==='failed')return {id:row.id,status:'failed',duplicate:true};
   check((table==='refund_operations'?LIVE_REFUND:LIVE_PAYOUT).includes(row.status),409,'Operation not in flight');
   const used=(await c.query('SELECT 1 FROM payment_operation_events WHERE provider=$1 AND event_id=$2',[row.provider,record.eventId])).rowCount;
   check(!used,409,'Provider receipt already applied to another operation');
   await recordEvent(c,row,table==='refund_operations'?'refund_failed':'payout_failed',record);
   await c.query(`UPDATE ${table} SET status='failed',failure_reason=$2,failed_at=now(),updated_at=now() WHERE id=$1`,[row.id,String(record.failureReason||'Provider reported definitive failure').slice(0,500)]);
   await c.query('INSERT INTO audit_logs(action,entity_id) VALUES($1,$2)',[table+'.failed',row.id]);
   return {id:row.id,status:'failed',duplicate:false};
  });
 }
 async function applyRefundRecord(r,record){
  if(record?.status==='refunded'){
   assertRefundReceipt(r,record,provider?.name);
   return confirmRefund(record);
  }
  if(record?.status==='failed'){
   check(typeof record.eventId==='string'&&record.eventId.length>=4,409,'Failure evidence requires a provider event');
   assertRefundReceipt(r,record,provider?.name);
   return failOperation('refund_operations',r,record);
  }
  if(record&&record.verified===true&&record.requestId===r.id&&record.providerId!=null&&!r.provider_id)
   await db.query('UPDATE refund_operations SET provider_id=$2 WHERE id=$1 AND provider_id IS NULL',[r.id,String(record.providerId)]);
  return {id:r.id,status:r.status==='needs_review'?'needs_review':'pending_verification'};
 }
 async function submitRefundOperation(id,submittedBy){
   check(typeof provider?.createRefund==='function'&&typeof provider?.verifyRefund==='function',503,'Configure an adapter with verified refund support');
   const r=await db.tx(async c=>{
    const row=(await c.query('SELECT * FROM refund_operations WHERE id=$1 FOR UPDATE',[id])).rows[0];
    check(row&&row.provider===provider.name,404,'Refund unavailable for active adapter');
    if(row.status!=='queued')return {...row,existing:true};
    await c.query("UPDATE refund_operations SET status='initiating',submitted_by=$2,submitted_at=coalesce(submitted_at,now()),updated_at=now() WHERE id=$1",[id,submittedBy]);return row;
   });
   if(r.existing)return {id:r.id,status:r.status};
   let receipt;
   try{receipt=await provider.createRefund({requestId:r.id,idempotencyKey:r.id,reference:r.reference,amountMinor:Number(r.amount_minor),currency:r.currency});}
   catch(e){
    // Outcome unknown: never resubmit automatically; verification only.
    await db.query("UPDATE refund_operations SET status='needs_review',failure_reason=$2,updated_at=now() WHERE id=$1 AND status='initiating'",[id,'Submission outcome uncertain: '+reasonText(e)]);
    return {id,status:'needs_review'};
   }
   const pid=receipt?.providerId!=null?String(receipt.providerId):null;
   await db.query("UPDATE refund_operations SET provider_id=coalesce(provider_id,$2),status=CASE WHEN status='initiating' THEN 'pending' ELSE status END,updated_at=now() WHERE id=$1",[id,pid]);
   try{return await reconcileRefund(id);}catch{return {id,status:'pending_verification'};}
  }
 async function reconcileRefund(id){
  const r=(await db.query('SELECT * FROM refund_operations WHERE id=$1',[id])).rows[0];
  check(r&&r.provider===provider?.name,404,'Refund unavailable for active adapter');
  if(['refunded','failed','queued'].includes(r.status))return {id:r.id,status:r.status};
  check(typeof provider.verifyRefund==='function',503,'Active adapter does not support refund verification');
  const record=await withTimeout(provider.verifyRefund({requestId:r.id,providerId:r.provider_id,reference:r.reference,amountMinor:Number(r.amount_minor),currency:r.currency}),verifyTimeoutMs);
  return applyRefundRecord(r,record);
 }
 async function loadWithdrawal(id){return (await db.query('SELECT * FROM payout_withdrawals WHERE id=$1',[id])).rows[0];}
 async function lockIfRider(c,userId){if((await c.query('SELECT 1 FROM riders WHERE id=$1',[userId])).rowCount)await lockRiderAccount(c,userId);}
 /** Returns every delivery in the withdrawal to the available balance. */
 async function releaseWithdrawal(c,row,status,reason){
  const text=String(reason||'Provider reported definitive failure').slice(0,500);
  await c.query("UPDATE payout_operations SET status='failed',failed_at=now(),failure_reason=$2,updated_at=now() WHERE withdrawal_id=$1",[row.id,text]);
  await c.query('UPDATE payout_withdrawals SET status=$2,failure_reason=$3,updated_at=now() WHERE id=$1',[row.id,status,text]);
  await c.query('INSERT INTO audit_logs(action,entity_id) VALUES($1,$2)',['payout_withdrawal.'+status,row.id]);
 }
 /** One verified transfer settles every delivery in the withdrawal, or none of them. */
 async function applyWithdrawalRecord(w,record){
  if(!['paid','failed'].includes(record?.status))return {id:w.id,status:w.status==='needs_review'?'needs_review':'pending_verification'};
  check(typeof record.eventId==='string'&&record.eventId.length>=4,409,'Withdrawal evidence requires a provider event');
  assertPayoutReceipt(w,record,provider?.name);
  return db.tx(async c=>{
   await lockIfRider(c,w.beneficiary_id);
   const row=(await c.query('SELECT * FROM payout_withdrawals WHERE id=$1 FOR UPDATE',[w.id])).rows[0];
   const target=record.status==='paid'?'paid':record.reversed?'reversed':'failed';
   if(row.status===target)return {id:row.id,status:row.status,duplicate:true};
   const reversingPaid=row.status==='paid'&&target==='reversed';
   // Paid after the money was released: block more withdrawals now, so the same money cannot leave twice.
   if(target==='paid'&&['failed','reversed'].includes(row.status)){
    const held=await c.query('INSERT INTO payout_holds(user_id,withdrawal_id,reason) VALUES($1,$2,$3) ON CONFLICT(user_id) DO NOTHING RETURNING user_id',[row.beneficiary_id,row.id,'Provider paid a withdrawal already released to the balance']);
    if(held.rowCount){
     await c.query("INSERT INTO audit_logs(action,entity_id) VALUES('payout_withdrawal.paid_after_release',$1)",[row.id]);
    }
    return {id:row.id,status:'paid_after_release',duplicate:!held.rowCount};
   }
   check(LIVE_PAYOUT.includes(row.status)||reversingPaid,409,'Withdrawal not in flight');
   check(!(await c.query('SELECT 1 FROM payment_operation_events WHERE provider=$1 AND event_id=$2',[row.provider,record.eventId])).rowCount,409,'Provider receipt already applied to another operation');
   await recordEvent(c,row,target==='paid'?'payout':'payout_failed',record);
   // Shipments before payouts, in a fixed order, matching dispute resolution.
   await c.query('SELECT id FROM shipments WHERE id IN (SELECT shipment_id FROM payout_operations WHERE withdrawal_id=$1) ORDER BY id FOR UPDATE',[row.id]);
   const items=(await c.query('SELECT * FROM payout_operations WHERE withdrawal_id=$1 FOR UPDATE',[row.id])).rows;
   const payableAccount=item=>item.kind==='restaurant'?'restaurant_payable':'rider_payable';
   if(target==='paid'){
    check(items.reduce((sum,item)=>sum+Number(item.amount_minor),0)===Number(row.amount_minor)+Number(row.fee_minor),409,'Withdrawal does not match its deliveries');
    for(const item of items){
     await checkoutJournal(c,{shipmentId:item.shipment_id,eventKey:'payout:'+item.shipment_id+':'+item.kind+':'+row.id,kind:'payout_completed',entries:[[payableAccount(item),'debit',Number(item.amount_minor)],['provider_receivable','credit',Number(item.amount_minor)]]});
     if(item.kind==='restaurant')await c.query("UPDATE restaurant_settlements SET status='settled',settled_at=now() WHERE order_id IN (SELECT id FROM food_orders WHERE shipment_id=$1)",[item.shipment_id]);
    }
    await c.query("UPDATE payout_operations SET status='paid',updated_at=now() WHERE withdrawal_id=$1",[row.id]);
    await c.query("UPDATE payout_withdrawals SET status='paid',provider_id=coalesce(provider_id,$2),updated_at=now() WHERE id=$1",[row.id,record.providerId!=null?String(record.providerId):null]);
    return {id:row.id,status:'paid',duplicate:false};
   }
   // Money the provider sent back after a success goes back on the ledger and becomes available again.
   if(reversingPaid)for(const item of items){
    await checkoutJournal(c,{shipmentId:item.shipment_id,eventKey:'payout-reversal:'+item.shipment_id+':'+item.kind+':'+row.id,kind:'payout_reversed',entries:[['provider_receivable','debit',Number(item.amount_minor)],[payableAccount(item),'credit',Number(item.amount_minor)]]});
    if(item.kind==='restaurant')await c.query("UPDATE restaurant_settlements SET status='accrued',settled_at=NULL WHERE order_id IN (SELECT id FROM food_orders WHERE shipment_id=$1)",[item.shipment_id]);
   }
   await releaseWithdrawal(c,row,target,record.failureReason);
   return {id:row.id,status:target,duplicate:false};
  });
 }
 async function failLocally(w,reason){
  return db.tx(async c=>{
   await lockIfRider(c,w.beneficiary_id);
   const row=(await c.query('SELECT * FROM payout_withdrawals WHERE id=$1 FOR UPDATE',[w.id])).rows[0];
   if(!LIVE_PAYOUT.includes(row.status))return {id:row.id,status:row.status};
   await releaseWithdrawal(c,row,'failed',reason);
   return {id:row.id,status:'failed',amountMinor:Number(row.amount_minor)};
  });
 }
 async function reconcileWithdrawal(w){
  check(typeof provider?.verifyPayout==='function',503,'Active adapter does not support payout verification');
  const record=await withTimeout(provider.verifyPayout({requestId:w.id,providerId:w.provider_id,recipientReference:w.recipient_reference,amountMinor:Number(w.amount_minor),currency:w.currency}),verifyTimeoutMs);
  if(record?.status!=='not_found')return applyWithdrawalRecord(w,record);
  // The provider has no such transfer. Resending the same reference cannot pay twice, so this needs no staff.
  const age=(Date.now()-new Date(w.created_at).getTime())/1000,idle=(Date.now()-new Date(w.updated_at).getTime())/1000;
  // Never released automatically: "not found" could be wrong, and a second payment could follow. Staff are told.
  if(age>GIVE_UP_AFTER_SECONDS&&!w.stuck_flagged_at){
   await db.query("UPDATE payout_withdrawals SET stuck_flagged_at=now() WHERE id=$1",[w.id]);
  }
  if(idle<RESUBMIT_AFTER_SECONDS)return {id:w.id,status:w.status};
  return submitWithdrawal(w);
 }
 async function submitWithdrawal(w){
  const amountMinor=Number(w.amount_minor);
  let receipt;
  try{
   // Re-check the destination at the last moment, so an altered record cannot redirect the money.
   if(typeof provider.verifyBeneficiary==='function'){
    const user=(await db.query('SELECT phone FROM users WHERE id=$1',[w.beneficiary_id])).rows[0];
    const owned=await provider.verifyBeneficiary({beneficiaryId:w.beneficiary_id,recipientReference:w.recipient_reference,verifiedPhone:user?.phone});
    if(owned?.verified!==true){
     // A release is only safe if the provider has never been asked to pay this withdrawal.
     if(!w.provider_attempted_at)return failLocally(w,'Payout destination no longer matches the verified phone number');
     await db.query("UPDATE payout_withdrawals SET status='needs_review',failure_reason=$2,updated_at=now() WHERE id=$1 AND status IN ('initiating','pending','needs_review')",[w.id,'Destination check failed after an earlier attempt']);
     return {id:w.id,status:'needs_review',amountMinor};
    }
   }
   await db.query('UPDATE payout_withdrawals SET provider_attempted_at=coalesce(provider_attempted_at,now()) WHERE id=$1',[w.id]);
   receipt=await provider.createPayout({requestId:w.id,idempotencyKey:w.id,recipientReference:w.recipient_reference,amountMinor,currency:w.currency});
  }catch(e){
   // The transfer may have gone through, so it stays locked until the provider says what happened.
   await db.query("UPDATE payout_withdrawals SET status='needs_review',failure_reason=$2,updated_at=now() WHERE id=$1 AND status IN ('initiating','needs_review')",[w.id,'Submission outcome uncertain: '+reasonText(e)]);
   return {id:w.id,status:'needs_review',amountMinor};
  }
  await db.query("UPDATE payout_withdrawals SET status=CASE WHEN status IN ('initiating','needs_review') THEN 'pending' ELSE status END,provider_id=coalesce(provider_id,$2),updated_at=now() WHERE id=$1",[w.id,receipt?.providerId!=null?String(receipt.providerId):null]);
  const fresh=await loadWithdrawal(w.id);
  try{return {...await reconcileWithdrawal(fresh),amountMinor};}catch{return {id:w.id,status:'pending_verification',amountMinor};}
 }
 async function availableEarnings(c,kind,scope,userId){
  const account=kind==='restaurant'?'restaurant_payable':'rider_payable';
  return (await c.query(`SELECT s.id AS shipment_id,s.company_id,$2::text AS kind,sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END)::bigint AS amount
    FROM shipments s JOIN checkout_accounting_journals j ON j.shipment_id=s.id JOIN checkout_accounting_lines l ON l.journal_id=j.id AND l.account=$3
    WHERE ${scope} AND s.state IN ('COMPLETED','RETURNED','CANCELLED') AND s.paid AND s.payment_method<>'CASH'
      AND coalesce(s.completed_at,s.created_at)<=now()-make_interval(hours=>$4)
      AND NOT EXISTS(SELECT 1 FROM payout_operations p WHERE p.shipment_id=s.id AND p.kind=$2 AND p.status NOT IN ('failed','superseded'))
      ${kind==='restaurant'?"AND NOT EXISTS(SELECT 1 FROM food_orders f JOIN restaurant_settlements rs ON rs.order_id=f.id WHERE f.shipment_id=s.id AND rs.status<>'accrued')":''}
    GROUP BY s.id HAVING sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END)>0 ORDER BY min(coalesce(s.completed_at,s.created_at)) LIMIT 500`,[userId,kind,account,earningsHoldHours])).rows;
 }
 /** Every automatic safety check lives here. Anything that fails leaves the money in the balance. */
 async function createWithdrawal(c,userId,{idempotencyKey,earnings}){
  const prior=(await c.query('SELECT * FROM payout_withdrawals WHERE beneficiary_id=$1 AND idempotency_key=$2',[userId,idempotencyKey])).rows[0];
  if(prior)return {existing:prior};
  check(!(await c.query("SELECT 1 FROM payout_withdrawals WHERE beneficiary_id=$1 AND status IN ('initiating','pending','needs_review')",[userId])).rowCount,409,'You already have a withdrawal in progress');
  check(!(await c.query("SELECT 1 FROM payout_withdrawals WHERE beneficiary_id=$1 AND status NOT IN ('failed','reversed') AND (created_at AT TIME ZONE 'UTC')::date=(now() AT TIME ZONE 'UTC')::date",[userId])).rowCount,429,'You can withdraw once a day. Please try again tomorrow');
  check(!(await c.query('SELECT 1 FROM payout_holds WHERE user_id=$1',[userId])).rowCount,423,'Withdrawals are on hold on this account. Please contact support');
  const user=(await c.query('SELECT phone_verified_at,credentials_changed_at,deleted_at FROM users WHERE id=$1',[userId])).rows[0];
  check(user?.phone_verified_at&&!user.deleted_at,403,'Verify your phone number before withdrawing');
  const holdUntil=changed=>changed?new Date(changed).getTime()+securityHoldHours*3600000:0;
  check(holdUntil(user.credentials_changed_at)<=Date.now(),423,`For your security, withdrawals resume ${securityHoldHours} hours after a password change`);
  const beneficiary=(await c.query('SELECT * FROM payout_beneficiaries WHERE user_id=$1 AND provider=$2',[userId,provider.name])).rows[0];
  check(beneficiary,409,'Add your payout details first');
  check(holdUntil(beneficiary.destination_changed_at)<=Date.now(),423,`For your security, withdrawals resume ${securityHoldHours} hours after payout details change`);
  const stats=(await c.query("SELECT count(*) FILTER(WHERE status IN ('failed','reversed'))::int AS failures FROM payout_withdrawals WHERE beneficiary_id=$1 AND created_at>now()-interval '24 hours'",[userId])).rows[0];
  check(stats.failures<MAX_DAILY_FAILURES,429,'Several withdrawals failed today. Check your Mobile Money account and try again tomorrow');
  const grossMinor=earnings.reduce((sum,e)=>sum+Number(e.amount),0);
  check(grossMinor>=withdrawalMinMinor&&grossMinor>withdrawalFeeMinor,409,`You need at least GH₵${(withdrawalMinMinor/100).toFixed(2)} available to withdraw`);
  // The person pays the transfer fee, so what leaves the provider balance equals what they earned.
  const amountMinor=grossMinor-withdrawalFeeMinor;
  // An optional platform-wide ceiling, off unless configured.
  if(platformDailyLimitMinor>0){
  await c.query('SELECT pg_advisory_xact_lock($1)',[WITHDRAWAL_SPEND_LOCK]);
  const platform=Number((await c.query("SELECT coalesce(sum(amount_minor),0)::bigint AS total FROM payout_withdrawals WHERE status NOT IN ('failed','reversed') AND created_at>now()-interval '24 hours'")).rows[0].total);
  if(platform+amountMinor>platformDailyLimitMinor){
   process.stderr.write(JSON.stringify({level:'error',component:'withdrawals',code:'platform_daily_limit_reached'})+'\n');
   check(false,503,'Withdrawals are paused for now. Your money is safe, please try again later');
  }
  }
  const id=randomUUID();
  const created=(await c.query("INSERT INTO payout_withdrawals(id,beneficiary_id,idempotency_key,provider,recipient_reference,amount_minor,fee_minor,submitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()) RETURNING *",[id,userId,idempotencyKey,provider.name,beneficiary.recipient_reference,amountMinor,withdrawalFeeMinor])).rows[0];
  for(const e of earnings)await c.query("INSERT INTO payout_operations(id,shipment_id,kind,beneficiary_id,company_id,provider,recipient_reference,amount_minor,proposed_by,status,submitted_at,withdrawal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$4,'initiating',now(),$9)",[randomUUID(),e.shipment_id,e.kind,userId,e.company_id,provider.name,beneficiary.recipient_reference,Number(e.amount),id]);
  await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'payout_withdrawal.created',$2)",[userId,id]);
  return {created};
 }
 async function confirmPayout(record){
  check(record?.status==='paid',409,'Payout is not independently confirmed');uuid.parse(record.requestId);
  const withdrawal=await loadWithdrawal(record.requestId);
  if(withdrawal)return applyWithdrawalRecord(withdrawal,record);
  check(typeof record.eventId==='string'&&record.eventId.length>=4,409,'Payout evidence mismatch: event');
  return db.tx(async c=>{
   // Same lock order as approval and dispute resolution: rider account, shipment, then payout.
   const pre=(await c.query('SELECT o.kind,o.shipment_id,s.rider_id,s.company_id FROM payout_operations o JOIN shipments s ON s.id=o.shipment_id WHERE o.id=$1',[record.requestId])).rows[0];
   check(pre,409,'Payout evidence mismatch');
   if(pre.kind==='rider'&&pre.rider_id&&!pre.company_id)await lockRiderAccount(c,pre.rider_id);
   await c.query('SELECT id FROM shipments WHERE id=$1 FOR UPDATE',[pre.shipment_id]);
   const p=(await c.query('SELECT * FROM payout_operations WHERE id=$1 FOR UPDATE',[record.requestId])).rows[0];
   check(p,409,'Payout evidence mismatch');
   assertPayoutReceipt(p,record,provider?.name);
   if(p.status==='paid')return {id:p.id,status:'paid',duplicate:true};
   check(p.approved_by&&LIVE_PAYOUT.includes(p.status),409,'Payout was not approved and submitted');
   const used=(await c.query('SELECT 1 FROM payment_operation_events WHERE provider=$1 AND event_id=$2',[p.provider,record.eventId])).rowCount;
   check(!used,409,'Provider receipt already applied to another operation');
   await recordEvent(c,p,'payout',record);
   await checkoutJournal(c,{shipmentId:p.shipment_id,eventKey:'payout:'+p.shipment_id+':'+p.kind,kind:'payout_completed',entries:[[p.kind==='restaurant'?'restaurant_payable':'rider_payable','debit',record.amountMinor],['provider_receivable','credit',record.amountMinor]]});
   await c.query("UPDATE payout_operations SET status='paid',provider_id=coalesce(provider_id,$2),updated_at=now() WHERE id=$1",[p.id,record.providerId!=null?String(record.providerId):null]);
   if(p.kind==='restaurant')await c.query("UPDATE restaurant_settlements SET status='settled',settled_at=now() WHERE order_id IN (SELECT id FROM food_orders WHERE shipment_id=$1)",[p.shipment_id]);
   return {id:p.id,status:'paid',duplicate:false};
  });
 }
 async function applyPayoutRecord(p,record){
  if(record?.status==='paid'){
   assertPayoutReceipt(p,record,provider?.name);
   return confirmPayout(record);
  }
  if(record?.status==='failed'){
   check(typeof record.eventId==='string'&&record.eventId.length>=4,409,'Failure evidence requires a provider event');
   assertPayoutReceipt(p,record,provider?.name);
   return failOperation('payout_operations',p,record);
  }
  return {id:p.id,status:p.status==='needs_review'?'needs_review':'pending_verification'};
 }
 async function verifyPayoutOp(p){
  check(typeof provider?.verifyPayout==='function',503,'Active adapter does not support payout verification');
  const record=await withTimeout(provider.verifyPayout({requestId:p.id,providerId:p.provider_id,recipientReference:p.recipient_reference,amountMinor:Number(p.amount_minor),currency:p.currency}),verifyTimeoutMs);
  return applyPayoutRecord(p,record);
 }
 async function claim(table,limit,olderThanSeconds=2){
  return (await db.query(`UPDATE ${table} SET reconcile_lease_until=now()+make_interval(secs=>$3) WHERE id IN (
    SELECT id FROM ${table} WHERE provider=$1 AND status IN ('initiating','pending','needs_review')
    AND (reconcile_lease_until IS NULL OR reconcile_lease_until<now())
    ${table==='payout_operations'?'AND withdrawal_id IS NULL':''}
    AND coalesce(last_reconciled_at,submitted_at,updated_at,created_at)<now()-make_interval(secs=>$4)
    ORDER BY coalesce(last_reconciled_at,submitted_at,updated_at,created_at) LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING *`,[provider.name,limit,leaseSeconds,olderThanSeconds])).rows;
 }
 async function release(table,id){await db.query(`UPDATE ${table} SET reconcile_lease_until=NULL,last_reconciled_at=now() WHERE id=$1`,[id]);}
 async function liveRefundExists(c,root){
  return (await c.query("SELECT 1 FROM refund_operations WHERE (source_key=$1 OR source_key LIKE $1||':retry:%') AND status NOT IN ('failed')",[root])).rowCount>0;
 }
 return {
  confirmRefund,confirmPayout,syncRefunds,
  /** Bounded, lease-based: safe across restarts and multiple instances. */
  async reconcileDue({limit=25,olderThanSeconds=2}={}){
   if(!provider)return [];
   const results=[];
   if(typeof provider.verifyRefund==='function'){
    const rows=await claim('refund_operations',limit,olderThanSeconds);
    results.push(...await pool(rows,concurrency,async r=>{try{return await reconcileRefund(r.id);}catch(e){return {id:r.id,status:'verification_unavailable',error:e.code??'error'};}finally{await release('refund_operations',r.id).catch(()=>{});}}));
   }
   if(typeof provider.verifyPayout==='function'){
    const rows=await claim('payout_operations',limit,olderThanSeconds);
    const withdrawals=await claim('payout_withdrawals',limit,olderThanSeconds);
    // Released withdrawals are rechecked for a week, in case the provider pays one late.
    const released=(await db.query("UPDATE payout_withdrawals SET last_reconciled_at=now() WHERE id IN (SELECT id FROM payout_withdrawals WHERE provider=$1 AND status IN ('failed','reversed') AND provider_attempted_at IS NOT NULL AND updated_at>now()-interval '7 days' AND coalesce(last_reconciled_at,updated_at)<now()-interval '1 hour' ORDER BY coalesce(last_reconciled_at,updated_at) LIMIT $2) RETURNING *",[provider.name,limit])).rows;
    results.push(...await pool(released,concurrency,async w=>{try{return await reconcileWithdrawal(w);}catch(e){return {id:w.id,status:'verification_unavailable',error:e.code??'error'};}}));
    results.push(...await pool(withdrawals,concurrency,async w=>{try{return await reconcileWithdrawal(w);}catch(e){return {id:w.id,status:'verification_unavailable',error:e.code??'error'};}finally{await release('payout_withdrawals',w.id);}}));
    results.push(...await pool(rows,concurrency,async p=>{try{return await verifyPayoutOp(p);}catch(e){return {id:p.id,status:'verification_unavailable',error:e.code??'error'};}finally{await release('payout_operations',p.id).catch(()=>{});}}));
   }
   return results;
  },
  async refunds(actor){await permit(actor,READ);await syncRefunds();return (await db.query('SELECT * FROM refund_operations ORDER BY created_at DESC LIMIT 100')).rows;},
  async exceptions(actor){
   await permit(actor,READ);
   const refunds=(await db.query("SELECT 'refund' AS kind,id,shipment_id,provider,amount_minor,currency,status,failure_reason,failed_at,submitted_at,last_reconciled_at,updated_at,retry_of FROM refund_operations WHERE status IN ('failed','needs_review') OR (status IN ('initiating','pending') AND coalesce(submitted_at,updated_at,created_at)<now()-interval '1 hour') ORDER BY coalesce(submitted_at,updated_at,created_at) LIMIT 200")).rows;
   const payouts=(await db.query("SELECT 'payout' AS kind,id,shipment_id,provider,amount_minor,currency,status,failure_reason,failed_at,submitted_at,last_reconciled_at,updated_at,retry_of,beneficiary_id,company_id FROM payout_operations WHERE status IN ('failed','needs_review') OR (status IN ('initiating','pending') AND coalesce(submitted_at,updated_at,created_at)<now()-interval '1 hour') ORDER BY coalesce(submitted_at,updated_at,created_at) LIMIT 200")).rows;
   return {refunds,payouts};
  },
  async submitRefund(actor,id){
   await permit(actor);uuid.parse(id);
   return submitRefundOperation(id,actor.id);
  },
  /** A cancelled order was never collected, as the database enforces, so the money can go back without waiting for staff. */
  async refundUncollectedOrders({limit=20}={}){
   if(process.env.AUTOMATIC_REFUNDS==='false'||typeof provider?.createRefund!=='function'||typeof provider?.verifyRefund!=='function')return [];
   const due=(await db.query(`SELECT o.id FROM refund_operations o JOIN shipments s ON s.id=o.shipment_id WHERE o.status='queued' AND o.retry_of IS NULL AND o.provider=$1 AND o.source_key LIKE 'cancellation:%'
     AND s.state='CANCELLED'
     ORDER BY o.created_at LIMIT $2`,[provider.name,limit])).rows;
   const results=[];
   for(const {id} of due)results.push(await submitRefundOperation(id,null).catch(e=>({id,status:'error',reason:reasonText(e)})));
   return results;
  },
  async reconcileRefund(actor,id){await permit(actor);uuid.parse(id);return reconcileRefund(id);},
  /** New operation only after a verified definitive failure; one live attempt per refund. */
  async retryRefund(actor,id){
   await permit(actor);uuid.parse(id);
   return db.tx(async c=>{
    const old=(await c.query('SELECT * FROM refund_operations WHERE id=$1 FOR UPDATE',[id])).rows[0];
    check(old,404,'Refund unavailable');check(old.status==='failed',409,'Only definitively failed refunds can be retried');
    const root=old.source_key.split(':retry:')[0];
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['refund:'+root]);
    check(!(await liveRefundExists(c,root)),409,'A refund attempt is already active or completed');
    const prior=(await c.query('SELECT id FROM refund_operations WHERE retry_of=$1',[id])).rows[0];if(prior)return {id:prior.id,status:'exists'};
    const nid=randomUUID();
    const row=(await c.query(`INSERT INTO refund_operations(id,source_key,shipment_id,provider,reference,amount_minor,currency,retry_of) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[nid,root+':retry:'+nid,old.shipment_id,old.provider,old.reference,old.amount_minor,old.currency,old.id])).rows[0];
    await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,'refund.retry_queued',nid]);
    return row;
   });
  },
  async verifyBeneficiary(actor,input){
   check(actor?.id,403,'Authentication required');
   const v=z.union([
    z.object({recipientReference:z.string().min(3).max(160)}).strict(),
    z.object({momoNetwork:z.enum(['MTN','TELECEL','AT']),accountName:z.string().trim().min(2).max(100)}).strict()
   ]).parse(input);
   check(typeof provider?.verifyBeneficiary==='function',503,'Adapter beneficiary verification unavailable');
   let verifiedPhone;
   if(provider.requiresVerifiedPhone){
    const user=(await db.query('SELECT phone,phone_verified_at FROM users WHERE id=$1',[actor.id])).rows[0];
    check(user?.phone_verified_at,403,'Verify your phone number before adding payout details');
    verifiedPhone=user.phone;
   }
   let recipientReference=v.recipientReference;
   if(!recipientReference){
    check(typeof provider.createBeneficiary==='function',503,'Adapter cannot create payout recipients');
    recipientReference=(await provider.createBeneficiary({phone:verifiedPhone,network:v.momoNetwork,accountName:v.accountName})).recipientReference;
   }
   const r=await provider.verifyBeneficiary({beneficiaryId:actor.id,recipientReference,...(verifiedPhone?{verifiedPhone}:{})});
   check(r.verified===true&&r.beneficiaryId===actor.id&&r.recipientReference===recipientReference,409,'Beneficiary ownership not verified');
   await db.query(`INSERT INTO payout_beneficiaries(user_id,provider,recipient_reference) VALUES($1,$2,$3) ON CONFLICT(user_id,provider) DO UPDATE SET destination_changed_at=CASE WHEN payout_beneficiaries.recipient_reference<>excluded.recipient_reference THEN now() ELSE payout_beneficiaries.destination_changed_at END,recipient_reference=excluded.recipient_reference,verified_at=now()`,[actor.id,provider.name,recipientReference]);
   return {verified:true};
  },
  /** Pays the rider's available balance as one transfer through the provider, with no staff step. */
  async requestWithdrawal(actor,input){
   check(actor?.kind==='rider',403,'Rider account required');
   const v=z.object({idempotencyKey:z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),password:z.string().min(1).max(256)}).strict().parse(input);
   check(typeof provider?.createPayout==='function'&&typeof provider?.verifyPayout==='function',503,'Withdrawals are not available yet');
   // A stolen or unlocked phone is not enough to move money.
   const stored=(await db.query('SELECT password_hash FROM users WHERE id=$1',[actor.id])).rows[0]?.password_hash;
   check(stored&&await passwordMatches(v.password,stored),403,'Incorrect password');
   const result=await db.tx(async c=>{
    await lockRiderAccount(c,actor.id);
    const rider=(await c.query('SELECT status FROM riders WHERE id=$1',[actor.id])).rows[0];
    check(rider?.status==='approved',403,'Withdrawals are unavailable on this account');
    await recoverDebtFromEarnings(c,actor.id,{trigger:'payout_precheck'});
    check((await debtState(c,actor.id)).debtMinor===0,409,'Your earnings first repay your outstanding commission');
    const earnings=await availableEarnings(c,'rider','s.rider_id=$1 AND s.company_id IS NULL',actor.id);
    return createWithdrawal(c,actor.id,{idempotencyKey:v.idempotencyKey,earnings});
   });
   if(result.existing)return {id:result.existing.id,status:result.existing.status,amountMinor:Number(result.existing.amount_minor),feeMinor:Number(result.existing.fee_minor)};
   return submitWithdrawal(result.created);
  },
  /** Pays restaurants and delivery companies automatically, once per day per owner. */
  async settleBusinessesDue({limit=50}={}){
   if(typeof provider?.createPayout!=='function'||typeof provider?.verifyPayout!=='function')return [];
   const owners=(await db.query(`SELECT b.user_id FROM payout_beneficiaries b WHERE b.provider=$1 AND (
     EXISTS(SELECT 1 FROM restaurants r WHERE r.owner_id=b.user_id) OR EXISTS(SELECT 1 FROM companies co WHERE co.owner_id=b.user_id AND co.status='approved'))
     ORDER BY b.user_id LIMIT $2`,[provider.name,limit])).rows;
   const idempotencyKey='auto-'+new Date().toISOString().slice(0,10);
   const results=[];
   for(const {user_id:userId} of owners){
    try{
     const result=await db.tx(c=>(async()=>{
      for(const co of (await c.query("SELECT id FROM companies WHERE owner_id=$1 AND status='approved'",[userId])).rows)await recoverCompanyDebt(c,co.id);
      const food=await availableEarnings(c,'restaurant','s.id IN (SELECT f.shipment_id FROM food_orders f JOIN restaurants r ON r.id=f.restaurant_id WHERE r.owner_id=$1)',userId);
      const fleet=await availableEarnings(c,'rider',"s.company_id IN (SELECT id FROM companies WHERE owner_id=$1 AND status='approved')",userId);
      const earnings=[...food,...fleet];
      if(!earnings.length)return {};
      return createWithdrawal(c,userId,{idempotencyKey,earnings});
     })());
     if(result.created)results.push(await submitWithdrawal(result.created));
    }catch(e){results.push({userId,status:'skipped',reason:e.message});}
   }
   return results;
  },
  /** Last resort for a transfer the provider still cannot find after a day. Late payment is caught by the recheck. */
  async releaseUnsentWithdrawal(actor,id,input){
   await permit(actor,'finance:approve');uuid.parse(id);
   const {reason}=z.object({reason:z.string().trim().min(10).max(500)}).strict().parse(input);
   const w=await loadWithdrawal(id);
   check(w&&LIVE_PAYOUT.includes(w.status),409,'Withdrawal is not in progress');
   check(Date.now()-new Date(w.created_at).getTime()>GIVE_UP_AFTER_SECONDS*1000,409,'Wait 24 hours before releasing a withdrawal');
   const record=await withTimeout(provider.verifyPayout({requestId:w.id,providerId:w.provider_id,recipientReference:w.recipient_reference,amountMinor:Number(w.amount_minor),currency:w.currency}),verifyTimeoutMs);
   check(record?.status==='not_found',409,'The provider has a record of this transfer, so it cannot be released');
   await db.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,'payout_withdrawal.manual_release:'+reason,id]);
   return failLocally(w,'Released by finance: '+reason);
  },
  async withdrawals(actor){await permit(actor,READ);return (await db.query('SELECT id,beneficiary_id,amount_minor,fee_minor,currency,status,provider_id,failure_reason,stuck_flagged_at,created_at,updated_at,(SELECT reason FROM payout_holds h WHERE h.withdrawal_id=payout_withdrawals.id) AS hold_reason FROM payout_withdrawals ORDER BY created_at DESC LIMIT 100')).rows;},
  /** Handles a verified provider reversal. Returns null for payouts that are not withdrawals. */
  async reverseWithdrawal(record){
   uuid.parse(record.requestId);
   const w=await loadWithdrawal(record.requestId);
   return w?applyWithdrawalRecord(w,record):null;
  },
  async payouts(actor){await permit(actor,READ);return (await db.query('SELECT * FROM payout_operations ORDER BY created_at DESC LIMIT 100')).rows;},
  async proposePayout(actor,input){
   await permit(actor);const v=z.object({shipmentId:uuid,kind:z.enum(['restaurant','rider'])}).strict().parse(input);
   check(typeof provider?.createPayout==='function'&&typeof provider?.verifyPayout==='function',503,'Configure an adapter with verified payout support');
   return db.tx(async c=>{
    // Lock order: rider commission account -> shipment. Debt recovery holds the account and then takes FK
    // key-share locks on earning shipments, so taking the shipment first here would deadlock.
    const pre=(await c.query('SELECT rider_id,company_id FROM shipments WHERE id=$1',[v.shipmentId])).rows[0];
    if(v.kind==='rider'&&pre?.rider_id&&!pre.company_id)await lockRiderAccount(c,pre.rider_id);
    const s=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[v.shipmentId])).rows[0];check(s?.state==='COMPLETED'&&s.paid&&s.payment_method!=='CASH',409,'Completed prepaid delivery required');
    const old=(await c.query("SELECT * FROM payout_operations WHERE shipment_id=$1 AND kind=$2 AND status NOT IN ('failed','superseded')",[s.id,v.kind])).rows[0];if(old)return old;
    check(!(await c.query("SELECT 1 FROM payout_operations WHERE shipment_id=$1 AND kind=$2 AND status='failed'",[s.id,v.kind])).rowCount,409,'A failed payout exists; use the retry action');
    await applyRiderDebtBeforePayout(c,s,v.kind);
    const {beneficiaryId,companyId}=await resolveBeneficiary(c,s,v.kind);
    const beneficiary=(await c.query('SELECT * FROM payout_beneficiaries WHERE user_id=$1 AND provider=$2',[beneficiaryId,provider.name])).rows[0];check(beneficiary,409,'Verified payout destination required');
    const amount=await payable(c,s.id,v.kind);
    return (await c.query(`INSERT INTO payout_operations(id,shipment_id,kind,beneficiary_id,company_id,provider,recipient_reference,amount_minor,proposed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[randomUUID(),s.id,v.kind,beneficiaryId,companyId,provider.name,beneficiary.recipient_reference,amount,actor.id])).rows[0];
   });
  },
  async retryPayout(actor,id){
   await permit(actor);uuid.parse(id);
   check(typeof provider?.createPayout==='function'&&typeof provider?.verifyPayout==='function',503,'Configure an adapter with verified payout support');
   return db.tx(async c=>{
    const pre=(await c.query('SELECT id,shipment_id,kind,company_id,provider FROM payout_operations WHERE id=$1',[id])).rows[0];
    check(pre&&pre.provider===provider.name,404,'Payout unavailable');
    const shipPre=(await c.query('SELECT id,rider_id,company_id FROM shipments WHERE id=$1',[pre.shipment_id])).rows[0];
    if(pre.kind==='rider'&&shipPre?.rider_id&&!shipPre.company_id)await lockRiderAccount(c,shipPre.rider_id);
    const s=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[pre.shipment_id])).rows[0];
    const old=(await c.query('SELECT * FROM payout_operations WHERE id=$1 FOR UPDATE',[id])).rows[0];
    check(old&&old.provider===provider.name,404,'Payout unavailable');check(old.status==='failed',409,'Only definitively failed payouts can be retried');
    const live=(await c.query("SELECT * FROM payout_operations WHERE shipment_id=$1 AND kind=$2 AND status NOT IN ('failed','superseded')",[old.shipment_id,old.kind])).rows[0];if(live)return live;
    await applyRiderDebtBeforePayout(c,s,old.kind);
    const {beneficiaryId,companyId}=await resolveBeneficiary(c,s,old.kind);
    const beneficiary=(await c.query('SELECT * FROM payout_beneficiaries WHERE user_id=$1 AND provider=$2',[beneficiaryId,provider.name])).rows[0];check(beneficiary,409,'Verified payout destination required');
    const amount=await payable(c,s.id,old.kind);
    // Fresh proposal: requires a new independent approval.
    return (await c.query(`INSERT INTO payout_operations(id,shipment_id,kind,beneficiary_id,company_id,provider,recipient_reference,amount_minor,proposed_by,retry_of) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[randomUUID(),s.id,old.kind,beneficiaryId,companyId,provider.name,beneficiary.recipient_reference,amount,actor.id,old.id])).rows[0];
   });
  },
  async approvePayout(actor,id){
   await permit(actor,'finance:approve');uuid.parse(id);check(typeof provider?.createPayout==='function',503,'Payout adapter unavailable');
   const p=await db.tx(async c=>{
    // Canonical lock hierarchy: commission_accounts (if independent rider) -> shipments FOR UPDATE -> payout_operations FOR UPDATE -> restaurant_settlements FOR UPDATE.
    // This serializes payout approval against concurrent dispute refunds and debt recovery without deadlocks.
    const pre=(await c.query('SELECT id,shipment_id,kind,company_id,provider FROM payout_operations WHERE id=$1',[id])).rows[0];
    check(pre&&pre.provider===provider.name,404,'Payout unavailable');
    const shipPre=(await c.query('SELECT id,rider_id,company_id FROM shipments WHERE id=$1',[pre.shipment_id])).rows[0];
    if(pre.kind==='rider'&&shipPre?.rider_id&&!shipPre.company_id)await lockRiderAccount(c,shipPre.rider_id);
    const s=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[pre.shipment_id])).rows[0];
    check(s,404,'Shipment unavailable');
    const row=(await c.query('SELECT * FROM payout_operations WHERE id=$1 FOR UPDATE',[id])).rows[0];check(row&&row.provider===provider.name,404,'Payout unavailable');
    check(row.proposed_by!==actor.id,403,'A different finance administrator must approve the payout');
    if(row.status!=='proposed')return {...row,existing:true};
    if(row.kind==='rider'){
     let debtMinor=0;
     if(!row.company_id&&s.rider_id){
      // Independent rider: re-apply debt recovery under the rider account lock at approval time so a
      // debt that arose after proposal can never be paid out as cash. Amount only ever decreases.
      await recoverDebtFromEarnings(c,s.rider_id,{trigger:'payout_precheck'});
      const debt=await debtState(c,s.rider_id);
      debtMinor=debt.debtMinor;
     }
     const current=await payableOrZero(c,row.shipment_id,'rider');
     if(debtMinor>0||current<=0){
      const reason=debtMinor>0
       ?'Earnings applied to outstanding ELESEND commission debt before payout'
       :'Superseded by dispute refund of rider payable before payout approval';
      await c.query("UPDATE payout_operations SET status='superseded',failure_reason=$2,updated_at=now() WHERE id=$1 AND status='proposed'",[id,reason]);
      await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'payout.superseded_by_debt_recovery',$2)",[actor.id,id]);
      return {...row,status:'superseded',existing:true};
     }
     if(current!==Number(row.amount_minor)){
      check(current<Number(row.amount_minor),409,'Payout amount cannot increase after proposal');
      await c.query("UPDATE payout_operations SET amount_minor=$2,updated_at=now() WHERE id=$1 AND status='proposed'",[id,current]);
      await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'payout.reduced_by_debt_recovery',$2)",[actor.id,id]);
      row.amount_minor=current;
     }
    }else if(row.kind==='restaurant'){
     const fo=(await c.query('SELECT id FROM food_orders WHERE shipment_id=$1 FOR UPDATE',[row.shipment_id])).rows[0];
     if(fo){
      const settlement=(await c.query('SELECT * FROM restaurant_settlements WHERE order_id=$1 FOR UPDATE',[fo.id])).rows[0];
      check(!settlement||settlement.status!=='settled',409,'Restaurant settlement already paid out');
     }
     const current=await payableOrZero(c,row.shipment_id,'restaurant');
     if(current<=0){
      await c.query("UPDATE payout_operations SET status='superseded',failure_reason=$2,updated_at=now() WHERE id=$1 AND status='proposed'",[id,'Superseded by full dispute refund of restaurant payable before payout approval']);
      await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'payout.superseded_by_dispute_refund',$2)",[actor.id,id]);
      return {...row,status:'superseded',existing:true};
     }
     if(current!==Number(row.amount_minor)){
      check(current<Number(row.amount_minor),409,'Payout amount cannot increase after proposal');
      await c.query("UPDATE payout_operations SET amount_minor=$2,updated_at=now() WHERE id=$1 AND status='proposed'",[id,current]);
      await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'payout.reduced_by_dispute_refund',$2)",[actor.id,id]);
      row.amount_minor=current;
     }
    }
    await c.query("UPDATE payout_operations SET approved_by=$2,status='initiating',submitted_at=coalesce(submitted_at,now()),updated_at=now() WHERE id=$1",[id,actor.id]);return row;
   });
   if(p.existing)return {id:p.id,status:p.status};
   let receipt;
   try{receipt=await provider.createPayout({requestId:p.id,idempotencyKey:p.id,recipientReference:p.recipient_reference,amountMinor:Number(p.amount_minor),currency:p.currency});}
   catch(e){
    await db.query("UPDATE payout_operations SET status='needs_review',failure_reason=$2,updated_at=now() WHERE id=$1 AND status='initiating'",[id,'Submission outcome uncertain: '+reasonText(e)]);
    return {id,status:'needs_review'};
   }
   const pid=receipt?.providerId!=null?String(receipt.providerId):null;
   await db.query("UPDATE payout_operations SET provider_id=coalesce(provider_id,$2),status=CASE WHEN status='initiating' THEN 'pending' ELSE status END,updated_at=now() WHERE id=$1",[id,pid]);
   const fresh=(await db.query('SELECT * FROM payout_operations WHERE id=$1',[id])).rows[0];
   try{return await verifyPayoutOp(fresh);}catch{return {id,status:'pending_verification'};}
  },
  async reconcilePayout(actor,id){
   await permit(actor,['finance:configure','finance:approve']);uuid.parse(id);
   const p=(await db.query('SELECT * FROM payout_operations WHERE id=$1',[id])).rows[0];check(p&&p.provider===provider?.name,404,'Payout unavailable');
   if(['paid','failed','proposed','superseded'].includes(p.status))return {id:p.id,status:p.status};
   check(p.approved_by,409,'Approved payout verification required');
   return verifyPayoutOp(p);
  },
  async disputes(actor,{status=null}={}){
   await permit(actor,READ);
   const params=[];
   let where='';
   if(status){
    check(['open','resolved','dismissed'].includes(status),400,'Invalid dispute status filter');
    params.push(status);
    where='WHERE d.status=$1';
   }
   return (await db.query(`
    SELECT d.*, f.id AS food_order_id, f.total_minor AS food_total_minor, f.subtotal_minor AS food_subtotal_minor,
           f.payment_status AS food_payment_status, dr.id AS dispute_refund_request_id, dr.status AS refund_request_status
    FROM disputes d
    LEFT JOIN food_orders f ON f.shipment_id=d.shipment_id
    LEFT JOIN dispute_refund_requests dr ON dr.dispute_id=d.id
    ${where}
    ORDER BY d.created_at DESC LIMIT 100
   `,params)).rows;
  },
  async resolveDispute(actor,disputeId,input={}){
   await permit(actor,['finance:configure','finance:approve']);
   uuid.parse(disputeId);
   const v=z.object({
    decision:z.enum(['approve_refund','dismiss']).default('approve_refund'),
    reason:z.string().trim().min(5).max(1000),
    items:z.array(z.object({
     orderItemId:uuid.optional(),
     foodOrderItemId:uuid.optional(),
     itemId:uuid.optional(),
     menuItemId:uuid.optional(),
     quantity:z.number().int().min(1).max(50)
    })).max(30).optional(),
    refundAmountMinor:z.number().int().min(1).optional(),
    deliveryFeeRefundMinor:z.number().int().min(0).optional().default(0)
   }).strict().parse(input);
   const result=await db.tx(async c=>{
    // Canonical lock hierarchy: commission_accounts (if independent rider) -> shipments FOR UPDATE -> disputes FOR UPDATE -> payout_operations FOR UPDATE -> food_orders/restaurant_settlements FOR UPDATE.
    const dPre=(await c.query('SELECT id,shipment_id FROM disputes WHERE id=$1',[disputeId])).rows[0];
    check(dPre,404,'Dispute not found');
    const sPre=(await c.query('SELECT id,rider_id,company_id FROM shipments WHERE id=$1',[dPre.shipment_id])).rows[0];
    if(sPre?.rider_id&&!sPre.company_id)await lockRiderAccount(c,sPre.rider_id);
    const s=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[dPre.shipment_id])).rows[0];
    const d=(await c.query('SELECT * FROM disputes WHERE id=$1 FOR UPDATE',[disputeId])).rows[0];
    check(d,404,'Dispute not found');
    if(d.status!=='open'){
     const existingOp=(await c.query('SELECT * FROM refund_operations WHERE source_key=$1',['dispute:'+d.id])).rows[0];
     check(
      (v.decision==='dismiss'&&d.status==='dismissed')||(v.decision==='approve_refund'&&d.status==='resolved'),
      409,`Dispute is already ${d.status}`
     );
     return {
      disputeId:d.id,
      status:d.status,
      approvedRefundMinor:Number(d.approved_refund_minor||0),
      refundOperationId:existingOp?.id??null,
      duplicate:true
     };
    }
    if(v.decision==='dismiss'){
     await c.query("UPDATE disputes SET status='dismissed',approved_refund_minor=0,resolution_notes=$2,resolved_by=$3,resolved_at=now() WHERE id=$1",[d.id,v.reason,actor.id]);
     await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,'dispute.dismissed:'+v.reason,d.id]);
     return {disputeId:d.id,status:'dismissed',approvedRefundMinor:0,refundOperationId:null,duplicate:false};
    }
    // Delivery confirmed by SMS, and failed deliveries, are never refunded and commission is never given up.
    const food=(await c.query('SELECT 1 FROM food_orders WHERE shipment_id=$1',[d.shipment_id])).rowCount;
    check(false,409,food?'Delivered food orders are not refunded by ELESEND. The customer should chat with the restaurant':'Parcels confirmed by SMS and failed deliveries are not refunded');
   });
   return result;
  }
 };
 async function resolveBeneficiary(c,s,kind){
  if(kind==='restaurant'){
   const food=(await c.query('SELECT r.owner_id FROM food_orders f JOIN restaurants r ON r.id=f.restaurant_id WHERE f.shipment_id=$1',[s.id])).rows[0];
   check(food?.owner_id,409,'No payout beneficiary');return {beneficiaryId:food.owner_id,companyId:null};
  }
  if(s.company_id){
   // Company riders: rider earnings belong to the company; pay the company owner's verified account.
   const co=(await c.query('SELECT id,owner_id,status FROM companies WHERE id=$1',[s.company_id])).rows[0];
   check(co?.owner_id&&co.status==='approved',409,'Approved company payout account required');
   return {beneficiaryId:co.owner_id,companyId:co.id};
  }
  check(s.rider_id,409,'No payout beneficiary');return {beneficiaryId:s.rider_id,companyId:null};
 }
 async function payable(c,shipmentId,kind){
  const amount=await payableOrZero(c,shipmentId,kind);check(Number.isSafeInteger(amount)&&amount>0,409,'No payable balance');return amount;
 }
 async function payableOrZero(c,shipmentId,kind){
  const account=kind==='restaurant'?'restaurant_payable':'rider_payable';
  const balance=(await c.query(`SELECT coalesce(sum(CASE WHEN side='credit' THEN amount_minor ELSE -amount_minor END),0)::bigint AS amount FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.shipment_id=$1 AND l.account=$2`,[shipmentId,account])).rows[0];
  return Number(balance.amount);
 }
 /** Independent riders never withdraw while owing commission: unpaid earnings settle the debt first. */
 async function applyRiderDebtBeforePayout(c,s,kind){
  if(kind!=='rider'||s.company_id||!s.rider_id)return;
  await recoverDebtFromEarnings(c,s.rider_id,{trigger:'payout_precheck'});
  const d=await debtState(c,s.rider_id);
  check(d.debtMinor===0,409,'Rider has outstanding ELESEND commission debt; earnings are applied to the debt before any withdrawal');
 }
}
