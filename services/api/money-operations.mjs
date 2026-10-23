import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check} from './security.mjs';
import {checkoutJournal} from './checkout-accounting.mjs';
import {recoverDebtFromEarnings,debtState,lockRiderAccount} from './rider-wallet.mjs';
const uuid=z.string().uuid();

const LIVE_REFUND=['initiating','pending','needs_review'];
const LIVE_PAYOUT=['initiating','pending','needs_review'];

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

export function moneyOperations(db,{provider,verifyTimeoutMs=10000,concurrency=4,leaseSeconds=120}={}){
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
 async function reconcileRefund(id){
  const r=(await db.query('SELECT * FROM refund_operations WHERE id=$1',[id])).rows[0];
  check(r&&r.provider===provider?.name,404,'Refund unavailable for active adapter');
  if(['refunded','failed','queued'].includes(r.status))return {id:r.id,status:r.status};
  check(typeof provider.verifyRefund==='function',503,'Active adapter does not support refund verification');
  const record=await withTimeout(provider.verifyRefund({requestId:r.id,providerId:r.provider_id,reference:r.reference,amountMinor:Number(r.amount_minor),currency:r.currency}),verifyTimeoutMs);
  return applyRefundRecord(r,record);
 }
 async function confirmPayout(record){
  check(record?.status==='paid',409,'Payout is not independently confirmed');uuid.parse(record.requestId);
  check(typeof record.eventId==='string'&&record.eventId.length>=4,409,'Payout evidence mismatch: event');
  return db.tx(async c=>{
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
   check(typeof provider?.createRefund==='function'&&typeof provider?.verifyRefund==='function',503,'Configure an adapter with verified refund support');
   const r=await db.tx(async c=>{
    const row=(await c.query('SELECT * FROM refund_operations WHERE id=$1 FOR UPDATE',[id])).rows[0];
    check(row&&row.provider===provider.name,404,'Refund unavailable for active adapter');
    if(row.status!=='queued')return {...row,existing:true};
    await c.query("UPDATE refund_operations SET status='initiating',submitted_by=$2,submitted_at=coalesce(submitted_at,now()),updated_at=now() WHERE id=$1",[id,actor.id]);return row;
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
   const v=z.object({recipientReference:z.string().min(3).max(160)}).strict().parse(input);
   check(typeof provider?.verifyBeneficiary==='function',503,'Adapter beneficiary verification unavailable');
   const r=await provider.verifyBeneficiary({beneficiaryId:actor.id,recipientReference:v.recipientReference});
   check(r.verified===true&&r.beneficiaryId===actor.id&&r.recipientReference===v.recipientReference,409,'Beneficiary ownership not verified');
   await db.query(`INSERT INTO payout_beneficiaries(user_id,provider,recipient_reference) VALUES($1,$2,$3) ON CONFLICT(user_id,provider) DO UPDATE SET recipient_reference=excluded.recipient_reference,verified_at=now()`,[actor.id,provider.name,v.recipientReference]);
   return {verified:true};
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
    const old=(await c.query('SELECT * FROM payout_operations WHERE id=$1 FOR UPDATE',[id])).rows[0];
    check(old&&old.provider===provider.name,404,'Payout unavailable');check(old.status==='failed',409,'Only definitively failed payouts can be retried');
    const live=(await c.query("SELECT * FROM payout_operations WHERE shipment_id=$1 AND kind=$2 AND status NOT IN ('failed','superseded')",[old.shipment_id,old.kind])).rows[0];if(live)return live;
    const s=(await c.query('SELECT * FROM shipments WHERE id=$1',[old.shipment_id])).rows[0];
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
    const row=(await c.query('SELECT * FROM payout_operations WHERE id=$1 FOR UPDATE',[id])).rows[0];check(row&&row.provider===provider.name,404,'Payout unavailable');
    check(row.proposed_by!==actor.id,403,'A different finance administrator must approve the payout');
    if(row.status!=='proposed')return {...row,existing:true};
    if(row.kind==='rider'&&!row.company_id){
     // Independent rider: re-apply debt recovery under the rider account lock at approval time so a
     // debt that arose after proposal can never be paid out as cash. Amount only ever decreases.
     const s=(await c.query('SELECT id,rider_id,company_id FROM shipments WHERE id=$1',[row.shipment_id])).rows[0];
     await recoverDebtFromEarnings(c,s.rider_id,{trigger:'payout_precheck'});
     const debt=await debtState(c,s.rider_id);
     const current=await payableOrZero(c,row.shipment_id,'rider');
     if(debt.debtMinor>0||current<=0){
      await c.query("UPDATE payout_operations SET status='superseded',failure_reason=$2,updated_at=now() WHERE id=$1 AND status='proposed'",[id,'Earnings applied to outstanding ELESEND commission debt before payout']);
      await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'payout.superseded_by_debt_recovery',$2)",[actor.id,id]);
      return {...row,status:'superseded',existing:true};
     }
     if(current!==Number(row.amount_minor)){
      check(current<Number(row.amount_minor),409,'Payout amount cannot increase after proposal');
      await c.query("UPDATE payout_operations SET amount_minor=$2,updated_at=now() WHERE id=$1 AND status='proposed'",[id,current]);
      await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'payout.reduced_by_debt_recovery',$2)",[actor.id,id]);
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
