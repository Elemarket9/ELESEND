import {createHmac,timingSafeEqual} from 'node:crypto';
import {check} from './security.mjs';
import {validatedCheckoutUrl} from './checkout-policy.mjs';
/** OPTIONAL initial adapter. Not a domain dependency. Never expose secret to native app.
 * QR renders a provider-hosted checkout URL as a QR code (not GHQR merchant QR).
 * Requires active Ghana merchant account with the chosen checkout channels.
 */
export function paystackCheckout({secretKey,fetchImpl=fetch,endpoint='https://api.paystack.co',allowedMethods=['MOMO','CARD','QR'],production=process.env.NODE_ENV==='production'}={}){
 check(typeof secretKey==='string'&&/^sk_(live|test)_/.test(secretKey),503,'Valid server-only PSP key required');
 if(production)check(secretKey.startsWith('sk_live_'),503,'Live PSP key required for production');
 check(endpoint==='https://api.paystack.co',500,'Only official PSP endpoint is accepted');
 const methods=allowedMethods.filter(v=>['MOMO','CARD','QR'].includes(v));
 async function remote(path,options={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
   const response=await fetchImpl(endpoint+path,{...options,headers:{Authorization:`Bearer ${secretKey}`,'Accept-Encoding':'gzip, deflate',...options.headers},signal:controller.signal,redirect:'error'});
   check(response.ok,502,`PSP request failed (${response.status})`);
   const raw=await response.json();check(raw?.status===true,502,'PSP rejected request');return raw.data;
  }finally{clearTimeout(timer);}
 }
 async function verifyPayment(reference){
  check(/^[A-Za-z0-9._=-]{8,90}$/.test(reference),400,'Invalid PSP reference');
  const d=await remote('/transaction/verify/'+encodeURIComponent(reference));
  const id=d?.id;
  if(production)check(d?.domain==='live',409,'Production payment is not live');
  return {reference:d?.reference,status:d?.status,amountMinor:Number(d?.amount),currency:d?.currency,channel:d?.channel,
   eventId:(typeof id==='number'||typeof id==='string')?'psp-transaction:'+String(id):'',
   environment:d?.domain,transactionId:id};
 }
 return {
  name:'paystack',methods,allowedCheckoutHosts:['checkout.paystack.com'],payerFields:['email'],
  commissionIntentId(record){const ref=typeof record==='string'?record:record?.reference||'';const m=/^escomm_([0-9a-f]{32})$/.exec(ref);if(!m)return null;const h=m[1];return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');},
  async createCheckout({reference,amountMinor,currency,method,email}){
   check(methods.includes(method),503,'PSP channel not enabled');
   check(typeof email==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&email.length<=254,400,'Email required for authorized checkout');
   check(currency==='GHS'&&Number.isSafeInteger(amountMinor)&&amountMinor>0,400,'Invalid checkout amount');
   const channels={MOMO:['mobile_money'],CARD:['card'],QR:['mobile_money','card']}[method];
   // QR is rendered by the native app from this hosted checkout URL; buyer
   // scans with another device then uses a provider-approved payment channel.
   const d=await remote('/transaction/initialize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,amount:String(amountMinor),currency,reference,channels})});
   check(d?.reference===reference,502,'Provider reference differs from payment intent');
   return {checkoutUrl:validatedCheckoutUrl(d.authorization_url,{allowedHosts:['checkout.paystack.com']}),reference};
  },
  verifyPayment,
  async createRefund({requestId,reference,amountMinor,currency}){
   check(/^[0-9a-f-]{36}$/.test(requestId)&&Number.isSafeInteger(amountMinor)&&amountMinor>0&&currency==='GHS',400,'Invalid refund request');
   const d=await remote('/refund',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transaction:reference,amount:amountMinor,currency,merchant_note:'ELESEND refund '+requestId})});
   return {providerId:d?.id?String(d.id):null};
  },
  async verifyRefund({requestId,providerId,reference,amountMinor,currency}){
   const payment=await verifyPayment(reference);
   let d;
   if(providerId){check(/^\d+$/.test(String(providerId)),400,'Invalid provider refund ID');d=await remote('/refund/'+encodeURIComponent(providerId));}
   else{
    const rows=await remote('/refund?transaction='+encodeURIComponent(payment.transactionId)+'&perPage=100');
    check(Array.isArray(rows),503,'Invalid refund verification response');
    d=rows.find(x=>x.merchant_note==='ELESEND refund '+requestId);
    if(!d)return {verified:true,status:'pending',requestId};
   }
   const transactionId=typeof d.transaction==='object'?d.transaction?.id:d.transaction;
   check(/^\d+$/.test(String(d.id))&&payment.reference===reference&&String(transactionId)===String(payment.transactionId)&&Number(d.amount)===amountMinor&&d.currency===currency,409,'Refund transaction mismatch');
   if(production)check(d.domain==='live',409,'Refund is not live');
   return {verified:true,type:'refund',provider:'paystack',status:d.status==='processed'?'refunded':d.status==='failed'?'failed':'pending',requestId:/^ELESEND refund ([0-9a-f-]{36})$/.exec(String(d.merchant_note||''))?.[1]??null,providerId:String(d.id),reference:payment.reference,amountMinor:Number(d.amount),currency:d.currency,eventId:'refund:'+d.id+(d.status==='failed'?':failed':''),...(d.status==='failed'?{failureReason:'Provider reported refund failed'}:{})};
  },
  // Commission repayments use exactly the same vetted payment provider, but a
  // distinct webhook and backend financial transaction.
  async createPayment({intentId,amountMinor,currency,email,allowedChannels=['mobile_money']}){
   check(/^[0-9a-f-]{36}$/.test(intentId),400,'Invalid commission intent');
   check(typeof email==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),400,'Email required');
   // ELESEND channel names map 1:1 onto Paystack channel identifiers; unknown names are dropped.
   const channels=[...new Set((Array.isArray(allowedChannels)?allowedChannels:[]).filter(ch=>['mobile_money','card','bank_transfer','ussd'].includes(ch)))];
   check(channels.length>0,400,'No supported repayment channel configured');
   const reference='escomm_'+intentId.replaceAll('-','');
   const d=await remote('/transaction/initialize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reference,email,amount:String(amountMinor),currency,channels})});
   check(d?.reference===reference,502,'Commission PSP reference mismatch');
   return {checkoutUrl:validatedCheckoutUrl(d.authorization_url,{allowedHosts:['checkout.paystack.com']}),reference};
  },
  async verifyEvent({rawBody,headers}){
   const v=await this.parseVerifiedWebhook(rawBody,headers);
   // Channel admissibility is a business policy enforced by the finance service, not the adapter.
   check(v?.status==='success'&&['mobile_money','card','bank_transfer','ussd'].includes(v.channel),409,'Commission settlement not verified');
   const m=/^escomm_([0-9a-f]{32})$/.exec(v.reference);
   check(m,403,'Not a commission repayment event');
   const h=m[1],intentId=[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');
   return {verified:true,providerName:this.name,eventId:v.eventId,intentId,amountMinor:v.amountMinor,currency:v.currency,channel:v.channel};
  },
  async parseVerifiedWebhook(rawBody,headers){
   if(rawBody&&typeof rawBody==='object'&&!Buffer.isBuffer(rawBody)&&!(rawBody instanceof Uint8Array)&&('rawBody' in rawBody||'headers' in rawBody)){headers=rawBody.headers;rawBody=rawBody.rawBody;}
   const signature=headers?.['x-paystack-signature'];
   check(typeof signature==='string'&&/^[0-9a-f]{128}$/i.test(signature),403,'Missing or invalid PSP signature');
   const digest=createHmac('sha512',secretKey).update(rawBody).digest();
   check(timingSafeEqual(Buffer.from(signature,'hex'),digest),403,'Invalid PSP signature');
   let incoming;try{incoming=JSON.parse(rawBody.toString('utf8'));}catch{check(false,400,'Invalid PSP event');}
   if(incoming.event!=='charge.success')return null;
   const ref=incoming?.data?.reference;
   check(typeof ref==='string'&&/^[A-Za-z0-9._=-]{8,90}$/.test(ref),400,'Invalid PSP reference');
   // Signature does NOT replace independent server-side verification.
   const verified=await verifyPayment(ref);
   if(production)check(verified.environment==='live',409,'Production PSP transaction is not live');
   return verified;
  }
 };
}
