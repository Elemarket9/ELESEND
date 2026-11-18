import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {isPublicAddress,validWebhookUrl,signatureFor,webhookService} from '../services/api/modules/orders/api-webhooks.mjs';
import {network} from '../services/api/modules/riders/network.mjs';
import {renderCompanyPortalHtml} from '../services/api/company-web/company-portal.mjs';

test('webhooks cannot reach internal addresses',()=>{
 for(const a of ['127.0.0.1','10.1.2.3','172.16.0.9','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','fe80::1','fd00::1','::ffff:127.0.0.1','::ffff:169.254.169.254','not-an-ip'])assert.equal(isPublicAddress(a),false,a);
 for(const a of ['8.8.8.8','102.176.0.1','2001:4860:4860::8888'])assert.equal(isPublicAddress(a),true,a);
 for(const u of ['http://example.com/x','https://user:pw@example.com/x','https://localhost/x','https://127.0.0.1/x','https://[::1]/x','https://169.254.169.254/latest','https://example.com:8443/x','notaurl'])assert.throws(()=>validWebhookUrl(u),undefined,u);
 assert.equal(validWebhookUrl('https://hooks.example.com/elesend'),'https://hooks.example.com/elesend');
});

test('a failed webhook retries, then stops, and its secret stays sealed',async()=>{
 const key=randomBytes(32);
 const queries=[];
 let sealed;
 const db={
  async query(sql,params=[]){
   queries.push(sql);
   if(/INSERT INTO api_webhooks/.test(sql)){sealed=params[3];return {rows:[{id:params[0],url:params[2]}]};}
   if(/UPDATE api_webhook_deliveries d/.test(sql))return {rows:[{id:7,attempts:1,shipment_id:'s1',event:'IN_TRANSIT',occurred_at:new Date(),url:'https://hooks.example.com/e',secret_sealed:sealed,owner_id:'o1'}]};
   return {rows:[]};
  },
  tx:fn=>fn({query:async sql=>/max\(id\)/.test(sql)?{rows:[{id:1}]}:{rows:[]}})
 };
 const seen=[];
 const service=webhookService(db,{key:()=>key,send:async(url,body,headers)=>{seen.push({url,body,headers});return 500;}});
 const saved=await service.set({id:'o1'},{url:'https://hooks.example.com/e'});
 assert.match(saved.secret,/^whsec_/);
 assert.equal(sealed.includes(saved.secret),false);
 const [result]=await service.tick();
 assert.equal(result.delivered,false);
 const [,t,v1]=/^t=(\d+),v1=([0-9a-f]+)$/.exec(seen[0].headers['X-Elesend-Signature']);
 assert.equal(v1,signatureFor(saved.secret,t,seen[0].body));
 assert.deepEqual(Object.keys(JSON.parse(seen[0].body)).sort(),['event','id','occurredAt','shipmentId']);
 assert.ok(queries.some(q=>/abandoned_at=CASE/.test(q)));
});

test('API keys reach only their own scopes',()=>{
 const net=network({});
 const actor={api_client_id:'k',scopes:['shipments:read']};
 assert.doesNotThrow(()=>net.authorizeKey(actor,'GET','/api/v1/shipments'));
 for(const [m,p] of [['POST','/api/v1/shipments'],['POST','/api/v1/shipments/abc/checkout'],['GET','/api/v1/company/profile'],['POST','/api/v1/business/api-keys'],['GET','/api/v1/business/webhook'],['POST','/api/v1/me/payout-beneficiary'],['GET','/api/v1/company/riders']])assert.throws(()=>net.authorizeKey(actor,m,p),undefined,p);
 assert.doesNotThrow(()=>net.authorizeKey({api_client_id:'k',scopes:['payments:write']},'POST','/api/v1/shipments/abc/checkout'));
});

test('company registration and keys are limited to approved delivery companies',()=>{
 const source=readFileSync(new URL('../services/api/modules/riders/network.mjs',import.meta.url),'utf8');
 assert.match(source,/co\.status='approved' AND 'delivery'=ANY\(co\.services\)/);
 assert.match(source,/await assertCompanyDelivery\(db,actor\)/);
});

