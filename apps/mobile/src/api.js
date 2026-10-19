import * as SecureStore from 'expo-secure-store';
export const BASE=(process.env.EXPO_PUBLIC_ELESEND_API_BASE_URL||'').replace(/\/$/,'');
// Plain HTTP is forbidden except for loopback Android emulator/simulator development.
if(BASE&&!/^https:\/\//.test(BASE)&&!/^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/.test(BASE))throw Error('ELESEND app requires HTTPS for real devices');
export const loadToken=()=>SecureStore.getItemAsync('elesend.session');
export const saveToken=t=>SecureStore.setItemAsync('elesend.session',t);
export const clearToken=()=>SecureStore.deleteItemAsync('elesend.session');
export async function call(method,path,body=null,{token=null,idempotencyKey=null}={}){
 if(!BASE)throw Error('Configure EXPO_PUBLIC_ELESEND_API_BASE_URL to an HTTPS backend');
 const bearer=token??await loadToken();const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);
 try{
  const response=await fetch(`${BASE}${path}`,{method,headers:{'Content-Type':'application/json',...(bearer?{Authorization:`Bearer ${bearer}`}:{}) ,...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},body:body===null?undefined:JSON.stringify(body),signal:controller.signal});
  const data=await response.json();if(!response.ok)throw Error(data.error||`Request failed: ${response.status}`);return data;
 }finally{clearTimeout(timeout);}
}
export const ghc=minor=>`GH₵${(Number(minor??0)/100).toFixed(2)}`;
