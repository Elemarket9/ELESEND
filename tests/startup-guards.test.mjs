import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRequiredSchema,assertPaymentOperations,REQUIRED_MIGRATION} from '../services/api/startup-guards.mjs';
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
