import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {database} from '../services/api/db.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {calculateQuote} from '../services/api/pricing.mjs';
import {commissionEngine, calculateCommissionBreakdown} from '../services/api/commission-engine.mjs';
import {platform} from '../services/api/platform.mjs';
import {fixtureRouting} from '../services/api/dispatch-routing.mjs';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^elesend_test(?:_|$)/.test(new URL(url).pathname.slice(1))) {
  throw Error('Dedicated disposable elesend_test database is mandatory');
}

const db = database(url);
const engine = commissionEngine(db);
const router = fixtureRouting(async (a, b) => ({
  durationSeconds: 300,
  distanceMeters: 3000,
  geometry: { type: 'LineString', coordinates: [[a.longitude, a.latitude], [b.longitude, b.latitude]] }
}));
const app = platform(db, {
  otpKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  routing: router
});

const adminActor = { id: randomUUID(), kind: 'admin' };
const riderActor = { id: randomUUID(), kind: 'rider' };
const customerActor = { id: randomUUID(), kind: 'customer' };

test.before(async () => {
  await migrate(db);
  // Ensure test admin exists in DB for foreign key references
  const res = await db.query(`
    INSERT INTO users (id, phone, password_hash, kind)
    VALUES ($1, '+233240999001', 'hash_test', 'admin')
    ON CONFLICT (phone) DO UPDATE SET kind = 'admin'
    RETURNING id
  `, [adminActor.id]);
  adminActor.id = res.rows[0].id;

  // Clear commission rules and logs for deterministic test isolation
  await db.query('DELETE FROM commission_audit_logs; DELETE FROM commission_rules;');
  // Ensure an active global policy at standard 13% (1300 bps)
  await db.query('UPDATE pricing_policies SET active = false WHERE active AND vehicle IS NULL');
  await db.query('INSERT INTO pricing_policies (id, base_minor, per_km_minor, commission_bps, active) VALUES ($1, 2000, 150, 1300, true)', [randomUUID()]);
});

test('Dynamic Commission Engine — 0.00% to 100.00% Inclusive Arithmetic', () => {
  // 1. 0.00% (0 bps): Rider receives 100%, platform takes 0
  const zeroComm = calculateCommissionBreakdown(5000, 0);
  assert.equal(zeroComm.commissionMinor, 0);
  assert.equal(zeroComm.netEarningsMinor, 5000);
  assert.equal(zeroComm.amountMinor, 5000);

  // 2. 0.01% (1 bps): Deterministic pesewa rounding
  const microComm = calculateCommissionBreakdown(10000, 1);
  assert.equal(microComm.commissionMinor, 1);
  assert.equal(microComm.netEarningsMinor, 9999);

  // 3. 3.00% (300 bps): Historical rate test
  const threeComm = calculateCommissionBreakdown(3000, 300);
  assert.equal(threeComm.commissionMinor, 90);
  assert.equal(threeComm.netEarningsMinor, 2910);

  // 4. 10.00% (1,000 bps): Default restaurant food rate
  const tenComm = calculateCommissionBreakdown(8000, 1000);
  assert.equal(tenComm.commissionMinor, 800);
  assert.equal(tenComm.netEarningsMinor, 7200);

  // 5. 13.00% (1,300 bps): Default delivery rate
  const thirteenComm = calculateCommissionBreakdown(3000, 1300);
  assert.equal(thirteenComm.commissionMinor, 390);
  assert.equal(thirteenComm.netEarningsMinor, 2610);

  // 6. 20.00% (2,000 bps): Former upper ceiling
  const twentyComm = calculateCommissionBreakdown(4000, 2000);
  assert.equal(twentyComm.commissionMinor, 800);
  assert.equal(twentyComm.netEarningsMinor, 3200);

  // 7. 50.00% (5,000 bps): High rate
  const fiftyComm = calculateCommissionBreakdown(10000, 5000);
  assert.equal(fiftyComm.commissionMinor, 5000);
  assert.equal(fiftyComm.netEarningsMinor, 5000);

  // 8. 99.99% (9,999 bps): Upper edge
  const edgeComm = calculateCommissionBreakdown(10000, 9999);
  assert.equal(edgeComm.commissionMinor, 9999);
  assert.equal(edgeComm.netEarningsMinor, 1);

  // 9. 100.00% (10,000 bps): Full platform take, zero rider earnings, never negative
  const fullComm = calculateCommissionBreakdown(6500, 10000);
  assert.equal(fullComm.commissionMinor, 6500);
  assert.equal(fullComm.netEarningsMinor, 0);

  // 10. Pricing quote calculation matches across full range
  const policy0 = { base_minor: 3000, per_km_minor: 0, commission_bps: 0, commission_mode: 'percentage' };
  const quote0 = calculateQuote(policy0, 0);
  assert.equal(quote0.commissionMinor, 0);
  assert.equal(quote0.riderEarningsMinor, 3000);

  const policy100 = { base_minor: 3000, per_km_minor: 0, commission_bps: 10000, commission_mode: 'percentage' };
  const quote100 = calculateQuote(policy100, 0);
  assert.equal(quote100.commissionMinor, 3000);
  assert.equal(quote100.riderEarningsMinor, 0);

  // 11. Rejection of invalid rates (< 0 or > 10,000)
  assert.throws(() => calculateCommissionBreakdown(1000, -1), /Invalid rateBps/);
  assert.throws(() => calculateCommissionBreakdown(1000, 10001), /Invalid rateBps/);
  assert.throws(() => calculateQuote({ ...policy0, commission_bps: 10001 }, 0), /exceed 100% limit/);
});

