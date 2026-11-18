import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID,randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {installProcessGuards} from '../services/api/shared/process-guards.mjs';
import {registerRealtimeConnection} from '../services/api/modules/safety/chat-engine.mjs';
import {platform} from '../services/api/modules/orders/platform.mjs';
import {passwordHash} from '../services/api/shared/security.mjs';

test('fatal process errors are logged and end the process',()=>{
 const target=new EventEmitter(),exits=[],lines=[];
 installProcessGuards('api',{target,exit:c=>exits.push(c),write:l=>lines.push(l)});
 target.emit('unhandledRejection',Object.assign(Error('boom'),{code:'X'}));
 assert.deepEqual(exits,[1]);
 const entry=JSON.parse(lines[0]);
 assert.equal(entry.level,'fatal');assert.equal(entry.message,'boom');assert.equal(entry.component,'api');
});

test('one account cannot hold more than 5 live connections',()=>{
 const user=randomUUID(),closed=[],unregister=[];
 for(let i=0;i<7;i++)unregister.push(registerRealtimeConnection(user,{id:i,conversationIds:new Set(),send(){},close(){closed.push(i);}}));
 assert.deepEqual(closed,[0,1]);
 unregister.forEach(fn=>fn());
});

test('account deletion needs the right password and refuses admins',async()=>{
 const hash=await passwordHash('correct-password');
 const query=async sql=>sql.includes('FROM users')?{rowCount:1,rows:[{id:'u',kind:'customer',password_hash:hash}]}:{rowCount:0,rows:[]};
 const app=platform({query,tx:fn=>fn({query})},{otpKey:'c'.repeat(64)});
 await assert.rejects(app.deleteAccount({id:'u',kind:'customer'},{password:'wrong'}),e=>e.status===401);
 await assert.rejects(app.deleteAccount({id:'u',kind:'admin'},{password:'correct-password'}),e=>e.status===403);
});

test('both apps offer account deletion',()=>{
 for(const file of ['customer/CustomerApp.js','rider/RiderApp.js'])assert.match(readFileSync(new URL('../apps/mobile/src/'+file,import.meta.url),'utf8'),/DeleteAccountModal|setDeleteAccountOpen/);
});

test('account deletion works against PostgreSQL and frees the phone number',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const {database}=await import('../services/api/shared/db.mjs');
 const {migrate}=await import('../scripts/migrate.mjs');
 const configured=new URL(process.env.TEST_DATABASE_URL);
 assert.match(configured.pathname,/^\/elesend_test/);
 const db=database(configured.toString());
 try{
  await migrate(db);
  const app=platform(db,{otpKey:'c'.repeat(64)});
  const phone='+23324'+String(randomInt(0,10000000)).padStart(7,'0'),password='a-strong-password-1';
  for(const kind of ['customer','rider']){
   const created=await app.register({phone,password,kind,termsVersion:'2026-11'});
   if(kind==='rider'){
    await db.query(`INSERT INTO rider_licences(rider_id,document_type,legal_name,number_encrypted,number_hash,expires_on,ghana_card_encrypted,ghana_card_hash) VALUES($1,'ghana_card','Deleted Rider','sealed-number',$2,'2030-01-01','sealed-card',$3)`,[created.id,'n'+created.id.replaceAll('-',''),'c'+created.id.replaceAll('-','')]);
    await db.query(`INSERT INTO rider_documents(rider_id,kind,data_encrypted,byte_size) VALUES($1,'ghana_card_photo','sealed-photo',12)`,[created.id]);
   }
   const session=await app.login({phone,password});
   assert.deepEqual(await app.deleteAccount({id:created.id,kind},{password}),{ok:true});
   if(kind==='rider'){
    assert.equal((await db.query('SELECT count(*)::int AS n FROM rider_licences WHERE rider_id=$1',[created.id])).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM rider_documents WHERE rider_id=$1',[created.id])).rows[0].n,0);
   }
   const row=(await db.query('SELECT phone,deleted_at,password_hash FROM users WHERE id=$1',[created.id])).rows[0];
   assert.ok(row.phone.startsWith('deleted:'));assert.ok(row.deleted_at);assert.equal(row.password_hash,'deleted');
   await assert.rejects(app.authenticate(session.token),e=>e.status===401);
   await assert.rejects(app.login({phone,password}),e=>e.status===401);
  }
 }finally{await db.close();}
});

test('the transaction helper keeps the original error when rollback fails',()=>{
 const source=readFileSync(new URL('../services/api/shared/db.mjs',import.meta.url),'utf8');
 assert.match(source,/c\.query\('ROLLBACK'\)\.catch/);assert.match(source,/c\.release\(broken\)/);
});
