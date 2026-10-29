/** Optional HTTPS SMS gateway contract; NOT a simulated SMS sender.
 * The configured integration must accept {to,message,clientReference} and
 * reply {accepted:true,messageId:"..."} only after durable provider acceptance.
 * Never use customer-supplied URLs and never log OTP or provider credentials.
 */
import {check} from './security.mjs';
import {isIP} from 'node:net';
export function httpsSmsGateway({endpoint,allowedHost,token,fetchImpl=fetch,timeoutMs=8000}={}){
 check(typeof endpoint==='string'&&typeof allowedHost==='string'&&typeof token==='string'&&token.length>=16,503,'SMS gateway configuration incomplete');
 let url;try{url=new URL(endpoint);}catch{check(false,503,'Invalid SMS gateway endpoint');}
 check(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&!url.search&&isIP(url.hostname)===0&&url.hostname===allowedHost&&!/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(allowedHost)&&!allowedHost.endsWith('.local'),503,'SMS gateway destination not approved');
 check(Number.isInteger(timeoutMs)&&timeoutMs>=1000&&timeoutMs<=30000,500,'Invalid SMS request timeout');
 async function dispatchSms({phone,message,clientReference}){
  let response;
  try{response=await fetchImpl(url.toString(),{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Accept-Encoding':'gzip, deflate'},body:JSON.stringify({to:phone,message,clientReference}),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}
  catch{check(false,503,'SMS gateway unavailable');}
  check(response.ok,503,'SMS gateway refused request');
  let result;try{result=await response.json();}catch{check(false,503,'SMS gateway receipt invalid');}
  check(result?.accepted===true&&typeof result.messageId==='string'&&result.messageId.length>=3&&result.messageId.length<=160,503,'SMS gateway acceptance not verified');
  return {accepted:true,messageId:result.messageId};
 }
 return {
  async send({phone,code,purpose,challengeId}){
   check(typeof phone==='string',400,'Invalid OTP delivery request');
   let normalized=phone.trim().replace(/\s+/g,'');
   if(/^0[25]\d{8}$/.test(normalized))normalized='+233'+normalized.slice(1);
   else if(/^233[25]\d{8}$/.test(normalized))normalized='+'+normalized;
   check(/^\+233[25]\d{8}$/.test(normalized)&&/^\d{6}$/.test(code)&&['pickup','delivery','account','account_recovery'].includes(purpose)&&/^[0-9a-f-]{36}$/i.test(challengeId),400,'Invalid OTP delivery request');
   const msg=purpose==='account'
    ?`ELESEND account phone verification: ${code}. Do not share this code with anyone.`
    :purpose==='account_recovery'
    ?`ELESEND password recovery code: ${code}. Expires in 10 minutes. Do not share this code with anyone.`
    :purpose==='pickup'
    ?`ELESEND parcel pickup verification: ${code}. Never share with anyone except your assigned rider at handover.`
    :`ELESEND parcel delivery verification: ${code}. Give this to your assigned rider only when receiving the parcel.`;
   return dispatchSms({phone:normalized,message:msg,clientReference:challengeId});
  },
  async sendNotification({phone,message,jobId,clientReference,kind='notification'}={}){
   check(typeof phone==='string',400,'Phone number required');
   let normalized=phone.trim();
   if(/^0[25]\d{8}$/.test(normalized))normalized='+233'+normalized.slice(1);
   else if(/^233[25]\d{8}$/.test(normalized))normalized='+'+normalized;
   check(/^\+233[25]\d{8}$/.test(normalized),400,'Invalid notification phone number');
   const text=typeof message==='string'?message.trim():'';
   check(text.length>=1&&text.length<=480,400,'Invalid notification message text');
   const ref=String(clientReference||jobId||`${kind}:${normalized}`).trim().slice(0,120);
   check(ref.length>=1,400,'Notification reference required');
   return dispatchSms({phone:normalized,message:text,clientReference:ref});
  }
 };
}
