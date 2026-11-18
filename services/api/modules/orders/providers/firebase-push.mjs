import {createSign} from 'node:crypto';
import {check} from '../../../shared/security.mjs';
import {RIDER_OFFER_ALERT_CHANNEL} from '../notifications.mjs';

export const UPDATES_CHANNEL='elesend-updates';
const TOKEN_URL='https://oauth2.googleapis.com/token';
const SCOPE='https://www.googleapis.com/auth/firebase.messaging';
const base64url=value=>Buffer.from(value).toString('base64url');

const strings=payload=>Object.fromEntries(Object.entries(payload).filter(([key,value])=>key!=='pushTokens'&&value!==null&&value!==undefined).map(([key,value])=>[key,typeof value==='string'?value:JSON.stringify(value)]));

/** Sends directly to Firebase. A job is accepted when at least one of the person's devices took it. */
export function firebasePush(account,{fetchImpl=fetch,now=()=>Date.now()}={}){
 let cached=null;
 async function accessToken(){
  if(cached&&cached.expiresAt>now()+60000)return cached.token;
  const issued=Math.floor(now()/1000);
  const unsigned=`${base64url(JSON.stringify({alg:'RS256',typ:'JWT'}))}.${base64url(JSON.stringify({iss:account.client_email,scope:SCOPE,aud:TOKEN_URL,iat:issued,exp:issued+3600}))}`;
  const signature=createSign('RSA-SHA256').update(unsigned).sign(account.private_key,'base64url');
  const response=await fetchImpl(TOKEN_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${unsigned}.${signature}`})});
  check(response.ok,503,'Firebase sign-in refused');
  const data=await response.json();
  check(typeof data.access_token==='string',503,'Firebase sign-in incomplete');
  cached={token:data.access_token,expiresAt:now()+Number(data.expires_in||3600)*1000};
  return cached.token;
 }
 return {
  pushOnly:true,
  async send(job){
   const tokens=(job.payload?.pushTokens||[]).filter(t=>t.platform==='fcm').map(t=>t.token);
   if(!tokens.length)return {accepted:false,noDevice:true};
   const bearer=await accessToken();
   const offer=job.kind==='dispatch_offer';
   const invalidTokens=[];let messageId=null;
   for(const token of tokens){
    const response=await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},
     body:JSON.stringify({message:{token,data:strings({...job.payload,kind:job.kind,jobId:job.id}),android:{priority:'HIGH',...(offer?{ttl:'30s'}:{}),notification:{title:'ELESEND',body:String(job.payload?.message||'You have an update from ELESEND'),channel_id:offer?RIDER_OFFER_ALERT_CHANNEL:UPDATES_CHANNEL}}}})});
    if(response.ok){messageId=(await response.json()).name||messageId;continue;}
    if(response.status===404)invalidTokens.push(token);
   }
   return {accepted:Boolean(messageId),messageId,invalidTokens,noDevice:!messageId&&invalidTokens.length===tokens.length};
  }
 };
}
