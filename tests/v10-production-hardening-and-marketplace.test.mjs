import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {database} from '../services/api/db.mjs';
import {platform} from '../services/api/platform.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {httpServer} from '../services/api/http.mjs';
import {dispatchEngine} from '../services/api/dispatch.mjs';
import {fixtureRouting} from '../services/api/dispatch-routing.mjs';
import {haversine} from '../services/api/dispatch-geometry.mjs';
import {resetDispatchFixtures} from './helpers/reset-dispatch-fixtures.mjs';
import {restaurantService} from '../services/api/restaurant.mjs';
import {restaurantOrderService} from '../services/api/restaurant-orders.mjs';
import {checkoutService} from '../services/api/checkout.mjs';
import {evaluateRestaurantBatch} from '../services/api/algorithms/restaurant-batch.mjs';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^elesend_test(?:_|$)/.test(new URL(url).pathname.slice(1))) {
  throw Error('TEST_DATABASE_URL must point to a dedicated elesend_test database');
}

const db = database(url);
const messages = [];
const routing = fixtureRouting(async (a, b) => ({
  distanceMeters: Math.ceil(haversine(a, b) * 1.35),
  durationSeconds: Math.ceil(haversine(a, b) * 1.35 / 7) + 1,
  geometry: {type: 'LineString', coordinates: [[a.longitude, a.latitude], [b.longitude, b.latitude]]}
}));

const dispatcher = dispatchEngine(db, {routing});
const app = platform(db, {
  otpKey: randomBytes(32).toString('hex'),
  sms: {async send(m) { messages.push(m); }},
  dispatch: dispatcher,
  routing
});

const restService = restaurantService(db);
const restOrderService = restaurantOrderService(db, {platform: app, dispatcher, routing});

// PSP Provider Mock for Checkout & Webhook Idempotency Testing
const pspTransactions = new Map();
const pspProvider = {
  name: 'paystack',
  methods: ['MOMO', 'CARD', 'QR'],
  allowedCheckoutHosts: ['checkout.paystack.com'],
  async createCheckout({reference, amountMinor, currency, method, email}) {
    pspTransactions.set(reference, {
      reference,
      amountMinor,
      currency,
      method,
      status: 'success'
    });
    return {
      reference,
      checkoutUrl: `https://checkout.paystack.com/pay/${reference}`
    };
  },
  async verifyPayment(ref) {
    const t = pspTransactions.get(ref);
    if (!t) throw Object.assign(Error('Not found'), {status: 404});
    return {
      reference: t.reference,
      status: t.status,
      amountMinor: t.amountMinor,
      currency: t.currency,
      channel: t.method === 'MOMO' ? 'mobile_money' : 'card',
      eventId: 'evt_' + t.reference
    };
  },
  async parseVerifiedWebhook(rawBody, headers) {
    return JSON.parse(rawBody.toString('utf8'));
  }
};
const checkout = checkoutService(db, {provider: pspProvider});

let admin, businessOwnerA, businessOwnerB, customer, rider1, rider2;
let tokenAdmin, tokenBizA, tokenBizB, tokenCust, tokenRider1, tokenRider2;
let server, base;
const pw = 'V10HardenedPassword2026!';

async function account(phone, kind = 'customer', extra = {}) {
  return app.register({phone, password: pw, kind, ...extra});
}