test('company portal covers both ways of working and escapes what it shows',()=>{
 const html=renderCompanyPortalHtml();
 for(const text of ['Send our deliveries','Provide riders','Invite a rider','API keys','Status updates to your system','Payout account'])assert.ok(html.includes(text),text);
 assert.ok(!/https?:\/\/(?!your-system\.example)/.test(html.replace(/\/\^https:\\\/\\\//,'')),'no outside addresses');
 for(const value of ['r.phone','k.name','profile.name','i.rider_phone_ending'])assert.ok(html.includes('esc('+value+')'),value);
});

const url=process.env.TEST_DATABASE_URL;
test('company works through approval, API access, riders and status updates',{skip:!url},async()=>{
 assert.match(new URL(url).pathname,/^\/elesend_test/,'Requires dedicated test database');
 const {randomUUID,randomInt}=await import('node:crypto');
 const {database}=await import('../services/api/shared/db.mjs');
 const {migrate}=await import('../scripts/migrate.mjs');
 const {companyService}=await import('../services/api/modules/riders/company.mjs');
 const db=database(url);
 const key=randomBytes(32);
 const phone=()=>'+2332'+String(randomInt(10000000,99999999));
 const mkUser=async(kind,number=phone())=>{const id=randomUUID();await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'test-only',$3,now())",[id,number,kind]);return {id,kind,phone:number};};
 try{
  await migrate(db);
  const owner=await mkUser('company');
  const companyId=randomUUID();
  await db.query("INSERT INTO companies(id,owner_id,name,services) VALUES($1,$2,'Test Logistics','{delivery,riders}')",[companyId,owner.id]);
  const companies=companyService(db),net=network(db);

  // Nothing opens before approval.
  await assert.rejects(net.createKey(owner,{name:'Warehouse',scopes:['quotes:write']}),/approval/);
  await assert.rejects(companies.inviteByPhone(owner,{phone:phone()}),/approval/);
  assert.equal((await companies.profile(owner)).status,'pending');
  await db.query("UPDATE companies SET status='approved' WHERE id=$1",[companyId]);

  // Delivery mode: a key works, then stops when the service is turned off.
  const created=await net.createKey(owner,{name:'Warehouse',scopes:['quotes:write','shipments:read']});
  const keyActor=await net.authenticateKey(created.key);
  assert.equal(keyActor.id,owner.id);
  assert.equal(keyActor.kind,'company');
  await companies.setServices(owner,{services:['riders']});
  await assert.rejects(net.authenticateKey(created.key),/unavailable/);
  await assert.rejects(net.createKey(owner,{name:'Second',scopes:['quotes:write']}),/delivery/);
  await companies.setServices(owner,{services:['delivery','riders']});

  // Rider mode: the answer does not reveal who is a rider, and only the invited rider can answer.
  const rider=await mkUser('rider');
  await db.query("INSERT INTO riders(id,status,vehicle,max_weight_g) VALUES($1,'approved','motorcycle',20000)",[rider.id]);
  const known=await companies.inviteByPhone(owner,{phone:rider.phone});
  const unknown=await companies.inviteByPhone(owner,{phone:phone()});
  assert.deepEqual(known,unknown);
  const [invite]=await companies.riderInvitations(rider);
  assert.equal(invite.company_name,'Test Logistics');
  const stranger=await mkUser('rider');
  await assert.rejects(net.acceptInvitation(stranger,{invitationId:invite.id}),/unavailable/);
  await net.acceptInvitation(rider,{invitationId:invite.id});
  assert.equal((await net.fleet(owner)).length,1);
  await assert.rejects(companies.setServices(owner,{services:['delivery']}),/Remove your riders/);
  assert.deepEqual((await companies.profile(owner)).balance,{debtMinor:0,debtLimitMinor:(await companies.profile(owner)).balance.debtLimitMinor,unpaidEarningsMinor:0,nextPayoutMinor:0});
  await net.leaveCompany(rider);
  assert.equal((await db.query('SELECT status,company_id FROM riders WHERE id=$1',[rider.id])).rows[0].status,'pending');

  // Status updates: only the client's own shipments, each sent once after success.
  const sent=[];
  const hooks=webhookService(db,{key:()=>key,send:async(target,body)=>{sent.push(JSON.parse(body));return 200;}});
  await hooks.set(owner,{url:'https://hooks.example.com/e'});
  const other=await mkUser('customer');
  const policy=(await db.query('SELECT id FROM pricing_policies WHERE active LIMIT 1')).rows[0]?.id;
  if(policy){
   const shipment=async customerId=>{const quote=randomUUID(),id=randomUUID();
    await db.query("INSERT INTO quotes(id,customer_id,policy_id,request,amount_minor,commission_minor,expires_at) VALUES($1,$2,$3,'{}',1000,100,now()+interval '1 hour')",[quote,customerId,policy]);
    await db.query("INSERT INTO shipments(id,customer_id,quote_id,idempotency_key,state,recipient_phone,amount_minor,commission_minor) VALUES($1,$2,$3,$4,'AWAITING_ASSIGNMENT',$5,1000,100)",[id,customerId,quote,randomUUID(),phone()]);
    await db.query("INSERT INTO outbox(shipment_id,kind,payload) VALUES($1,'RIDER_ASSIGNED','{\"secret\":\"x\"}')",[id]);return id;};
   const mine=await shipment(owner.id);await shipment(other.id);
   await hooks.tick();await hooks.tick();
   assert.deepEqual(sent.map(e=>e.shipmentId),[mine]);
   assert.equal(sent[0].secret,undefined);
  }
 }finally{await db.close();}
});

test('companies register in the Rider app and manage riders there',()=>{
 const rider=readFileSync(new URL('../apps/mobile/src/rider/RiderApp.js',import.meta.url),'utf8');
 assert.match(rider,/kind: 'company', name: credentials\.name\.trim\(\), services/);
 assert.match(rider,/user\.kind !== 'rider' && user\.kind !== 'company'/);
 assert.match(rider,/auth\?\.kind === 'company'/);
 const html=renderCompanyPortalHtml();
 assert.ok(html.includes('Register in the ELESEND Rider app'));
 assert.ok(!html.includes('/api/v1/auth/register'),'the portal does not register companies');
 const customer=readFileSync(new URL('../apps/mobile/src/customer/CustomerApp.js',import.meta.url),'utf8');
 assert.ok(!customer.includes("kind: 'company'"));
});

test('Firebase push signs in, sends, and reports dead devices',async()=>{
 const {generateKeyPairSync}=await import('node:crypto');
 const {firebasePush}=await import('../services/api/modules/orders/providers/firebase-push.mjs');
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
 const calls=[];
 const fetchImpl=async(u,o)=>{calls.push({u:String(u),o});if(String(u).includes('oauth2'))return {ok:true,json:async()=>({access_token:'tok',expires_in:3600})};const t=JSON.parse(o.body).message.token;return t==='dead'?{ok:false,status:404}:{ok:true,status:200,json:async()=>({name:'projects/p/messages/1'})};};
 const push=firebasePush({project_id:'p',client_email:'a@b.c',private_key:privateKey},{fetchImpl});
 assert.deepEqual(await push.send({id:'j',kind:'refund_completed',payload:{message:'x',pushTokens:[]}}),{accepted:false,noDevice:true});
 const r=await push.send({id:'j',kind:'refund_completed',payload:{message:'Your refund',amountMinor:5,pushTokens:[{platform:'fcm',token:'good'},{platform:'fcm',token:'dead'},{platform:'expo',token:'skip'}]}});
 assert.equal(r.accepted,true);assert.deepEqual(r.invalidTokens,['dead']);
 const sent=JSON.parse(calls.find(c=>c.u.includes('messages:send')).o.body).message;
 assert.equal(sent.android.notification.body,'Your refund');assert.equal(sent.data.amountMinor,'5');assert.equal(sent.android.notification.channel_id,'elesend-updates');
 assert.equal(calls.filter(c=>c.u.includes('oauth2')).length,1);
 assert.equal(calls.some(c=>c.o.body?.toString().includes('skip')),false);
});

test('chat never becomes a paid SMS, and with push set up neither do offers',async()=>{
 const {notificationWorker}=await import('../services/api/modules/orders/notifications.mjs');
 const job=kind=>({id:kind,kind,recipient_id:'u',payload:{message:'m'},attempts:1});
 const run=async transport=>{const sent=[];
  const db={query:async sql=>/FROM users/.test(sql)?{rows:[{phone:'+233241234567'}]}:/SELECT 1 FROM dispatch_offers/.test(sql)?{rows:[{}],rowCount:1}:{rows:[]},tx:async f=>f({query:async sql=>/WITH due/.test(sql)?{rows:['dispatch_offer','chat_message','refund_completed'].map(job)}:{rows:[]}})};
  await notificationWorker(db,{transport,sms:{sendNotification:async m=>{sent.push(m.kind);return {accepted:true,messageId:'1'};}}}).tick();return sent;};
 assert.deepEqual(await run(null),['dispatch_offer','refund_completed']);
 assert.deepEqual(await run({pushOnly:true,send:async()=>({accepted:false,noDevice:true})}),['refund_completed']);
});

test('people see plain messages when the connection fails',async()=>{
 const {friendlyNetworkError,readResponse}=await import('../apps/mobile/src/api-errors.js');
 assert.match(friendlyNetworkError(new TypeError('Network request failed')).message,/internet connection/);
 assert.match(friendlyNetworkError(Object.assign(new Error('Aborted'),{name:'AbortError'})).message,/slow/);
 assert.equal(friendlyNetworkError(Object.assign(new Error('Refused'),{status:403})).message,'Refused');
 await assert.rejects(readResponse({ok:false,status:502,json:async()=>{throw new SyntaxError('Unexpected token <');}}),/having a problem/);
 await assert.rejects(readResponse({ok:false,status:400,json:async()=>({error:'Bad phone'})}),{message:'Bad phone',status:400});
});
