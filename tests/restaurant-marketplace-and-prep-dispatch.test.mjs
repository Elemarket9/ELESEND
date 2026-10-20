import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
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

let admin, businessOwner, otherBusiness, customer, rider;
let server, base;
const pw = 'Test-long-password-123!';

async function account(phone, kind = 'customer', extra = {}) {
  return app.register({phone, password: pw, kind, ...extra});
}

before(async () => {
  await migrate(db);
  await db.query('TRUNCATE users,pricing_policies,restaurants,menu_categories,menu_items,food_orders RESTART IDENTITY CASCADE');
  await resetDispatchFixtures(db);

  // Seed default 13% pricing policies
  await db.query(`INSERT INTO pricing_policies(id, vehicle, base_minor, per_km_minor, per_minute_minor, minimum_minor, commission_bps, active)
    VALUES (gen_random_uuid(), 'motorcycle', 1200, 320, 25, 2000, 1300, true)`);

  admin = await account('0208888001');
  await db.query("UPDATE users SET kind='admin' WHERE id=$1", [admin.id]);
  admin.kind = 'admin';
  for (const p of ['verification:write', 'pricing:write', 'shipments:read', 'dispatch:configure']) {
    await db.query('INSERT INTO permissions VALUES($1,$2)', [admin.id, p]);
  }

  businessOwner = await account('0208888002', 'business', {name: 'Mama Osu Kitchen'});
  otherBusiness = await account('0208888003', 'business', {name: 'Kumasi Chop Bar'});
  customer = await account('0208888004', 'customer');
  rider = await account('0208888005', 'rider');

  await app.approve(admin, 'riders', rider.id, 'approved');
  await app.availability(rider, {online: true});

  server = httpServer(db, app, dispatcher, null, null, {
    restaurant: restService,
    restaurantOrders: restOrderService
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  await new Promise(r => server.close(r));
  await db.close();
});

test('Restaurant Marketplace & Preparation-Aware Dispatch Suite', async t => {
  let mamaRestaurant, jollofItem, portionModifier, jumboOption, plantainOption;
  let foodQuoteResult, createdFoodOrder;

  await t.test('1. Restaurant registration, boundaries and role enforcement', async () => {
    // Customers cannot create restaurants
    await assert.rejects(
      () => restService.createRestaurant(customer, {
        name: 'Illegal Eatery',
        phone: '0241112233',
        address: 'Oxford Street, Osu',
        latitude: 5.5562,
        longitude: -0.1825
      }),
      {status: 403}
    );

    // Business owner registers restaurant in Accra
    mamaRestaurant = await restService.createRestaurant(businessOwner, {
      name: 'Mama Osu Kitchen',
      phone: '0241112233',
      address: '14 Oxford Street, Osu, Accra',
      latitude: 5.5562,
      longitude: -0.1825,
      prepTimeMinutes: 20,
      deliveryRadiusM: 12000,
      cuisine: 'Ghanaian & Grills'
    });

    assert.ok(mamaRestaurant.id);
    assert.equal(mamaRestaurant.name, 'Mama Osu Kitchen');
    assert.equal(mamaRestaurant.owner_id, businessOwner.id);
    assert.equal(mamaRestaurant.status, 'approved');
    assert.equal(mamaRestaurant.food_commission_bps, 1000); // 10% default
    assert.equal(mamaRestaurant.is_open, true);
    assert.equal(mamaRestaurant.is_paused, false);

    // Coordinate outside Ghana bounds must fail
    await assert.rejects(
      () => restService.createRestaurant(businessOwner, {
        name: 'Ocean Food',
        phone: '0241112233',
        address: 'Out in the Atlantic',
        latitude: 2.0,
        longitude: 0.0
      }),
      e => e.name === 'ZodError' || e.status === 400
    );
  });

  await t.test('2. Menu categories, items, modifiers and options configuration', async () => {
    // Create Category
    const cat = await restService.createCategory(businessOwner, mamaRestaurant.id, {
      name: 'Signature Rice Dishes',
      displayOrder: 1
    });
    assert.equal(cat.name, 'Signature Rice Dishes');

    // Other business cannot create items in Mama Osu Kitchen
    await assert.rejects(
      () => restService.createMenuItem(otherBusiness, mamaRestaurant.id, {
        categoryId: cat.id,
        name: 'Hacked Jollof',
        priceMinor: 3000
      }),
      {status: 403}
    );

    // Create Menu Item: Jollof Rice with Chicken (GH₵50.00 = 5000 pesewas, prep 20m)
    jollofItem = await restService.createMenuItem(businessOwner, mamaRestaurant.id, {
      categoryId: cat.id,
      name: 'Special Smokey Jollof Rice with Grilled Chicken',
      description: 'Authentic Ghanaian party jollof with spicy pepper sauce and tender grilled chicken',
      priceMinor: 5000,
      prepTimeMinutes: 25,
      isAvailable: true
    });
    assert.equal(jollofItem.price_minor, 5000);
    assert.equal(jollofItem.prep_time_minutes, 25);

    // Add Required Modifier: Portion Size (min 1, max 1)
    portionModifier = await restService.createModifier(businessOwner, jollofItem.id, {
      name: 'Choose Portion Size',
      minSelections: 1,
      maxSelections: 1,
      isRequired: true
    });
    assert.equal(portionModifier.is_required, true);

    // Add Options to Portion Size
    const regularOption = await restService.createModifierOption(businessOwner, portionModifier.id, {
      name: 'Regular Pack',
      priceMinor: 0
    });
    jumboOption = await restService.createModifierOption(businessOwner, portionModifier.id, {
      name: 'Jumbo Pack (+GH₵15.00)',
      priceMinor: 1500
    });
    assert.equal(jumboOption.price_minor, 1500);

    // Add Optional Modifier: Extras (min 0, max 2)
    const extrasModifier = await restService.createModifier(businessOwner, jollofItem.id, {
      name: 'Extra Add-ons',
      minSelections: 0,
      maxSelections: 2,
      isRequired: false
    });

    plantainOption = await restService.createModifierOption(businessOwner, extrasModifier.id, {
      name: 'Spicy Fried Plantain (Kelewele)',
      priceMinor: 1000
    });
    assert.equal(plantainOption.price_minor, 1000);

    // Retrieve hierarchical menu
    const menu = await restService.getMenu(mamaRestaurant.id);
    assert.equal(menu.categories.length, 1);
    assert.equal(menu.categories[0].items.length, 1);
    assert.equal(menu.categories[0].items[0].modifiers.length, 2);
    assert.equal(menu.categories[0].items[0].modifiers[0].options.length, 2);
  });

  await t.test('3. Exact integer quote with independent food commission & delivery fare', async () => {
    // Delivery to Airport Residential Area (~4.5km away)
    const quoteInput = {
      restaurantId: mamaRestaurant.id,
      items: [
        {
          itemId: jollofItem.id,
          quantity: 2,
          // 2x Jumbo Pack (+15.00 each) + Plantain (+10.00 each) = (50.00 + 15.00 + 10.00) * 2 = GH₵150.00
          options: [jumboOption.id, plantainOption.id]
        }
      ],
      deliveryAddress: 'Airport Residential, Accra',
      deliveryLatitude: 5.6021,
      deliveryLongitude: -0.1834,
      customerPhone: customer.phone,
      specialInstructions: 'Extra shito pepper sauce please'
    };

    foodQuoteResult = await restOrderService.quoteFoodOrder(customer, quoteInput);

    // Verify Food Subtotal: (5000 + 1500 + 1000) * 2 = 7500 * 2 = 15000 pesewas (GH₵150.00)
    assert.equal(foodQuoteResult.subtotalMinor, 15000);

    // Verify Independent Food Commission: 10% of 15000 = 1500 pesewas (GH₵15.00)
    assert.equal(foodQuoteResult.foodCommissionBps, 1000);
    assert.equal(foodQuoteResult.foodCommissionMinor, 1500);

    // Verify Delivery Fee & Delivery Commission (13% platform delivery commission)
    assert.ok(foodQuoteResult.deliveryFeeMinor > 0);
    assert.ok(foodQuoteResult.deliveryCommissionMinor > 0);
    assert.equal(
      foodQuoteResult.totalMinor,
      foodQuoteResult.subtotalMinor + foodQuoteResult.deliveryFeeMinor
    );

    // Verify prep time inherited
    assert.equal(foodQuoteResult.estimatedPrepMinutes, 25);
  });

  await t.test('4. Missing required modifier validation fails closed', async () => {
    await assert.rejects(
      () => restOrderService.quoteFoodOrder(customer, {
        restaurantId: mamaRestaurant.id,
        items: [
          {
            itemId: jollofItem.id,
            quantity: 1,
            options: [] // Missing required portion size
          }
        ],
        deliveryAddress: 'Airport Residential',
        deliveryLatitude: 5.6021,
        deliveryLongitude: -0.1834,
        customerPhone: customer.phone
      }),
      {status: 400}
    );
  });

  await t.test('5. Order placement creates shipment and food order atomically', async () => {
    createdFoodOrder = await restOrderService.createFoodOrder(customer, foodQuoteResult, {
      paymentMethod: 'CASH',
      specialInstructions: 'Gate code 4452'
    });

    assert.ok(createdFoodOrder.id);
    assert.equal(createdFoodOrder.state, 'SUBMITTED');
    assert.equal(createdFoodOrder.payment_method, 'CASH');
    assert.equal(createdFoodOrder.subtotal_minor, 15000);
    assert.equal(createdFoodOrder.food_commission_minor, 1500);
    assert.ok(createdFoodOrder.shipment_id);

    // Verify linked delivery shipment was created in AWAITING_ASSIGNMENT
    const shipmentRow = (await db.query('SELECT * FROM shipments WHERE id = $1', [createdFoodOrder.shipment_id])).rows[0];
    assert.ok(shipmentRow);
    assert.equal(shipmentRow.state, 'AWAITING_ASSIGNMENT');
  });

  await t.test('6. Kitchen acceptance & preparation-aware dispatch synchronization', async () => {
    // Restaurant owner accepts order with 25-minute prep time
    const accepted = await restOrderService.acceptOrder(businessOwner, createdFoodOrder.id, {
      estimatedPrepMinutes: 25
    });

    assert.equal(accepted.state, 'ACCEPTED');
    assert.ok(accepted.accepted_at);
    assert.ok(accepted.ready_at);

    // Verify that shipment.next_dispatch_at is delayed ~20 min into the future
    // (ready_at - 5 min buffer) so couriers don't wait fruitlessly at the restaurant
    const sh = (await db.query('SELECT * FROM shipments WHERE id = $1', [createdFoodOrder.shipment_id])).rows[0];
    const diffSeconds = (new Date(sh.next_dispatch_at).getTime() - new Date(accepted.accepted_at).getTime()) / 1000;
    assert.ok(diffSeconds >= 1150 && diffSeconds <= 1250); // ~1200s = 20 minutes

    // Start preparing
    const prep = await restOrderService.startPreparing(businessOwner, createdFoodOrder.id);
    assert.equal(prep.state, 'PREPARING');

    // Mark ready for pickup -> triggers immediate priority dispatch
    const ready = await restOrderService.markReadyForPickup(businessOwner, createdFoodOrder.id);
    assert.equal(ready.state, 'READY_FOR_PICKUP');

    const shReady = (await db.query('SELECT * FROM shipments WHERE id = $1', [createdFoodOrder.shipment_id])).rows[0];
    // next_dispatch_at was reset to immediate now()
    assert.ok(new Date(shReady.next_dispatch_at).getTime() <= Date.now() + 1000);
  });

  await t.test('7. Rider assignment, OTP pickup and OTP delivery sync with food order', async () => {
    // Position rider near restaurant in Osu
    await dispatcher.riderPosition(rider, {
      latitude: 5.5565,
      longitude: -0.1820,
      accuracyMeters: 10,
      observedAt: new Date().toISOString()
    });

    // Dispatch shipment
    const offer = await dispatcher.dispatchShipment(createdFoodOrder.shipment_id);
    assert.equal(offer.status, 'offered');

    // Rider accepts delivery offer
    await app.accept(rider, createdFoodOrder.shipment_id, offer.offerId);

    // Rider requests pickup OTP challenge from restaurant
    const pickupChallenge = await app.challenge(rider, createdFoodOrder.shipment_id, 'pickup');
    assert.ok(pickupChallenge.challengeId);
    const pickupSms = messages.at(-1);

    // Verify pickup OTP (no cash collection required at kitchen for recipient cash delivery)
    await app.verify(rider, createdFoodOrder.shipment_id, {
      challengeId: pickupChallenge.challengeId,
      code: pickupSms.code
    });

    // Verify food order transitioned to IN_TRANSIT
    const foodInTransit = (await db.query('SELECT state FROM food_orders WHERE id = $1', [createdFoodOrder.id])).rows[0];
    assert.equal(foodInTransit.state, 'IN_TRANSIT');

    // Rider arrives at customer, transitions to AWAITING_DELIVERY_OTP
    await app.transition(rider, createdFoodOrder.shipment_id, {action: 'start'});

    // Delivery challenge
    const deliveryChallenge = await app.challenge(rider, createdFoodOrder.shipment_id, 'delivery');
    const deliverySms = messages.at(-1);

    // Rider collects full cash from recipient at handover
    await db.query(
      `INSERT INTO cash_collections(shipment_id, rider_id, reported_minor, cash_payer, reported_status, report_idempotency_key)
       VALUES($1, $2, $3, 'recipient', 'reported_full', $4)`,
      [createdFoodOrder.shipment_id, rider.id, createdFoodOrder.delivery_fee_minor, randomUUID()]
    );

    // Confirm delivery OTP
    await app.verify(rider, createdFoodOrder.shipment_id, {
      challengeId: deliveryChallenge.challengeId,
      code: deliverySms.code
    });

    // Verify food order transitioned to DELIVERED atomically
    const foodDelivered = (await db.query('SELECT state, completed_at, payment_status FROM food_orders WHERE id = $1', [createdFoodOrder.id])).rows[0];
    assert.equal(foodDelivered.state, 'DELIVERED');
    assert.equal(foodDelivered.payment_status, 'PAID');
    assert.ok(foodDelivered.completed_at);

    // Verify independent restaurant settlement row created
    const settlement = (await db.query('SELECT * FROM restaurant_settlements WHERE order_id = $1', [createdFoodOrder.id])).rows[0];
    assert.ok(settlement);
    assert.equal(settlement.restaurant_id, mamaRestaurant.id);
    assert.equal(settlement.gross_sales_minor, 15000);
    assert.equal(settlement.commission_bps, 1000); // 10%
    assert.equal(settlement.commission_minor, 1500); // GH₵15.00
    assert.equal(settlement.net_payable_minor, 13500); // GH₵135.00
    assert.equal(settlement.status, 'accrued');
  });

  await t.test('8. HTTP endpoints authorization and data contracts', async () => {
    const custLogin = await app.login({phone: customer.phone, password: pw});
    const bizLogin = await app.login({phone: businessOwner.phone, password: pw});

    // Public/customer lists restaurants
    const resList = await fetch(`${base}/api/v1/restaurants?lat=5.55&lon=-0.18`, {
      headers: {Authorization: `Bearer ${custLogin.token}`}
    });
    assert.equal(resList.status, 200);
    const listBody = await resList.json();
    assert.ok(Array.isArray(listBody));
    assert.ok(listBody.some(r => r.name === 'Mama Osu Kitchen'));

    // Restaurant menu endpoint
    const resMenu = await fetch(`${base}/api/v1/restaurants/${mamaRestaurant.id}/menu`, {
      headers: {Authorization: `Bearer ${custLogin.token}`}
    });
    assert.equal(resMenu.status, 200);
    const menuBody = await resMenu.json();
    assert.ok(menuBody.categories.length >= 1);

    // Restaurant settlements endpoint (business owner only)
    const resSettleCust = await fetch(`${base}/api/v1/restaurants/${mamaRestaurant.id}/settlements`, {
      headers: {Authorization: `Bearer ${custLogin.token}`}
    });
    assert.equal(resSettleCust.status, 403); // Customer blocked

    const resSettleBiz = await fetch(`${base}/api/v1/restaurants/${mamaRestaurant.id}/settlements`, {
      headers: {Authorization: `Bearer ${bizLogin.token}`}
    });
    assert.equal(resSettleBiz.status, 200);
    const settleBody = await resSettleBiz.json();
    assert.equal(settleBody.totals.grossSalesMinor, 15000);
    assert.equal(settleBody.totals.commissionMinor, 1500);
    assert.equal(settleBody.totals.netPayableMinor, 13500);
  });
});
