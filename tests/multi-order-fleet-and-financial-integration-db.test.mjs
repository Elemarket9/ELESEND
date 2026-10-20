import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {database} from '../services/api/db.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {platform} from '../services/api/platform.mjs';
import {dispatchEngine} from '../services/api/dispatch.mjs';
import {financeService} from '../services/api/finance.mjs';
import {vehicleService} from '../services/api/vehicle.mjs';
import {fixtureRouting} from '../services/api/dispatch-routing.mjs';
import {candidateInsertions,evaluateStops,bestInsertion,freshStops,weightCapacityValid} from '../services/api/multi-parcel.mjs';
import {resetDispatchFixtures} from './helpers/reset-dispatch-fixtures.mjs';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^elesend_test(?:_|$)/.test(new URL(url).pathname.slice(1))) {
  throw Error('Dedicated disposable elesend_test database is mandatory');
}

const db = database(url);
const sms = [];
const router = fixtureRouting(async (a, b) => ({
  durationSeconds: Math.ceil((Math.abs(a.latitude - b.latitude) + Math.abs(a.longitude - b.longitude)) * 18000) + 5,
  distanceMeters: Math.ceil((Math.abs(a.latitude - b.latitude) + Math.abs(a.longitude - b.longitude)) * 62000) + 10,
  geometry: { type: 'LineString', coordinates: [[a.longitude, a.latitude], [b.longitude, b.latitude]] }
}));

const dispatcher = dispatchEngine(db, { routing: router });
const app = platform(db, {
  otpKey: randomBytes(32).toString('hex'),
  routing: router,
  dispatch: dispatcher,
  sms: { async send(v) { sms.push(v); } }
});
const finance = financeService(db);
const vehicle = vehicleService(db);

const pass = 'Synthetic-benchmark-password-44!';
const P = (lat, lon, addr = 'Accra Test Point') => ({ address: addr, latitude: lat, longitude: lon });

async function createUser(phoneSuffix, kind = 'customer', extra = {}) {
  return app.register({ phone: '024009' + String(phoneSuffix).padStart(4, '0'), password: pass, kind, ...extra });
}

async function createPaidShipment(sender, pickup, dest, weightG, opts = {}) {
  const q = await app.quote(sender, {
    pickup,
    destination: dest,
    weightG,
    parcelCategory: 'general',
    parcelSize: 'small',
    recipientPhone: '0240099999',
    description: 'Test parcel',
    ...opts
  });
  const sh = await app.book(sender, { quoteId: q.id }, randomUUID());
  if (opts.paymentMethod !== 'CASH') {
    await app.paymentConfirmed({
      provider: 'synthetic-test-only',
      eventId: randomUUID(),
      shipmentId: sh.id,
      amountMinor: sh.amount_minor,
      currency: 'GHS'
    });
  }
  return { ...sh, quote: q };
}

async function completeHandover(rider, shipmentId, kind) {
  const ch = await app.challenge(rider, shipmentId, kind);
  const one = sms.at(-1);
  assert.equal(one.challengeId, ch.challengeId);
  await app.verify(rider, shipmentId, { challengeId: ch.challengeId, code: one.code });
}

