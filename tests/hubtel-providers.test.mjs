import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {hubtelSmsGateway} from '../services/api/providers/hubtel-sms.mjs';
import {hubtelCheckout} from '../services/api/providers/hubtel-payment.mjs';
import {database} from '../services/api/db.mjs';
import {checkoutService} from '../services/api/checkout.mjs';
import {financeService, journal} from '../services/api/finance.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {resetDispatchFixtures} from './helpers/reset-dispatch-fixtures.mjs';

const testDbUrl = process.env.TEST_DATABASE_URL;
if (!testDbUrl || !/^elesend_test(?:_|$)/.test(new URL(testDbUrl).pathname.slice(1))) {
  throw Error('TEST_DATABASE_URL must point to a dedicated elesend_test database');
}

const db = database(testDbUrl);

test('Hubtel SMS Gateway — Configuration, authentication, phone normalization and dispatch', async () => {
  // 1. Missing credentials fail closed
  assert.throws(() => hubtelSmsGateway({clientId: '', clientSecret: 'sec'}), {status: 503});
  assert.throws(() => hubtelSmsGateway({clientId: 'id', clientSecret: ''}), {status: 503});
  assert.throws(() => hubtelSmsGateway({clientId: 'id', clientSecret: 'sec', endpoint: 'http://insecure.hubtel.com'}), {status: 503});
  assert.throws(() => hubtelSmsGateway({clientId: 'id', clientSecret: 'sec', endpoint: 'https://attacker.invalid/sms'}), {status: 503});
  assert.throws(() => hubtelSmsGateway({clientId: 'id', clientSecret: 'sec', senderId: 'TOOLONGSENDERID123'}), {status: 400});

  let capturedUrl, capturedHeaders, capturedBody;
  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedHeaders = options.headers;
    capturedBody = JSON.parse(options.body);

    return Response.json({
      Code: '00',
      Message: 'Success',
      Data: {
        MessageId: 'hubtel-msg-998877',
        Status: 'Sent',
        RecipientNumber: capturedBody.To
      }
    });
  };

  const sms = hubtelSmsGateway({
    clientId: 'test-hubtel-client-id',
    clientSecret: 'test-hubtel-client-secret',
    senderId: 'ELESEND',
    endpoint: 'https://api.hubtel.com/v1/messages/send',
    fetchImpl: mockFetch
  });

  // 2. Normalizes 024XXXXXXX to 23324XXXXXXX
  const chId = randomUUID();
  const res = await sms.send({
    phone: '0241234567',
    code: '839201',
    purpose: 'pickup',
    challengeId: chId
  });

  assert.equal(res.accepted, true);
  assert.equal(res.messageId, 'hubtel-msg-998877');
  assert.equal(res.provider, 'hubtel');

  assert.equal(capturedUrl, 'https://api.hubtel.com/v1/messages/send');
  const expectedAuth = 'Basic ' + Buffer.from('test-hubtel-client-id:test-hubtel-client-secret').toString('base64');
  assert.equal(capturedHeaders.Authorization, expectedAuth);
  assert.equal(capturedBody.From, 'ELESEND');
  assert.equal(capturedBody.To, '233241234567');
  assert.equal(capturedBody.RegisteredDelivery, true);
  assert.equal(capturedBody.ClientReference, chId);
  assert.match(capturedBody.Content, /ELESEND parcel pickup verification: 839201/);

  // 3. Error response handling
  const failingFetch = async () => Response.json({
    Code: '1102',
    Message: 'Insufficient account SMS balance',
    Data: null
  });
  const failingSms = hubtelSmsGateway({
    clientId: 'id',
    clientSecret: 'sec',
    fetchImpl: failingFetch
  });

  await assert.rejects(
    () => failingSms.send({phone: '+233240001111', code: '123456', purpose: 'account', challengeId: randomUUID()}),
    {status: 503}
  );
});

