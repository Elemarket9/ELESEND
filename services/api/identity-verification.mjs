/**
 * Hosted identity check: the provider's secure page takes the licence photo, selfie and liveness check,
 * so ELESEND stores results and never the images. Webhook bodies only prompt a fresh read from the provider.
 */
import {createHmac,timingSafeEqual} from 'node:crypto';
import {check} from './security.mjs';

const ENDPOINT='https://verification.didit.me/v3/session/';
const uuidPattern=/^[0-9a-f-]{36}$/i;
export function diditProvider({apiKey,workflowId,webhookSecret,fetchImpl=fetch}){
 check(apiKey&&workflowId&&webhookSecret,503,'Identity verification is not configured');
 async function remote(path,options={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
   const response=await fetchImpl(ENDPOINT+path,{...options,headers:{'x-api-key':apiKey,'Content-Type':'application/json',...options.headers},signal:controller.signal,redirect:'error'});
   check(response.ok,502,`Identity provider request failed (${response.status})`);
   return await response.json();
  }finally{clearTimeout(timer);}
 }
 return {
  async createSession({riderId}){
   const d=await remote('',{method:'POST',body:JSON.stringify({workflow_id:workflowId,vendor_data:riderId})});
   check(uuidPattern.test(d?.session_id)&&/^https:\/\//.test(d?.url),502,'Invalid identity session response');
   return {sessionId:d.session_id,url:d.url};
  },
  getDecision(sessionId){
   check(uuidPattern.test(sessionId),400,'Invalid identity session');
   return remote(encodeURIComponent(sessionId)+'/decision/');
  },
  verifyWebhook(rawBody,headers,now=Date.now()){
   const timestamp=Number(headers['x-timestamp']),signature=String(headers['x-signature']??'');
   check(Number.isFinite(timestamp)&&Math.abs(now/1000-timestamp)<=300,403,'Stale identity webhook');
   const digest=createHmac('sha256',webhookSecret).update(rawBody).digest();
   let given=Buffer.alloc(0);
   if(/^[0-9a-f]{64}$/i.test(signature))given=Buffer.from(signature,'hex');
   check(given.length===digest.length&&timingSafeEqual(given,digest),403,'Invalid identity webhook signature');
  }
 };
}
export function identityConfigured(env=process.env){return Boolean(env.DIDIT_API_KEY&&env.DIDIT_WORKFLOW_ID&&env.DIDIT_WEBHOOK_SECRET);}
export function identityProviderFromEnv(env=process.env){
 return diditProvider({apiKey:env.DIDIT_API_KEY,workflowId:env.DIDIT_WORKFLOW_ID,webhookSecret:env.DIDIT_WEBHOOK_SECRET});
}
