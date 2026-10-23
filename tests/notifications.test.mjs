import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {notificationGateway} from '../services/api/notifications.mjs';
test('notification bridge signs requests and requires actual acceptance evidence',async()=>{
 const token='a'.repeat(32);let request;
 const gateway=notificationGateway({endpoint:'https://notify.example.test/send',allowedHost:'notify.example.test',token,fetchImpl:async(url,options)=>{request=options;return {ok:true,json:async()=>({accepted:true,messageId:'provider-123'})};}});
 const job={id:'offer:123',recipient_id:'rider',phone:'+233241234567',kind:'dispatch_offer',payload:{message:'Review offer'}};
 assert.equal((await gateway.send(job)).messageId,'provider-123');
 assert.equal(request.headers['Idempotency-Key'],job.id);
 assert.equal(request.headers['X-Elesend-Signature'],createHmac('sha256',token).update(request.body).digest('hex'));
 const invalid=notificationGateway({endpoint:'https://notify.example.test/send',allowedHost:'notify.example.test',token,fetchImpl:async()=>({ok:true,json:async()=>({accepted:false})})});
 await assert.rejects(invalid.send(job),/acceptance not verified/);
});
test('notification credentials cannot be sent to an unapproved destination',()=>{
 assert.throws(()=>notificationGateway({endpoint:'http://notify.example.test/send',allowedHost:'notify.example.test',token:'a'.repeat(32)}),/approved HTTPS/);
 assert.throws(()=>notificationGateway({endpoint:'https://attacker.example.test/send',allowedHost:'notify.example.test',token:'a'.repeat(32)}),/approved HTTPS/);
});
