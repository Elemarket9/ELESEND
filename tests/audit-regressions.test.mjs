import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import net from 'node:net';
import {httpServer} from '../services/api/http.mjs';
import {equal} from '../services/api/security.mjs';
import {paymentWebhook} from '../services/api/modules/payments/payment-provider.mjs';
import {adminWalletReconciliation} from '../services/api/modules/payments/rider-wallet.mjs';
import {promotionEngine} from '../services/api/promotion-engine.mjs';
import {platform} from '../services/api/platform.mjs';
import {mac} from '../services/api/security.mjs';
import {rateLimitKey} from '../services/api/client-ip.mjs';
import {ipLimits,memoryRateLimiter,parseIpLimitMultiplier} from '../services/api/rate-limits.mjs';

const SESSION='a'.repeat(64);
const permissive=(overrides=()=>null)=>{
 const calls=[];
 const query=async(sql,params=[])=>{
  calls.push({sql,params});
  const custom=overrides(sql,params);
  if(custom)return custom;
  if(sql.includes('rate_limits'))return {rowCount:1,rows:[{count:1}]};
  return {rowCount:0,rows:[]};
 };
 return {calls,query,tx:fn=>fn({query})};
};
const fakeApp={authenticate:async token=>{if(token!==SESSION)throw Object.assign(Error('Authentication required'),{status:401});return {id:'00000000-0000-4000-8000-000000000001',kind:'customer',sessionTokenHash:'secret-hash'};}};