test('Multi-order, Multi-stop & Financial Integration Suite', async (suite) => {
  let admin, carRider, customerSender, merchantSender;

  suite.before(async () => {
    await migrate(db);
    await db.query('TRUNCATE users, pricing_policies, pricing_surge_zones RESTART IDENTITY CASCADE');
    await resetDispatchFixtures(db);

    admin = await createUser(1, 'customer');
    await db.query("UPDATE users SET kind='admin' WHERE id=$1", [admin.id]);
    admin.kind = 'admin';
    await db.query("INSERT INTO permissions VALUES($1,'verification:write'),($1,'pricing:write'),($1,'dispatch:configure'),($1,'finance:configure'),($1,'finance:read') ON CONFLICT DO NOTHING", [admin.id]);
    await app.setPricing(admin, { baseMinor: 2000, perKmMinor: 150, commissionBps: 300 });

    customerSender = await createUser(2, 'customer');
    merchantSender = await createUser(3, 'business', { name: 'Accra Retail Mart Ltd' });

    carRider = await createUser(4, 'rider', {
      vehicle: 'car',
      maxWeightG: 8000,
      car: { plateNumber: 'GW 8821-26', make: 'Toyota', model: 'Vitz', color: 'Blue' }
    });
    await app.approve(admin, 'riders', carRider.id, 'approved');
    await vehicle.review(admin, carRider.id, { status: 'approved' });
    await app.availability(carRider, { online: true });
    await dispatcher.riderPosition(carRider, { latitude: 5.600, longitude: -0.200, accuracyMeters: 5, observedAt: new Date().toISOString() });

    const p = await dispatcher.getPolicy(admin);
    await dispatcher.configure(admin, {
      searchRadiiM: p.search_radii_m,
      candidateLimit: p.candidate_limit,
      freshSeconds: p.fresh_seconds,
      maxSampleAgeSeconds: p.max_sample_age_seconds,
      maxAccuracyM: p.max_accuracy_m,
      maxSpeedMps: p.max_speed_mps,
      offerSeconds: 30,
      retrySeconds: 30,
      maxAttempts: 10,
      sampleRetentionHours: 24,
      movingUploadSeconds: 15,
      idleUploadSeconds: 60,
      multiStopEnabled: true,
      maxActiveParcels: 3,
      maxDetourSeconds: 1200,
      deliverySlackSeconds: 1800,
      maxPickupEtaSeconds: 2400,
      maxOfferMovementM: 300
    });
    await dispatcher.optIn(carRider, { enabled: true });
  });

  suite.after(async () => {
    await db.close();
  });

  await suite.test('1. Independent customer and merchant deliveries safely group into one rider trip', async () => {
    const custOrder = await createPaidShipment(
      customerSender,
      P(5.602, -0.198, 'Customer Home'),
      P(5.610, -0.190, 'Customer Delivery'),
      1200
    );

    const merchOrder = await createPaidShipment(
      merchantSender,
      P(5.604, -0.196, 'Merchant Warehouse'),
      P(5.615, -0.185, 'Merchant Client Drop'),
      1800
    );

    const o1 = await dispatcher.dispatchShipment(custOrder.id);
    assert.equal(o1.status, 'offered');
    assert.equal(o1.riderId, carRider.id);
    await app.accept(carRider, custOrder.id, o1.offerId);

    const o2 = await dispatcher.dispatchShipment(merchOrder.id);
    assert.equal(o2.status, 'offered');
    assert.equal(o2.riderId, carRider.id);
    await app.accept(carRider, merchOrder.id, o2.offerId);

    const manifest = await dispatcher.manifest(carRider);
    assert.equal(manifest.shipments.length, 2, 'Rider must have 2 active shipments');
    assert.equal(manifest.stops.length, 4, 'Manifest must have 4 stops (2 pickups, 2 drops)');

    const customerView = await app.get(customerSender, custOrder.id);
    assert.equal(customerView.id, custOrder.id);
    await assert.rejects(() => app.get(customerSender, merchOrder.id), (err) => err.status === 403 || err.status === 404);

    const merchantView = await app.get(merchantSender, merchOrder.id);
    assert.equal(merchantView.id, merchOrder.id);
    await assert.rejects(() => app.get(merchantSender, custOrder.id), (err) => err.status === 403 || err.status === 404);

    // Complete all manifest stops dynamically
    for (const stop of manifest.stops) {
      if (stop.kind === 'pickup') {
        await completeHandover(carRider, stop.shipmentId, 'pickup');
        await app.transition(carRider, stop.shipmentId, { action: 'start' });
      } else {
        await completeHandover(carRider, stop.shipmentId, 'delivery');
      }
    }
    assert.equal((await app.get(customerSender, custOrder.id)).state, 'COMPLETED');
    assert.equal((await app.get(merchantSender, merchOrder.id)).state, 'COMPLETED');
    assert.equal((await dispatcher.manifest(carRider)).stops.length, 0);
  });

  await suite.test('2. Topology routing verification: 1-to-1, 1-to-many, many-to-1, many-to-many', async () => {
    const start = P(5.600, -0.200);

    // 2.1 One-to-One: 1 pickup -> 1 dropoff
    const oneToOneStops = freshStops('S1', { pickup: P(5.602, -0.198), destination: P(5.610, -0.190), weightG: 1000 });
    const eval1to1 = await evaluateStops(router, start, oneToOneStops, { vehicle: 'car', capacityG: 5000 });
    assert.ok(eval1to1);
    assert.equal(eval1to1.stops[0].kind, 'pickup');
    assert.equal(eval1to1.stops[1].kind, 'dropoff');

    // 2.2 One-to-Many: 1 pickup location (Merchant Depot) -> 2 separate customer dropoffs
    const depot = P(5.601, -0.199, 'Central Warehouse');
    const dropA = P(5.608, -0.192, 'Client A');
    const dropB = P(5.612, -0.188, 'Client B');
    const oneToManyBase = freshStops('ParcelA', { pickup: depot, destination: dropA, weightG: 1000 });
    const parcelBStops = freshStops('ParcelB', { pickup: depot, destination: dropB, weightG: 1500 });
    const oneToManyInserted = await bestInsertion(router, start, oneToManyBase, parcelBStops, {
      vehicle: 'car',
      capacityG: 5000,
      maxDetourSeconds: 1200
    });
    assert.ok(oneToManyInserted);
    const pAIdx = oneToManyInserted.stops.findIndex(s => s.shipmentId === 'ParcelA' && s.kind === 'pickup');
    const dAIdx = oneToManyInserted.stops.findIndex(s => s.shipmentId === 'ParcelA' && s.kind === 'dropoff');
    const pBIdx = oneToManyInserted.stops.findIndex(s => s.shipmentId === 'ParcelB' && s.kind === 'pickup');
    const dBIdx = oneToManyInserted.stops.findIndex(s => s.shipmentId === 'ParcelB' && s.kind === 'dropoff');
    assert.ok(pAIdx < dAIdx, 'Parcel A pickup must precede dropoff');
    assert.ok(pBIdx < dBIdx, 'Parcel B pickup must precede dropoff');

    // 2.3 Many-to-One: 2 customer pickups -> 1 central return / consolidation hub
    const hub = P(5.620, -0.180, 'Consolidation Hub');
    const pick1 = P(5.602, -0.198, 'Customer 1');
    const pick2 = P(5.604, -0.196, 'Customer 2');
    const m2oBase = freshStops('Return1', { pickup: pick1, destination: hub, weightG: 800 });
    const return2Stops = freshStops('Return2', { pickup: pick2, destination: hub, weightG: 1200 });
    const m2oInserted = await bestInsertion(router, start, m2oBase, return2Stops, {
      vehicle: 'car',
      capacityG: 5000,
      maxDetourSeconds: 1200
    });
    assert.ok(m2oInserted);
    const r1P = m2oInserted.stops.findIndex(s => s.shipmentId === 'Return1' && s.kind === 'pickup');
    const r1D = m2oInserted.stops.findIndex(s => s.shipmentId === 'Return1' && s.kind === 'dropoff');
    const r2P = m2oInserted.stops.findIndex(s => s.shipmentId === 'Return2' && s.kind === 'pickup');
    const r2D = m2oInserted.stops.findIndex(s => s.shipmentId === 'Return2' && s.kind === 'dropoff');
    assert.ok(r1P < r1D && r2P < r2D, 'Each return must be picked up before hub delivery');

    // 2.4 Capacity & Precedence Validation
    assert.equal(weightCapacityValid(m2oInserted.stops, [], 1500), false, 'Must reject when combined weight exceeds capacity');
    const reversedStops = [
      { shipmentId: 'X', kind: 'dropoff', weightG: 500, latitude: 5.6, longitude: -0.2 },
      { shipmentId: 'X', kind: 'pickup', weightG: 500, latitude: 5.6, longitude: -0.2 }
    ];
    assert.equal(weightCapacityValid(reversedStops, [], 5000), false, 'Dropoff before pickup must be rejected');
  });

  await suite.test('3. Independent custody, cash collection, commission calculation, and settlement', async () => {
    await dispatcher.riderPosition(carRider, { latitude: 5.600, longitude: -0.200, accuracyMeters: 5, observedAt: new Date().toISOString() });

    const cashOrder = await createPaidShipment(
      customerSender,
      P(5.601, -0.199),
      P(5.609, -0.191),
      1000,
      { paymentMethod: 'CASH', cashPayer: 'recipient' }
    );
    const digitalOrder = await createPaidShipment(
      merchantSender,
      P(5.603, -0.197),
      P(5.611, -0.189),
      1500
    );

    const o1 = await dispatcher.dispatchShipment(cashOrder.id);
    assert.equal(o1.status, 'offered');
    await app.accept(carRider, cashOrder.id, o1.offerId);

    const o2 = await dispatcher.dispatchShipment(digitalOrder.id);
    assert.equal(o2.status, 'offered');
    await app.accept(carRider, digitalOrder.id, o2.offerId);

    const manifest = await dispatcher.manifest(carRider);
    assert.equal(manifest.stops.length, 4);

    // Follow manifest stop order dynamically
    for (const stop of manifest.stops) {
      if (stop.kind === 'pickup') {
        await completeHandover(carRider, stop.shipmentId, 'pickup');
        await app.transition(carRider, stop.shipmentId, { action: 'start' });
      } else {
        const sh = await app.get(carRider, stop.shipmentId);
        if (sh.payment_method === 'CASH') {
          await finance.reportCash(carRider, stop.shipmentId, {
            reportedMinor: sh.amount_minor,
            cashPayer: sh.cash_payer,
            idempotencyKey: randomUUID()
          });
        }
        await completeHandover(carRider, stop.shipmentId, 'delivery');
      }
    }

    assert.equal((await app.get(customerSender, cashOrder.id)).state, 'COMPLETED');
    assert.equal((await app.get(merchantSender, digitalOrder.id)).state, 'COMPLETED');

    // Check financial ledger lines:
    const cashJournal = (await db.query("SELECT * FROM finance_journals WHERE shipment_id=$1 AND kind='cash_commission'", [cashOrder.id])).rows[0];
    assert.ok(cashJournal, 'Cash order must create cash_commission journal');
    const cashLines = (await db.query("SELECT * FROM finance_lines WHERE journal_id=$1", [cashJournal.id])).rows;
    assert.equal(cashLines.length, 2);
    const commissionMinor = Math.round(Number(cashOrder.amount_minor) * 0.03);
    assert.equal(Number(cashLines[0].amount_minor), commissionMinor);

    const cashEntries = (await db.query("SELECT * FROM financial_entries WHERE shipment_id=$1", [cashOrder.id])).rows;
    assert.equal(cashEntries.length, 1);
    assert.equal(Number(cashEntries[0].commission_minor), commissionMinor);

    // Digital order: 3% commission in financial_entries
    const digitalEntries = (await db.query("SELECT * FROM financial_entries WHERE shipment_id=$1", [digitalOrder.id])).rows;
    assert.equal(digitalEntries.length, 1);
    assert.equal(Number(digitalEntries[0].commission_minor), Number(digitalOrder.quote.commission_minor));
  });

  await suite.test('4. Partial delivery failure and dispute isolation in multi-order trip', async () => {
    await dispatcher.riderPosition(carRider, { latitude: 5.600, longitude: -0.200, accuracyMeters: 5, observedAt: new Date().toISOString() });

    const orderA = await createPaidShipment(customerSender, P(5.602, -0.198), P(5.608, -0.192), 1000);
    const orderB = await createPaidShipment(customerSender, P(5.603, -0.197), P(5.612, -0.188), 1200);

    const oA = await dispatcher.dispatchShipment(orderA.id);
    assert.equal(oA.status, 'offered');
    await app.accept(carRider, orderA.id, oA.offerId);

    const oB = await dispatcher.dispatchShipment(orderB.id);
    assert.equal(oB.status, 'offered');
    await app.accept(carRider, orderB.id, oB.offerId);

    const manifest = await dispatcher.manifest(carRider);
    assert.equal(manifest.stops.length, 4);

    // Perform pickups for both orders in manifest sequence
    for (const stop of manifest.stops) {
      if (stop.kind === 'pickup') {
        await completeHandover(carRider, stop.shipmentId, 'pickup');
        await app.transition(carRider, stop.shipmentId, { action: 'start' });
      }
    }

    // Determine dropoff order from current manifest
    const currentManifest = await dispatcher.manifest(carRider);
    const firstDrop = currentManifest.stops[0];
    const secondDrop = currentManifest.stops[1];

    // If first drop is orderA, deliver orderA, then fail orderB
    if (firstDrop.shipmentId === orderA.id) {
      await completeHandover(carRider, orderA.id, 'delivery');
      assert.equal((await app.get(customerSender, orderA.id)).state, 'COMPLETED');

      await app.dispute(customerSender, orderB.id, {
        category: 'other',
        detail: 'Recipient phone was unreachable after 15 minutes of attempts.'
      });
      await app.transition(carRider, orderB.id, {
        action: 'fail',
        reason: 'Recipient phone unreachable at destination'
      });
    } else {
      // If first drop is orderB, fail orderB, then deliver orderA
      await app.dispute(customerSender, orderB.id, {
        category: 'other',
        detail: 'Recipient phone was unreachable after 15 minutes of attempts.'
      });
      await app.transition(carRider, orderB.id, {
        action: 'fail',
        reason: 'Recipient phone unreachable at destination'
      });
      await completeHandover(carRider, orderA.id, 'delivery');
      assert.equal((await app.get(customerSender, orderA.id)).state, 'COMPLETED');
    }

    const failedB = await app.get(customerSender, orderB.id);
    assert.equal(failedB.state, 'FAILED');
    assert.equal((await app.get(customerSender, orderA.id)).state, 'COMPLETED');

    // Financial isolation check:
    const entriesA = (await db.query("SELECT * FROM financial_entries WHERE shipment_id=$1", [orderA.id])).rows;
    assert.equal(entriesA.length, 1);
    const entriesB = (await db.query("SELECT * FROM financial_entries WHERE shipment_id=$1", [orderB.id])).rows;
    assert.equal(entriesB.length, 0, 'Failed order must not create completion earnings or platform commission');

    // Complete return cycle for Order B
    await app.transition(carRider, orderB.id, { action: 'return', reason: 'Returning goods to pickup location' });
    assert.equal((await app.get(customerSender, orderB.id)).state, 'RETURN_REQUESTED');
    await app.transition(carRider, orderB.id, { action: 'returned', reason: 'Returned parcel handed back to sender' });
    assert.equal((await app.get(customerSender, orderB.id)).state, 'RETURNED');
  });

  await suite.test('5. Concurrent rider acceptance and duplicate payment event protection', async () => {
    await dispatcher.riderPosition(carRider, { latitude: 5.600, longitude: -0.200, accuracyMeters: 5, observedAt: new Date().toISOString() });

    const secondRider = await createUser(5, 'rider', {
      vehicle: 'car',
      maxWeightG: 8000,
      car: { plateNumber: 'GS 9912-26', make: 'Honda', model: 'Civic', color: 'Silver' }
    });
    await app.approve(admin, 'riders', secondRider.id, 'approved');
    await vehicle.review(admin, secondRider.id, { status: 'approved' });
    await app.availability(secondRider, { online: true });
    await dispatcher.riderPosition(secondRider, { latitude: 5.601, longitude: -0.201, accuracyMeters: 5, observedAt: new Date().toISOString() });

    await dispatcher.setAlgorithmFeature(admin, { featureKey: 'multi_rider_broadcast', enabled: true });

    const job = await createPaidShipment(customerSender, P(5.605, -0.195), P(5.615, -0.185), 900);
    const broadcast = await dispatcher.dispatchShipment(job.id);
    assert.equal(broadcast.status, 'offered');
    assert.equal(broadcast.offerCount, 2);

    const offer1 = (await app.offers(carRider)).find(o => o.id === job.id);
    const offer2 = (await app.offers(secondRider)).find(o => o.id === job.id);
    assert.ok(offer1 && offer2);

    // Race both accepts concurrently
    const race = await Promise.allSettled([
      app.accept(carRider, job.id, offer1.offerId),
      app.accept(secondRider, job.id, offer2.offerId)
    ]);
    const fulfilled = race.filter(r => r.status === 'fulfilled');
    const rejected = race.filter(r => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'Exactly one acceptance must win');
    assert.equal(rejected.length, 1, 'Second concurrent acceptance must fail');

    // Duplicate payment event check on dedicated booked shipment:
    const unpaidQuote = await app.quote(customerSender, {
      pickup: P(5.602, -0.198),
      destination: P(5.608, -0.192),
      weightG: 500,
      recipientPhone: '0240099999',
      description: 'Payment dedup test'
    });
    const unpaidShipment = await app.book(customerSender, { quoteId: unpaidQuote.id }, randomUUID());
    const eventId = randomUUID();
    const pay1 = await app.paymentConfirmed({
      provider: 'synthetic-test-only',
      eventId,
      shipmentId: unpaidShipment.id,
      amountMinor: unpaidShipment.amount_minor,
      currency: 'GHS'
    });
    assert.equal(pay1.ok, true);
    const pay2 = await app.paymentConfirmed({
      provider: 'synthetic-test-only',
      eventId,
      shipmentId: unpaidShipment.id,
      amountMinor: unpaidShipment.amount_minor,
      currency: 'GHS'
    });
    assert.equal(pay2.duplicate, true, 'Duplicate payment event must be recognized as duplicate');
  });
});