test('Hubtel Payment Adapter — Checkout creation, status query, and webhook verification', async () => {
  assert.throws(() => hubtelCheckout({clientId: '', clientSecret: 'sec', merchantAccountNumber: '20199'}), {status: 503});
  assert.throws(() => hubtelCheckout({clientId: 'id', clientSecret: '', merchantAccountNumber: '20199'}), {status: 503});
  assert.throws(() => hubtelCheckout({clientId: 'id', clientSecret: 'sec', merchantAccountNumber: ''}), {status: 503});

  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({url, method: options.method, body: options.body ? JSON.parse(options.body) : null});

    if (url.includes('/items/initiate')) {
      const b = JSON.parse(options.body);
      return Response.json({
        ResponseCode: '00',
        ResponseMessage: 'Success',
        Data: {
          CheckoutUrl: `https://checkout.hubtel.com/pay/chk-${b.clientReference}`,
          CheckoutId: `chk-${b.clientReference}`,
          TransactionId: `trx-${b.clientReference}`
        }
      });
    }

    if (url.includes('/transaction/status')) {
      const b = JSON.parse(options.body);
      return Response.json({
        ResponseCode: '0000',
        ResponseMessage: 'Success',
        Data: {
          TransactionId: `trx-${b.ClientReference}`,
          ClientReference: b.ClientReference,
          Amount: 45.00,
          Status: 'Success',
          PaymentDetails: {
            Channel: 'mtn-gh'
          }
        }
      });
    }

    return new Response('Not found', {status: 404});
  };

  const hubtel = hubtelCheckout({
    clientId: 'hubtel-id-001',
    clientSecret: 'hubtel-secret-001',
    merchantAccountNumber: 'POS-2026-GH',
    fetchImpl: mockFetch
  });

  assert.equal(hubtel.name, 'hubtel');
  assert.deepEqual(hubtel.allowedCheckoutHosts, ['checkout.hubtel.com', 'payproxyapi.hubtel.com']);

  // 1. Create Checkout
  const ref = 'es_testref12345678';
  const checkoutRes = await hubtel.createCheckout({
    reference: ref,
    amountMinor: 4500, // GH₵ 45.00
    currency: 'GHS',
    method: 'MOMO',
    email: 'test@elesend.example'
  });

  assert.equal(checkoutRes.reference, ref);
  assert.equal(checkoutRes.checkoutUrl, `https://checkout.hubtel.com/pay/chk-${ref}`);

  const initCall = calls.find(c => c.url.includes('/items/initiate'));
  assert.ok(initCall);
  assert.equal(initCall.body.totalAmount, 45);
  assert.equal(initCall.body.merchantAccountNumber, 'POS-2026-GH');
  assert.equal(initCall.body.clientReference, ref);

  // 2. Verify Payment
  const verified = await hubtel.verifyPayment(ref);
  assert.equal(verified.status, 'success');
  assert.equal(verified.amountMinor, 4500);
  assert.equal(verified.currency, 'GHS');
  assert.equal(verified.channel, 'mobile_money');
  assert.equal(verified.eventId, `hubtel-transaction:trx-${ref}`);

  // 3. Webhook Parsing with Out-of-band Verification
  const webhookBody = Buffer.from(JSON.stringify({
    ResponseCode: '0000',
    Data: {
      Amount: 45.00,
      ClientReference: ref,
      TransactionId: `trx-${ref}`,
      Status: 'Success',
      PaymentType: 'mobilemoney'
    }
  }));

  const webhookVerified = await hubtel.parseVerifiedWebhook(webhookBody, {});
  assert.equal(webhookVerified.status, 'success');
  assert.equal(webhookVerified.reference, ref);
  assert.equal(webhookVerified.amountMinor, 4500);
});

