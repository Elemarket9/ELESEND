import * as SecureStore from 'expo-secure-store';
// Read-only operational cache. Do not queue OTPs, financial postings or cash confirmations.
// Each segment is stored encrypted by OS SecureStore; never use unencrypted AsyncStorage for parcel data.
const KEY='elesend.active-cache-v1';
const MAX_SEGMENTS=16,SEGMENT_CHARS=1200,MAX_AGE_MS=24*60*60*1000;
export async function clearCachedJobs(){
 for(let i=0;i<MAX_SEGMENTS;i++)await SecureStore.deleteItemAsync(`${KEY}.${i}`);
 await SecureStore.deleteItemAsync(`${KEY}.meta`);
}
export async function cacheJobs(actorId,{shipments=[],stops=[]}={}){
 const slim={shipments:shipments.slice(0,8).map(s=>({id:s.id,state:s.state,amount_minor:s.amount_minor,commission_minor:s.commission_minor,payment_method:s.payment_method,cash_payer:s.cash_payer,details:s.request&&{pickup:s.request.pickup?.address,destination:s.request.destination?.address}})),
  stops:stops.slice(0,16).map(s=>({shipmentId:s.shipmentId,kind:s.kind,position:s.position||s.location||null}))};
 const str=JSON.stringify(slim);if(str.length>MAX_SEGMENTS*SEGMENT_CHARS)return false;
 const count=Math.ceil(str.length/SEGMENT_CHARS);
 // Invalidate old metadata BEFORE writing and commit metadata LAST to prevent torn reads.
 await SecureStore.deleteItemAsync(`${KEY}.meta`);
 for(let i=0;i<count;i++)await SecureStore.setItemAsync(`${KEY}.${i}`,str.slice(i*SEGMENT_CHARS,(i+1)*SEGMENT_CHARS));
 await SecureStore.setItemAsync(`${KEY}.meta`,JSON.stringify({actorId,savedAt:Date.now(),count}));
 return true;
}
export async function readCachedJobs(actorId){
 const raw=await SecureStore.getItemAsync(`${KEY}.meta`);if(!raw)return null;
 const meta=JSON.parse(raw);
 if(meta.actorId!==actorId||Date.now()-meta.savedAt>MAX_AGE_MS||meta.count<1||meta.count>MAX_SEGMENTS)return null;
 let text='';for(let i=0;i<meta.count;i++){const part=await SecureStore.getItemAsync(`${KEY}.${i}`);if(!part)return null;text+=part;}
 return {...JSON.parse(text),cachedAt:new Date(meta.savedAt).toISOString(),readOnly:true};
}