async function withServer(db,run){
 const server=httpServer(db,fakeApp,null,null,null,{restaurant:{},restaurantOrders:{}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{await run(server.address().port);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
const auth={Authorization:`Bearer ${SESSION}`};

test('GET /me does not expose the session token hash',async()=>{
 await withServer(permissive(),async port=>{
  const body=await (await fetch(`http://127.0.0.1:${port}/api/v1/me`,{headers:auth})).json();
  assert.equal(body.id,'00000000-0000-4000-8000-000000000001');
  assert.equal('sessionTokenHash' in body,false);
 });
});

test('non-object JSON bodies are rejected as client errors',async()=>{
 await withServer(permissive(),async port=>{
  for(const payload of ['null','[]','5']){
   const r=await fetch(`http://127.0.0.1:${port}/api/v1/rider/offers/decline`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:payload});
   assert.equal(r.status,400,payload);
  }
 });
});

test('an unparseable request URL is a 400, not a server error',async()=>{
 await withServer(permissive(),async port=>{
  const status=await new Promise((resolve,reject)=>{
   const socket=net.connect(port,'127.0.0.1',()=>socket.write('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
   let data='';socket.on('data',d=>{data+=d;});socket.on('end',()=>resolve(Number(data.split(' ')[1])));socket.on('error',reject);
  });
  assert.equal(status,400);
 });
});

test('restaurant viewport falls back to the default for a non-numeric limit',async()=>{
 const db=permissive();
 await withServer(db,async port=>{
  const r=await fetch(`http://127.0.0.1:${port}/api/v1/maps/restaurants/viewport?limit=abc`,{headers:auth});
  assert.equal(r.status,200);
  assert.equal((await r.json()).limit,50);
 });
});

test('API keys cannot open the chat WebSocket',async()=>{
 const db=permissive(sql=>sql.includes('api_clients')?{rowCount:1,rows:[{id:'00000000-0000-4000-8000-000000000002',kind:'business',scopes:['quotes:write'],api_client_id:'k'}]}:null);
 await withServer(db,async port=>{
  const reply=await new Promise((resolve,reject)=>{
   const socket=net.connect(port,'127.0.0.1',()=>socket.write(`GET /api/v1/chat/ws HTTP/1.1\r\nAuthorization: Bearer es_live_${'b'.repeat(64)}\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
   let data='';socket.on('data',d=>{data+=d;});socket.on('close',()=>resolve(data));socket.on('error',reject);
  });
  assert.match(reply,/^HTTP\/1\.1 403/);
 });
});

test('equal handles equal-length strings with different byte lengths',()=>{
 assert.equal(equal('é','e'),false);
 assert.equal(equal('same','same'),true);
 assert.equal(equal('same',undefined),false);
});

test('a checkout reversal is audited against the affected shipment',async()=>{
 const shipmentId='00000000-0000-4000-8000-000000000003';
 const db=permissive(sql=>sql.includes('shipment_checkout_intents')?{rowCount:1,rows:[{shipment_id:shipmentId}]}:null);
 const provider={name:'bridge',parseVerifiedWebhook:async()=>({status:'reversed',reference:'es_ref1'})};
 const result=await paymentWebhook({db,provider})(Buffer.from('{}'),{});
 assert.equal(result.requiresReview,true);
 const audit=db.calls.find(c=>c.sql.includes('audit_logs'));
 assert.deepEqual(audit.params,['payment.checkout_reversal_reported:es_ref1',shipmentId]);
});

test('wallet repair needs more than read-only finance permission',async()=>{
 const actor={id:'00000000-0000-4000-8000-000000000004',kind:'admin'};
 // Grants only finance:read, and proves repair is refused before any ledger work begins.
 const db=permissive((sql,params)=>sql.includes('FROM permissions')?{rowCount:params[1].includes('finance:read')?1:0,rows:[]}:null);
 await assert.rejects(adminWalletReconciliation(db,actor,{repair:true}),e=>e.status===403);
 assert.equal(db.calls.filter(c=>!c.sql.includes('FROM permissions')).length,0);
});

test('portal promotion requests use the fields the API accepts',()=>{
 const merchant=readFileSync(new URL('../apps/restaurant-web/index.html',import.meta.url),'utf8');
 const admin=readFileSync(new URL('../services/api/admin-web/admin-portal.mjs',import.meta.url),'utf8');
 for(const source of [merchant,admin]){
  assert.match(source,/function promoDiscountFields/);
  for(const stale of ['discountAmountMinor','budgetCapMinor','fundingSource','status, reason'])assert.equal(source.includes(stale),false,stale);
 }
 for(const stale of ["'ended'",'minOrderSubtotalMinor','selfServicePromotions','sampleSubtotalMinor'])assert.equal(merchant.includes(stale),false,stale);
});

test('the promotion payloads the portals send pass API validation',async()=>{
 // Validation runs before the transaction, so reaching tx proves the payload was accepted.
 const reached=Symbol('validated');
 const admin={id:'00000000-0000-4000-8000-000000000005',kind:'admin'};
 const db={query:async()=>({rowCount:1,rows:[]}),tx:async()=>{throw reached;}};
 const engine=promotionEngine(db);
 const payloads=[
  {name:'Ten off',ownerType:'elesend',fundingType:'elesend_100',discountType:'percentage',targetType:'food_subtotal',discountBps:1000,code:null,totalBudgetMinor:null,elesendFundingBps:10000,restaurantFundingBps:0,commissionConcessionBps:0,status:'active'},
  {name:'Joint delivery',ownerType:'joint',fundingType:'shared_percentage',discountType:'fixed',targetType:'delivery_fee',discountMinor:500,code:'JOINT5',totalBudgetMinor:50000,elesendFundingBps:6000,restaurantFundingBps:4000,commissionConcessionBps:100,status:'active'},
  {name:'Free delivery',ownerType:'elesend',fundingType:'elesend_100',discountType:'free_delivery',targetType:'delivery_fee',code:null,totalBudgetMinor:null,elesendFundingBps:10000,restaurantFundingBps:0,commissionConcessionBps:0,status:'active'}
 ];
 for(const payload of payloads)await assert.rejects(engine.createAdminCampaign(admin,payload),e=>e===reached,payload.name);
});

test('root compose healthcheck escapes its shell variables',()=>{
 const compose=readFileSync(new URL('../compose.yaml',import.meta.url),'utf8');
 assert.match(compose,/pg_isready -U "\$\$POSTGRES_USER" -d "\$\$POSTGRES_DB"/);
});

const upgradeStatus=(port,target)=>new Promise((resolve,reject)=>{
 const socket=net.connect(port,'127.0.0.1',()=>socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
 let data='';socket.on('data',d=>{data+=d;});socket.on('close',()=>resolve(Number(data.split(' ')[1])));socket.on('error',reject);
});

test('chat refuses session tokens in the URL',async()=>{
 await withServer(permissive(),async port=>{
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/chat/stream?token=${SESSION}`)).status,401);
  assert.equal(await upgradeStatus(port,`/api/v1/chat/ws?token=${SESSION}`),401);
 });
});

const OTP_KEY='c'.repeat(64);
function countingDb(){
 const counts=new Map();
 return permissive((sql,params)=>{
  if(!sql.includes('rate_limits'))return null;
  const count=(counts.get(params[0])??0)+1;counts.set(params[0],count);
  return {rowCount:1,rows:[{count}]};
 });
}

test('failed logins from one source do not lock out the account elsewhere',async()=>{
 const app=platform(countingDb(),{otpKey:OTP_KEY});
 const attempt=clientIp=>app.login({phone:'0241234567',password:'wrong-password-1'},{clientIp});
 for(let i=0;i<10;i++)await assert.rejects(attempt('198.51.100.1'),e=>e.status===401);
 await assert.rejects(attempt('198.51.100.1'),e=>e.status===429);
 await assert.rejects(attempt('203.0.113.7'),e=>e.status===401);
});

test('logins are capped across all sources for one account',async()=>{
 const db=countingDb();
 const app=platform(db,{otpKey:OTP_KEY});
 const attempt=clientIp=>app.login({phone:'0241234567',password:'wrong-password-1'},{clientIp});
 for(let i=0;i<100;i++){await assert.rejects(attempt('source-'+i),e=>e.status===401);}
 await assert.rejects(attempt('source-final'),e=>e.status===429);
});

test('a password reset leaves API keys working',async()=>{
 const userId='00000000-0000-4000-8000-000000000006',challengeId='00000000-0000-4000-8000-000000000007',phone='+233241234567';
 const digest=mac(OTP_KEY,['account-recovery-v1',challengeId,userId,phone,'123456']);
 const db=permissive(sql=>{
  if(sql.includes('rate_limits'))return {rowCount:1,rows:[{count:1}]};
  if(sql.includes('FROM users WHERE phone'))return {rowCount:1,rows:[{id:userId,phone,kind:'business'}]};
  if(sql.includes('FROM account_recovery_challenges'))return {rowCount:1,rows:[{id:challengeId,digest,sent:true,live:true,consumed_at:null,attempts:0,phone}]};
  return null;
 });
 const result=await platform(db,{otpKey:OTP_KEY}).resetPassword({phone,challengeId,code:'123456',newPassword:'a-new-strong-password'});
 assert.equal(result.ok,true);
 assert.equal(db.calls.some(c=>c.sql.includes('api_clients')),false);
});

test('rate limit identity groups an IPv6 /64 and leaves IPv4 alone',()=>{
 assert.equal(rateLimitKey('197.210.1.5'),'197.210.1.5');
 const one=rateLimitKey('2001:db8:1:2:aaaa::1');
 assert.equal(one,'2001:db8:1:2::/64');
 assert.equal(rateLimitKey('2001:0DB8:1:2:bbbb:cccc:dddd:eeee'),one);
 assert.notEqual(rateLimitKey('2001:db8:1:3::1'),one);
 assert.equal(rateLimitKey('2001:db8::1'),'2001:db8:0:0::/64');
});

test('the flood guard limits per window and keeps memory bounded',()=>{
 let at=0;
 const guard=memoryRateLimiter({maxKeys:3,now:()=>at});
 guard.hit('a',2,60);guard.hit('a',2,60);
 assert.throws(()=>guard.hit('a',2,60),e=>e.status===429);
 at=61000;
 guard.hit('a',2,60);
 for(const key of ['b','c','d','e','f'])guard.hit(key,2,60);
 assert.ok(guard.size()<=3);
});

test('IP limit multiplier scales limits and rejects bad values',()=>{
 assert.equal(ipLimits(2).loginFailuresPer15Min,ipLimits(1).loginFailuresPer15Min*2);
 assert.equal(parseIpLimitMultiplier(undefined),1);
 assert.equal(parseIpLimitMultiplier('2.5'),2.5);
 for(const bad of ['0','1000','many'])assert.equal(parseIpLimitMultiplier(bad),null);
});

test('many users on one shared address can log in, but failures from it are capped',async()=>{
 const counts=new Map();
 const db=permissive((sql,params)=>{
  if(sql.startsWith('SELECT count FROM rate_limits')){const count=counts.get(params[0]);return {rowCount:count?1:0,rows:count?[{count}]:[]};}
  if(sql.includes('rate_limits')){const count=(counts.get(params[0])??0)+1;counts.set(params[0],count);return {rowCount:1,rows:[{count}]};}
  return null;
 });
 const app={...fakeApp,login:async b=>{if(b.password!=='right')throw Object.assign(Error('Invalid credentials'),{status:401});return {token:'t'};}};
 const server=httpServer(db,app,null,null,null,{restaurant:{},restaurantOrders:{}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 const login=password=>fetch(`http://127.0.0.1:${port}/api/v1/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})}).then(r=>r.status);
 try{
  // More successes than the old limit of 40 allowed for a whole address.
  for(let i=0;i<60;i++)assert.equal(await login('right'),200);
  assert.equal(await login('wrong'),401);
  const failures=ipLimits().loginFailuresPer15Min;
  for(const key of counts.keys())if(key.startsWith('login-fail-ip:'))counts.set(key,failures);
  assert.equal(await login('wrong'),429);
  assert.equal(await login('right'),429);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