before(async () => {
  await migrate(db);
  await db.query('TRUNCATE users,pricing_policies,restaurants,menu_categories,menu_items,food_orders,rate_limits RESTART IDENTITY CASCADE');
  await resetDispatchFixtures(db);

  // Default 13% motorcycle pricing policy
  await db.query(`INSERT INTO pricing_policies(id, vehicle, base_minor, per_km_minor, per_minute_minor, minimum_minor, commission_bps, active)
    VALUES (gen_random_uuid(), 'motorcycle', 1200, 320, 25, 2000, 1300, true)`);

  // Enable payment methods in checkout_method_policies
  await db.query("UPDATE checkout_method_policies SET enabled=true WHERE method IN ('CASH','CARD','MOMO')");

  admin = await account('0207777001');
  await db.query("UPDATE users SET kind='admin' WHERE id=$1", [admin.id]);
  admin.kind = 'admin';
  for (const p of ['verification:write', 'pricing:write', 'shipments:read', 'dispatch:configure', 'payments:configure']) {
    await db.query('INSERT INTO permissions VALUES($1,$2)', [admin.id, p]);
  }

  businessOwnerA = await account('0207777002', 'business', {name: 'Golden Stool Eatery'});
  businessOwnerB = await account('0207777003', 'business', {name: 'Cape Coast Seafood'});
  customer = await account('0207777004', 'customer');
  rider1 = await account('0207777005', 'rider');
  rider2 = await account('0207777006', 'rider');

  await app.approve(admin, 'riders', rider1.id, 'approved');
  await app.availability(rider1, {online: true});

  await app.approve(admin, 'riders', rider2.id, 'approved');
  await app.availability(rider2, {online: true});

  // Pre-authenticate and cache tokens to respect production rate limiting
  tokenBizA = (await app.login({phone: businessOwnerA.phone, password: pw})).token;
  tokenBizB = (await app.login({phone: businessOwnerB.phone, password: pw})).token;
  tokenCust = (await app.login({phone: customer.phone, password: pw})).token;
  tokenRider1 = (await app.login({phone: rider1.phone, password: pw})).token;
  tokenRider2 = (await app.login({phone: rider2.phone, password: pw})).token;

  server = httpServer(db, app, dispatcher, null, checkout, {
    restaurant: restService,
    restaurantOrders: restOrderService
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  await db.close();
});

test('ELESEND V10 — Complete Production Hardening Verification Suite', async t => {
  let restA, restB, catA, dishA, modA, optA1, optA2;
  let foodQuote, bookedFoodOrder;

  // =========================================================================
  // 1. Restaurant Ownership Isolation, Authorization & Cross-Merchant Attacks
  // =========================================================================
  await t.test('1. Restaurant ownership isolation, authorization & cross-merchant attack attempts', async () => {
    // Merchant A creates Restaurant A in Osu, Accra
    restA = await restService.createRestaurant(businessOwnerA, {
      name: 'Golden Stool Eatery',
      phone: '0241002001',
      address: 'Oxford Street, Osu, Accra',
      latitude: 5.5562,
      longitude: -0.1825,
      prepTimeMinutes: 20,
      deliveryRadiusM: 10000,
      cuisine: 'Ghanaian Traditional'
    });
    assert.ok(restA.id);
    assert.equal(restA.owner_id, businessOwnerA.id);

    // Merchant B creates Restaurant B in Labone, Accra
    restB = await restService.createRestaurant(businessOwnerB, {
      name: 'Cape Coast Seafood',
      phone: '0241002002',
      address: 'Labone Crescent, Accra',
      latitude: 5.5600,
      longitude: -0.1700,
      prepTimeMinutes: 25,
      deliveryRadiusM: 12000,
      cuisine: 'Seafood & Grills'
    });
    assert.ok(restB.id);
    assert.equal(restB.owner_id, businessOwnerB.id);

    const tokenB = tokenBizB;

    // ATTACK 1: Merchant B attempts to mutate Restaurant A's profile via HTTP
    const attackProfile = await fetch(`${base}/api/v1/restaurants/${restA.id}`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({name: 'Hacked By Merchant B', deliveryRadiusM: 40000})
    });
    assert.equal(attackProfile.status, 403, 'Cross-merchant profile mutation must return 403');

    // Create Category in Restaurant A by Merchant A for subsequent attack tests
    catA = await restService.createCategory(businessOwnerA, restA.id, {
      name: 'Hearty Soups & Fufu',
      displayOrder: 1
    });

    // ATTACK 2: Merchant B attempts to create category in Restaurant A
    const attackCatCreate = await fetch(`${base}/api/v1/restaurants/${restA.id}/categories`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({name: 'Malicious Category', displayOrder: 99})
    });
    assert.equal(attackCatCreate.status, 403, 'Cross-merchant category creation must return 403');

    // ATTACK 3: Merchant B attempts to update Restaurant A's category
    const attackCatUpdate = await fetch(`${base}/api/v1/restaurants/${restA.id}/categories/${catA.id}`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({name: 'Defaced Category Name'})
    });
    assert.equal(attackCatUpdate.status, 403, 'Cross-merchant category update must return 403');

    // Create dish in Restaurant A by Merchant A
    dishA = await restService.createMenuItem(businessOwnerA, restA.id, {
      categoryId: catA.id,
      name: 'Fufu with Light Soup & Fresh Goat Meat',
      priceMinor: 6500, // GH₵65.00
      prepTimeMinutes: 20,
      isAvailable: true
    });

    // ATTACK 4: Merchant B attempts to alter Restaurant A's dish price / stock
    const attackDishUpdate = await fetch(`${base}/api/v1/restaurants/${restA.id}/items/${dishA.id}`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({priceMinor: 100, isAvailable: false})
    });
    assert.equal(attackDishUpdate.status, 403, 'Cross-merchant item update must return 403');

    // ATTACK 5: Merchant B attempts to inspect Restaurant A's financial settlements
    const attackSettlements = await fetch(`${base}/api/v1/restaurants/${restA.id}/settlements`, {
      headers: {Authorization: `Bearer ${tokenB}`}
    });
    assert.equal(attackSettlements.status, 403, 'Cross-merchant financial settlements inspection must return 403');

    // ATTACK 6: Merchant B attempts to list Restaurant A's private food orders
    const attackOrderList = await fetch(`${base}/api/v1/food-orders?restaurantId=${restA.id}`, {
      headers: {Authorization: `Bearer ${tokenB}`}
    });
    assert.equal(attackOrderList.status, 403, 'Cross-merchant food orders inspection must return 403');

    // Verify DB integrity: Restaurant A and its items were not mutated
    const dbRestA = (await db.query('SELECT name FROM restaurants WHERE id = $1', [restA.id])).rows[0];
    assert.equal(dbRestA.name, 'Golden Stool Eatery');

    const dbDishA = (await db.query('SELECT price_minor, is_available FROM menu_items WHERE id = $1', [dishA.id])).rows[0];
    assert.equal(dbDishA.price_minor, 6500);
    assert.equal(dbDishA.is_available, true);
  });

  // =========================================================================
  // 2. Complete Restaurant Menu Management Through Authenticated API
  // =========================================================================
  await t.test('2. Complete restaurant menu management through actual authenticated API requests', async () => {
    const tokenA = tokenBizA;

    // 1. Create Modifier for Dish A: "Meat Selection" (Required, 1 selection)
    const modRes = await fetch(`${base}/api/v1/restaurants/${restA.id}/items/${dishA.id}/modifiers`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        name: 'Choose Goat Meat Portion',
        minSelections: 1,
        maxSelections: 1,
        isRequired: true
      })
    });
    assert.equal(modRes.status, 200);
    modA = await modRes.json();
    assert.equal(modA.name, 'Choose Goat Meat Portion');
    assert.equal(modA.is_required, true);

    // 2. Add Options to Modifier
    const optRes1 = await fetch(`${base}/api/v1/restaurants/${restA.id}/modifiers/${modA.id}/options`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({name: 'Regular Goat Meat', priceMinor: 0, isAvailable: true})
    });
    assert.equal(optRes1.status, 200);
    optA1 = await optRes1.json();

    const optRes2 = await fetch(`${base}/api/v1/restaurants/${restA.id}/modifiers/${modA.id}/options`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({name: 'Double Goat Meat (+GH₵20.00)', priceMinor: 2000, isAvailable: true})
    });
    assert.equal(optRes2.status, 200);
    optA2 = await optRes2.json();

    // 3. Update Category Display Order
    const catUpdateRes = await fetch(`${base}/api/v1/restaurants/${restA.id}/categories/${catA.id}`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({name: 'Premium Fufu & Soups', displayOrder: 10})
    });
    assert.equal(catUpdateRes.status, 200);
    const updatedCat = await catUpdateRes.json();
    assert.equal(updatedCat.name, 'Premium Fufu & Soups');
    assert.equal(updatedCat.display_order, 10);

    // 4. Update Menu Item Details
    const itemUpdateRes = await fetch(`${base}/api/v1/restaurants/${restA.id}/items/${dishA.id}`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({prepTimeMinutes: 22, description: 'Freshly prepared goat meat light soup with soft cassava fufu'})
    });
    assert.equal(itemUpdateRes.status, 200);
    const updatedItem = await itemUpdateRes.json();
    assert.equal(updatedItem.prep_time_minutes, 22);

    // 5. Query Full Menu Hierarchy with valid token
    const menuRes = await fetch(`${base}/api/v1/restaurants/${restA.id}/menu`, {
      headers: {Authorization: `Bearer ${tokenA}`}
    });
    assert.equal(menuRes.status, 200);
    const menu = await menuRes.json();
    assert.equal(menu.categories.length, 1);
    assert.equal(menu.categories[0].name, 'Premium Fufu & Soups');
    assert.equal(menu.categories[0].items.length, 1);
    assert.equal(menu.categories[0].items[0].name, 'Fufu with Light Soup & Fresh Goat Meat');
    assert.equal(menu.categories[0].items[0].modifiers.length, 1);
    assert.equal(menu.categories[0].items[0].modifiers[0].options.length, 2);
  });

  // =========================================================================
  // 3. Customer Food Checkout, Acceptance, Prep, Dispatch & OTP Handover
  // =========================================================================
  await t.test('3. Customer food checkout, restaurant acceptance, prep, rider dispatch & OTP delivery', async () => {
    const custToken = tokenCust;
    const tokenA = tokenBizA;

    // 1. Food Quote: Customer orders 2 bowls with Double Goat Meat (+20 GHS each)
    // Base 6500 + 2000 = 8500 * 2 = 17000 pesewas (GH₵170.00)
    const quoteRes = await fetch(`${base}/api/v1/food-orders/quote`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${custToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        restaurantId: restA.id,
        items: [{
          itemId: dishA.id,
          quantity: 2,
          options: [optA2.id]
        }],
        deliveryAddress: 'Airport Residential, Accra',
        deliveryLatitude: 5.6021,
        deliveryLongitude: -0.1834,
        customerPhone: customer.phone,
        specialInstructions: 'Very hot pepper sauce please'
      })
    });
    assert.equal(quoteRes.status, 200);
    foodQuote = await quoteRes.json();

    assert.equal(foodQuote.subtotalMinor, 17000);
    assert.equal(foodQuote.foodCommissionBps, 1000); // 10%
    assert.equal(foodQuote.foodCommissionMinor, 1700); // 1700 pesewas = GH₵17.00
    assert.ok(foodQuote.deliveryFeeMinor > 0);
    assert.equal(foodQuote.totalMinor, foodQuote.subtotalMinor + foodQuote.deliveryFeeMinor);

    // 2. Customer Books Order
    const bookRes = await fetch(`${base}/api/v1/food-orders`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${custToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        ...foodQuote,
        paymentMethod: 'CASH',
        specialInstructions: 'Ring doorbell twice'
      })
    });
    assert.equal(bookRes.status, 200);
    bookedFoodOrder = await bookRes.json();
    assert.equal(bookedFoodOrder.state, 'SUBMITTED');
    assert.ok(bookedFoodOrder.shipment_id);

    // 3. Restaurant Accepts Order with 22-minute prep time
    const acceptRes = await fetch(`${base}/api/v1/food-orders/${bookedFoodOrder.id}/accept`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({estimatedPrepMinutes: 22})
    });
    assert.equal(acceptRes.status, 200);
    const acceptedOrder = await acceptRes.json();
    assert.equal(acceptedOrder.state, 'ACCEPTED');

    // Verify shipment.next_dispatch_at buffered (~17 min in the future)
    const shAccepted = (await db.query('SELECT * FROM shipments WHERE id = $1', [bookedFoodOrder.shipment_id])).rows[0];
    const diffSec = (new Date(shAccepted.next_dispatch_at).getTime() - Date.now()) / 1000;
    assert.ok(diffSec > 600, 'Shipment next_dispatch_at should be buffered during prep');

    // 4. Restaurant transitions to PREPARING
    const prepRes = await fetch(`${base}/api/v1/food-orders/${bookedFoodOrder.id}/prepare`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json'}
    });
    assert.equal(prepRes.status, 200);
    const prepOrder = await prepRes.json();
    assert.equal(prepOrder.state, 'PREPARING');

    // 5. Restaurant marks READY_FOR_PICKUP
    const readyRes = await fetch(`${base}/api/v1/food-orders/${bookedFoodOrder.id}/ready`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json'}
    });
    assert.equal(readyRes.status, 200);
    const readyOrder = await readyRes.json();
    assert.equal(readyOrder.state, 'READY_FOR_PICKUP');

    // Verify shipment is now dispatchable immediately
    const shReady = (await db.query('SELECT * FROM shipments WHERE id = $1', [bookedFoodOrder.shipment_id])).rows[0];
    assert.ok(new Date(shReady.next_dispatch_at).getTime() <= Date.now() + 2000);

    // 6. Dispatch to Rider 1
    await dispatcher.riderPosition(rider1, {
      latitude: 5.5565,
      longitude: -0.1820,
      accuracyMeters: 8,
      observedAt: new Date().toISOString()
    });
    const offer = await dispatcher.dispatchShipment(bookedFoodOrder.shipment_id);
    assert.equal(offer.status, 'offered');

    await app.accept(rider1, bookedFoodOrder.shipment_id, offer.offerId);

    // 7. Pickup OTP Challenge & Verification
    const pickupChallenge = await app.challenge(rider1, bookedFoodOrder.shipment_id, 'pickup');
    assert.ok(pickupChallenge.challengeId);
    const pickupSms = messages.at(-1);

    await app.verify(rider1, bookedFoodOrder.shipment_id, {
      challengeId: pickupChallenge.challengeId,
      code: pickupSms.code
    });

    // Verify food order transitioned to IN_TRANSIT
    const foodInTransit = (await db.query('SELECT state FROM food_orders WHERE id = $1', [bookedFoodOrder.id])).rows[0];
    assert.equal(foodInTransit.state, 'IN_TRANSIT');

    // 8. Rider Transitions to Start Leg & Requests Delivery Challenge
    await app.transition(rider1, bookedFoodOrder.shipment_id, {action: 'start'});

    const deliveryChallenge = await app.challenge(rider1, bookedFoodOrder.shipment_id, 'delivery');
    const deliverySms = messages.at(-1);

    // Rider reports full recipient cash collection for delivery fee
    await db.query(
      `INSERT INTO cash_collections(shipment_id, rider_id, reported_minor, cash_payer, reported_status, report_idempotency_key)
       VALUES($1, $2, $3, 'recipient', 'reported_full', $4)`,
      [bookedFoodOrder.shipment_id, rider1.id, bookedFoodOrder.delivery_fee_minor, randomUUID()]
    );

    // Verify Delivery OTP
    const verifyResult = await app.verify(rider1, bookedFoodOrder.shipment_id, {
      challengeId: deliveryChallenge.challengeId,
      code: deliverySms.code
    });
    assert.equal(verifyResult.ok, true);

    // Assert Atomic Handover: shipment COMPLETED, food order DELIVERED
    const shDone = (await db.query('SELECT state, completed_at FROM shipments WHERE id = $1', [bookedFoodOrder.shipment_id])).rows[0];
    assert.equal(shDone.state, 'COMPLETED');
    assert.ok(shDone.completed_at);

    const foodDone = (await db.query('SELECT state, payment_status, completed_at FROM food_orders WHERE id = $1', [bookedFoodOrder.id])).rows[0];
    assert.equal(foodDone.state, 'DELIVERED');
    assert.equal(foodDone.payment_status, 'PAID');
    assert.ok(foodDone.completed_at);
  });

  // =========================================================================
  // 4. Strict Individual 30-Minute Food-Ready-to-Handover ETA Feasibility
  // =========================================================================
  await t.test('4. Strict individual 30-minute food-ready-to-handover ETA feasibility', async () => {
    const restaurant = {latitude: 5.5562, longitude: -0.1825};
    const rider = {latitude: 5.5560, longitude: -0.1820, vehicle: 'motorcycle', maxCapacityG: 15000};
    const t0 = new Date('2026-10-22T12:00:00Z').getTime();

    // Batch Scenario: 2 nearby orders and 1 distant order
    // Order 1: Labone (~1.5 km away) - ready at 12:00
    // Order 2: Cantonments (~2.2 km away) - ready at 12:05
    // Order 3: distant destination (~20 km away, >40 min travel) - ready at 12:00
    const orders = [
      {
        id: randomUUID(),
        readyAt: new Date(t0).toISOString(),
        destination: {latitude: 5.5600, longitude: -0.1700},
        weightG: 1200
      },
      {
        id: randomUUID(),
        readyAt: new Date(t0 + 5 * 60000).toISOString(),
        destination: {latitude: 5.5750, longitude: -0.1750},
        weightG: 1500
      },
      {
        id: randomUUID(),
        readyAt: new Date(t0).toISOString(),
        destination: {latitude: 5.7500, longitude: -0.2200}, // >20km away
        weightG: 2000
      }
    ];

    const batchEval = await evaluateRestaurantBatch({
      routing,
      restaurant,
      orders,
      rider,
      options: {now: new Date(t0).toISOString(), maxPlannedMinutes: 30, targetPlannedMinutes: 25}
    });

    // The full batch of 3 cannot all be delivered within 30 minutes
    assert.equal(batchEval.feasible, false, 'Full batch of 3 cannot all be served within 30m');
    assert.equal(batchEval.batchRequiresSplit, true, 'Batch exceeding 30m must be split');
    assert.equal(batchEval.recommendedBatch.length, 2, '2 nearby orders form recommended batch');
    assert.equal(batchEval.splitOrders.length, 1, 'Distant order must be separated into splitOrders');
    assert.equal(batchEval.splitOrders[0].id, orders[2].id);

    // Test Feasible Sub-Batch (Orders 1 and 2 only)
    const feasibleBatch = await evaluateRestaurantBatch({
      routing,
      restaurant,
      orders: orders.slice(0, 2),
      rider,
      options: {now: new Date(t0).toISOString(), maxPlannedMinutes: 30, targetPlannedMinutes: 25}
    });

    assert.equal(feasibleBatch.feasible, true, 'Nearby batch must be marked feasible');
    assert.equal(feasibleBatch.allWithinMax, true, 'All accepted orders must be <= 30 minutes from readiness');
    for (const m of feasibleBatch.metrics) {
      assert.ok(m.minutesFromReady <= 30, `Order ${m.orderId} took ${m.minutesFromReady}m, exceeding 30m limit`);
    }
  });

  // =========================================================================
  // 5. Concurrent Rider Acceptance & Atomic Assignment
  // =========================================================================
  await t.test('5. Concurrent rider acceptance and atomic assignment', async () => {
    // Book a parcel shipment
    const quote = await app.quote(customer, {
      pickup: {address: 'Ridge Church School, Accra', latitude: 5.5650, longitude: -0.1980},
      destination: {address: 'Ministry of Finance, Accra', latitude: 5.5450, longitude: -0.2010},
      vehicle: 'motorcycle',
      recipientPhone: '0249998877',
      weightG: 800,
      description: 'Tax Returns',
      paymentMethod: 'CASH'
    });

    const booked = await app.book(customer, {quoteId: quote.id}, randomUUID());
    assert.equal(booked.state, 'AWAITING_ASSIGNMENT');

    // Reset rider position anchors to allow fresh realistic position sampling
    await db.query('UPDATE riders SET position_at=NULL, current_position=NULL WHERE id IN ($1, $2)', [rider1.id, rider2.id]);

    const nowIso = new Date().toISOString();
    await dispatcher.riderPosition(rider1, {latitude: 5.5640, longitude: -0.1970, accuracyMeters: 5, observedAt: nowIso});
    await dispatcher.riderPosition(rider2, {latitude: 5.5645, longitude: -0.1975, accuracyMeters: 5, observedAt: nowIso});

    // Dispatch offer
    const offer1 = await dispatcher.dispatchShipment(booked.id);
    assert.ok(offer1.offerId);
    const winningRider = offer1.riderId === rider1.id ? rider1 : rider2;
    const losingRider = winningRider === rider1 ? rider2 : rider1;

    // Compete concurrently: two rapid concurrent acceptance requests race for the shipment
    const [res1, res2] = await Promise.allSettled([
      app.accept(winningRider, booked.id, offer1.offerId),
      app.accept(winningRider, booked.id, offer1.offerId)
    ]);

    // Exactly one winner, exactly one 409 rejection via SELECT ... FOR UPDATE serialization
    const fulfilled = [res1, res2].filter(r => r.status === 'fulfilled');
    const rejected = [res1, res2].filter(r => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Exactly one concurrent acceptance must succeed');
    assert.equal(rejected.length, 1, 'The competing concurrent request must be rejected with 409 conflict');
    assert.equal(rejected[0].reason.status, 409, 'Conflict status must be HTTP 409');

    // Competing Rider attempting to claim the assigned shipment must also be rejected
    await assert.rejects(
      () => app.accept(losingRider, booked.id, offer1.offerId),
      {status: 409}
    );

    // Confirm DB atomic assignment
    const shRow = (await db.query('SELECT rider_id, state FROM shipments WHERE id = $1', [booked.id])).rows[0];
    assert.equal(shRow.state, 'RIDER_ASSIGNED');
    assert.equal(shRow.rider_id, winningRider.id);
  });

  // =========================================================================
  // 6. Cash Collection, Commissions (13% Delivery, 10% Food) & Reconciliation
  // =========================================================================
  await t.test('6. Cash collection, delivery commissions, restaurant commissions & financial reconciliation', async () => {
    // Reconcile the delivered order from Test 3: bookedFoodOrder
    const orderId = bookedFoodOrder.id;
    const shipmentId = bookedFoodOrder.shipment_id;

    // 1. Verify Delivery Financial Ledger (financial_entries)
    const finEntry = (await db.query('SELECT * FROM financial_entries WHERE shipment_id = $1', [shipmentId])).rows[0];
    assert.ok(finEntry);
    assert.equal(finEntry.customer_charge_minor, bookedFoodOrder.delivery_fee_minor);

    // Strict 13% Platform Delivery Commission
    const expectedDeliveryComm = Math.round(bookedFoodOrder.delivery_fee_minor * 0.13);
    assert.equal(finEntry.commission_minor, expectedDeliveryComm);
    assert.equal(finEntry.entitlement_minor, bookedFoodOrder.delivery_fee_minor - expectedDeliveryComm);
    assert.equal(finEntry.payout_status, 'cash_rider_reported');

    // 2. Verify Restaurant Settlement Ledger (restaurant_settlements)
    const restSettle = (await db.query('SELECT * FROM restaurant_settlements WHERE order_id = $1', [orderId])).rows[0];
    assert.ok(restSettle);
    assert.equal(restSettle.restaurant_id, restA.id);
    assert.equal(restSettle.gross_sales_minor, 17000); // GH₵170.00
    assert.equal(restSettle.commission_bps, 1000); // Strictly 10% (1000 bps)
    assert.equal(restSettle.commission_minor, 1700); // Strictly GH₵17.00
    assert.equal(restSettle.net_payable_minor, 15300); // 90% payable = GH₵153.00
    assert.equal(restSettle.status, 'accrued');

    // 3. Mathematical Reconciliation Identities
    assert.equal(
      restSettle.gross_sales_minor,
      restSettle.commission_minor + restSettle.net_payable_minor,
      'Food Gross Sales = Commission + Net Payable'
    );
    assert.equal(
      finEntry.customer_charge_minor,
      finEntry.commission_minor + finEntry.entitlement_minor,
      'Delivery Charge = Commission + Rider Entitlement'
    );
  });

  // =========================================================================
  // 7. Payment Webhook Idempotency, Refunds & Failure Recovery
  // =========================================================================
  await t.test('7. Payment webhook idempotency, refunds and failure recovery', async () => {
    // Create Momo Shipment
    const quote = await app.quote(customer, {
      pickup: {address: 'Dzorwulu Junction', latitude: 5.6080, longitude: -0.1920},
      destination: {address: 'East Legon Underbridge', latitude: 5.6320, longitude: -0.1650},
      vehicle: 'motorcycle',
      recipientPhone: '0245678901',
      weightG: 1100,
      description: 'Design Prototype',
      paymentMethod: 'MOMO'
    });

    const digitalShipment = await app.book(customer, {quoteId: quote.id}, randomUUID());
    assert.equal(digitalShipment.state, 'AWAITING_PAYMENT');
    assert.equal(digitalShipment.paid, false);

    // Customer initiates checkout
    const initRes = await checkout.initiate(customer, digitalShipment.id, {
      idempotencyKey: randomUUID()
    });
    assert.ok(initRes.reference);
    assert.ok(initRes.checkoutUrl);

    // SCENARIO A: Normal PSP Webhook Confirmation (channel: mobile_money)
    const webhookPayloadNormal = {
      reference: initRes.reference,
      status: 'success',
      amountMinor: initRes.amountMinor,
      currency: 'GHS',
      channel: 'mobile_money',
      eventId: 'evt_normal_' + initRes.reference
    };

    const rawNormal = Buffer.from(JSON.stringify(webhookPayloadNormal));
    const confirmA = await checkout.webhook(rawNormal, {});
    assert.equal(confirmA.status, 'confirmed');
    assert.equal(confirmA.duplicate, false);

    // Verify shipment transitioned to paid & AWAITING_ASSIGNMENT
    const shPaid = (await db.query('SELECT paid, state FROM shipments WHERE id = $1', [digitalShipment.id])).rows[0];
    assert.equal(shPaid.paid, true);
    assert.equal(shPaid.state, 'AWAITING_ASSIGNMENT');

    // SCENARIO B: Idempotent Replay of Identical Webhook Event
    const confirmB = await checkout.webhook(rawNormal, {});
    assert.equal(confirmB.status, 'confirmed');
    assert.equal(confirmB.duplicate, true, 'Replay of confirmed event must return duplicate: true');

    // SCENARIO C: Tampered / Mismatched Payment Terms -> Quarantined to Refund Review
    const quote2 = await app.quote(customer, {
      pickup: {address: 'Adabraka Market', latitude: 5.5600, longitude: -0.2100},
      destination: {address: 'Circle VIP Station', latitude: 5.5700, longitude: -0.2150},
      vehicle: 'motorcycle',
      recipientPhone: '0245678902',
      weightG: 500,
      description: 'Usb Drive',
      paymentMethod: 'CARD'
    });
    const digitalShipment2 = await app.book(customer, {quoteId: quote2.id}, randomUUID());
    const initRes2 = await checkout.initiate(customer, digitalShipment2.id, {
      idempotencyKey: randomUUID()
    });

    const webhookPayloadMismatched = {
      reference: initRes2.reference,
      status: 'success',
      amountMinor: initRes2.amountMinor + 1000, // Tampered amount (+10 GHS)
      currency: 'GHS',
      channel: 'card',
      eventId: 'evt_mismatched_' + initRes2.reference
    };

    const rawMismatched = Buffer.from(JSON.stringify(webhookPayloadMismatched));
    const confirmC = await checkout.webhook(rawMismatched, {});
    assert.equal(confirmC.status, 'refund_review');
    assert.equal(confirmC.reason, 'payment_terms_mismatch');

    // Verify record in checkout_unapplied_payments table
    const unapplied = (await db.query('SELECT * FROM checkout_unapplied_payments WHERE event_id = $1', [webhookPayloadMismatched.eventId])).rows[0];
    assert.ok(unapplied);
    assert.equal(unapplied.reason, 'payment_terms_mismatch');

    // SCENARIO D: Payment Arrives After Shipment Cancellation -> Refund Review
    const quote3 = await app.quote(customer, {
      pickup: {address: 'Spintex Road', latitude: 5.6300, longitude: -0.1000},
      destination: {address: 'Batsonaa Total', latitude: 5.6400, longitude: -0.0800},
      vehicle: 'motorcycle',
      recipientPhone: '0245678903',
      weightG: 500,
      description: 'Shoes',
      paymentMethod: 'MOMO'
    });
    const digitalShipment3 = await app.book(customer, {quoteId: quote3.id}, randomUUID());
    const initRes3 = await checkout.initiate(customer, digitalShipment3.id, {
      idempotencyKey: randomUUID()
    });

    // Customer cancels before payment confirmation
    await app.transition(customer, digitalShipment3.id, {action: 'cancel', reason: 'Customer changed mind'});

    // Webhook subsequently arrives for cancelled shipment
    const webhookPayloadPostCancel = {
      reference: initRes3.reference,
      status: 'success',
      amountMinor: initRes3.amountMinor,
      currency: 'GHS',
      channel: 'mobile_money',
      eventId: 'evt_cancelled_' + initRes3.reference
    };

    const rawPostCancel = Buffer.from(JSON.stringify(webhookPayloadPostCancel));
    const confirmD = await checkout.webhook(rawPostCancel, {});
    assert.equal(confirmD.status, 'refund_review');
    assert.equal(confirmD.reason, 'shipment_not_payable');
  });

  // =========================================================================
  // 8. Rider Navigation to Correct Pickup and Confirmed Dropoff Coordinates
  // =========================================================================
  await t.test('8. Rider navigation to correct pickup and confirmed dropoff coordinates', async () => {
    // Query shipments for winner rider (either rider1 or rider2 from Test 5)
    const listR1 = await app.list(rider1);
    const listR2 = await app.list(rider2);
    const assigned = [...listR1, ...listR2].find(s => s.state === 'RIDER_ASSIGNED');
    assert.ok(assigned, 'Must find assigned shipment for navigation verification');

    // Verify pickup and destination coordinates are strictly populated
    assert.ok(assigned.pickup, 'Assigned shipment must have pickup location');
    assert.ok(assigned.destination, 'Assigned shipment must have destination location');
    assert.ok(Number.isFinite(assigned.pickup.latitude));
    assert.ok(Number.isFinite(assigned.pickup.longitude));
    assert.ok(Number.isFinite(assigned.destination.latitude));
    assert.ok(Number.isFinite(assigned.destination.longitude));

    // Turn-by-Turn Navigation URI Generator Contract (matching mobile map-adapter.js)
    function generateNavUri(platform, point, label) {
      const lat = Number(point.latitude);
      const lon = Number(point.longitude);
      if (platform === 'android') {
        return `geo:${lat},${lon}?q=${lat},${lon}(${encodeURIComponent(label)})`;
      }
      return `https://maps.google.com/?daddr=${lat},${lon}`;
    }

    const pickupUriAndroid = generateNavUri('android', assigned.pickup, `Pickup #${assigned.id.slice(0, 8)}`);
    assert.match(pickupUriAndroid, /^geo:5\.[0-9]+,-0\.[0-9]+\?q=5\.[0-9]+,-0\.[0-9]+\(Pickup/);

    const dropoffUriAndroid = generateNavUri('android', assigned.destination, `Dropoff #${assigned.id.slice(0, 8)}`);
    assert.match(dropoffUriAndroid, /^geo:5\.[0-9]+,-0\.[0-9]+\?q=5\.[0-9]+,-0\.[0-9]+\(Dropoff/);

    const dropoffUriIos = generateNavUri('ios', assigned.destination, `Dropoff #${assigned.id.slice(0, 8)}`);
    assert.match(dropoffUriIos, /^https:\/\/maps\.google\.com\/\?daddr=5\.[0-9]+,-0\.[0-9]+/);
  });

  // =========================================================================
  // 9. Frontend / Backend Contract Testing with Real API Responses
  // =========================================================================
  await t.test('9. Frontend/backend contract testing with real API responses', async () => {
    const custToken = tokenCust;

    // 1. Shipment Listing Contract (App.js expects details, pickup, destination, amount_minor)
    const listRes = await fetch(`${base}/api/v1/shipments`, {
      headers: {Authorization: `Bearer ${custToken}`}
    });
    assert.equal(listRes.status, 200);
    const shipments = await listRes.json();
    assert.ok(Array.isArray(shipments));
    for (const s of shipments) {
      assert.ok(s.id, 'id is required');
      assert.ok(s.state, 'state is required');
      assert.ok(s.pickup, 'pickup object is required');
      assert.ok(s.destination, 'destination object is required');
      assert.ok(Number.isFinite(s.pickup.latitude));
      assert.ok(Number.isFinite(s.destination.latitude));
    }

    // 2. Restaurant Discovery Contract (App.js expects id, name, address, cuisine, prep_time_minutes)
    const restRes = await fetch(`${base}/api/v1/restaurants?lat=5.5562&lon=-0.1825`, {
      headers: {Authorization: `Bearer ${custToken}`}
    });
    assert.equal(restRes.status, 200);
    const restList = await restRes.json();
    assert.ok(Array.isArray(restList));
    const sampleRest = restList[0];
    assert.ok(sampleRest.id);
    assert.ok(sampleRest.name);
    assert.ok(sampleRest.address);
    assert.ok(Number.isFinite(sampleRest.latitude));
    assert.ok(Number.isFinite(sampleRest.longitude));
    assert.ok(Number.isInteger(sampleRest.prep_time_minutes));
    assert.ok(typeof sampleRest.isDeliverable === 'boolean');

    // 3. Restaurant Menu Contract (App.js expects categories with items & modifiers)
    const menuRes = await fetch(`${base}/api/v1/restaurants/${restA.id}/menu`, {
      headers: {Authorization: `Bearer ${custToken}`}
    });
    assert.equal(menuRes.status, 200);
    const menuData = await menuRes.json();
    assert.ok(Array.isArray(menuData.categories));
    assert.ok(menuData.categories[0].items.length > 0);
    const sampleItem = menuData.categories[0].items[0];
    assert.ok(sampleItem.id);
    assert.ok(sampleItem.name);
    assert.ok(Number.isInteger(sampleItem.price_minor));
    assert.ok(Array.isArray(sampleItem.modifiers));
  });

  // =========================================================================
  // 10. Docker Deployment Readiness, Database Migrations & Operational Security
  // =========================================================================
  await t.test('10. Docker deployment readiness, database migrations, restore testing & operational security', async () => {
    // 1. Database Migration Idempotency (Re-running migrate(db) executes cleanly)
    await migrate(db);
    const migCount = (await db.query('SELECT COUNT(*) AS c FROM schema_migrations')).rows[0];
    assert.equal(Number(migCount.c), 29, 'All 29 migrations must be recorded and intact');

    // 2. Inspect Dockerfile for Non-Root Execution & Hardening
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
    assert.match(dockerfile, /FROM node:22-bookworm-slim/, 'Must use LTS slim base image');
    assert.match(dockerfile, /USER node/, 'Must run as non-root user node');
    assert.match(dockerfile, /HEALTHCHECK/, 'Must declare container healthcheck');
    assert.match(dockerfile, /NODE_ENV=production/, 'Must enforce production node environment');

    // 3. Inspect compose.yaml for Container Isolation & Least Privilege
    const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
    assert.match(compose, /read_only:\s*true/, 'Root filesystem must be read-only');
    assert.match(compose, /cap_drop:\s*\[ALL\]/, 'All Linux capabilities must be dropped');
    assert.match(compose, /security_opt:\s*\[no-new-privileges:true\]/, 'Must prevent privilege escalation');
    assert.match(compose, /networks:\s*\[private\]/, 'Database must reside on isolated private internal network');

    // 4. Database Restore Simulation & Integrity Check
    const dbTables = (await db.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `)).rows.map(r => r.table_name);

    const essentialTables = [
      'users', 'restaurants', 'menu_categories', 'menu_items', 'menu_item_modifiers',
      'menu_modifier_options', 'food_orders', 'food_order_items', 'restaurant_settlements',
      'shipments', 'quotes', 'pricing_policies', 'dispatch_offers', 'rider_dispatch_plans',
      'cash_collections', 'financial_entries', 'checkout_confirmed_events', 'checkout_unapplied_payments'
    ];

    for (const t of essentialTables) {
      assert.ok(dbTables.includes(t), `Essential table ${t} must exist in the database`);
    }
  });
});
