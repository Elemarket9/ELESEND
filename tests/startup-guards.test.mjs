import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRequiredSchema,assertPaymentOperations,warnIfOwnerDatabaseLogin,REQUIRED_MIGRATION} from '../services/api/startup-guards.mjs';
import {readdirSync} from 'node:fs';
import {startWorker} from '../services/api/worker.mjs';

test('schema guard rejects outdated workers before starting background jobs',async()=>{
 const db={query:async()=>({rows:[],rowCount:0})};
 await assert.rejects(startWorker({db,config:{database:{}},skipPing:true}),/Apply migrations through/);
 await assertRequiredSchema({query:async(sql,args)=>{
  assert.equal(args[0],REQUIRED_MIGRATION);
  return {rowCount:1};
 }});
});

test('production rejects incomplete financial adapters and accepts complete adapters',()=>{
 assert.throws(()=>assertPaymentOperations({name:'limited',createCheckout(){},verifyPayment(){}},{production:true}),/createRefund.*verifyRefund.*verifyBeneficiary.*createPayout.*verifyPayout/);
 const provider={name:'complete'};
 for(const name of ['createCheckout','verifyPayment','createRefund','verifyRefund','verifyBeneficiary','createPayout','verifyPayout'])provider[name]=async()=>{};
 assert.doesNotThrow(()=>assertPaymentOperations(provider,{production:true}));
 assert.doesNotThrow(()=>assertPaymentOperations(null,{production:true}));
 assert.doesNotThrow(()=>assertPaymentOperations({name:'limited'},{production:false}));
});

test('the server requires the newest database update shipped with the code',()=>{
 const newest=readdirSync(new URL('../database/migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort().at(-1);
 assert.equal(REQUIRED_MIGRATION,newest);
});

test('an owner database login only warns; it never stops the server',async()=>{
 const as=row=>({query:async()=>({rows:[row]})});const lines=[];const log=l=>lines.push(l);
 assert.equal(await warnIfOwnerDatabaseLogin(as({login:'elesend',powerful:true,owner:true}),{production:true,log}),'owner_login');
 assert.match(lines[0],/owns the tables and is a superuser/);
 assert.equal(await warnIfOwnerDatabaseLogin(as({login:'elesend_app',powerful:false,owner:false}),{production:true,log}),null);
 assert.equal(await warnIfOwnerDatabaseLogin({query:async()=>{throw Error('no access');}},{production:true,log}),null,'a failed check is ignored');
 assert.equal(await warnIfOwnerDatabaseLogin(as({login:'elesend',powerful:true,owner:true}),{production:false,log}),null);
});
