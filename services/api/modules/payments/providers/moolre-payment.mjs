import {timingSafeEqual} from 'node:crypto';
import {check,phone as canonicalGhanaPhone} from '../../../security.mjs';
import {validatedCheckoutUrl} from '../checkout-policy.mjs';

/**
 * Moolre adapter. Fixture-tested against https://docs.moolre.com, not yet run against its sandbox.
 * Off unless PAYMENT_PROVIDER=moolre. The rule throughout: only a clear answer changes money.
 * Anything unclear stays pending and is checked again, so nobody is paid twice.
 */
const LIVE='https://api.moolre.com',SANDBOX='https://sandbox.moolre.com';
const CHANNELS={MTN:'1',TELECEL:'6',AT:'7'};
// Ghana's number prefixes. Refunds only: a ported number fails safely and goes to staff.
const PREFIX_CHANNELS={'024':'1','025':'1','053':'1','054':'1','055':'1','059':'1','020':'6','050':'6','026':'7','027':'7','056':'7','057':'7'};
const NOT_FOUND='SS07';
const local=value=>{try{return '0'+canonicalGhanaPhone(value).slice(4);}catch{return null;}};
const decimal=minor=>{check(Number.isSafeInteger(minor)&&minor>0,400,'Invalid amount');return `${Math.floor(minor/100)}.${String(minor%100).padStart(2,'0')}`;};
/** Whole pesewas from provider text, without passing through floating point. */
function pesewas(value){
 const m=/^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(value??''));
 return m?Number(m[1])*100+Number((m[2]??'').padEnd(2,'0')):NaN;
}
// Payment links allow only letters, numbers and - . = so internal underscores are swapped at the edge.
const external=reference=>reference.replace(/^(es|escomm)_/,'$1-');
const internal=reference=>String(reference??'').replace(/^(es|escomm)-/,'$1_');
const sameText=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);};

