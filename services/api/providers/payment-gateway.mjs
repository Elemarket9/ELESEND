import {check} from '../security.mjs';
import {isIP} from 'node:net';

// Deployment-owned PSP bridge. This is an ELESEND integration contract, not a
// claim that any third-party PSP implements these paths directly.
export function paymentGateway({name,endpoint,allowedHost,token,methods=['MOMO','CARD'],checkoutHosts=[],payerFields=[],fetchImpl=fetch}={}){
 const url=new URL(endpoint);
 check(/^[a-z][a-z0-9_-]{1,40}$/.test(name||''),500,'Payment gateway name required');
 check(url.protocol==='https:'&&url.hostname===allowedHost&&!url.username&&!url.password&&!url.search&&!url.hash&&!url.port&&isIP(url.hostname)===0&&url.hostname!=='localhost'&&!url.hostname.endsWith('.local')&&typeof token==='string'&&token.length>=32,500,'Payment bridge requires approved HTTPS endpoint and secret');
 check(checkoutHosts.length>0&&checkoutHosts.every(h=>/^[a-z0-9.-]+$/.test(h)),500,'Approved hosted checkout domains required');
 check(Array.isArray(methods)&&methods.length>0&&methods.every(m=>['MOMO','CARD','QR'].includes(m)),500,'Invalid payment bridge methods');
 check(Array.isArray(payerFields)&&payerFields.every(f=>f==='email'),500,'Unsupported payment bridge payer field');
 async function remote(path,input){
  const r=await fetchImpl(new URL(url.toString().replace(/\/$/,'')+path),{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':input.idempotencyKey||input.reference||input.intentId||input.requestId||''},body:JSON.stringify(input)});
  const result=await r.json();
  if(!r.ok&&result?.verified===true&&result.definitiveNoCharge===true)throw Object.assign(Error('Payment request rejected before any charge'),{status:400,definitiveNoCharge:true});
  check(r.ok,503,'Payment bridge unavailable');return result;
 }
 async function verified(path,input){const r=await remote(path,input);check(r?.verified===true,409,'Independent provider verification required');return r;}
 return {
  name,methods,allowedCheckoutHosts:checkoutHosts,payerFields,
  createCheckout:x=>remote('/checkout',x),verifyPayment:reference=>verified('/verify',{reference}),
  createPayment:x=>remote('/commission-checkout',x),
  commissionIntentId:r=>{if(typeof r==='object'&&r?.commissionIntentId)return r.commissionIntentId;const ref=typeof r==='string'?r:r?.reference||'';const m=/^escomm_([0-9a-f]{32})$/.exec(ref);if(!m)return null;const h=m[1];return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');},
  parseVerifiedWebhook:(rawBody,headers)=>{if(rawBody&&typeof rawBody==='object'&&!Buffer.isBuffer(rawBody)&&!(rawBody instanceof Uint8Array)&&('rawBody' in rawBody||'headers' in rawBody)){headers=rawBody.headers;rawBody=rawBody.rawBody;}return verified('/webhooks/verify',{rawBody:Buffer.from(rawBody).toString('base64'),headers:Object.fromEntries(Object.entries(headers||{}).filter(([k])=>!['authorization','cookie'].includes(k)))});},
  createRefund:x=>remote('/refunds',x),verifyRefund:x=>verified('/refunds/verify',x),
  verifyBeneficiary:x=>verified('/beneficiaries/verify',x),
  createPayout:x=>remote('/payouts',x),verifyPayout:x=>verified('/payouts/verify',x)
 };
}