test('Hubtel & CheckoutService Integration — End-to-end shipment checkout confirmation', async () => {
  await migrate(db);
  await db.query('TRUNCATE users, pricing_policies, shipments, shipment_checkout_intents, checkout_confirmed_events RESTART IDENTITY CASCADE');
  await resetDispatchFixtures(db);

  const mockFetch = async (url, options) => {
    if (url.includes('/items/initiate')) {
      const b = JSON.parse(options.body);
      return Response.json({
        ResponseCode: '00',
        Data: {
          CheckoutUrl: `https://checkout.hubtel.com/pay/${b.clientReference}`
        }
      });
    }
    if (url.includes('/transaction/status')) {
      const b = JSON.parse(options.body);
      return Response.json({
        ResponseCode: '0000',
        Data: {
          TransactionId: `hubtel-${b.ClientReference}`,
          ClientReference: b.ClientReference,
          Amount: 30.00,
          Status: 'Success',
          PaymentDetails: {Channel: 'mtn-gh'}
        }
      });
    }
    return new Response('Not found', {status: 404});
  };

  const hubtel = hubtelCheckout({
    clientId: 'hubtel-id-test',
    clientSecret: 'hubtel-secret-test',
    merchantAccountNumber: 'POS-TEST-1',
    fetchImpl: mockFetch
  });

  const checkout = checkoutService(db, {provider: hubtel});

  // Enable MOMO checkout
  const adminId = randomUUID();
  await db.query(`INSERT INTO users(id, phone, password_hash, kind) VALUES($1, '+233240000999', 'hash', 'admin')`, [adminId]);
  await db.query(`INSERT INTO permissions(user_id, permission) VALUES($1, 'payments:configure')`, [adminId]);
  await checkout.configure({id: adminId, kind: 'admin'}, {method: 'MOMO', enabled: true});

  // Create customer & unpaid digital shipment
  const custId = randomUUID();
  await db.query(`INSERT INTO users(id, phone, password_hash, kind) VALUES($1, '+233240000111', 'hash', 'customer')`, [custId]);

  let pol = (await db.query('SELECT id FROM pricing_policies WHERE active LIMIT 1')).rows[0];
  if (!pol) {
    const pid = randomUUID();
    await db.query(`INSERT INTO pricing_policies(id, base_minor, per_km_minor, commission_bps, active) VALUES($1, 3000, 100, 1300, true)`, [pid]);
    pol = { id: pid };
  }

  const quoteId = randomUUID();
  await db.query(`INSERT INTO quotes(id, customer_id, policy_id, request, amount_minor, commission_minor, expires_at)
    VALUES($1, $2, $3, '{"pickup":{"latitude":5.6,"longitude":-0.2},"destination":{"latitude":5.65,"longitude":-0.18}}', 3000, 390, now() + interval '15 minutes')`, [quoteId, custId, pol.id]);

  const shipId = randomUUID();
  const bookIdem = 'book-' + shipId.slice(0, 12);
  await db.query(`INSERT INTO shipments(id, customer_id, quote_id, state, amount_minor, commission_minor, payment_method, paid, idempotency_key, recipient_phone)
    VALUES($1, $2, $3, 'AWAITING_PAYMENT', 3000, 390, 'MOMO', false, $4, '+233240000222')`, [shipId, custId, quoteId, bookIdem]);

  // Initiate checkout
  const init = await checkout.initiate({id: custId, kind: 'customer'}, shipId, {
    idempotencyKey: 'hubtel-pay-' + shipId.slice(0, 12),
    email: 'ghana_customer@elesend.example'
  });

  assert.ok(init.checkoutUrl.startsWith('https://checkout.hubtel.com/pay/es_'));
  assert.equal(init.amountMinor, 3000);
  assert.equal(init.method, 'MOMO');

  // Receive Hubtel Webhook
  const webhookBody = Buffer.from(JSON.stringify({
    ResponseCode: '0000',
    Data: {
      Amount: 30.00,
      ClientReference: init.reference,
      TransactionId: 'trx-991283',
      Status: 'Success'
    }
  }));

  const webhookResult = await checkout.webhook(webhookBody, {});
  assert.equal(webhookResult.status, 'confirmed');
  assert.equal(webhookResult.duplicate, false);

  // Verify shipment is marked paid and dispatchable
  const paidShipment = (await db.query('SELECT paid, state FROM shipments WHERE id = $1', [shipId])).rows[0];
  assert.equal(paidShipment.paid, true);
  assert.equal(paidShipment.state, 'AWAITING_ASSIGNMENT');
});

