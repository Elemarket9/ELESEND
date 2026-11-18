// SIMULATION ONLY: tries what goes wrong in real life against the real API, on a throwaway database.
// Other people's orders, money on cancellations and refunds, two requests at once, riders dropping out and bad input.
// Each case states what a safe system does; the report lists every case that did something else.
//   NODE_ENV=test TEST_DATABASE_URL=postgres://.../elesend_test node scripts/audit-simulation.mjs [--json out.json]
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {journeyHarness} from './full-journey-simulation.mjs';
import {simulationPhone, withSimulationDatabase} from './local-simulation-support.mjs';

export async function runAudit(db) {
  const h = await journeyHarness(db);
  const {api, must, account, rider, gps, pay, deliver, state, offline, codeFor, boundary, dispatch, PLACES} = h;
  const results = [];
  const expect = (area, what, ok, detail) => results.push({area, what, ok: Boolean(ok), ...(ok ? {} : {detail})});
  const blocked = r => r.status === 403 || r.status === 404;
  const P = PLACES.accraMall, D = PLACES.osuOxford;
  const trip = (over = {}) => ({pickup: P, destination: D, vehicle: 'motorcycle', recipientPhone: simulationPhone(), weightG: 1000, description: 'SIMULATION ONLY parcel', paymentMethod: 'MOMO', ...over});
  async function booked(customer, over) {
    const q = await must(customer.token, 'POST', '/api/v1/quotes', trip(over));
    const s = await must(customer.token, 'POST', '/api/v1/shipments', {quoteId: q.id}, {'Idempotency-Key': 'aud-' + randomUUID()});
    return {quote: q, shipment: s, id: s.id, amount: Number(q.amount_minor)};
  }
  async function paidParcel(customer, over) { const b = await booked(customer, over); await pay(customer, b.id); return b; }
  async function accepted(customer, r, over) {
    const b = await paidParcel(customer, over); await dispatch.tick();
    const offer = (await must(r.token, 'GET', '/api/v1/rider/offers')).find(o => o.id === b.id);
    if (!offer) throw Error('no offer for ' + b.id + ' state ' + await state(b.id));
    await must(r.token, 'POST', `/api/v1/shipments/${b.id}/accept`, {offerId: offer.offerId});
    return {...b, offer};
  }
  const refundOf = async id => (await db.query('SELECT coalesce(sum(amount_minor),0)::bigint AS n FROM checkout_refund_requests WHERE shipment_id=$1', [id])).rows[0].n;
  const ledgerBalanced = async id => (await db.query(`SELECT coalesce(sum(CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END),0)::bigint AS net
    FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.shipment_id=$1`, [id])).rows[0].net === '0';
  const safely = async (area, what, fn) => { try { await fn(); } catch (e) { expect(area, what, false, 'scenario error: ' + e.message); } };
  // Each scenario starts with no riders out and no unassigned jobs left over from the one before.
  const ROUND = async () => { await offline(); await db.query("UPDATE dispatch_offers SET status='expired' WHERE status='offered'"); await db.query("UPDATE shipments SET state='CANCELLED' WHERE state='AWAITING_ASSIGNMENT'"); };

  try {
    await db.query("UPDATE checkout_method_policies SET enabled=true WHERE method IN ('MOMO','CASH')");
    const alice = await account('customer'), bob = await account('customer');

    await safely('cargo', 'long-vehicle pricing separation', async () => {
      const customRate = await api(alice.token, 'POST', '/api/v1/quotes', trip({vehicle: 'long_vehicle', weightG: 1000000, lengthCm: 500, volumeL: 10000, perTonneKmMinor: 1}));
      expect('cargo', 'customers cannot inject a heavy-freight tonne-kilometre rate', customRate.status === 400, customRate);
    });

    await safely('cargo', 'vehicle capacity limits', async () => {
      const tamperedRates = await api(alice.token, 'POST', '/api/v1/quotes', trip({helpers: 2, pickupFloorsNoLift: 3, perHelperMinor: 1, perFloorMinor: 1}));
      expect('cargo', 'a customer cannot set helper or floor prices in the quote request', tamperedRates.status === 400, tamperedRates);
      const tooManyHelpers = await api(alice.token, 'POST', '/api/v1/quotes', trip({helpers: 5}));
      expect('cargo', 'the quote refuses more than four helpers', tooManyHelpers.status === 400, tooManyHelpers);
      const cap = (await db.query("SELECT enabled,max_weight_g,max_trip_m,max_length_cm,max_volume_l FROM vehicle_capabilities WHERE vehicle='tricycle'")).rows[0];
      const tariff = (await db.query("SELECT id,is_placeholder FROM pricing_policies WHERE vehicle='tricycle' AND active")).rows[0];
      const temporaryTariff = randomUUID();
      const cargoTerms = (await db.query('SELECT liability_limit_minor,liability_terms FROM cargo_policy_settings WHERE id=1')).rows[0];
      try {
        if (tariff) await db.query('UPDATE pricing_policies SET active=false WHERE id=$1', [tariff.id]);
        await db.query("INSERT INTO pricing_policies(id,vehicle,base_minor,per_km_minor,per_minute_minor,minimum_minor,commission_bps,active,is_placeholder) VALUES($1,'tricycle',100,0,0,0,0,true,false)", [temporaryTariff]);
        await db.query("UPDATE cargo_policy_settings SET liability_limit_minor=500000,liability_terms='Temporary test cargo terms only.' WHERE id=1");
        await db.query("UPDATE vehicle_capabilities SET enabled=true,max_weight_g=300000,max_trip_m=25000,max_length_cm=200,max_volume_l=1500 WHERE vehicle='tricycle'");
        const heavy = await api(alice.token, 'POST', '/api/v1/quotes', trip({vehicle: 'tricycle', weightG: 300001, lengthCm: 100, volumeL: 1000}));
        expect('cargo', 'tricycle quote refuses an overweight load', heavy.status === 422 && /heavy|heavier/i.test(heavy.data.error ?? ''), heavy);
        const long = await api(alice.token, 'POST', '/api/v1/quotes', trip({vehicle: 'tricycle', weightG: 1000, lengthCm: 201, volumeL: 1000}));
        expect('cargo', 'tricycle quote refuses an over-length load', long.status === 422 && /long/i.test(long.data.error ?? ''), long);
        const far = await api(alice.token, 'POST', '/api/v1/quotes', trip({vehicle: 'tricycle', destination: PLACES.kumasiAdum, weightG: 1000, lengthCm: 100, volumeL: 1000}));
        expect('cargo', 'tricycle quote refuses a road trip beyond its limit', far.status === 422 && /limit|larger vehicle|truck/i.test(far.data.error ?? ''), far);
      } finally {
        await db.query("UPDATE vehicle_capabilities SET enabled=$1,max_weight_g=$2,max_trip_m=$3,max_length_cm=$4,max_volume_l=$5 WHERE vehicle='tricycle'", [cap.enabled, cap.max_weight_g, cap.max_trip_m, cap.max_length_cm, cap.max_volume_l]);
        await db.query("UPDATE pricing_policies SET active=false WHERE id=$1", [temporaryTariff]);
        await db.query('DELETE FROM pricing_policies WHERE id=$1', [temporaryTariff]);
        if (tariff) await db.query('UPDATE pricing_policies SET active=true WHERE id=$1', [tariff.id]);
        await db.query('UPDATE cargo_policy_settings SET liability_limit_minor=$1,liability_terms=$2 WHERE id=1', [cargoTerms.liability_limit_minor, cargoTerms.liability_terms]);
      }
    });

    // ---------- 1. Other people's things ----------
    await safely('access', 'setup', async () => {
      await ROUND();
      const riderA = await rider('motorcycle', P), riderB = await rider('motorcycle', PLACES.kumasiAdum);
      const a = await accepted(alice, riderA);
      expect('access', "a customer cannot read another customer's delivery", blocked(await api(bob.token, 'GET', `/api/v1/shipments/${a.id}`)));
      expect('access', "a customer cannot cancel another customer's delivery", blocked(await api(bob.token, 'POST', `/api/v1/shipments/${a.id}/transition`, {action: 'cancel', reason: 'Not mine at all'})));
      expect('access', "a customer cannot see another customer's live tracking", blocked(await api(bob.token, 'GET', `/api/v1/public-track/${a.id}`)));
      expect('access', 'nobody signed out can track by delivery number alone', (await api(null, 'GET', `/api/v1/public-track/${a.id}`)).status === 404);
      expect('access', "a customer cannot change another customer's recipient", blocked(await api(bob.token, 'POST', `/api/v1/shipments/${a.id}/recipient`, {recipientPhone: simulationPhone()})));
      expect('access', "a customer cannot open a dispute on another customer's delivery", blocked(await api(bob.token, 'POST', `/api/v1/shipments/${a.id}/disputes`, {category: 'damaged', detail: 'Trying to dispute a stranger delivery'})));
      expect('access', "a customer cannot get another customer's rider photo", blocked(await api(bob.token, 'GET', `/api/v1/shipments/${a.id}/rider-photo`)));
      expect('access', 'another rider cannot read the delivery', blocked(await api(riderB.token, 'GET', `/api/v1/shipments/${a.id}`)));
      expect('access', "another rider cannot ask for the pickup code", blocked(await api(riderB.token, 'POST', `/api/v1/shipments/${a.id}/pickup-challenge`, {})) || (await api(riderB.token, 'POST', `/api/v1/shipments/${a.id}/pickup-challenge`, {})).status === 409);
      expect('access', "another rider cannot post location for it", (await api(riderB.token, 'POST', `/api/v1/shipments/${a.id}/location`, {latitude: P.latitude, longitude: P.longitude})).status >= 400);
      expect('access', "another rider cannot take the offer with the first rider's offer number", (await api(riderB.token, 'POST', `/api/v1/shipments/${a.id}/accept`, {offerId: a.offer.offerId})).status >= 400);
      const q = await must(alice.token, 'POST', '/api/v1/quotes', trip());
      expect('access', "a customer cannot book with another customer's quote", (await api(bob.token, 'POST', '/api/v1/shipments', {quoteId: q.id}, {'Idempotency-Key': 'aud-' + randomUUID()})).status >= 400);
      const list = await must(bob.token, 'GET', '/api/v1/shipments');
      expect('access', "a customer's delivery list holds only their own", (Array.isArray(list) ? list : list.items ?? []).every(s => s.customer_id === undefined || s.customer_id === bob.id));
    });

    await safely('access', 'food setup', async () => {
      const admin = randomUUID();
      await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'simulation-only','admin',now())", [admin, simulationPhone()]);
      await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'verification:write')", [admin]);
      const {restaurantService} = await import('../services/api/modules/food/index.mjs');
      const ownerA = await account('business'), ownerB = await account('business');
      const kA = await must(ownerA.token, 'POST', '/api/v1/restaurants', {name: 'Audit Kitchen A ' + randomUUID().slice(0, 6), phone: '0241234567', address: D.address, latitude: D.latitude, longitude: D.longitude});
      const kB = await must(ownerB.token, 'POST', '/api/v1/restaurants', {name: 'Audit Kitchen B ' + randomUUID().slice(0, 6), phone: '0241234568', address: D.address, latitude: D.latitude, longitude: D.longitude});
      for (const k of [kA, kB]) await restaurantService(db).updateRestaurant({id: admin, kind: 'admin'}, k.id, {status: 'approved'});
      const item = await must(ownerA.token, 'POST', `/api/v1/restaurants/${kA.id}/items`, {name: 'Waakye', priceMinor: 3000});
      expect('access', "a kitchen owner cannot add items to another kitchen's menu", blocked(await api(ownerB.token, 'POST', `/api/v1/restaurants/${kA.id}/items`, {name: 'Sneaky', priceMinor: 1})));
      expect('access', "a kitchen owner cannot change another kitchen's prices", blocked(await api(ownerB.token, 'POST', `/api/v1/restaurants/${kA.id}/items/${item.id}`, {priceMinor: 1})));
      expect('access', "a kitchen owner cannot read another kitchen's settlements", blocked(await api(ownerB.token, 'GET', `/api/v1/restaurants/${kA.id}/settlements`)));
      expect('access', "a customer cannot read a kitchen's settlements", blocked(await api(alice.token, 'GET', `/api/v1/restaurants/${kA.id}/settlements`)));
      expect('access', 'a kitchen owner cannot approve their own kitchen', (await api(ownerA.token, 'POST', `/api/v1/restaurants/${kA.id}`, {status: 'approved'})).status === 403);
      const order = {restaurantId: kA.id, items: [{itemId: item.id, quantity: 2}], deliveryAddress: P.address, deliveryLatitude: P.latitude, deliveryLongitude: P.longitude, customerPhone: '0241234567'};
      const placed = await must(alice.token, 'POST', '/api/v1/food-orders', {...order}, {'Idempotency-Key': 'aud-' + randomUUID()});
      const oid = placed.id ?? placed.order?.id, sid = placed.shipment_id ?? placed.order?.shipment_id;
      expect('access', "a customer cannot read another customer's food order", blocked(await api(bob.token, 'GET', `/api/v1/food-orders/${oid}`)));
      expect('access', "a customer cannot cancel another customer's food order", blocked(await api(bob.token, 'POST', `/api/v1/food-orders/${oid}/cancel`, {reason: 'Not mine'})));
      const strangerAccept = await api(ownerB.token, 'POST', `/api/v1/food-orders/${oid}/accept`, {prepMinutes: 10});
      expect('access', "another kitchen cannot accept the order, or learn its state", blocked(strangerAccept), strangerAccept);
      expect('access', "another kitchen cannot reject the order", blocked(await api(ownerB.token, 'POST', `/api/v1/food-orders/${oid}/reject`, {reason: 'Not mine'})));
      const selfReady = await api(alice.token, 'POST', `/api/v1/food-orders/${oid}/ready`, {});
      expect('access', 'a customer cannot mark their own food ready, or learn its state', blocked(selfReady), selfReady);
      // Price tampering: the order total comes from the menu, not from the request.
      const tampered = await api(alice.token, 'POST', '/api/v1/food-orders/quote', {...order, items: [{itemId: item.id, quantity: 2, priceMinor: 1}]});
      expect('money', 'a customer cannot set their own food price', tampered.status >= 400 || Number(tampered.data.subtotalMinor) === 6000, tampered.data);
      // Money: kitchen rejects after payment, so everything comes back.
      await pay(alice, sid);
      await must(ownerA.token, 'POST', `/api/v1/food-orders/${oid}/reject`, {reason: 'Out of waakye'});
      const total = Number(placed.total_minor ?? placed.order?.total_minor);
      expect('money', 'a kitchen rejecting a paid order refunds food and delivery in full', Number(await refundOf(sid)) === total, {refund: String(await refundOf(sid)), total});
      expect('money', "the books balance after a kitchen rejects", await ledgerBalanced(sid));
      // A second paid order, cancelled by the customer before the kitchen accepts.
      const second = await must(alice.token, 'POST', '/api/v1/food-orders', {...order}, {'Idempotency-Key': 'aud-' + randomUUID()});
      const oid2 = second.id ?? second.order?.id, sid2 = second.shipment_id ?? second.order?.shipment_id;
      await pay(alice, sid2);
      await must(alice.token, 'POST', `/api/v1/food-orders/${oid2}/cancel`, {reason: 'Changed my mind'});
      expect('money', 'a customer cancelling before the kitchen accepts is refunded in full', Number(await refundOf(sid2)) === Number(second.total_minor ?? second.order?.total_minor), {refund: String(await refundOf(sid2))});
      // After the kitchen accepts, the customer can no longer cancel by themselves.
      const third = await must(alice.token, 'POST', '/api/v1/food-orders', {...order}, {'Idempotency-Key': 'aud-' + randomUUID()});
      const oid3 = third.id ?? third.order?.id, sid3 = third.shipment_id ?? third.order?.shipment_id;
      await pay(alice, sid3);
      await must(ownerA.token, 'POST', `/api/v1/food-orders/${oid3}/accept`, {prepMinutes: 10});
      expect('money', 'a customer cannot cancel food the kitchen is already cooking', (await api(alice.token, 'POST', `/api/v1/food-orders/${oid3}/cancel`, {reason: 'Too late'})).status === 409);
      // Two identical orders sent at once with one idempotency key create one order.
      const key = 'aud-' + randomUUID();
      const twins = await Promise.all([1, 2, 3].map(() => api(alice.token, 'POST', '/api/v1/food-orders', {...order}, {'Idempotency-Key': key})));
      const ids = new Set(twins.filter(t => t.status === 200 || t.status === 201).map(t => t.data.id ?? t.data.order?.id));
      expect('races', 'the same food order sent three times at once is created once', ids.size === 1, twins.map(t => t.status));
    });

    // ---------- 2. Money on parcels ----------
    await safely('money', 'parcel money', async () => {
      await ROUND();
      const r = await rider('motorcycle', P);
      // Paid, then cancelled before any rider: full refund.
      const b = await paidParcel(alice);
      await must(alice.token, 'POST', `/api/v1/shipments/${b.id}/transition`, {action: 'cancel', reason: 'Changed my mind'});
      expect('money', 'cancelling a paid delivery before a rider accepts refunds it in full', Number(await refundOf(b.id)) === b.amount, {refund: String(await refundOf(b.id)), amount: b.amount});
      expect('money', 'the books balance after that cancellation', await ledgerBalanced(b.id));
      // Delivered: rider pay plus commission equals the fare, and the books balance.
      const c = await accepted(alice, r);
      await deliver(r, c.id, P, D, {customer: alice, skipDispatch: true}).catch(e => { throw Error('deliver: ' + e.message); });
      const s = (await db.query('SELECT amount_minor,commission_minor FROM shipments WHERE id=$1', [c.id])).rows[0];
      expect('money', 'rider pay plus commission equals the fare', Number(c.offer.entitlement_minor) + Number(s.commission_minor) === Number(s.amount_minor), {offer: c.offer.entitlement_minor, s});
      expect('money', 'the books balance after a delivery', await ledgerBalanced(c.id));
      expect('money', 'a completed delivery cannot be cancelled for a refund', (await api(alice.token, 'POST', `/api/v1/shipments/${c.id}/transition`, {action: 'cancel', reason: 'Want my money back'})).status >= 400);
      // A payment for the wrong amount is not accepted as payment.
      const w = await booked(alice);
      const intent = await must(alice.token, 'POST', `/api/v1/shipments/${w.id}/checkout`, {idempotencyKey: 'aud-' + randomUUID(), email: 'a@simulation.invalid'});
      const original = boundary.provider.verifyPayment;
      boundary.provider.verifyPayment = async ref => ({...(await original.call(boundary.provider, ref)), amountMinor: 100, amount: 100});
      boundary.paid(intent.reference);
      const signed = boundary.callback(intent.reference);
      await fetch(h.base + '/api/v1/payments/webhook', {method: 'POST', headers: {'Content-Type': 'application/json', 'x-simulation-signature': signed.signature}, body: signed.body});
      boundary.provider.verifyPayment = original;
      expect('money', 'a payment of GH₵1 does not pay for a larger delivery', (await db.query('SELECT paid FROM shipments WHERE id=$1', [w.id])).rows[0].paid === false);
      // A forged callback without the provider's signature does nothing.
      const f = await booked(alice);
      const fi = await must(alice.token, 'POST', `/api/v1/shipments/${f.id}/checkout`, {idempotencyKey: 'aud-' + randomUUID(), email: 'a@simulation.invalid'});
      boundary.paid(fi.reference);
      const forged = await fetch(h.base + '/api/v1/payments/webhook', {method: 'POST', headers: {'Content-Type': 'application/json', 'x-simulation-signature': 'f'.repeat(64)}, body: JSON.stringify({reference: fi.reference})});
      expect('money', 'a forged payment callback is refused', forged.status >= 400 && (await db.query('SELECT paid FROM shipments WHERE id=$1', [f.id])).rows[0].paid === false, forged.status);
    });

    // ---------- 3. Two at once ----------
    await safely('races', 'races', async () => {
      await ROUND();
      const q = await must(alice.token, 'POST', '/api/v1/quotes', trip());
      const key = 'aud-' + randomUUID();
      const twins = await Promise.all([1, 2, 3, 4].map(() => api(alice.token, 'POST', '/api/v1/shipments', {quoteId: q.id}, {'Idempotency-Key': key})));
      expect('races', 'the same booking sent four times at once creates one delivery', new Set(twins.filter(t => t.status === 200).map(t => t.data.id)).size === 1, twins.map(t => t.status));
      const quoteTwice = await Promise.all([1, 2].map(() => api(alice.token, 'POST', '/api/v1/shipments', {quoteId: q.id}, {'Idempotency-Key': 'aud-' + randomUUID()})));
      expect('races', 'one quote cannot be booked twice with different keys', quoteTwice.filter(t => t.status === 200 && t.data.id !== twins[0].data.id).length === 0, quoteTwice.map(t => t.status));
      // The provider calls back five times at once.
      const b = await booked(alice);
      const intent = await must(alice.token, 'POST', `/api/v1/shipments/${b.id}/checkout`, {idempotencyKey: 'aud-' + randomUUID(), email: 'a@simulation.invalid'});
      boundary.paid(intent.reference);
      const signed = boundary.callback(intent.reference);
      await Promise.all([1, 2, 3, 4, 5].map(() => fetch(h.base + '/api/v1/payments/webhook', {method: 'POST', headers: {'Content-Type': 'application/json', 'x-simulation-signature': signed.signature}, body: signed.body})));
      const confirmed = (await db.query("SELECT count(*)::int AS n FROM checkout_accounting_journals WHERE shipment_id=$1 AND kind ILIKE '%confirm%'", [b.id])).rows[0].n;
      expect('races', 'five payment callbacks at once record the payment once', confirmed <= 1, {journals: confirmed});
      expect('races', 'the books balance after five callbacks', await ledgerBalanced(b.id));
      // Two riders tap Accept on a broadcast offer at the same moment: one gets it.
      await ROUND();
      const r1 = await rider('motorcycle', P), r2 = await rider('motorcycle', {latitude: P.latitude + 0.001, longitude: P.longitude});
      await db.query("UPDATE dispatch_algorithm_features SET enabled=true WHERE feature_key='multi_rider_broadcast'");
      const race = await paidParcel(alice);
      await dispatch.tick();
      const offers = await Promise.all([r1, r2].map(async r => ({r, offer: (await must(r.token, 'GET', '/api/v1/rider/offers')).find(o => o.id === race.id)})));
      const both = offers.filter(o => o.offer);
      if (both.length === 2) {
        const taps = await Promise.all(both.map(({r, offer}) => api(r.token, 'POST', `/api/v1/shipments/${race.id}/accept`, {offerId: offer.offerId})));
        expect('races', 'two riders accepting at once: exactly one gets the job', taps.filter(t => t.status === 200).length === 1, taps.map(t => t.status));
      }
      expect('races', 'both nearby riders are offered the job when offers go to several riders', both.length === 2, both.length);
      await db.query("UPDATE dispatch_algorithm_features SET enabled=false WHERE feature_key='multi_rider_broadcast'");
      const holders = (await db.query("SELECT count(*)::int n FROM dispatch_offers WHERE shipment_id=$1 AND status='accepted'", [race.id])).rows[0].n;
      expect('races', 'the job ends up with exactly one rider', holders === 1, holders);
      // One rider tapping Accept three times.
      await ROUND();
      const r3 = await rider('motorcycle', P);
      const c = await paidParcel(alice); await dispatch.tick();
      const o3 = (await must(r3.token, 'GET', '/api/v1/rider/offers')).find(o => o.id === c.id);
      const taps = await Promise.all([1, 2, 3].map(() => api(r3.token, 'POST', `/api/v1/shipments/${c.id}/accept`, {offerId: o3.offerId})));
      expect('races', 'a rider tapping Accept three times gets the job once', (await db.query("SELECT count(*)::int n FROM dispatch_offers WHERE shipment_id=$1 AND status='accepted'", [c.id])).rows[0].n === 1 && taps.some(t => t.status === 200), taps.map(t => t.status));
    });

    // ---------- 4. Riders dropping out, and bad input ----------
    await safely('failure', 'rider failure', async () => {
      await ROUND();
      const r1 = await rider('motorcycle', P);
      const a = await accepted(alice, r1);
      const rel = await api(r1.token, 'POST', '/api/v1/rider/assignments/release', {shipmentId: a.id, reason: 'Bike broke down on the way'});
      expect('failure', 'a rider can hand back a job before pickup', rel.status === 200, rel);
      expect('failure', 'a handed-back job looks for a rider again', await state(a.id) === 'AWAITING_ASSIGNMENT', await state(a.id));
      await offline();
      const r2 = await rider('motorcycle', P);
      await db.query('UPDATE shipments SET next_dispatch_at=now() WHERE id=$1', [a.id]);
      await dispatch.tick();
      expect('failure', 'another rider is then offered it', (await must(r2.token, 'GET', '/api/v1/rider/offers')).some(o => o.id === a.id));
      expect('failure', 'the first rider is not offered it again straight away', (await db.query("SELECT count(*)::int n FROM dispatch_offers WHERE shipment_id=$1 AND rider_id=$2 AND status='offered'", [a.id, r1.id])).rows[0].n === 0);
      // A rider who declines: the next rider gets it.
      await ROUND();
      const r3 = await rider('motorcycle', P);
      const b = await paidParcel(alice); await dispatch.tick();
      const o3 = (await must(r3.token, 'GET', '/api/v1/rider/offers')).find(o => o.id === b.id);
      expect('failure', 'declining an offer works', (await api(r3.token, 'POST', '/api/v1/rider/offers/decline', {shipmentId: b.id, offerId: o3?.offerId})).status === 200);
      // Going offline while carrying a parcel.
      await ROUND();
      const r4 = await rider('motorcycle', P);
      const c = await accepted(alice, r4);
      await gps(r4, P);
      const pc = await must(r4.token, 'POST', `/api/v1/shipments/${c.id}/pickup-challenge`, {});
      await must(r4.token, 'POST', `/api/v1/shipments/${c.id}/verify`, {challengeId: pc.challengeId, code: codeFor(pc.challengeId)});
      // Going offline with a parcel on board: tracking and the delivery must carry on.
      await must(r4.token, 'POST', '/api/v1/rider/availability', {online: false});
      await must(r4.token, 'POST', `/api/v1/shipments/${c.id}/transition`, {action: 'start'});
      const midway = {latitude: (P.latitude + D.latitude) / 2, longitude: (P.longitude + D.longitude) / 2};
      const fix = await api(r4.token, 'POST', '/api/v1/rider/location', {latitude: P.latitude, longitude: P.longitude, accuracyMeters: 8, observedAt: new Date().toISOString()});
      expect('failure', 'a rider who goes offline with a parcel still shares location for tracking', fix.status === 200, fix);
      await gps(r4, midway).catch(() => {});
      const tracked = await api(alice.token, 'GET', `/api/v1/public-track/${c.id}`);
      expect('failure', 'the customer still gets an ETA while that rider is offline', tracked.data?.deliveryEta?.status === 'estimated', tracked.data?.deliveryEta);
      expect('failure', 'an offline rider gets no new offers', (await api(r4.token, 'GET', '/api/v1/rider/offers')).status === 409);
      // Guessing the delivery code.
      await gps(r4, D);
      const dc = await must(r4.token, 'POST', `/api/v1/shipments/${c.id}/delivery-challenge`, {});
      const guesses = [];
      for (let i = 0; i < 8; i++) guesses.push((await api(r4.token, 'POST', `/api/v1/shipments/${c.id}/verify`, {challengeId: dc.challengeId, code: String(100000 + i)})).status);
      const right = await api(r4.token, 'POST', `/api/v1/shipments/${c.id}/verify`, {challengeId: dc.challengeId, code: codeFor(dc.challengeId)});
      expect('failure', 'guessing the delivery code is stopped after a few tries', guesses.some(s => s === 429 || s === 423) || right.status >= 400, {guesses, right: right.status});
      // With codes locked, the recipient asks for a new one and the offline rider can still finish.
      if (right.status >= 400) {
        await db.query("UPDATE challenges SET expires_at=now() WHERE shipment_id=$1 AND purpose='delivery'", [c.id]);
        await db.query("DELETE FROM rate_limits WHERE key LIKE '%' || $1 || '%'", [c.id]).catch(() => {});
        const again = await api(r4.token, 'POST', `/api/v1/shipments/${c.id}/delivery-challenge`, {});
        const done = again.status === 200 ? await api(r4.token, 'POST', `/api/v1/shipments/${c.id}/verify`, {challengeId: again.data.challengeId, code: codeFor(again.data.challengeId)}) : again;
        expect('failure', 'an offline rider can still complete the delivery with a new code', done.status === 200, done);
      }
    });

    await safely('input', 'inputs', async () => {
      const outside = await api(alice.token, 'POST', '/api/v1/quotes', trip({pickup: {address: 'Grand Marché, Lomé, Togo', latitude: 6.13, longitude: 1.22}}));
      expect('input', 'a pickup outside Ghana is refused with a reason the customer understands', outside.status >= 400 && /ghana/i.test(outside.data.error ?? ''), outside);
      const zero = await api(alice.token, 'POST', '/api/v1/quotes', trip({weightG: 0}));
      expect('input', 'a weight of 0 g is refused', zero.status === 400);
      const same = await api(alice.token, 'POST', '/api/v1/quotes', trip({destination: P}));
      expect('input', 'pickup and drop-off at the same spot is refused or charged the minimum', same.status >= 400 || Number(same.data.amount_minor) === Number(same.data.fareBreakdown?.minimumMinor), same.status);
      const longText = await api(alice.token, 'POST', '/api/v1/quotes', trip({description: 'x'.repeat(5000)}));
      expect('input', 'a 5,000-character description is refused', longText.status === 400);
      const script = await api(alice.token, 'POST', '/api/v1/quotes', trip({description: '<script>alert(1)</script> parcel'}));
      // Stored as typed is fine; what matters is that no page renders it as HTML. The tracking page is the public one.
      const {renderTrackingHtml} = await import('../services/api/modules/maps/index.mjs');
      const page = renderTrackingHtml({shipmentId: randomUUID(), state: 'IN_TRANSIT', statusLabel: 'On the way', pickup: {address: '<script>alert(1)</script>'}, destination: {address: '<img src=x onerror=alert(1)>'}, vehicle: 'motorcycle'}, 'x');
      expect('input', 'addresses with HTML are shown as text on the tracking page', script.status < 500 && !page.includes('<script>alert(1)') && !page.includes('<img src=x'));
      const badPhone = await api(alice.token, 'POST', '/api/v1/quotes', trip({recipientPhone: '12'}));
      expect('input', 'a recipient phone that is not a phone number is refused', badPhone.status === 400, badPhone);
      const noAuth = await api(null, 'POST', '/api/v1/quotes', trip());
      expect('input', 'quoting needs an account', noAuth.status === 401);
    });
  } finally {
    await h.close();
  }
  const failed = results.filter(r => !r.ok);
  return {SIMULATED_ONLY: true, ranAt: new Date().toISOString(), total: results.length, passed: results.length - failed.length, failed: failed.length, failures: failed, results};
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  process.env.NODE_ENV ||= 'test';
  withSimulationDatabase(runAudit).then(report => {
    const out = process.argv.indexOf('--json');
    if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify(report, null, 1));
    console.log(JSON.stringify({total: report.total, passed: report.passed, failed: report.failed, failures: report.failures}, null, 1));
    if (report.failed) process.exitCode = 1;
  }).catch(e => { console.error(e); process.exitCode = 1; });
}
