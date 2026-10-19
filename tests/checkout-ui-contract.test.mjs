import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../apps/mobile/App.js',import.meta.url),'utf8');
const server=readFileSync(new URL('../services/api/server.mjs',import.meta.url),'utf8');
const docker=readFileSync(new URL('../deploy/vps/compose.yaml',import.meta.url),'utf8');
test('native UI selects activated cash, momo, card and QR; renders QR without passing card details',()=>{
 for(const term of ['paymentMethods.filter(x=>x.enabled)','/api/v1/payments/methods','<QRCode','react-native-qrcode-svg','Linking.openURL','/checkout','payAmount'])assert.ok(code.includes(term),term);
 assert.ok(!/cardNumber|cardCvv|pinNumber/.test(code));
});
test('backend wires provider into finance and checkout; hosting is a configurable Linux VPS',()=>{
 for(const term of ['checkoutService','financeService(db,{provider:paymentProvider})','paystackCheckout','PAYSTACK_ENABLED_METHODS'])assert.ok(server.includes(term));
 for(const term of ['PAYSTACK_SECRET_KEY','NODE_ENV: production','DOCKER_DATABASE_URL'])assert.ok(docker.includes(term));
 assert.ok(!/hostinger/i.test(server));
});