test('Hubtel & FinanceService Integration — Rider commission settlement via Hubtel', async () => {
  await migrate(db);
  await db.query('TRUNCATE users, riders, commission_accounts, finance_journals, finance_lines, settlement_intents, settlement_provider_events RESTART IDENTITY CASCADE');

  const mockFetch = async (url, options) => {
    if (url.includes('/items/initiate')) {
      const b = JSON.parse(options.body);
      return Response.json({
        ResponseCode: '00',
        Data: {
          CheckoutUrl: `https://checkout.hubtel.com/pay/${b.clientReference}`
        }
      });
    }
    if (url.includes('/transaction/status')) {
      const b = JSON.parse(options.body);
      return Response.json({
        ResponseCode: '0000',
        Data: {
          TransactionId: `hubtel-${b.ClientReference}`,
          ClientReference: b.ClientReference,
          Amount: 20.00,
          Status: 'Success',
          PaymentDetails: {Channel: 'telecel-gh'}
        }
      });
    }
    return new Response('Not found', {status: 404});
  };

  const hubtel = hubtelCheckout({
    clientId: 'hubtel-fin-id',
    clientSecret: 'hubtel-fin-secret',
    merchantAccountNumber: 'POS-FIN-1',
    fetchImpl: mockFetch
  });

  const finance = financeService(db, {provider: hubtel});

  // Create Rider with commission account and debt
  const riderId = randomUUID();
  await db.query(`INSERT INTO users(id, phone, password_hash, kind) VALUES($1, '+233209998888', 'hash', 'rider')`, [riderId]);
  await db.query(`INSERT INTO riders(id, vehicle, max_weight_g, status) VALUES($1, 'motorcycle', 15000, 'approved')`, [riderId]);
  await db.query(`INSERT INTO commission_accounts(rider_id, postpaid_enabled, max_outstanding_minor, max_unpaid_jobs, settlement_due_days, blocked)
    VALUES($1, true, 50000, 20, 7, false)`, [riderId]);

  // Record an outstanding obligation of GH₵ 20.00 (2000 minor)
  const obligationId = randomUUID();
  await db.query(`INSERT INTO commission_obligations(id, shipment_id, rider_id, original_minor, due_at)
    VALUES($1, NULL, $2, 2000, now() + interval '7 days')`, [obligationId, riderId]);

  // Post journal entry establishing receivable
  await db.tx(async c => {
    await journal(c, {
      eventKey: 'test:receivable:hubtel:1',
      riderId,
      kind: 'cash_commission',
      value: 2000
    });
  });

  // Initiate commission repayment
  const repayment = await finance.initiate({id: riderId, kind: 'rider'}, {
    kind: 'commission_repayment',
    amountMinor: 2000,
    idempotencyKey: 'repay-idem-12345',
    email: 'rider_telecel@elesend.example'
  });

  assert.ok(repayment.paymentInstructions.checkoutUrl.startsWith('https://checkout.hubtel.com/pay/escomm_'));
  assert.equal(repayment.paymentInstructions.reference.startsWith('escomm_'), true);

  // Send Hubtel Commission Webhook
  const webhookBody = Buffer.from(JSON.stringify({
    ResponseCode: '0000',
    Data: {
      Amount: 20.00,
      ClientReference: repayment.paymentInstructions.reference,
      TransactionId: 'trx-repay-8812',
      Status: 'Success'
    }
  }));

  const webhookRes = await finance.handleWebhook(webhookBody, {});
  assert.equal(webhookRes.status, 'confirmed');
  assert.equal(webhookRes.collectedMinor, 2000);

  // Verify debt cleared
  const snapshot = await finance.snapshot({id: riderId, kind: 'rider'});
  assert.equal(snapshot.dueMinor, 0, 'Rider receivable must be completely cleared by verified Hubtel settlement');
});
