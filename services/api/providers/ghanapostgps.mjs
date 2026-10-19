import {check} from '../security.mjs';

const GHANA={minLatitude:4.5,maxLatitude:11.4,minLongitude:-3.4,maxLongitude:1.4};

export function normalizeGhanaDigitalAddress(value){
 check(typeof value==='string'&&value.length<=32,400,'Enter a valid GhanaPostGPS digital address');
 const compact=value.trim().toUpperCase().replace(/[\s-]/g,'');
 check(/^[A-Z]{2}\d{7}$/.test(compact),400,'Enter a valid GhanaPostGPS digital address');
 return `${compact.slice(0,2)}-${compact.slice(2,5)}-${compact.slice(5)}`;
}

function endpointUrl(value){
 check(typeof value==='string'&&value.length<=500,500,'GhanaPostGPS lookup endpoint is not configured');
 let url;try{url=new URL(value);}catch{check(false,500,'Invalid GhanaPostGPS lookup endpoint');}
 check(url.protocol==='https:'||(['localhost','127.0.0.1'].includes(url.hostname)&&url.protocol==='http:'),500,'GhanaPostGPS endpoint must use HTTPS');
 check(!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname.replace(/\/$/,'')==='',500,'GhanaPostGPS endpoint must be an origin without credentials or path');
 return new URL('/get-location',url);
}

async function boundedJson(response,maxBytes=65536){
 check(response.body?.getReader,502,'GhanaPostGPS returned an invalid response');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;check(size<=maxBytes,502,'GhanaPostGPS response is too large');chunks.push(value);}
 }catch(error){await reader.cancel().catch(()=>{});throw error;}
 let data;try{data=JSON.parse(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk))).toString('utf8'));}catch{check(false,502,'GhanaPostGPS returned invalid JSON');}
 check(data&&typeof data==='object'&&!Array.isArray(data),502,'GhanaPostGPS returned an invalid response');
 return data;
}

export function ghanaPostGps({endpoint,fetchImpl=fetch,timeoutMs=4000}={}){
 const url=endpointUrl(endpoint);
 check(typeof fetchImpl==='function'&&Number.isInteger(timeoutMs)&&timeoutMs>=200&&timeoutMs<=10000,500,'Invalid GhanaPostGPS client settings');
 return async function lookup(value){
  const address=normalizeGhanaDigitalAddress(value),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  let payload;
  try{
   const response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({address}),signal:controller.signal,redirect:'error'});
   check(response?.ok,503,'GhanaPostGPS lookup unavailable');payload=await boundedJson(response);
  }catch(error){if(Number.isInteger(error?.status))throw error;check(false,503,error?.name==='AbortError'?'GhanaPostGPS lookup timed out':'GhanaPostGPS lookup unavailable');}
  finally{clearTimeout(timer);}
  if(payload.found!==true)return {found:false,address,source:'GhanaPostGPS'};
  const rows=payload.data?.Table;
  check(Array.isArray(rows)&&rows.length===1,502,'GhanaPostGPS returned an ambiguous result');
  const row=rows[0],latitude=Number(row.CenterLatitude),longitude=Number(row.CenterLongitude);
  check(Number.isFinite(latitude)&&Number.isFinite(longitude)&&latitude>=GHANA.minLatitude&&latitude<=GHANA.maxLatitude&&longitude>=GHANA.minLongitude&&longitude<=GHANA.maxLongitude,502,'GhanaPostGPS returned coordinates outside Ghana');
  const area=typeof row.Area==='string'?row.Area.trim().slice(0,120):'',district=typeof row.District==='string'?row.District.trim().slice(0,120):'';
  return {found:true,address,latitude,longitude,label:[area,district].filter(Boolean).join(', '),source:'GhanaPostGPS',requiresPinReview:true};
 };
}

export function configuredGhanaPostGps(env=process.env,fetchImpl=fetch){
 if(env.GHANAPOSTGPS_LOOKUP_ENABLED!=='true')return null;
 const endpoint=env.GHANAPOSTGPS_LOOKUP_URL||'https://ghanapostgps.sperixlabs.org';
 return ghanaPostGps({endpoint,fetchImpl});
}
