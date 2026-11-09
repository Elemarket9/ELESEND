import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRequiredSchema,assertPaymentOperations,warnIfOwnerDatabaseLogin,REQUIRED_MIGRATION,REQUIRED_MIGRATIONS} from '../services/api/startup-guards.mjs';
import {readdirSync} from 'node:fs';
import {startWorker} from '../services/api/worker.mjs';

test('schema guard rejects outdated workers before starting background jobs',async()=>{
 const db={query:async()=>({rows:[],rowCount:0})};
 await assert.rejects(startWorker({db,config:{database:{}},skipPing:true}),/Apply migrations through/);
 await assertRequiredSchema({query:async(sql,args)=>{
  assert.deepEqual(args[0],REQUIRED_MIGRATIONS);
  return {rows:REQUIRED_MIGRATIONS.map(name=>({name})),rowCount:REQUIRED_MIGRATIONS.length};
 }});
 await assert.rejects(assertRequiredSchema({query:async()=>({rows:[{name:REQUIRED_MIGRATION}],rowCount:1})}),/Missing:/);
});

test('production rejects incomplete financial adapters and accepts complete adapters',()=>{
 assert.throws(()=>assertPaymentOperations({name:'limited',createCheckout(){},verifyPayment(){}},{production:true}),/createRefund.*verifyRefund.*verifyBeneficiary.*createPayout.*verifyPayout/);
 const provider={name:'complete',secretsConfigured:true,integerMinorAmounts:true,confirmsByReference:true,webhookSignatureEnforced:true};
 for(const name of ['createCheckout','verifyPayment','createRefund','verifyRefund','verifyBeneficiary','createPayout','verifyPayout','parseVerifiedWebhook'])provider[name]=async()=>{};
 assert.doesNotThrow(()=>assertPaymentOperations(provider,{production:true}));
 assert.throws(()=>assertPaymentOperations({...provider,webhookSignatureEnforced:false},{production:true}),/webhook or callback authentication is not enforced/);
 assert.doesNotThrow(()=>assertPaymentOperations({...provider,name:'hubtel',webhookSignatureEnforced:false,callbackAuthenticatedByStatusQuery:true},{production:true}));
 assert.throws(()=>assertPaymentOperations({...provider,integerMinorAmounts:false},{production:true}),/integer minor units/);
 const unnamed=assertPaymentOperations.bind(null,{...provider,secretsConfigured:false},{production:true});
 assert.throws(unnamed,/required payment secrets are not configured/);
 assert.doesNotThrow(()=>assertPaymentOperations(null,{production:true}));
 assert.doesNotThrow(()=>assertPaymentOperations({name:'limited'},{production:false}));
});

test('the server requires the newest database update shipped with the code',()=>{
 const newest=readdirSync(new URL('../database/migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort().at(-1);
 assert.equal(REQUIRED_MIGRATION,newest);
});

test('production refuses an owner or superuser database login',async()=>{
 const as=row=>({query:async()=>({rows:[row]})});const lines=[];const log=l=>lines.push(l);
 await assert.rejects(warnIfOwnerDatabaseLogin(as({login:'elesend',powerful:true,owner:true}),{production:true,log}),/elesend_app/);
 assert.match(lines[0],/owns the tables and is a superuser/);
 assert.equal(await warnIfOwnerDatabaseLogin(as({login:'elesend_app',powerful:false,owner:false}),{production:true,log}),null);
 await assert.rejects(warnIfOwnerDatabaseLogin({query:async()=>{throw Error('no access');}},{production:true,log}),/Could not verify the database login/);
 assert.equal(await warnIfOwnerDatabaseLogin(as({login:'elesend',powerful:true,owner:true}),{production:false,log}),null);
});
