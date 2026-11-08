// The server refuses a pickup until a sender's cash is recorded, and a delivery until a recipient's cash is.
// The rider app must ask for that cash at those moments, or every sender-pays cash delivery is stuck at pickup.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('../apps/mobile/src/rider/RiderApp.js',import.meta.url),'utf8');
const body=name=>{const i=app.indexOf(`async function ${name}(`);assert.ok(i>=0,name);return app.slice(i,app.indexOf('\n  }\n',i));};
test('pickup asks for the sender\'s cash first when the sender pays cash',()=>{
 const pickup=body('initiatePickupVerification');
 assert.match(pickup,/cash_payer === 'sender'/);assert.match(pickup,/collectCashThen\(shipment, 'sender', 'pickup'\)/);
});
test('delivery asks for the recipient\'s cash first when the recipient pays cash',()=>{
 const delivery=body('initiateDeliveryVerification');
 assert.match(delivery,/cash_payer === 'recipient'/);assert.match(delivery,/collectCashThen\(shipment, 'recipient', 'delivery'\)/);
});
test('the customer app does not promise an SMS handover code',()=>{
 for(const f of ['customer/CustomerApp.js','customer/RecipientPhoneModal.js'])assert.doesNotMatch(readFileSync(new URL('../apps/mobile/src/'+f,import.meta.url),'utf8'),/handover code/i,f);
});