export function moolreCheckout({apiUser,publicKey,privateKey,accountNumber,callbackSecret,merchantEmail,callbackBaseUrl,returnBaseUrl,
 allowedMethods=['MOMO'],processingFeeBps=0,checkoutHosts=['pos.moolre.com','moolre.com','sandbox.moolre.com'],checkoutPath='/embed/link',
 sandbox=false,failedStatusConfirmed=false,fetchImpl=fetch,production=process.env.NODE_ENV==='production'}={}){
 check(typeof apiUser==='string'&&apiUser.trim(),503,'Moolre API user required');
 check(/^\d{6,20}$/.test(String(accountNumber??'')),503,'Moolre account number required');
 check(typeof merchantEmail==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(merchantEmail),503,'Moolre merchant email required');
 check(typeof callbackSecret==='string'&&callbackSecret.length>=8,503,'Moolre callback secret required');
 check(Number.isInteger(processingFeeBps)&&processingFeeBps>=0&&processingFeeBps<=1000,500,'Invalid Moolre customer fee');
 if(production)check(!sandbox,503,'Moolre sandbox cannot be used in production');
 if(!sandbox)check(publicKey&&privateKey,503,'Moolre live keys required');
 const endpoint=sandbox?SANDBOX:LIVE;
 const methods=allowedMethods.filter(v=>['MOMO','QR'].includes(v));
 check(methods.length>0,500,'No supported Moolre payment method');
 const callback=()=>{check(callbackBaseUrl&&returnBaseUrl,500,'Moolre needs callback and return URLs');return String(callbackBaseUrl).replace(/\/$/,'')+'/api/v1/payments/webhook';};

 async function remote(path,body,{secret=false}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
   const key=secret?{'X-API-KEY':privateKey}:{'X-API-PUBKEY':publicKey};
   const response=await fetchImpl(endpoint+path,{method:'POST',redirect:'error',signal:controller.signal,
    headers:{'Content-Type':'application/json',Accept:'application/json','X-API-USER':apiUser,...(sandbox?{}:key)},
    body:JSON.stringify({accountnumber:String(accountNumber),...body})});
   let raw=null;try{raw=await response.json();}catch{/* Reported below. */}
   check(raw&&typeof raw==='object',502,'Moolre returned an unreadable response');
   return {...raw,ok:response.ok,accepted:Number(raw.status)===1};
  }finally{clearTimeout(timer);}
 }
 /** One lookup for payments, payouts and refunds. Never turns "not found" or an unknown value into a failure. */
 async function lookup(reference,{secret=false}={}){
  const r=await remote('/open/transact/status',{type:1,idtype:1,id:reference},{secret});
  if(r.code===NOT_FOUND)return {state:'not_found'};
  check(r.ok,502,'Moolre status lookup failed');
  const d=r.data;
  if(!d||typeof d!=='object')return {state:'pending'};
  check(String(d.externalref??'')===reference,409,'Moolre returned another transaction');
  if(d.accountnumber!=null)check(String(d.accountnumber)===String(accountNumber),409,'Moolre returned another wallet');
  const tx=Number(d.txstatus);
  return {state:r.accepted&&r.code==='SS01'&&tx===1?'success':tx===2?'failed':'pending',data:d,amountMinor:pesewas(d.amount),transactionId:d.transactionid!=null?String(d.transactionid):null};
 }
 async function verifyPayment(reference){
  check(typeof reference==='string'&&/^[A-Za-z0-9._=-]{8,90}$/.test(reference),400,'Invalid payment reference');
  const found=await lookup(external(reference));
  if(found.state==='not_found')return {reference,status:'pending',currency:'GHS',channel:'mobile_money'};
  return {reference,status:found.state,amountMinor:found.amountMinor,currency:'GHS',channel:'mobile_money',
   eventId:found.transactionId?'moolre-transaction:'+found.transactionId:'',environment:sandbox?'test':'live',transactionId:found.transactionId};
 }
 async function paymentLink(reference,amountMinor,currency,returnPath){
  check(currency==='GHS',400,'Moolre checkout supports cedis only');
  const r=await remote(checkoutPath,{type:1,amount:decimal(amountMinor),email:merchantEmail,externalref:external(reference),reusable:'0',currency,
   callback:callback(),redirect:`${String(returnBaseUrl).replace(/\/$/,'')}${returnPath}?ref=${encodeURIComponent(reference)}`});
  check(r.ok&&r.accepted&&typeof r.data?.authorization_url==='string',502,'Moolre did not return a checkout link');
  return {checkoutUrl:validatedCheckoutUrl(r.data.authorization_url,{allowedHosts:checkoutHosts}),reference};
 }
 /** Sends money from the Moolre wallet. A repeated reference is refused by Moolre, so a retry cannot pay twice. */
 async function transfer({externalref,channel,receiver,amountMinor,currency,note}){
  check(currency==='GHS',400,'Moolre transfers support cedis only');
  const r=await remote('/open/transact/transfer',{type:1,channel,currency,amount:decimal(amountMinor),receiver,externalref,reference:note},{secret:true});
  // Already sent under this reference: the status lookup decides what happened.
  if(r.code==='APY18')return {providerId:null};
  // An error here leaves the operation locked for review, never released.
  check(r.ok&&r.accepted,502,'Moolre transfer not accepted: '+String(r.code??'unknown'));
  return {providerId:r.data?.transactionid!=null?String(r.data.transactionid):null};
 }
 /** Reads a transfer. A failure only counts once Moolre has confirmed in writing what txstatus 2 means. */
 async function transferOutcome(reference,amountMinor){
  const found=await lookup(reference,{secret:true});
  if(found.state==='not_found')return {state:'not_found'};
  if(found.state==='success')check(found.amountMinor===amountMinor,409,'Moolre transfer amount mismatch');
  return {...found,state:found.state==='failed'&&!failedStatusConfirmed?'pending':found.state};
 }
 const parseRecipient=value=>{const m=/^moolre:(1|6|7):(0\d{9})$/.exec(String(value??''));return m&&{channel:m[1],phone:m[2]};};
 const PAYOUT='espayout-',REFUND='esrefund-';

 return {
  name:'moolre',methods,processingFeeBps,requiresVerifiedPhone:true,requiresRefundPhone:true,payerFields:[],allowedCheckoutHosts:checkoutHosts,
  async createCheckout({reference,amountMinor,currency,method}){
   check(methods.includes(method),503,'Payment method not enabled on Moolre');
   check(/^[A-Za-z0-9._=-]{8,90}$/.test(reference),400,'Invalid checkout reference');
   return paymentLink(reference,amountMinor,currency,'/checkout/complete');
  },
  verifyPayment,
  async createPayment({intentId,amountMinor,currency}){
   check(/^[0-9a-f-]{36}$/.test(intentId),400,'Invalid commission intent');
   return paymentLink('escomm_'+intentId.replaceAll('-',''),amountMinor,currency,'/settlement/complete');
  },
  commissionIntentId(record){const ref=typeof record==='string'?record:record?.reference||'';const m=/^escomm_([0-9a-f]{32})$/.exec(ref);if(!m)return null;const h=m[1];return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');},
  async verifyEvent({rawBody,headers}){
   const v=await this.parseVerifiedWebhook(rawBody,headers);
   check(v?.status==='success'&&v.channel==='mobile_money',409,'Commission settlement not verified');
   const intentId=this.commissionIntentId(v);
   check(intentId,403,'Not a commission repayment event');
   return {verified:true,providerName:this.name,eventId:v.eventId,intentId,amountMinor:v.amountMinor,currency:v.currency,channel:v.channel};
  },
  /** The callback only prompts a check: the payment is read back from Moolre before anything changes. */
  async parseVerifiedWebhook(rawBody,headers){
   if(rawBody&&typeof rawBody==='object'&&!Buffer.isBuffer(rawBody)&&!(rawBody instanceof Uint8Array)&&('rawBody' in rawBody||'headers' in rawBody)){headers=rawBody.headers;rawBody=rawBody.rawBody;}
   let incoming;try{incoming=JSON.parse(Buffer.from(rawBody).toString('utf8'));}catch{check(false,400,'Invalid Moolre callback');}
   check(typeof incoming?.data?.secret==='string'&&sameText(incoming.data.secret,callbackSecret),403,'Invalid Moolre callback secret');
   if(incoming.code!=='P01')return null;
   const reference=incoming.data.externalref;
   check(typeof reference==='string'&&/^[A-Za-z0-9._=-]{8,90}$/.test(reference),400,'Invalid Moolre reference');
   // Payouts and refunds are confirmed by the reconciliation job.
   if(reference.startsWith(PAYOUT)||reference.startsWith(REFUND))return null;
   return verifyPayment(internal(reference));
  },
  /** The number is verified by SMS before this runs, and is the only place money can go. */
  async createBeneficiary({phone,network}){
   const channel=CHANNELS[network],receiver=local(phone);
   check(channel,400,'Unsupported mobile money network');
   check(receiver,400,'Valid mobile money number required');
   return {recipientReference:`moolre:${channel}:${receiver}`};
  },
  async verifyBeneficiary({beneficiaryId,recipientReference,verifiedPhone}){
   const recipient=parseRecipient(recipientReference);
   return {verified:Boolean(recipient&&local(verifiedPhone)&&recipient.phone===local(verifiedPhone)),beneficiaryId,recipientReference};
  },
  async createPayout({requestId,recipientReference,amountMinor,currency}){
   check(/^[0-9a-f-]{36}$/.test(requestId),400,'Invalid payout request');
   const recipient=parseRecipient(recipientReference);
   check(recipient,400,'Invalid payout recipient');
   return transfer({externalref:PAYOUT+requestId,channel:recipient.channel,receiver:recipient.phone,amountMinor,currency,note:'ELESEND payout'});
  },
  async verifyPayout({requestId,recipientReference,amountMinor,currency}){
   check(/^[0-9a-f-]{36}$/.test(requestId),400,'Invalid payout request');
   const out=await transferOutcome(PAYOUT+requestId,amountMinor);
   if(out.state==='not_found')return {verified:false,type:'payout',provider:'moolre',status:'not_found',requestId};
   return {verified:true,type:'payout',provider:'moolre',status:out.state==='success'?'paid':out.state,reversed:false,requestId,
    providerId:out.transactionId,recipientReference,amountMinor,currency,eventId:out.transactionId?`transfer:${out.transactionId}${out.state==='failed'?':failed':''}`:'',
    ...(out.state==='failed'?{failureReason:'Moolre reported the transfer failed'}:{})};
  },
  /** Moolre documents no refund for collections, so the money goes back to the customer's verified number as a transfer. */
  async createRefund({requestId,reference,amountMinor,currency,customerPhone}){
   check(/^[0-9a-f-]{36}$/.test(requestId),400,'Invalid refund request');
   const receiver=local(customerPhone),channel=receiver&&PREFIX_CHANNELS[receiver.slice(0,3)];
   check(channel,409,'Refund needs staff: the customer number or its network is unknown');
   const paid=await verifyPayment(reference);
   check(paid.status==='success'&&paid.amountMinor>=amountMinor,409,'Refund exceeds the verified payment');
   return transfer({externalref:REFUND+requestId,channel,receiver,amountMinor,currency,note:'ELESEND refund'});
  },
  async verifyRefund({requestId,reference,amountMinor,currency}){
   check(/^[0-9a-f-]{36}$/.test(requestId),400,'Invalid refund request');
   const out=await transferOutcome(REFUND+requestId,amountMinor);
   if(!['success','failed'].includes(out.state))return {verified:true,type:'refund',provider:'moolre',status:'pending',requestId};
   return {verified:true,type:'refund',provider:'moolre',status:out.state==='success'?'refunded':'failed',requestId,reference,providerId:out.transactionId,amountMinor,currency,
    eventId:out.transactionId?`refund:${out.transactionId}${out.state==='failed'?':failed':''}`:'',
    ...(out.state==='failed'?{failureReason:'Moolre reported the refund failed'}:{})};
  }
 };
}
