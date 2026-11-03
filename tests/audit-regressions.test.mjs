import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import net from 'node:net';
import {httpServer} from '../services/api/http.mjs';
import {equal} from '../services/api/security.mjs';
import {paymentWebhook} from '../services/api/payment-provider.mjs';
import {adminWalletReconciliation} from '../services/api/rider-wallet.mjs';
import {promotionEngine} from '../services/api/promotion-engine.mjs';

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
   const socket=net.connect(port,'127.0.0.1',()=>socket.write(`GET /api/v1/chat/ws?token=es_live_${'b'.repeat(64)} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
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
