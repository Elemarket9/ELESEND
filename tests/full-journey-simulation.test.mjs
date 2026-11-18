import test from 'node:test';
import assert from 'node:assert/strict';
const url = process.env.TEST_DATABASE_URL;

// Real parcel and food journeys from quote to payout, through the HTTP API (scripts/full-journey-simulation.mjs).
// It found three faults: motorbike quotes for parcels no motorbike can carry, motorbike quotes for Accra to
// Kumasi, and food orders more than about 3 km from the kitchen that no rider could ever be offered.
test('parcel and food journeys complete with sensible prices and ETAs', {skip: !url, timeout: 180000}, async () => {
  assert.match(new URL(url).pathname, /^\/elesend_test/);
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const {runFullJourneys} = await import('../scripts/full-journey-simulation.mjs');
  const {withSimulationDatabase} = await import('../scripts/local-simulation-support.mjs');
  try {
    // A fresh database, so tariffs and switches other tests change cannot leak in.
    const report = await withSimulationDatabase(runFullJourneys);
    assert.deepEqual(report.checks.filter(c => !c.ok), []);
    assert.equal(report.parcels.length, 6);
    assert.equal(report.food.length, 2);
    const refused = Object.fromEntries(report.refused.map(r => [r.name, r]));
    assert.match(refused['40 kg on a motorbike'].message, /too heavy for a motorbike.*(?:car|tricycle|pickup|truck)/i);
    assert.match(refused['Accra to Kumasi on a motorbike'].message, /beyond this motorbike's 80 km limit.*(?:car|pickup|van|truck)/i);
    assert.ok(report.food.every(f => f.status.at(-1) === 'delivered: DELIVERED'), 'both kitchens deliver, including 5 km away');
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test('staff can change a vehicle\'s weight and trip limits', {skip: !url}, async () => {
  const {database} = await import('../services/api/shared/db.mjs');
  const {migrate} = await import('../scripts/migrate.mjs');
  const {dispatchEngine} = await import('../services/api/modules/orders/dispatch.mjs');
  const {fixtureRouting} = await import('../services/api/modules/maps/osrm-routing.mjs');
  const {randomUUID} = await import('node:crypto');
  const db = database(url);
  try {
    await migrate(db);
    const admin = randomUUID();
    await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'test-only','admin',now())", [admin, '+2332' + String(Date.now()).slice(-8)]);
    await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'dispatch:configure')", [admin]);
    const dispatch = dispatchEngine(db, {routing: fixtureRouting(async () => ({distanceMeters: 1000, durationSeconds: 120}))});
    const actor = {id: admin, kind: 'admin'};
    const before = (await db.query("SELECT * FROM vehicle_capabilities WHERE vehicle='motorcycle'")).rows[0];
    const base = {vehicle: 'motorcycle', maxParcelSize: before.max_parcel_size, allowedCategories: before.allowed_categories, enabled: before.enabled};
    try {
      await dispatch.setVehiclePolicy(actor, {...base, maxWeightG: 30000, maxTripKm: 60});
      let row = (await db.query("SELECT max_weight_g,max_trip_m FROM vehicle_capabilities WHERE vehicle='motorcycle'")).rows[0];
      assert.deepEqual(row, {max_weight_g: 30000, max_trip_m: 60000});
      await dispatch.setVehiclePolicy(actor, base);
      row = (await db.query("SELECT max_weight_g,max_trip_m FROM vehicle_capabilities WHERE vehicle='motorcycle'")).rows[0];
      assert.deepEqual(row, {max_weight_g: 30000, max_trip_m: 60000}, 'leaving a limit out keeps it');
      await dispatch.setVehiclePolicy(actor, {...base, maxTripKm: null});
      assert.equal((await db.query("SELECT max_trip_m FROM vehicle_capabilities WHERE vehicle='motorcycle'")).rows[0].max_trip_m, null, 'null removes it');
    } finally {
      await db.query("UPDATE vehicle_capabilities SET max_weight_g=$1,max_trip_m=$2 WHERE vehicle='motorcycle'", [before.max_weight_g, before.max_trip_m]);
    }
  } finally {
    await db.close();
  }
});

// Other people's orders, money on cancellations and refunds, two requests at once, riders dropping out and bad
// input (scripts/audit-simulation.mjs). It found a rider who went offline with a parcel could no longer share
// location, so the customer lost tracking; the 12-hour limit did the same mid-delivery; and kitchen actions told
// strangers an order's state before checking who was asking.
test('the audit cases all behave safely', {skip: !url, timeout: 240000}, async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const {runAudit} = await import('../scripts/audit-simulation.mjs');
  const {withSimulationDatabase} = await import('../scripts/local-simulation-support.mjs');
  try {
    const report = await withSimulationDatabase(runAudit);
    assert.deepEqual(report.failures, []);
    assert.ok(report.total >= 60, `only ${report.total} cases ran`);
  } finally {
    process.env.NODE_ENV = previous;
  }
});

// Every route signed out, every admin route as everyone else, junk input everywhere, and targeted attacks on
// sign-in, sessions, SMS cost, API keys, uploads, webhooks, headers, chat, ratings and money
// (scripts/security-audit-simulation.mjs). It found the chat policy readable by an admin with no permissions.
test('the security sweep finds nothing open', {skip: !url, timeout: 600000}, async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const {runSecurityAudit} = await import('../scripts/security-audit-simulation.mjs');
  const {withSimulationDatabase} = await import('../scripts/local-simulation-support.mjs');
  try {
    const report = await withSimulationDatabase(runSecurityAudit);
    assert.deepEqual(report.failures, []);
    assert.ok(report.routes >= 250, `only ${report.routes} routes found; the route reader may have broken`);
    assert.ok(report.total >= 85, `only ${report.total} checks ran`);
  } finally {
    process.env.NODE_ENV = previous;
  }
});
