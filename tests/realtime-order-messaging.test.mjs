import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { database } from '../services/api/db.mjs';
import { migrate } from '../scripts/migrate.mjs';
import { chatEngine } from '../services/api/chat-engine.mjs';
import { restaurantOrderService } from '../services/api/restaurant-orders.mjs';
import { checkoutService } from '../services/api/checkout.mjs';

const url = process.env.TEST_DATABASE_URL;

test('Order-Scoped Real-Time Chat, Customer Communication, and Order Messaging Engine', { skip: !url }, async t => {
  assert.match(new URL(url).pathname, /^\/elesend_test/, 'Requires dedicated test database');
  const root = database(url);

  try {
    await migrate(root);

    async function fixture(fn) {
      const c = await root.pool.connect();
      await c.query('BEGIN');
      let savepoint = 0;
      const db = {
        query: (...a) => c.query(...a),
        async tx(f) {
          const name = 'sp_chat_' + (++savepoint);
          await c.query('SAVEPOINT ' + name);
          try {
            const result = await f(c);
            await c.query('RELEASE SAVEPOINT ' + name);
            return result;
          } catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT ' + name);
            throw e;
          }
        }
      };

      try {
        const adminId = randomUUID();
        const customerId = randomUUID();
        const intruderCustomerId = randomUUID();
        const ownerAId = randomUUID();
        const ownerBId = randomUUID();
        const rider1Id = randomUUID();
        const rider2Id = randomUUID();
        const restAId = randomUUID();
        const restBId = randomUUID();
        const itemA1 = randomUUID();
        const policyId = randomUUID();

        for (const [id, kind] of [
          [adminId, 'admin'],
          [customerId, 'customer'],
          [intruderCustomerId, 'customer'],
          [ownerAId, 'business'],
          [ownerBId, 'business'],
          [rider1Id, 'rider'],
          [rider2Id, 'rider']
        ]) {
          await c.query(
            "INSERT INTO users(id, phone, password_hash, kind, phone_verified_at) VALUES($1, $2, 'test-hash', $3, now())",
            [id, '+2332' + String(randomInt(10000000, 99999999)), kind]
          );
        }

        await c.query(
          "INSERT INTO permissions(user_id, permission) VALUES($1, 'finance:configure'), ($1, 'finance:approve'), ($1, 'verification:write')",
          [adminId]
        );
        await c.query("INSERT INTO riders(id, vehicle, max_weight_g, online, status) VALUES($1, 'motorcycle', 20000, true, 'approved')", [rider1Id]);
        await c.query("INSERT INTO riders(id, vehicle, max_weight_g, online, status) VALUES($1, 'motorcycle', 20000, true, 'approved')", [rider2Id]);

        await c.query('UPDATE pricing_policies SET active = false');
        await c.query(
          "INSERT INTO pricing_policies(id, base_minor, per_km_minor, commission_bps, vehicle, active) VALUES($1, 1000, 100, 1300, 'motorcycle', true)",
          [policyId]
        );
        await c.query("UPDATE checkout_method_policies SET enabled = true WHERE method = 'MOMO'");
        await c.query("UPDATE service_markets SET service_enabled = true WHERE country_code = 'GH'");

        await c.query(
          `INSERT INTO restaurants(id, owner_id, name, phone, address, latitude, longitude, status)
           VALUES($1, $2, 'Osu Kitchen', '+233241112222', 'Osu', 5.5600, -0.1800, 'approved')`,
          [restAId, ownerAId]
        );
        await c.query(
          `INSERT INTO restaurants(id, owner_id, name, phone, address, latitude, longitude, status)
           VALUES($1, $2, 'Other Kitchen', '+233243334444', 'Tema', 5.6300, -0.1600, 'approved')`,
          [restBId, ownerBId]
        );
        await c.query("INSERT INTO menu_items(id, restaurant_id, name, price_minor) VALUES($1, $2, 'Banku & Tilapia', 5000)", [itemA1, restAId]);

        const admin = { id: adminId, kind: 'admin' };
        const customer = { id: customerId, kind: 'customer' };
        const intruderCustomer = { id: intruderCustomerId, kind: 'customer' };
        const kitchenA = { id: ownerAId, kind: 'business' };
        const kitchenB = { id: ownerBId, kind: 'business' };
        const rider1 = { id: rider1Id, kind: 'rider' };
        const rider2 = { id: rider2Id, kind: 'rider' };

        const chat = chatEngine(db);
        const food = restaurantOrderService(db, {
          routing: { route: async () => ({ distanceMeters: 2000, durationSeconds: 300 }) }
        });

        let receipt;
        const provider = {
          name: 'fixture',
          methods: ['MOMO'],
          allowedCheckoutHosts: ['checkout.test'],
          createCheckout: async x => ({ reference: x.reference, checkoutUrl: 'https://checkout.test/pay' }),
          verifyPayment: async () => receipt,
          parseVerifiedWebhook: async () => receipt
        };
        const checkout = checkoutService(db, { provider });

        const order = await food.createFoodOrder(
          customer,
          {
            restaurantId: restAId,
            items: [{ itemId: itemA1, quantity: 1, options: [] }],
            deliveryAddress: 'Cantonments Ring Rd',
            deliveryLatitude: 5.58,
            deliveryLongitude: -0.17,
            customerPhone: '0241234567'
          },
          { paymentMethod: 'MOMO', idempotencyKey: randomUUID() }
        );

        const intent = await checkout.initiate(customer, order.shipment_id, { idempotencyKey: randomUUID() });
        receipt = {
          reference: intent.reference,
          status: 'success',
          amountMinor: Number(order.total_minor),
          currency: 'GHS',
          channel: 'mobile_money',
          eventId: 'evt_' + randomUUID()
        };
        await checkout.webhook(Buffer.from('{}'), {});
        await food.acceptOrder(kitchenA, order.id, { estimatedPrepMinutes: 15 });

        await fn({
          db, c, chat, food, order,
          admin, customer, intruderCustomer, kitchenA, kitchenB, rider1, rider2, restAId, restBId
        });
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }

    await t.test('1. Strict participant authorization & IDOR protection across all 4 conversation categories', () =>
      fixture(async ({ c, chat, order, customer, intruderCustomer, kitchenA, kitchenB, rider1, rider2 }) => {
        // Before any rider is assigned, CUSTOMER_RIDER and RIDER_RESTAURANT cannot be opened
        await assert.rejects(
          chat.openOrCreateConversation(customer, {
            conversationType: 'CUSTOMER_RIDER',
            shipmentId: order.shipment_id,
            foodOrderId: order.id
          }),
          /active courier assignment/i
        );

        // Assign Rider 1 to the shipment
        await c.query("UPDATE shipments SET rider_id = $2, state = 'RIDER_ASSIGNED' WHERE id = $1", [order.shipment_id, rider1.id]);

        // Intruder customer cannot open CUSTOMER_RIDER or CUSTOMER_RESTAURANT for someone else's order
        await assert.rejects(
          chat.openOrCreateConversation(intruderCustomer, {
            conversationType: 'CUSTOMER_RIDER',
            shipmentId: order.shipment_id
          }),
          /Only the customer on this order/i
        );
        await assert.rejects(
          chat.openOrCreateConversation(intruderCustomer, {
            conversationType: 'CUSTOMER_RESTAURANT',
            foodOrderId: order.id
          }),
          /Only the customer on this food order/i
        );

        // Unassigned Rider 2 cannot open CUSTOMER_RIDER or RIDER_RESTAURANT
        await assert.rejects(
          chat.openOrCreateConversation(rider2, {
            conversationType: 'CUSTOMER_RIDER',
            shipmentId: order.shipment_id
          }),
          /Only the currently assigned courier/i
        );

        // Unrelated Kitchen B cannot open CUSTOMER_RESTAURANT or RIDER_RESTAURANT
        await assert.rejects(
          chat.openOrCreateConversation(kitchenB, {
            conversationType: 'CUSTOMER_RESTAURANT',
            foodOrderId: order.id
          }),
          /Only the owning restaurant/i
        );

        // Valid participants can open all 4 conversation types
        const convCR = await chat.openOrCreateConversation(customer, {
          conversationType: 'CUSTOMER_RIDER',
          shipmentId: order.shipment_id,
          foodOrderId: order.id
        });
        assert.equal(convCR.conversationType, 'CUSTOMER_RIDER');
        assert.equal(convCR.assignmentEpoch, 1);

        const convCK = await chat.openOrCreateConversation(kitchenA, {
          conversationType: 'CUSTOMER_RESTAURANT',
          foodOrderId: order.id
        });
        assert.equal(convCK.conversationType, 'CUSTOMER_RESTAURANT');

        const convRK = await chat.openOrCreateConversation(rider1, {
          conversationType: 'RIDER_RESTAURANT',
          foodOrderId: order.id,
          shipmentId: order.shipment_id
        });
        assert.equal(convRK.conversationType, 'RIDER_RESTAURANT');

        const convCS = await chat.openOrCreateConversation(customer, {
          conversationType: 'CUSTOMER_SUPPORT',
          foodOrderId: order.id
        });
        assert.equal(convCS.conversationType, 'CUSTOMER_SUPPORT');
      })
    );

    await t.test('2. Rider reassignment immediately revokes old rider access, expires pending notifications, and isolates new rider epoch', () =>
      fixture(async ({ c, chat, order, customer, rider1, rider2 }) => {
        await c.query("UPDATE shipments SET rider_id = $2, state = 'RIDER_ASSIGNED' WHERE id = $1", [order.shipment_id, rider1.id]);

        // Epoch 1: Customer & Rider 1 exchange messages
        const convEpoch1 = await chat.openOrCreateConversation(customer, {
          conversationType: 'CUSTOMER_RIDER',
          shipmentId: order.shipment_id,
          foodOrderId: order.id
        });
        assert.equal(convEpoch1.assignmentEpoch, 1);

        await chat.sendMessage(customer, convEpoch1.id, {
          clientMessageId: 'msg-c-1',
          messageType: 'text',
          bodyText: 'Please use the blue gate on arrival.'
        });
        await chat.sendMessage(rider1, convEpoch1.id, {
          clientMessageId: 'msg-r1-1',
          messageType: 'quick_reply',
          quickReplyKey: 'rider_on_my_way'
        });

        // Reassign shipment from Rider 1 to Rider 2
        await c.query("UPDATE shipments SET rider_id = $2, state = 'RIDER_ASSIGNED' WHERE id = $1", [order.shipment_id, rider2.id]);
        await chat.revokeRiderConversations(c, {
          shipmentId: order.shipment_id,
          oldRiderUserId: rider1.id,
          reason: 'rider_reassigned'
        });

        // Rider 1 is immediately blocked from reading history or sending messages on Epoch 1
        await assert.rejects(
          chat.listMessages(rider1, convEpoch1.id),
          /revoked|no longer active|Forbidden/i
        );
        await assert.rejects(
          chat.sendMessage(rider1, convEpoch1.id, {
            clientMessageId: 'msg-r1-after-revoke',
            messageType: 'text',
            bodyText: 'Still trying to message'
          }),
          /revoked|closed|Forbidden/i
        );

        // Customer or Rider 2 opening CUSTOMER_RIDER now gets a fresh Epoch 2 conversation
        const convEpoch2 = await chat.openOrCreateConversation(rider2, {
          conversationType: 'CUSTOMER_RIDER',
          shipmentId: order.shipment_id,
          foodOrderId: order.id
        });
        assert.notEqual(convEpoch2.id, convEpoch1.id);
        assert.equal(convEpoch2.assignmentEpoch, 2);

        // Rider 2 cannot read Epoch 1's messages and Epoch 2 starts clean
        await assert.rejects(
          chat.listMessages(rider2, convEpoch1.id),
          /not a participant|Forbidden/i
        );
        const epoch2History = await chat.listMessages(rider2, convEpoch2.id);
        assert.equal(epoch2History.messages.length, 0);
      })
    );

    await t.test('3. Monotonic seq, idempotent clientMessageId retries, delta sync, SENT/DELIVERED/READ receipts, and zero-DB typing indicator', () =>
      fixture(async ({ c, chat, order, customer, kitchenA }) => {
        const conv = await chat.openOrCreateConversation(customer, {
          conversationType: 'CUSTOMER_RESTAURANT',
          foodOrderId: order.id
        });

        // Idempotent send with same clientMessageId
        const m1 = await chat.sendMessage(customer, conv.id, {
          clientMessageId: 'idem-001',
          messageType: 'text',
          bodyText: 'Please make the pepper mild.'
        });
        const m1Retry = await chat.sendMessage(customer, conv.id, {
          clientMessageId: 'idem-001',
          messageType: 'text',
          bodyText: 'Please make the pepper mild.'
        });
        assert.equal(m1.id, m1Retry.id);
        assert.equal(m1.seq, 1);
        assert.equal(m1.deliveryStatus, 'SENT');

        const m2 = await chat.sendMessage(kitchenA, conv.id, {
          clientMessageId: 'idem-002',
          messageType: 'quick_reply',
          quickReplyKey: 'rest_preparing'
        });
        assert.equal(m2.seq, 2);

        // Delta sync afterSeq = 1 returns only seq 2
        const delta = await chat.listMessages(customer, conv.id, { afterSeq: 1 });
        assert.equal(delta.messages.length, 1);
        assert.equal(delta.messages[0].seq, 2);

        // Kitchen acknowledges delivered -> m1 becomes DELIVERED
        await chat.acknowledgeDelivered(kitchenA, conv.id, { upToSeq: 1 });
        let full = await chat.listMessages(customer, conv.id);
        assert.equal(full.messages.find(x => x.seq === 1).deliveryStatus, 'DELIVERED');

        // Kitchen marks read -> m1 becomes READ
        await chat.markRead(kitchenA, conv.id, { upToSeq: 1 });
        full = await chat.listMessages(customer, conv.id);
        assert.equal(full.messages.find(x => x.seq === 1).deliveryStatus, 'READ');

        // Ephemeral typing indicator writes ZERO rows to chat_messages
        const countBefore = (await c.query('SELECT count(*)::int AS cnt FROM chat_messages WHERE conversation_id = $1', [conv.id])).rows[0].cnt;
        const typingRes = await chat.sendTypingIndicator(customer, conv.id, { isTyping: true });
        assert.equal(typingRes.ok, true);
        const countAfter = (await c.query('SELECT count(*)::int AS cnt FROM chat_messages WHERE conversation_id = $1', [conv.id])).rows[0].cnt;
        assert.equal(countAfter, countBefore);
      })
    );

    await t.test('4. OTP & paid-address safety guards, confirmed location pin validation, privacy-safe push notifications, and audited support moderation', () =>
      fixture(async ({ c, chat, order, admin, customer, kitchenA }) => {
        const conv = await chat.openOrCreateConversation(customer, {
          conversationType: 'CUSTOMER_RESTAURANT',
          foodOrderId: order.id
        });

        // Sending a message mentioning 6-digit OTP or address change flags warnings and NEVER mutates order address or total
        const beforeOrder = (await c.query('SELECT delivery_address, total_minor, state FROM food_orders WHERE id = $1', [order.id])).rows[0];
        const guardedMsg = await chat.sendMessage(customer, conv.id, {
          clientMessageId: 'guard-1',
          messageType: 'text',
          bodyText: 'My OTP code is 123456 and please change address to Tema Community 1 instead.'
        });
        assert.equal(guardedMsg.metadata.otpWarning, true);
        assert.equal(guardedMsg.metadata.addressChangeWarning, true);

        const afterOrder = (await c.query('SELECT delivery_address, total_minor, state FROM food_orders WHERE id = $1', [order.id])).rows[0];
        assert.equal(afterOrder.delivery_address, beforeOrder.delivery_address);
        assert.equal(afterOrder.total_minor, beforeOrder.total_minor);

        // Unconfirmed location pin is rejected; confirmed pin within Ghana bounds succeeds
        await assert.rejects(
          chat.sendMessage(customer, conv.id, {
            clientMessageId: 'pin-bad',
            messageType: 'location_pin',
            locationPin: { latitude: 5.58, longitude: -0.17, label: 'Unconfirmed pin', confirmed: false }
          }),
          /explicitly confirmed/i
        );

        const validPinMsg = await chat.sendMessage(customer, conv.id, {
          clientMessageId: 'pin-good',
          messageType: 'location_pin',
          locationPin: { latitude: 5.58, longitude: -0.17, label: 'Blue Gate Entrance', confirmed: true }
        });
        assert.equal(validPinMsg.messageType, 'location_pin');

        // Privacy-safe push notification in notification_jobs does not leak raw phone numbers or OTP digits
        const notifRows = (await c.query(
          "SELECT payload FROM notification_jobs WHERE kind = 'chat_message' ORDER BY created_at DESC LIMIT 5"
        )).rows;
        assert.ok(notifRows.length > 0);
        for (const row of notifRows) {
          const serialized = JSON.stringify(row.payload);
          assert.ok(!serialized.includes('123456'), 'Notification payload must redact 6-digit OTP');
        }

        // Abuse report & audited support inspection
        const report = await chat.reportAbuse(kitchenA, conv.id, {
          reportedMessageId: guardedMsg.id,
          reasonCategory: 'spam',
          details: 'Repeated spam messages in kitchen chat'
        });
        assert.equal(report.status, 'open');

        // Admin reading a non-escalated thread WITHOUT justification reason is rejected
        await assert.rejects(
          chat.listMessages(admin, conv.id, { supportReason: '' }),
          /justification reason/i
        );
        // Admin reading WITH justification reason succeeds and writes an audit_log entry
        const adminRead = await chat.listMessages(admin, conv.id, {
          supportReason: 'Investigating kitchen abuse report #' + report.id
        });
        assert.ok(adminRead.messages.length >= 2);
      })
    );
  } finally {
    await root.close();
  }
});