test('Database Check Constraints Enforce 0 to 10,000 bps Across All Tables', async () => {
  // pricing_policies table check constraint
  const validPolicyId = randomUUID();
  await db.query(`
    INSERT INTO pricing_policies (id, base_minor, per_km_minor, commission_bps, active)
    VALUES ($1, 2000, 150, 0, false)
  `, [validPolicyId]);

  const validPolicyId2 = randomUUID();
  await db.query(`
    INSERT INTO pricing_policies (id, base_minor, per_km_minor, commission_bps, active)
    VALUES ($1, 2000, 150, 10000, false)
  `, [validPolicyId2]);

  // Reject out of bounds
  await assert.rejects(async () => {
    await db.query(`
      INSERT INTO pricing_policies (id, base_minor, per_km_minor, commission_bps, active)
      VALUES ($1, 2000, 150, 10001, false)
    `, [randomUUID()]);
  }, /pricing_policies_commission_bps_check/);

  await assert.rejects(async () => {
    await db.query(`
      INSERT INTO pricing_policies (id, base_minor, per_km_minor, commission_bps, active)
      VALUES ($1, 2000, 150, -1, false)
    `, [randomUUID()]);
  }, /pricing_policies_commission_bps_check/);

  // restaurants table check constraint
  const testRestId = randomUUID();
  await db.query(`
    INSERT INTO restaurants (
      id, owner_id, name, phone, address, latitude, longitude,
      operating_hours, prep_time_minutes, delivery_radius_m, food_commission_bps, status
    ) VALUES ($1, $2, 'Dynamic Comm Rest', '+233240888001', 'Osu Oxford St', 5.556, -0.186,
      '{"open": "08:00", "close": "22:00"}', 20, 5000, 5000, 'approved')
  `, [testRestId, adminActor.id]);

  await assert.rejects(async () => {
    await db.query(`
      UPDATE restaurants SET food_commission_bps = 10001 WHERE id = $1
    `, [testRestId]);
  }, /restaurants_food_commission_bps_check/);
});

test('Precedence Engine & 0% Non-Defaulting Semantics', async () => {
  const specificRiderId = randomUUID();
  const specificRestId = randomUUID();

  // Baseline fallback without any rules
  const defaultDelivery = await engine.resolveCommissionRate({ isFood: false });
  assert.equal(defaultDelivery.rateBps, 1300); // 13% default

  const defaultFood = await engine.resolveCommissionRate({ isFood: true });
  assert.equal(defaultFood.rateBps, 1000); // 10% default

  // Create explicit 0% Founding Rider Campaign
  const founding = await engine.enrollFoundingRider(adminActor, {
    riderId: specificRiderId,
    days: 90,
    maxOrders: 100,
    rationale: 'Top Accra courier onboarding incentive: 0% fee'
  });
  assert.equal(founding.rateBps, 0);

  // Resolve rate for this rider: must return exactly 0 bps, NOT default to 13%
  const resolvedRider = await engine.resolveCommissionRate({ actorId: specificRiderId, isFood: false });
  assert.equal(resolvedRider.rateBps, 0, 'Explicit 0% rate must never default away');
  assert.equal(resolvedRider.source, 'founding_rider');

  // Verify another rider still gets default rate
  const otherRider = await engine.resolveCommissionRate({ actorId: randomUUID(), isFood: false });
  assert.equal(otherRider.rateBps, 1300);

  // Test restaurant agreement precedence
  await db.query(`
    INSERT INTO restaurants (
      id, owner_id, name, phone, address, latitude, longitude,
      operating_hours, prep_time_minutes, delivery_radius_m, food_commission_bps, status
    ) VALUES ($1, $2, 'Precedence Rest', '+233240888002', 'Airport City', 5.590, -0.178,
      '{"open": "08:00", "close": "22:00"}', 15, 6000, 1500, 'approved')
  `, [specificRestId, adminActor.id]);

  const resolvedRest = await engine.resolveCommissionRate({ restaurantId: specificRestId, isFood: true });
  assert.equal(resolvedRest.rateBps, 1500); // 15% contractual rate overrides 10% default
});

