import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check} from './security.mjs';
import {DIGITAL_METHODS,validateVerifiedPayment,validatedCheckoutUrl} from './checkout-policy.mjs';
import {customerMoneyReceived,customerMoneyUnapplied} from './checkout-accounting.mjs';
import {validatePayer} from './payment-provider.mjs';
const uuid=z.string().uuid(),key=z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);
const payer=z.object({idempotencyKey:key,email:z.email().max(254).optional()}).strict();
const reasonText=e=>String(e?.message||'Provider error').slice(0,500);
function withTimeout(promise,ms){
 if(!Number.isFinite(ms)||ms<=0)return promise;
 let timer;
 return Promise.race([
  promise,
  new Promise((_,rej)=>{timer=setTimeout(()=>rej(Object.assign(Error('Payment provider verification timed out'),{status:504,code:'provider_timeout'})),ms);})
 ]).finally(()=>clearTimeout(timer));
}
async function pool(items,limit,fn){
 const out=[],n=Math.max(1,limit|0);let i=0;
 await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{
  while(i<items.length){const idx=i++;out[idx]=await fn(items[idx]);}
 }));
 return out;
}
/** A shipment payment is confirmed ONLY by independently verified provider evidence.
 * The local app never gets to choose amount, currency, provider reference or success.
 */
