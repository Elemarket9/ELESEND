import test from 'node:test';
import assert from 'node:assert/strict';
import {platform} from '../services/api/modules/orders/platform.mjs';

const PHONE='+233241234567',USER='00000000-0000-4000-8000-000000000010';
// Models the rate_limits statement, including the block that starts on the 6th attempt.
function fakeDb(existingUser=true){
 let now=0;const windows=new Map(),calls=[];
 const query=async(sql,params=[])=>{
  calls.push(sql);
  if(sql.includes('INTO rate_limits')){
   const w=windows.get(params[0]);
   if(!w||w.expiresAt<=now){windows.set(params[0],{count:1,expiresAt:now+params[1]*1000});return {rows:[{count:1}]};}
   if(w.count===params[2])w.expiresAt=now+params[1]*1000;
   w.count++;return {rows:[{count:w.count}]};
  }
  if(sql.includes('FROM users WHERE phone'))return {rowCount:existingUser?1:0,rows:existingUser?[{id:USER,phone:PHONE,kind:'customer'}]:[]};
  return {rowCount:1,rows:[]};
 };
 return {calls,query,tx:fn=>fn({query}),advance:ms=>{now+=ms;}};
}
const smsCounter=()=>{const sent=[];return {sent,send:async m=>{sent.push(m);}};};
const OTP_KEY='c'.repeat(64);

test('a number gets 5 recovery SMS, then waits a full 15 minutes',async()=>{
 const db=fakeDb(),sms=smsCounter(),app=platform(db,{otpKey:OTP_KEY,sms});
 const request=()=>app.passwordRecoveryChallenge({phone:PHONE});
 for(let i=0;i<5;i++)await request();
 assert.equal(sms.sent.length,5);
 db.advance(14*60000);
 await assert.rejects(request(),e=>e.status===429&&/15 minutes/.test(e.message));
 // The block runs from the 6th attempt, not from the first request.
 db.advance(14*60000);
 await assert.rejects(request(),e=>e.status===429);
 db.advance(61000);
 await request();
 assert.equal(sms.sent.length,6);
});

test('the same phone formats share one allowance',async()=>{
 const db=fakeDb(),app=platform(db,{otpKey:OTP_KEY,sms:smsCounter()});
 for(let i=0;i<5;i++)await app.passwordRecoveryChallenge({phone:i%2?'0241234567':PHONE});
 await assert.rejects(app.passwordRecoveryChallenge({phone:'024 123 4567'}),e=>e.status===429);
});

test('numbers without accounts are limited the same way, so accounts cannot be discovered',async()=>{
 const db=fakeDb(false),sms=smsCounter(),app=platform(db,{otpKey:OTP_KEY,sms});
 for(let i=0;i<5;i++)await app.passwordRecoveryChallenge({phone:PHONE});
 await assert.rejects(app.passwordRecoveryChallenge({phone:PHONE}),e=>e.status===429);
 assert.equal(sms.sent.length,0);
});

test('verification and recovery SMS share the allowance, counted outside the transaction',async()=>{
 const recoverDb=fakeDb();
 const query=recoverDb.query;
 const db={...recoverDb,query:async(sql,params)=>{
  if(sql.includes('SELECT phone,phone_verified_at FROM users'))return {rowCount:1,rows:[{phone:PHONE,phone_verified_at:null}]};
  if(sql.includes('SELECT 1 FROM account_phone_challenges'))return {rowCount:0,rows:[]};
  return query(sql,params);
 },tx:fn=>fn({query:async(sql,params)=>{
  if(sql.includes('SELECT phone,phone_verified_at FROM users'))return {rowCount:1,rows:[{phone:PHONE,phone_verified_at:null}]};
  if(sql.includes('SELECT 1 FROM account_phone_challenges'))return {rowCount:0,rows:[]};
  return query(sql,params);
 }})};
 const app=platform(db,{otpKey:OTP_KEY,sms:smsCounter()});
 const actor={id:USER,kind:'customer'};
 for(let i=0;i<3;i++)await app.passwordRecoveryChallenge({phone:PHONE});
 for(let i=0;i<2;i++)await app.phoneChallenge(actor);
 await assert.rejects(app.phoneChallenge(actor),e=>e.status===429);
 await assert.rejects(app.passwordRecoveryChallenge({phone:PHONE}),e=>e.status===429);
});
