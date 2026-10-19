import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check} from './security.mjs';
import {DIGITAL_METHODS,validateVerifiedPayment,validatedCheckoutUrl} from './checkout-policy.mjs';
import {customerMoneyReceived,customerMoneyUnapplied} from './checkout-accounting.mjs';
const uuid=z.string().uuid(),key=z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);
const payer=z.object({idempotencyKey:key,email:z.email().max(254).optional()}).strict();
/** A shipment payment is confirmed ONLY by independently verified provider evidence.
 * The local app never gets to choose amount, currency, provider reference or success.
 */
export function checkoutService(db,{provider=null}={}){
 const cap=method=>!!provider&&DIGITAL_METHODS.includes(method)&&provider.methods?.includes(method)&&typeof provider.createCheckout==='function'&&typeof provider.verifyPayment==='function';
 const list=async()=>{
  const r=await db.query('SELECT method,enabled FROM checkout_method_policies ORDER BY method');
  return r.rows.map(x=>({method:x.method,enabled:x.method==='CASH'?true:x.enabled&&cap(x.method),configured:x.method==='CASH'||cap(x.method),adminEnabled:x.enabled}));
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
   if(prior||suspense){check((prior??suspense).intent_id===intent.id,409,'Provider event reused for another checkout');return {status:prior?'confirmed':'refund_review',duplicate:true,shipmentId:s.id};}
   const valid=(()=>{try{return validateVerifiedPayment(verification,{reference:intent.reference,amountMinor:Number(intent.amount_minor),currency:intent.currency,method:intent.method});}catch{return false;}})();
   const normal=valid&&Number(s.amount_minor)===Number(intent.amount_minor)&&!s.paid&&s.state==='AWAITING_PAYMENT'&&intent.status!=='confirmed'&&intent.status!=='failed';
   if(!normal){
    // Verified money can arrive AFTER cancellation, an expired attempt, or
    // duplicate/conflicting PSP charges. Persist separately for refund review.
    const reason=!valid?'payment_terms_mismatch':s.paid?'already_paid':s.state!=='AWAITING_PAYMENT'?'shipment_not_payable':'stale_payment_intent';
    await c.query('INSERT INTO checkout_unapplied_payments(provider,event_id,intent_id,shipment_id,provider_reference,amount_minor,currency,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[provider.name,verification.eventId,intent.id,s.id,intent.reference,verification.amountMinor,verification.currency,reason]);
    await customerMoneyUnapplied(c,{shipmentId:s.id,eventKey:'checkout:'+provider.name+':unapplied:'+verification.eventId,amountMinor:verification.amountMinor});
    await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[s.customer_id,'checkout.payment_unapplied_refund_review',s.id]);
    return {status:'refund_review',reason,shipmentId:s.id};
   }
   await c.query('INSERT INTO checkout_confirmed_events(provider,event_id,intent_id,shipment_id,reference,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6,$7)',[provider.name,verification.eventId,intent.id,s.id,intent.reference,verification.amountMinor,verification.currency]);
   // Existing immutable settlement evidence retained for earlier module compatibility.
   await c.query('INSERT INTO payment_events(provider,event_id,shipment_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5)',[provider.name,verification.eventId,s.id,verification.amountMinor,verification.currency]);
   await customerMoneyReceived(c,{shipmentId:s.id,eventKey:'checkout:'+provider.name+':verified:'+verification.eventId,amountMinor:verification.amountMinor});
   await c.query("UPDATE shipment_checkout_intents SET status='confirmed',confirmed_at=now(),updated_at=now() WHERE id=$1",[intent.id]);
   await c.query("UPDATE shipments SET paid=true,state='AWAITING_ASSIGNMENT' WHERE id=$1",[s.id]);
   await c.query('INSERT INTO outbox(shipment_id,kind,payload) VALUES($1,$2,$3)',[s.id,'payment_confirmed',JSON.stringify({shipmentId:s.id,kind:'payment_confirmed'})]);
   await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[s.customer_id,'checkout.payment_verified',s.id]);
   return {status:'confirmed',duplicate:false,shipmentId:s.id};
  });
 }
 const resultRow=r=>({intentId:r.id,shipmentId:r.shipment_id,method:r.method,status:r.status,checkoutUrl:r.checkout_url??null,reference:r.reference,amountMinor:Number(r.amount_minor),currency:r.currency});
 return {
  methods:list,
  async configure(actor,{method,enabled}){
   check(DIGITAL_METHODS.includes(method)&&typeof enabled==='boolean',400,'Invalid checkout method configuration');
   if(enabled)check(cap(method),503,'Authorized payment adapter for this method is not configured');
   return db.tx(async c=>{await admin(c,actor);await c.query('UPDATE checkout_method_policies SET enabled=$2,updated_by=$3,updated_at=now() WHERE method=$1',[method,enabled,actor.id]);await c.query('INSERT INTO audit_logs(actor_id,action) VALUES($1,$2)',[actor.id,'checkout.method.'+method+'.'+(enabled?'enabled':'disabled')]);return {method,enabled};});
  },
  async initiate(actor,shipmentId,input){uuid.parse(shipmentId);const v=payer.parse(input);
   check(['customer','business'].includes(actor?.kind),403,'Customer or business account required');
   // Keep creation transaction short; no network calls while holding row locks.
   const created=await db.tx(async c=>{
    const s=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[shipmentId])).rows[0];
    check(s&&s.customer_id===actor.id,404,'Shipment not found');
    check(DIGITAL_METHODS.includes(s.payment_method),409,'Cash shipments do not require online checkout');
    const old=(await c.query('SELECT * FROM shipment_checkout_intents WHERE customer_id=$1 AND idempotency_key=$2',[actor.id,v.idempotencyKey])).rows[0];
    if(old){check(old.shipment_id===shipmentId,409,'Idempotency key reused for another shipment');return {...old,wasExisting:true};}
    check(!s.paid&&s.state==='AWAITING_PAYMENT',409,'Shipment no longer awaits payment');
    check(cap(s.payment_method),503,'Authorized payment channel unavailable');
    const active=(await c.query("SELECT * FROM shipment_checkout_intents WHERE shipment_id=$1 AND status IN ('initiating','pending')",[shipmentId])).rows[0];
    if(active){check(false,409,'An existing payment attempt is pending; refresh its status instead');}
    const pol=(await c.query('SELECT enabled FROM checkout_method_policies WHERE method=$1',[s.payment_method])).rows[0];
    check(pol?.enabled,503,'Payment method is disabled');
    const id=randomUUID(),reference='es_'+id.replaceAll('-','');
    const r=(await c.query('INSERT INTO shipment_checkout_intents(id,shipment_id,customer_id,method,provider,reference,amount_minor,currency,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[id,s.id,actor.id,s.payment_method,provider.name,reference,s.amount_minor,'GHS',v.idempotencyKey])).rows[0];
    return r;
   });
   if(created.wasExisting)return resultRow(created);
   let instructions;
   try{
    instructions=await provider.createCheckout({reference:created.reference,amountMinor:Number(created.amount_minor),currency:created.currency,method:created.method,email:v.email});
    check(instructions?.reference===created.reference,502,'PSP reference disagreement');
    instructions.checkoutUrl=validatedCheckoutUrl(instructions.checkoutUrl,{allowedHosts:provider.allowedCheckoutHosts??[]});
   }catch(e){
    // PSP may have accepted transaction although HTTP response failed. Leave
    // initiating for reconciler; never silently release slot and double-charge.
    throw Object.assign(Error('Checkout initialization unconfirmed; query status before retry'),{status:503});
   }
   const updated=await db.tx(async c=>{
    const s=(await c.query('SELECT id FROM shipments WHERE id=$1 FOR UPDATE',[shipmentId])).rows[0];
    check(s,404);
    return (await c.query("UPDATE shipment_checkout_intents SET status=CASE WHEN status='initiating' THEN 'pending' ELSE status END,checkout_url=$2,updated_at=now() WHERE id=$1 RETURNING *",[created.id,instructions.checkoutUrl])).rows[0];
   });
   return resultRow(updated);
  },
  async status(actor,shipmentId){uuid.parse(shipmentId);check(['customer','business'].includes(actor?.kind),403);
   const r=(await db.query(`SELECT i.* FROM shipment_checkout_intents i JOIN shipments s ON s.id=i.shipment_id WHERE i.shipment_id=$1 AND s.customer_id=$2 ORDER BY i.created_at DESC LIMIT 1`,[shipmentId,actor.id])).rows[0];
   check(r,404,'Checkout not found');
   return resultRow(r);
  },
  async webhook(rawBody,headers){check(provider&&typeof provider.parseVerifiedWebhook==='function',503,'Webhook not configured');
   const verification=await provider.parseVerifiedWebhook(rawBody,headers);
   if(!verification)return {status:'ignored'};
   return confirm(verification);
  },
  async reconcileIntent(intentId){ // server-only recovery call; no unsigned HTTP endpoint
   uuid.parse(intentId);check(provider,503,'Provider unavailable');
   const intent=(await db.query('SELECT * FROM shipment_checkout_intents WHERE id=$1',[intentId])).rows[0];check(intent&&intent.provider===provider.name,404);
   if(intent.status==='confirmed'||intent.status==='failed')return resultRow(intent);
   const status=await provider.verifyPayment(intent.reference);
   if(status.status==='success')return confirm(status);
   // A provider-verified explicit terminal failure may safely release payment slot.
   if(['failed','abandoned','reversed'].includes(status.status))return db.tx(async c=>{
    await c.query('SELECT id FROM shipments WHERE id=$1 FOR UPDATE',[intent.shipment_id]);
    const r=(await c.query("UPDATE shipment_checkout_intents SET status='failed',updated_at=now() WHERE id=$1 AND status IN ('initiating','pending') RETURNING *",[intent.id])).rows[0];return resultRow(r??intent);
   });
   return {status:'unverified_or_pending',intentId};
  },
  async exceptionQueue(actor){check(actor?.kind==='admin',403);check((await db.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission='payments:configure'",[actor.id])).rowCount,403);return (await db.query('SELECT provider,event_id,shipment_id,amount_minor,currency,reason,created_at FROM checkout_unapplied_payments ORDER BY created_at DESC LIMIT 100')).rows;},
  async reconcileDue({olderThanMinutes=5,limit=25}={}){
   check(Number.isInteger(olderThanMinutes)&&olderThanMinutes>=1&&Number.isInteger(limit)&&limit>0&&limit<=100,400);
   const rows=await db.query("SELECT id FROM shipment_checkout_intents WHERE status IN ('pending','initiating') AND updated_at<now()-($1::int*interval '1 minute') ORDER BY updated_at ASC LIMIT $2",[olderThanMinutes,limit]);
   const reports=[];for(const {id} of rows.rows){try{reports.push({id,result:await this.reconcileIntent(id)});}catch(e){reports.push({id,errorCode:e.status??503});}}
   return reports;
  }
 };
}