export function checkoutService(db,{provider=null,verifyTimeoutMs=10000,concurrency=4,leaseSeconds=120,submissionLeaseSeconds=60,checkoutExpirySeconds=3600,maxVerifyBackoffSeconds=21600}={}){
 const cap=method=>!!provider&&DIGITAL_METHODS.includes(method)&&provider.methods?.includes(method)&&typeof provider.createCheckout==='function'&&typeof provider.verifyPayment==='function';
 const inFlightInitiations=new Map();
 const shipmentLocks=new Map();
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
 async function withShipmentLock(shipmentId,fn){
  const prev=shipmentLocks.get(shipmentId)??Promise.resolve();
  let release;
  const gate=new Promise(r=>{release=r;});
  const chained=prev.then(()=>gate);
  shipmentLocks.set(shipmentId,chained);
  await prev;
  try{return await fn();}
  finally{
   release();
   if(shipmentLocks.get(shipmentId)===chained)shipmentLocks.delete(shipmentId);
  }
 }
 const list=async()=>{
  const r=await db.query('SELECT method,enabled FROM checkout_method_policies ORDER BY method');
  return r.rows.map(x=>({method:x.method,enabled:x.method==='CASH'?true:x.enabled&&cap(x.method),configured:x.method==='CASH'||cap(x.method),adminEnabled:x.enabled,payerFields:x.method==='CASH'?[]:provider?.payerFields||[]}));
 };
 const admin=async(c,actor)=>{check(actor?.kind==='admin',403,'Administrator required');check((await c.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission='payments:configure'",[actor.id])).rowCount,403,'Payment policy permission required');};
 async function confirm(verification){
  check(provider&&typeof verification?.reference==='string',503,'Provider verification unavailable');
  return db.tx(async c=>{
   // A shipment lock consistently comes before checkout intent lock.
   const row=(await c.query('SELECT shipment_id FROM shipment_checkout_intents WHERE provider=$1 AND reference=$2',[provider.name,verification.reference])).rows[0];
   check(row,404,'Unrecognized payment reference');
   const s=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[row.shipment_id])).rows[0];
   const intent=(await c.query('SELECT * FROM shipment_checkout_intents WHERE provider=$1 AND reference=$2 FOR UPDATE',[provider.name,verification.reference])).rows[0];
   check(s&&intent&&s.customer_id===intent.customer_id&&s.payment_method===intent.method,409,'Payment ownership/terms mismatch');
   // Every accepted provider record has to be independently retrieved by the adapter.
   check(verification.status==='success'&&verification.reference===intent.reference&&verification.currency===intent.currency&&Number.isSafeInteger(verification.amountMinor)&&verification.amountMinor>0&&typeof verification.eventId==='string'&&verification.eventId.length>=4,409,'Unverified provider receipt');
   const prior=(await c.query('SELECT * FROM checkout_confirmed_events WHERE provider=$1 AND event_id=$2',[provider.name,verification.eventId])).rows[0];
   const suspense=(await c.query('SELECT * FROM checkout_unapplied_payments WHERE provider=$1 AND event_id=$2',[provider.name,verification.eventId])).rows[0];
   if(prior||suspense){check((prior??suspense).intent_id===intent.id,409,'Provider event reused for another checkout');return {status:prior?'confirmed':'refund_review',duplicate:true,shipmentId:s.id,intentId:intent.id};}
   const valid=(()=>{try{return validateVerifiedPayment(verification,{reference:intent.reference,amountMinor:Number(intent.amount_minor),currency:intent.currency,method:intent.method});}catch{return false;}})();
   const fo=(await c.query('SELECT * FROM food_orders WHERE shipment_id=$1',[s.id])).rows[0];
   const expectedAmount=fo?Number(fo.total_minor):Number(s.amount_minor);
   const foodPayable=!fo||!['CANCELLED','REJECTED','DELIVERED'].includes(fo.state);
   const wasInactive=['failed','expired'].includes(intent.status);
   // A verified late payment arriving after local expiry/failure is still applied when the order remains payable and unpaid!
   const normal=foodPayable&&valid&&expectedAmount===Number(intent.amount_minor)&&!s.paid&&s.state==='AWAITING_PAYMENT'&&intent.status!=='confirmed';
   if(!normal){
    // Verified money can arrive AFTER cancellation, after another intent paid the shipment, or with
    // mismatched terms. Persist 100% of verified funds in customer_refund_liability for refund review.
    const reason=!valid?'payment_terms_mismatch':s.paid?'already_paid':s.state!=='AWAITING_PAYMENT'?'shipment_not_payable':'stale_payment_intent';
    await c.query('INSERT INTO checkout_unapplied_payments(provider,event_id,intent_id,shipment_id,provider_reference,amount_minor,currency,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[provider.name,verification.eventId,intent.id,s.id,intent.reference,verification.amountMinor,verification.currency,reason]);
    await customerMoneyUnapplied(c,{shipmentId:s.id,eventKey:'checkout:'+provider.name+':unapplied:'+verification.eventId,amountMinor:verification.amountMinor});
    await c.query(
     `UPDATE shipment_checkout_intents
         SET status=CASE WHEN status IN ('initiating','pending') THEN 'expired' ELSE status END,
             provider_terminal_at=coalesce(provider_terminal_at,now()),
             provider_last_status='success_unapplied',
             failure_reason=coalesce(failure_reason,$2),
             submission_token=NULL,
             submission_lease_until=NULL,
             reconcile_lease_until=NULL,
             last_reconciled_at=now(),
             updated_at=now()
       WHERE id=$1`,
     [intent.id,'Verified payment unapplied ('+reason+'); recorded for refund review']
    );
    await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[s.customer_id,'checkout.payment_unapplied_refund_review',s.id]);
    return {status:'refund_review',reason,duplicate:false,lateRecovery:wasInactive,shipmentId:s.id,intentId:intent.id};
   }
   await c.query('INSERT INTO checkout_confirmed_events(provider,event_id,intent_id,shipment_id,reference,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6,$7)',[provider.name,verification.eventId,intent.id,s.id,intent.reference,verification.amountMinor,verification.currency]);
   // Existing immutable settlement evidence retained for earlier module compatibility.
   await c.query('INSERT INTO payment_events(provider,event_id,shipment_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5)',[provider.name,verification.eventId,s.id,verification.amountMinor,verification.currency]);
   await customerMoneyReceived(c,{shipmentId:s.id,eventKey:'checkout:'+provider.name+':verified:'+verification.eventId,amountMinor:verification.amountMinor});
   await c.query(
    `UPDATE shipment_checkout_intents
        SET status='confirmed',
            confirmed_at=coalesce(confirmed_at,now()),
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
    [intent.id]
   );
   // Expire any other open attempt on this shipment while keeping provider_terminal_at NULL so duplicate charges are still caught.
   await c.query(
    `UPDATE shipment_checkout_intents
        SET status='expired',
            failure_reason='Superseded by confirmed payment on shipment',
            submission_token=NULL,
            submission_lease_until=NULL,
            updated_at=now()
      WHERE shipment_id=$1
        AND id<>$2
        AND status IN ('initiating','pending')`,
    [s.id,intent.id]
   );
   await c.query("UPDATE shipments SET paid=true,state='AWAITING_ASSIGNMENT' WHERE id=$1",[s.id]);
   if(fo){
    await c.query("UPDATE food_orders SET payment_status='PAID',updated_at=now() WHERE id=$1",[fo.id]);
    if(['ACCEPTED','PREPARING'].includes(fo.state)&&fo.ready_at){
     const leadMs=5*60*1000;
     const nextDisp=new Date(new Date(fo.ready_at).getTime()-leadMs);
     await c.query('UPDATE shipments SET next_dispatch_at=$2 WHERE id=$1',[s.id,nextDisp]);
    }else if(fo.state==='READY_FOR_PICKUP'){
     await c.query('UPDATE shipments SET next_dispatch_at=now() WHERE id=$1',[s.id]);
    }
   }
   await c.query('INSERT INTO outbox(shipment_id,kind,payload) VALUES($1,$2,$3)',[s.id,'payment_confirmed',JSON.stringify({shipmentId:s.id,kind:'payment_confirmed'})]);
   await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[s.customer_id,wasInactive?'checkout.late_payment_recovered':'checkout.payment_verified',s.id]);
   return {status:'confirmed',duplicate:false,lateRecovery:wasInactive,shipmentId:s.id,intentId:intent.id};
  });
 }
 const resultRow=r=>({intentId:r.id,shipmentId:r.shipment_id,method:r.method,status:r.status,checkoutUrl:r.checkout_url??null,reference:r.reference,amountMinor:Number(r.amount_minor),currency:r.currency,failureReason:r.failure_reason??null});
 return {
  methods:list,
  confirmVerified:confirm,
  async configure(actor,{method,enabled}){
   check(DIGITAL_METHODS.includes(method)&&typeof enabled==='boolean',400,'Invalid checkout method configuration');
   if(enabled)check(cap(method),503,'Authorized payment adapter for this method is not configured');
   return db.tx(async c=>{await admin(c,actor);await c.query('UPDATE checkout_method_policies SET enabled=$2,updated_by=$3,updated_at=now() WHERE method=$1',[method,enabled,actor.id]);await c.query('INSERT INTO audit_logs(actor_id,action) VALUES($1,$2)',[actor.id,'checkout.method.'+method+'.'+(enabled?'enabled':'disabled')]);return {method,enabled};});
  },
  async initiate(actor,shipmentId,input){uuid.parse(shipmentId);const v=payer.parse(input);
   check(['customer','business'].includes(actor?.kind),403,'Customer or business account required');
   const email=v.email??null;
   const {intent,task}=await withShipmentLock(shipmentId,async()=>{
    if(provider&&typeof provider.verifyPayment==='function'){
     const candidates=(await db.query(
      `SELECT id,status,submission_token,submission_lease_until
         FROM shipment_checkout_intents
        WHERE shipment_id=$1
          AND customer_id=$2
          AND (
            status IN ('initiating','pending')
            OR (status IN ('expired','failed') AND provider_terminal_at IS NULL)
          )
        ORDER BY created_at DESC
        LIMIT 5`,
      [shipmentId,actor.id]
     )).rows;
     for(const cand of candidates){
      if(!isSubmissionCallActive(cand)){
       try{await this.reconcileIntent(cand.id,{silentUnavailable:true});}catch{}
      }
     }
    }

    const submissionToken=randomUUID();
    const reserved=await db.tx(async c=>{
     const s=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[shipmentId])).rows[0];
     check(s&&s.customer_id===actor.id,404,'Shipment not found');
     check(DIGITAL_METHODS.includes(s.payment_method),409,'Cash shipments do not require online checkout');
     const old=(await c.query('SELECT * FROM shipment_checkout_intents WHERE customer_id=$1 AND idempotency_key=$2 FOR UPDATE',[actor.id,v.idempotencyKey])).rows[0];
     if(old){
      check(old.shipment_id===shipmentId,409,'Idempotency key reused for another shipment');
      check((old.payer_email??null)===email,409,'Idempotency key reused with different payer email');
      return {...old,wasExisting:true};
     }
     check(!s.paid&&s.state==='AWAITING_PAYMENT',409,'Shipment no longer awaits payment');
     check(cap(s.payment_method),503,'Authorized payment channel unavailable');
     validatePayer(provider,v);
     const active=(await c.query("SELECT * FROM shipment_checkout_intents WHERE shipment_id=$1 AND status IN ('initiating','pending') LIMIT 1",[shipmentId])).rows[0];
     if(active){check(false,409,'An existing payment attempt is pending; refresh its status instead');}
     const pol=(await c.query('SELECT enabled FROM checkout_method_policies WHERE method=$1',[s.payment_method])).rows[0];
     check(pol?.enabled,503,'Payment method is disabled');
     const fo=(await c.query('SELECT total_minor,state FROM food_orders WHERE shipment_id=$1',[s.id])).rows[0];
     if(fo)check(!['CANCELLED','REJECTED','DELIVERED'].includes(fo.state),409,'Food order is no longer payable');
     const chargeAmount=fo?fo.total_minor:s.amount_minor;
     const id=randomUUID(),reference='es_'+id.replaceAll('-','');
     const r=(await c.query(
      `INSERT INTO shipment_checkout_intents(
         id,shipment_id,customer_id,method,provider,reference,amount_minor,currency,
         idempotency_key,payer_email,submission_token,submission_lease_until,submitted_at,updated_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+make_interval(secs=>$12),now(),now())
       ON CONFLICT (customer_id,idempotency_key) DO NOTHING
       RETURNING *`,
      [id,s.id,actor.id,s.payment_method,provider.name,reference,chargeAmount,'GHS',v.idempotencyKey,email,submissionToken,submissionLeaseSeconds]
     )).rows[0];
     if(!r){
      const concurrent=(await c.query('SELECT * FROM shipment_checkout_intents WHERE customer_id=$1 AND idempotency_key=$2',[actor.id,v.idempotencyKey])).rows[0];
      check(concurrent&&concurrent.shipment_id===shipmentId,409,'Idempotency key reused for another shipment');
      check((concurrent.payer_email??null)===email,409,'Idempotency key reused with different payer email');
      return {...concurrent,wasExisting:true};
     }
     return {...r,wasExisting:false};
    });

    if(reserved.wasExisting){
     return {intent:reserved,task:null};
    }

    const createTask=(async()=>{
     let instructions;
     try{
      instructions=await provider.createCheckout({reference:reserved.reference,amountMinor:Number(reserved.amount_minor),currency:reserved.currency,method:reserved.method,email:v.email});
      check(instructions?.reference===reserved.reference,502,'PSP reference disagreement');
      instructions.checkoutUrl=validatedCheckoutUrl(instructions.checkoutUrl,{allowedHosts:provider.allowedCheckoutHosts??[]});
      const updated=await db.tx(async c=>{
       const s=(await c.query('SELECT id FROM shipments WHERE id=$1 FOR UPDATE',[shipmentId])).rows[0];
       check(s,404);
       const current=(await c.query('SELECT * FROM shipment_checkout_intents WHERE id=$1 FOR UPDATE',[reserved.id])).rows[0];
       check(current,404);
       if(current.status==='confirmed'){
        return (await c.query(
         `UPDATE shipment_checkout_intents
             SET checkout_url=coalesce($2,checkout_url),
                 submission_token=NULL,
                 submission_lease_until=NULL,
                 updated_at=now()
           WHERE id=$1 AND status='confirmed'
           RETURNING *`,
         [reserved.id,instructions.checkoutUrl]
        )).rows[0]??current;
       }
       const promoted=(await c.query(
        `UPDATE shipment_checkout_intents
            SET status='pending',
                checkout_url=$2,
                submission_token=NULL,
                submission_lease_until=NULL,
                updated_at=now()
          WHERE id=$1
            AND status='initiating'
            AND submission_token=$3
            AND NOT EXISTS (
              SELECT 1 FROM shipment_checkout_intents other
               WHERE other.shipment_id=shipment_checkout_intents.shipment_id
                 AND other.id<>shipment_checkout_intents.id
                 AND other.status IN ('initiating','pending')
            )
          RETURNING *`,
        [reserved.id,instructions.checkoutUrl,submissionToken]
       )).rows[0];
       if(!promoted){
        await c.query(
         'UPDATE shipment_checkout_intents SET checkout_url=coalesce($2,checkout_url),submission_token=NULL,submission_lease_until=NULL,updated_at=now() WHERE id=$1',
         [reserved.id,instructions.checkoutUrl]
        );
        check(false,409,'Checkout attempt expired or was superseded before provider initialization returned');
       }
       return promoted;
      });
      return resultRow(updated);
     }catch(e){
      if(e?.definitiveNoCharge===true){
       await db.tx(async c=>{
        await c.query('SELECT id FROM shipments WHERE id=$1 FOR UPDATE',[shipmentId]);
        await c.query(
         `UPDATE shipment_checkout_intents
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
      // PSP may have accepted transaction although HTTP response failed. Release submission_token
      // so status/reconcile can check provider, but keep submission_lease_until active so "not_created"
      // is not treated as definitive failure while creation may still complete at the PSP.
      await db.query(
       `UPDATE shipment_checkout_intents
           SET failure_reason=$2,
               submission_token=NULL,
               updated_at=now()
         WHERE id=$1
           AND status='initiating'
           AND submission_token=$3`,
       [reserved.id,'Initialization outcome uncertain: '+reasonText(e),submissionToken]
      ).catch(()=>{});
      throw Object.assign(Error('Checkout initialization unconfirmed; query status before retry'),{status:503});
     }
    })();

    inFlightInitiations.set(reserved.id,createTask);
    return {intent:reserved,task:createTask};
   });

   if(intent.wasExisting){
    if(inFlightInitiations.has(intent.id)){
     try{await inFlightInitiations.get(intent.id);}catch{}
    }else if(!isSubmissionCallActive(intent)&&['initiating','pending','expired','failed'].includes(intent.status)&&provider&&typeof provider.verifyPayment==='function'){
     try{await this.reconcileIntent(intent.id,{silentUnavailable:true});}catch{}
    }
    const refreshed=(await db.query('SELECT * FROM shipment_checkout_intents WHERE id=$1',[intent.id])).rows[0]??intent;
    if(refreshed.status==='confirmed')return resultRow(refreshed);
    if(refreshed.status==='pending'&&refreshed.checkout_url)return resultRow(refreshed);
    if(['failed','expired'].includes(refreshed.status)){
     check(false,409,'Previous payment attempt expired or failed; start a new attempt with a fresh idempotency key');
    }
    throw Object.assign(Error('Checkout initialization unconfirmed; query status before retry'),{status:503});
   }

   try{
    return await task;
   }finally{
    inFlightInitiations.delete(intent.id);
   }
  },
  async status(actor,shipmentId){uuid.parse(shipmentId);check(['customer','business'].includes(actor?.kind),403);
   const initial=(await db.query(`SELECT i.* FROM shipment_checkout_intents i JOIN shipments s ON s.id=i.shipment_id WHERE i.shipment_id=$1 AND s.customer_id=$2 ORDER BY i.created_at DESC LIMIT 1`,[shipmentId,actor.id])).rows[0];
   check(initial,404,'Checkout not found');
   if(['initiating','pending','expired','failed'].includes(initial.status)&&initial.provider_terminal_at===null&&provider&&typeof provider.verifyPayment==='function'&&!isSubmissionCallActive(initial)){
    try{await this.reconcileIntent(initial.id,{silentUnavailable:true});}catch{}
   }
   const r=(await db.query(`SELECT i.* FROM shipment_checkout_intents i JOIN shipments s ON s.id=i.shipment_id WHERE i.shipment_id=$1 AND s.customer_id=$2 ORDER BY i.created_at DESC LIMIT 1`,[shipmentId,actor.id])).rows[0];
   check(r,404,'Checkout not found');
   return resultRow(r);
  },
  async webhook(rawBody,headers){check(provider&&typeof provider.parseVerifiedWebhook==='function',503,'Webhook not configured');
   const verification=await provider.parseVerifiedWebhook(rawBody,headers);
   if(!verification)return {status:'ignored'};
   return confirm(verification);
  },
  async reconcileIntent(intentId,{silentUnavailable=false}={}){ // server-only recovery call; no unsigned HTTP endpoint
   uuid.parse(intentId);
   const intent=(await db.query('SELECT * FROM shipment_checkout_intents WHERE id=$1',[intentId])).rows[0];
   check(intent,404,'Checkout not found');
   if(intent.status==='confirmed')return {...resultRow(intent),duplicate:true};
   if(!provider||intent.provider!==provider.name||typeof provider.verifyPayment!=='function'){
    if(silentUnavailable)return resultRow(intent);
    check(false,503,'Provider unavailable');
   }
   let verified;
   try{
    verified=await withTimeout(provider.verifyPayment(intent.reference),verifyTimeoutMs);
   }catch(e){
    await db.query('UPDATE shipment_checkout_intents SET last_reconciled_at=now(),reconcile_lease_until=NULL WHERE id=$1',[intent.id]).catch(()=>{});
    return {status:'verification_unavailable',intentStatus:intent.status,intentId:intent.id,reference:intent.reference,error:e.code??reasonText(e)};
   }
   const providerStatus=String(verified?.status??'pending').toLowerCase().slice(0,40);
   if(providerStatus==='success')return confirm(verified);
   // Only an explicit provider failure (not flagged non-terminal by the adapter) or a verified
   // definitive "never created" response ends verification. 'abandoned', 'pending', 'ongoing' and
   // any unknown status are NON-terminal: the payer may still complete the same checkout session.
   const terminalFailure=['failed','reversed'].includes(providerStatus)&&verified?.terminal!==false;
   const definitiveNotCreated=providerStatus==='not_created'&&verified?.verified===true&&verified?.definitiveNoCharge===true;
   return db.tx(async c=>{
    await c.query('SELECT id FROM shipments WHERE id=$1 FOR UPDATE',[intent.shipment_id]);
    const locked=(await c.query('SELECT * FROM shipment_checkout_intents WHERE id=$1 FOR UPDATE',[intent.id])).rows[0];
    if(locked.status==='confirmed')return {...resultRow(locked),duplicate:true};
    const touch=()=>c.query('UPDATE shipment_checkout_intents SET last_reconciled_at=now(),reconcile_lease_until=NULL,provider_last_status=$2 WHERE id=$1',[locked.id,providerStatus]);
    if(isSubmissionCallActive(locked)){
     return {status:'initiating',submissionInProgress:true,providerStatus,intentId:locked.id,reference:locked.reference};
    }
    const creationActive=canCreationStillComplete(locked);
    const isTerminal=terminalFailure||(definitiveNotCreated&&!creationActive&&locked.status!=='pending');
    if(isTerminal){
     const reason=String(verified?.failureReason||(terminalFailure?'Provider reported failed':'Provider confirmed checkout was never created')).slice(0,500);
     if(['initiating','pending'].includes(locked.status)){
      const r=(await c.query(
       `UPDATE shipment_checkout_intents
           SET status='failed',
               failure_reason=$2,
               failed_at=coalesce(failed_at,now()),
               provider_terminal_at=now(),
               provider_last_status=$3,
               submission_token=NULL,
               submission_lease_until=NULL,
               last_reconciled_at=now(),
               reconcile_lease_until=NULL,
               updated_at=now()
         WHERE id=$1 AND status IN ('initiating','pending')
         RETURNING *`,
       [locked.id,reason,providerStatus]
      )).rows[0];
      return {...resultRow(r??locked),terminal:true};
     }
     await c.query(
      `UPDATE shipment_checkout_intents
          SET provider_terminal_at=now(),
              provider_last_status=$2,
              failure_reason=coalesce(failure_reason,$3),
              last_reconciled_at=now(),
              reconcile_lease_until=NULL
        WHERE id=$1 AND provider_terminal_at IS NULL`,
      [locked.id,providerStatus,reason]
     );
     return {...resultRow(locked),status:locked.status,terminal:true,failureReason:locked.failure_reason??reason};
    }
    // Non-terminal outcome ('abandoned', 'pending', 'ongoing', unknown). Release the shipment's
    // active checkout slot once the checkout window elapses, while keeping provider_terminal_at NULL
    // so late payment completion is still recovered.
    const originTs=locked.submitted_at??locked.created_at;
    const ageSeconds=originTs?(Date.now()-new Date(originTs).getTime())/1000:0;
    if(['initiating','pending'].includes(locked.status)&&ageSeconds>=checkoutExpirySeconds&&!creationActive){
     const r=(await c.query(
      `UPDATE shipment_checkout_intents
          SET status='expired',
              failure_reason='Checkout window elapsed without verified payment; provider verification continues',
              provider_last_status=$2,
              submission_token=NULL,
              submission_lease_until=NULL,
              last_reconciled_at=now(),
              reconcile_lease_until=NULL,
              updated_at=now()
        WHERE id=$1 AND status IN ('initiating','pending')
        RETURNING *`,
      [locked.id,providerStatus]
     )).rows[0];
     return {...resultRow(r??locked),providerStatus,verificationContinues:true};
    }
    if(locked.status==='initiating'&&providerStatus!=='not_created'){
     const promoted=(await c.query(
      `UPDATE shipment_checkout_intents
          SET status='pending',
              submission_token=NULL,
              submission_lease_until=NULL,
              provider_last_status=$2,
              last_reconciled_at=now(),
              reconcile_lease_until=NULL,
              updated_at=now()
        WHERE id=$1
          AND status='initiating'
          AND (submission_token IS NULL OR submission_lease_until IS NULL OR submission_lease_until<=now())
          AND NOT EXISTS (
            SELECT 1 FROM shipment_checkout_intents other
             WHERE other.shipment_id=shipment_checkout_intents.shipment_id
               AND other.id<>shipment_checkout_intents.id
               AND other.status IN ('initiating','pending')
          )
        RETURNING *`,
      [locked.id,providerStatus]
     )).rows[0];
     if(promoted)return {...resultRow(promoted),providerStatus};
    }
    await touch();
    return {status:'unverified_or_pending',intentStatus:locked.status,providerStatus,submissionInProgress:creationActive,verificationContinues:true,intentId:locked.id,reference:locked.reference};
   });
  },
  async exceptionQueue(actor){check(actor?.kind==='admin',403);check((await db.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission=ANY($2::text[])",[actor.id,['payments:configure','finance:read','finance:approve','finance:configure']])).rowCount,403);return (await db.query(`SELECT provider,event_id,shipment_id,amount_minor,currency,reason,created_at FROM checkout_unapplied_payments UNION ALL SELECT i.provider,'refund:'||r.shipment_id::text,r.shipment_id,r.amount_minor,i.currency,r.reason,r.created_at FROM checkout_refund_requests r JOIN shipment_checkout_intents i ON i.id=r.intent_id WHERE r.status<>'refunded' ORDER BY created_at DESC LIMIT 100`)).rows;},
  async reconcileDue({olderThanMinutes,olderThanSeconds,limit=25}={}){
   const minSec=olderThanSeconds!==undefined?olderThanSeconds:(olderThanMinutes!==undefined?olderThanMinutes*60:2);
   check(Number.isInteger(minSec)&&minSec>=0&&Number.isInteger(limit)&&limit>0&&limit<=100,400);
   if(!provider||typeof provider.verifyPayment!=='function')return [];
   const rows=(await db.query(
    `UPDATE shipment_checkout_intents
        SET reconcile_lease_until=now()+make_interval(secs=>$3)
      WHERE id IN (
        SELECT id FROM shipment_checkout_intents
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
    [provider.name,limit,leaseSeconds,minSec,maxVerifyBackoffSeconds]
   )).rows;
   return pool(rows,concurrency,async({id})=>{
    try{
     const result=await this.reconcileIntent(id,{silentUnavailable:true});
     return {id,intentId:id,result};
    }catch(e){
     await db.query('UPDATE shipment_checkout_intents SET last_reconciled_at=now(),provider_last_status=$2 WHERE id=$1',[id,('verification_error:'+(e.status??503)).slice(0,40)]).catch(()=>{});
     return {id,intentId:id,errorCode:e.status??503,error:reasonText(e)};
    }finally{
     await db.query('UPDATE shipment_checkout_intents SET reconcile_lease_until=NULL WHERE id=$1',[id]).catch(()=>{});
    }
   });
  }
 };
}
