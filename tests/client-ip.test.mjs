import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clientIp} from '../services/api/client-ip.mjs';
const req=(remote,h)=>({socket:{remoteAddress:remote},headers:{'x-forwarded-for':h}});
test('direct internet requests ignore forged forwarding headers',()=>{
 assert.equal(clientIp(req('45.1.2.3','1.2.3.4'),'172.24.0.0/16'),'45.1.2.3');
 assert.equal(clientIp(req('45.1.2.3','1.2.3.4'),''),'45.1.2.3');
});
test('trusted private ingress recovers true client for fair rider rate limits',()=>{
 assert.equal(clientIp(req('172.24.0.2','154.160.1.4'),'172.24.0.2/32'),'154.160.1.4');
 assert.equal(clientIp(req('172.24.0.2','154.160.1.4, 172.24.0.3'),'172.24.0.0/16'),'154.160.1.4');
});
test('forged left-most forwarding is ignored even when using a trusted ingress',()=>{
 assert.equal(clientIp(req('172.24.0.2','1.1.1.1, 154.160.1.4'),'172.24.0.0/16'),'154.160.1.4');
});
test('malformed and overlong forwarding never overrides the peer',()=>{
 assert.equal(clientIp(req('172.24.0.2','bad-input'),'172.24.0.0/16'),'172.24.0.2');
 assert.equal(clientIp(req('172.24.0.2','x'.repeat(600)),'172.24.0.0/16'),'172.24.0.2');
 assert.equal(clientIp(req('::ffff:172.24.0.2','154.160.1.4'),'172.24.0.0/16'),'154.160.1.4');
});