test('High-Rate Guardrails Require Explicit Confirmation and Commercial Rationale', async () => {
  // Setting rate > 20% without confirmHighRate throws 400
  await assert.rejects(async () => {
    await engine.createRule(adminActor, {
      name: 'Accidental High Rate',
      category: 'promotional_campaign',
      scopeType: 'campaign',
      rateBps: 2500, // 25%
      reason: 'Standard test campaign'
    });
  }, /confirmHighRate/);

  // Setting rate > 20% with confirmHighRate but short rationale throws 400
  await assert.rejects(async () => {
    await engine.createRule(adminActor, {
      name: 'High Rate Short Rationale',
      category: 'promotional_campaign',
      scopeType: 'campaign',
      rateBps: 2500,
      confirmHighRate: true,
      highRateRationale: 'too short',
      reason: 'Standard test campaign'
    });
  }, /Too small|highRateRationale/);

  // Setting with valid confirmation and rationale succeeds
  const rule = await engine.createRule(adminActor, {
    name: 'Approved High Rate Specialized Cargo',
    category: 'corporate_delivery',
    scopeType: 'campaign',
    rateBps: 2500,
    confirmHighRate: true,
    highRateRationale: 'Authorized by Board for hazardous goods high-liability handling',
    reason: 'Hazardous cargo premium surcharge'
  });

  assert.equal(rule.rateBps, 2500);
  assert.equal(rule.ratePercent, '25.00%');

  // Verify audit log entry
  const logs = await engine.getAuditLogs(adminActor, rule.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'created');
  assert.equal(logs[0].new_rate_bps, 2500);
  assert.match(logs[0].rationale, /Authorized by Board/);
});

test('Rule Lifecycle: Pause, Resume, Expiration & Immutability', async () => {
  const promoRiderId = randomUUID();

  // Create a 2-order promo rule
  const promo = await engine.createRule(adminActor, {
    name: '2-Order Promo 5%',
    category: 'promotional_campaign',
    scopeType: 'rider',
    scopeId: promoRiderId,
    rateBps: 500,
    maxOrders: 2,
    reason: 'Special sprint campaign'
  });

  // Check initial resolution
  let res = await engine.resolveCommissionRate({ actorId: promoRiderId });
  assert.equal(res.rateBps, 500);

  // Simulate Order 1 applied
  await engine.recordOrderCommissionApplied(db, promo.id);
  res = await engine.resolveCommissionRate({ actorId: promoRiderId });
  assert.equal(res.rateBps, 500);

  // Simulate Order 2 applied -> rule expires
  await engine.recordOrderCommissionApplied(db, promo.id);
  res = await engine.resolveCommissionRate({ actorId: promoRiderId });
  assert.equal(res.rateBps, 1300, 'Expired rule must fall back to next precedence tier');

  // Pause & Resume verification on a new rule
  const pauseRule = await engine.createRule(adminActor, {
    name: 'Pausable Rule',
    category: 'rider_delivery',
    scopeType: 'rider',
    scopeId: promoRiderId,
    rateBps: 800,
    reason: 'Merchant agreement test'
  });

  const paused = await engine.pauseRule(adminActor, pauseRule.id, 'Temporary pause for dispute');
  assert.equal(paused.status, 'paused');

  res = await engine.resolveCommissionRate({ actorId: promoRiderId });
  assert.equal(res.rateBps, 1300, 'Paused rule must be bypassed during rate resolution');

  const resumed = await engine.resumeRule(adminActor, pauseRule.id, 'Dispute resolved, reinstated');
  assert.equal(resumed.status, 'active');

  res = await engine.resolveCommissionRate({ actorId: promoRiderId });
  assert.equal(res.rateBps, 800, 'Resumed rule takes immediate effect');

  // Revoke rule permanently
  const revoked = await engine.revokeRule(adminActor, pauseRule.id, 'Permanent termination of contract');
  assert.equal(revoked.status, 'revoked');

  res = await engine.resolveCommissionRate({ actorId: promoRiderId });
  assert.equal(res.rateBps, 1300);

  // Audit logs show complete lifecycle
  const auditLogs = await engine.getAuditLogs(adminActor, pauseRule.id);
  const actions = auditLogs.map(l => l.action);
  assert.ok(actions.includes('created'));
  assert.ok(actions.includes('paused'));
  assert.ok(actions.includes('resumed'));
  assert.ok(actions.includes('revoked'));
});
