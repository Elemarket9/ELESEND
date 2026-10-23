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
 return {async send({phone,code,purpose,challengeId}){
  check(/^\+233[25]\d{8}$/.test(phone)&&/^\d{6}$/.test(code)&&['pickup','delivery','account'].includes(purpose)&&/^[0-9a-f-]{36}$/i.test(challengeId),400,'Invalid OTP delivery request');
  const msg=purpose==='account'?`ELESEND account phone verification: ${code}. Do not share this code with anyone.`:purpose==='pickup'?`ELESEND parcel pickup verification: ${code}. Never share with anyone except your assigned rider at handover.`:`ELESEND parcel delivery verification: ${code}. Give this to your assigned rider only when receiving the parcel.`;
  let response;
  try{response=await fetchImpl(url.toString(),{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Accept-Encoding':'gzip, deflate'},body:JSON.stringify({to:phone,message:msg,clientReference:challengeId}),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}
  catch{check(false,503,'SMS gateway unavailable');}
  check(response.ok,503,'SMS gateway refused request');
  let result;try{result=await response.json();}catch{check(false,503,'SMS gateway receipt invalid');}
  check(result?.accepted===true&&typeof result.messageId==='string'&&result.messageId.length>=3&&result.messageId.length<=160,503,'SMS gateway acceptance not verified');
  return {accepted:true,messageId:result.messageId};
 }};
}
