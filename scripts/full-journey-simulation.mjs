// SIMULATION ONLY: real parcel and food journeys through the real API, on a throwaway database.
// Every step a customer, kitchen and rider takes goes through HTTP, from quote to delivery and payout.
// Roads are a simple model (straight line x detour factor, city speeds by vehicle) so prices and ETAs vary like real
// trips; payments and SMS use the simulation stand-ins. Prints a report and exits non-zero on any failed check.
//   NODE_ENV=test TEST_DATABASE_URL=postgres://.../elesend_test node scripts/full-journey-simulation.mjs [--json out.json]
import {randomInt,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {platform} from '../services/api/modules/orders/platform.mjs';
import {httpServer} from '../services/api/http.mjs';
import {dispatchEngine} from '../services/api/modules/orders/dispatch.mjs';
import {checkoutService,financeService,moneyOperations,paymentWebhook} from '../services/api/modules/payments/index.mjs';
import {restaurantOrderService,restaurantService} from '../services/api/modules/food/index.mjs';
import {fixtureRouting} from '../services/api/modules/maps/osrm-routing.mjs';
import {haversine} from '../services/api/shared/dispatch-geometry.mjs';
import {simulationBoundaries,simulationPhone,withSimulationDatabase} from './local-simulation-support.mjs';

// Ghana road model: detour over the straight line, and typical moving speeds in town traffic.
const DETOUR = 1.35;
const SPEED_KMH = {bicycle: 12, motorcycle: 24, tricycle: 20, car: 18, pickup: 18, van: 16, truck: 14};
export function roadModel(a, b, {vehicle = 'motorcycle'} = {}) {
  const meters = Math.max(30, Math.round(haversine(a, b) * DETOUR));
  const seconds = Math.round(meters / ((SPEED_KMH[vehicle] ?? 20) * 1000 / 3600));
  return {distanceMeters: meters, durationSeconds: seconds};
}

const PLACES = {
  accraMall: {address: 'Accra Mall, Tetteh Quarshie', latitude: 5.6221, longitude: -0.1735},
  osuOxford: {address: 'Oxford Street, Osu', latitude: 5.5571, longitude: -0.1817},
  osuDanquah: {address: 'Danquah Circle, Osu', latitude: 5.5604, longitude: -0.1793},
  kasoaMarket: {address: 'Kasoa New Market, Kasoa', latitude: 5.5340, longitude: -0.4239},
  makola: {address: 'Makola Market, Accra Central', latitude: 5.5480, longitude: -0.2087},
  madina: {address: 'Madina Zongo Junction', latitude: 5.6729, longitude: -0.1665},
  temaComm1: {address: 'Community 1, Tema', latitude: 5.6698, longitude: -0.0166},
  eastLegon: {address: 'A&C Mall, East Legon', latitude: 5.6362, longitude: -0.1527},
  airportT3: {address: 'Kotoka Airport Terminal 3', latitude: 5.6052, longitude: -0.1668},
  kumasiAdum: {address: 'Adum, Kumasi', latitude: 6.6930, longitude: -1.6244},
  knust: {address: 'KNUST, Kumasi', latitude: 6.6745, longitude: -1.5716},
  kumasiAsokwa: {address: 'Asokwa, Kumasi', latitude: 6.6700, longitude: -1.6050},
  achimota: {address: 'Achimota Mall', latitude: 5.6206, longitude: -0.2280},
  dzorwulu: {address: 'Dzorwulu', latitude: 5.6116, longitude: -0.2001}
};

const PARCELS = [
  {name: 'Accra Mall to Osu, motorbike, MoMo', from: 'accraMall', to: 'osuOxford', vehicle: 'motorcycle', weightG: 1000, pay: 'MOMO'},
  {name: 'Kasoa to Makola, motorbike, cash from sender', from: 'kasoaMarket', to: 'makola', vehicle: 'motorcycle', weightG: 3000, pay: 'CASH', cashPayer: 'sender'},
  {name: 'Madina to Tema, car, MoMo', from: 'madina', to: 'temaComm1', vehicle: 'car', weightG: 15000, pay: 'MOMO'},
  {name: 'Kumasi Adum to KNUST, motorbike, cash from recipient', from: 'kumasiAdum', to: 'knust', vehicle: 'motorcycle', weightG: 2000, pay: 'CASH', cashPayer: 'recipient'},
  {name: 'Short hop inside Osu, motorbike, MoMo', from: 'osuOxford', to: 'osuDanquah', vehicle: 'motorcycle', weightG: 500, pay: 'MOMO'},
  {name: 'Achimota to Dzorwulu, motorbike, MoMo', from: 'achimota', to: 'dzorwulu', vehicle: 'motorcycle', weightG: 1500, pay: 'MOMO'}
];
const REFUSED = [
  {name: 'Accra to Kumasi on a motorbike', from: 'accraMall', to: 'kumasiAdum', vehicle: 'motorcycle', weightG: 1000, pay: 'MOMO'},
  {name: 'Van (switched off until launch)', from: 'eastLegon', to: 'airportT3', vehicle: 'van', weightG: 120000, pay: 'MOMO'},
  {name: '40 kg on a motorbike', from: 'accraMall', to: 'osuOxford', vehicle: 'motorcycle', weightG: 40000, pay: 'MOMO'},
  {name: 'Pickup outside Ghana (Lomé)', from: {address: 'Lomé', latitude: 6.13, longitude: 1.22}, to: 'osuOxford', vehicle: 'motorcycle', weightG: 1000, pay: 'MOMO'}
];
const FOOD_ALL = [
  {name: 'Osu kitchen to Danquah Circle', kitchen: 'osuOxford', to: 'osuDanquah', items: [['Jollof rice with chicken', 4500, 2], ['Kelewele', 1500, 1]]},
  {name: 'Asokwa kitchen to KNUST', kitchen: 'kumasiAsokwa', to: 'knust', items: [['Banku and tilapia', 7000, 1], ['Sobolo', 1000, 3]]}
];

const FOOD = process.env.SIM_FOOD ? FOOD_ALL.filter(f => f.name.includes(process.env.SIM_FOOD)) : FOOD_ALL;
const cedis = minor => minor == null ? null : 'GH₵' + (Number(minor) / 100).toFixed(2);

export async function runFullJourneys(db) {
  process.env.REDIS_URL ||= 'disabled';
  const otpKey = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const boundary = simulationBoundaries();
  const texts = [];
  const sms = {async send(m) { texts.push(m); return {accepted: true}; }, async sendNotification(m) { texts.push(m); return {accepted: true}; }};
  const routing = fixtureRouting(async (a, b, opts) => roadModel(a, b, opts));
  const dispatch = dispatchEngine(db, {routing});
  const app = platform(db, {otpKey, routing, dispatch, sms});
  const checkout = checkoutService(db, {provider: boundary.provider, sms, dispatch, routing});
  const finance = financeService(db, {provider: boundary.provider});
  const money = moneyOperations(db, {provider: boundary.provider});
  const restaurantOrders = restaurantOrderService(db, {platform: app, dispatcher: dispatch, routing, sms});
  const server = httpServer(db, app, dispatch, finance, checkout, {
    restaurantOrders, moneyOperations: money,
    paymentsWebhook: paymentWebhook({db, provider: boundary.provider, checkout, finance, money, moneyOperations: money})
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const report = {SIMULATED_ONLY: true, ranAt: new Date().toISOString(), parcels: [], refused: [], food: [], checks: []};
  const check = (ok, what, detail) => { report.checks.push({ok: Boolean(ok), what, ...(detail === undefined ? {} : {detail})}); return ok; };

  async function api(token, method, path, body, headers = {}) {
    const res = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {}), ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
    const text = await res.text(); let data; try { data = text ? JSON.parse(text) : {}; } catch { data = {text}; }
    return {status: res.status, data};
  }
  async function must(token, method, path, body, headers) {
    const r = await api(token, method, path, body, headers);
    if (r.status >= 400) throw Object.assign(Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`), {status: r.status});
    return r.data;
  }
  const codeFor = challengeId => [...boundary.sms.values(), ...texts].reverse().find(m => m.challengeId === challengeId)?.code ?? texts.at(-1)?.code;

  async function account(kind, extra = {}) {
    const phone = simulationPhone(), password = 'simulation lantern river ' + randomInt(1e6);
    await must(null, 'POST', '/api/v1/auth/register', {phone, password, kind, termsVersion: '2026-11-09', ...extra});
    const login = await must(null, 'POST', '/api/v1/auth/login', {phone, password});
    await db.query('UPDATE users SET phone_verified_at=now() WHERE id=$1', [login.user.id]);
    return {id: login.user.id, token: login.token, phone};
  }
  const car = () => ({plateNumber: 'GR ' + randomInt(1000, 9999) + '-2' + randomInt(10), make: 'Toyota', model: 'Corolla', color: 'Silver'});
  async function rider(vehicle, at) {
    const maxWeightG = {motorcycle: 20000, car: 100000, van: 500000}[vehicle] ?? 20000;
    const r = await account('rider', {vehicle, maxWeightG, name: 'Simulated ' + vehicle + ' rider', ...(vehicle === 'car' ? {car: car()} : {})});
    await db.query("UPDATE riders SET status='approved' WHERE id=$1", [r.id]);
    // Staff check a car's papers by hand before its rider can go online.
    if (vehicle === 'car') await db.query("UPDATE rider_vehicle_registrations SET verification_status='approved',reviewed_at=now() WHERE rider_id=$1", [r.id]);
    await must(r.token, 'POST', '/api/v1/rider/availability', {online: true});
    await gps(r, at);
    return r;
  }
  // Riders really travel between fixes. The simulation does not wait, so it moves the last fix back by the time the
  // ride would take; the API's speed check then sees a believable journey.
  async function gps(r, at, vehicle = 'motorcycle') {
    const last = (await db.query('SELECT ST_Y(current_position::geometry) AS latitude, ST_X(current_position::geometry) AS longitude, position_at FROM riders WHERE id=$1', [r.id])).rows[0];
    if (last?.position_at) {
      const seconds = roadModel(last, at, {vehicle}).durationSeconds + 5;
      await db.query("UPDATE riders SET position_at=now()-($2::int*interval '1 second') WHERE id=$1", [r.id, seconds]);
      // Shift the whole history, so the fixes stay in the order they were taken.
      await db.query(`WITH m AS (SELECT max(observed_at) AS latest FROM rider_location_samples WHERE rider_id=$1)
        UPDATE rider_location_samples s SET observed_at=s.observed_at-GREATEST(interval '0',m.latest-(now()-($2::int*interval '1 second'))) FROM m WHERE s.rider_id=$1`, [r.id, seconds]);
    }
    return must(r.token, 'POST', '/api/v1/rider/location', {latitude: at.latitude, longitude: at.longitude, accuracyMeters: 8, observedAt: new Date().toISOString()});
  }
  const offline = () => db.query('UPDATE riders SET online=false');
  async function pay(customer, shipmentId) {
    const intent = await must(customer.token, 'POST', `/api/v1/shipments/${shipmentId}/checkout`, {idempotencyKey: 'sim-' + randomUUID(), email: 'customer@simulation.invalid'});
    boundary.paid(intent.reference);
    const signed = boundary.callback(intent.reference);
    const res = await fetch(base + '/api/v1/payments/webhook', {method: 'POST', headers: {'Content-Type': 'application/json', 'x-simulation-signature': signed.signature}, body: signed.body});
    if (!res.ok) throw Error('payment webhook ' + res.status + ' ' + await res.text());
    return intent;
  }
  const state = async id => (await db.query('SELECT state FROM shipments WHERE id=$1', [id])).rows[0]?.state;

  /** Rider side of any delivery: offer, accept, pickup code, ride, delivery code. Returns a timeline. */
  async function deliver(r, shipmentId, from, to, {cash = null, customer} = {}) {
    const timeline = [];
    const mark = async step => timeline.push({step, state: await state(shipmentId)});
    await dispatch.tick();
    const offers = (await must(r.token, 'GET', '/api/v1/rider/offers'));
    const offer = offers.find(o => o.id === shipmentId);
    if (!offer) {
      const s = (await db.query('SELECT state,next_dispatch_at>now() AS waiting,next_dispatch_at,no_rider_since,dispatch_attempts,payment_method,paid FROM shipments WHERE id=$1', [shipmentId])).rows[0];
      const tried = (await db.query('SELECT status,rider_id FROM dispatch_offers WHERE shipment_id=$1', [shipmentId])).rows;
      const ex = (await db.query('SELECT kind,detail FROM dispatch_exceptions WHERE shipment_id=$1', [shipmentId]).catch(() => ({rows: []}))).rows;
      const fo = (await db.query('SELECT status,ready_at,dispatch_released_at FROM food_orders WHERE shipment_id=$1', [shipmentId]).catch(e => ({rows: [{error: e.message}]}))).rows[0];
      await db.query('UPDATE shipments SET next_dispatch_at=now() WHERE id=$1', [shipmentId]);
      const retry = await dispatch.dispatchShipment(shipmentId).catch(e => ({error: e.message}));
      const req = (await db.query('SELECT q.request FROM shipments s JOIN quotes q ON q.id=s.quote_id WHERE s.id=$1', [shipmentId])).rows[0].request;
      const near = await dispatch.nearby(req.pickup, req.weightG, {vehicle: req.vehicle ?? null, shipmentId, parcelCategory: req.parcelCategory ?? 'general', parcelSize: req.parcelSize ?? 'small'}).catch(e => [{error: e.message}]);
      const pol = (await db.query('SELECT * FROM dispatch_policy WHERE id=1')).rows[0]; const fo2 = (await db.query('SELECT ready_at, now() AS now FROM food_orders WHERE shipment_id=$1', [shipmentId])).rows[0]; if (process.env.SIM_DEBUG) console.error('POLICY', JSON.stringify({slack: pol.delivery_slack_seconds, maxPickup: pol.max_pickup_eta_seconds, offer: pol.offer_seconds, fo2})); const ranked = await dispatch.evaluate(near.filter(n => !n.error), req.pickup, {request: req, shipmentId, dispatchPolicy: pol}).catch(e => [{error: e.message}]);
      if (process.env.SIM_DEBUG) console.error('NO OFFER', JSON.stringify({req, near: near.map(n => ({id: n.id, crow: n.crow_meters, error: n.error})), ranked: ranked.map?.(x => ({id: x.id, eta: x.pickupEtaSeconds, error: x.error})) ?? ranked}));
      const riderRow = (await db.query("SELECT id,online,status,vehicle,max_weight_g,position_at,ST_Y(current_position::geometry) lat,ST_X(current_position::geometry) lng FROM riders WHERE id=$1", [r.id])).rows[0];
      const audits = (await db.query("SELECT action,detail FROM audit_log WHERE entity_id=$1 ORDER BY created_at", [shipmentId]).catch(e => ({rows: [e.message]}))).rows;
      throw Error('rider got no offer: ' + JSON.stringify({shipment: s, offers: tried, exceptions: ex, retry, rider: riderRow, audits}));
    }
    await mark('offered');
    await must(r.token, 'POST', `/api/v1/shipments/${shipmentId}/accept`, {offerId: offer.offerId});
    await mark('accepted');
    const trackingAfterAccept = customer ? await api(customer.token, 'GET', `/api/v1/public-track/${shipmentId}`) : null;
    await gps(r, from);
    // A sender paying cash hands it over at pickup, before the parcel is released.
    if (cash?.payer === 'sender') await must(r.token, 'POST', '/api/v1/rider/cash-report', {shipmentId, reportedMinor: cash.amountMinor, cashPayer: 'sender', idempotencyKey: 'cash-' + randomUUID()});
    const pc = await must(r.token, 'POST', `/api/v1/shipments/${shipmentId}/pickup-challenge`, {});
    await must(r.token, 'POST', `/api/v1/shipments/${shipmentId}/verify`, {challengeId: pc.challengeId, code: codeFor(pc.challengeId)});
    await mark('picked up');
    await must(r.token, 'POST', `/api/v1/shipments/${shipmentId}/transition`, {action: 'start'});
    await mark('on the way');
    // Halfway there, then at the door.
    await gps(r, {latitude: (from.latitude + to.latitude) / 2, longitude: (from.longitude + to.longitude) / 2});
    const trackingMidway = customer ? await api(customer.token, 'GET', `/api/v1/public-track/${shipmentId}`) : null;
    if (process.env.SIM_DEBUG) console.error('GPS', JSON.stringify((await db.query(`SELECT l.updated_at, now() AS now, (SELECT json_agg(x ORDER BY x.observed_at DESC) FROM (SELECT observed_at, ST_Y(position::geometry) lat, ST_X(position::geometry) lng FROM rider_location_samples WHERE rider_id=$2 ORDER BY observed_at DESC LIMIT 3) x) AS samples FROM locations l WHERE l.shipment_id=$1`, [shipmentId, r.id])).rows[0]));
    await gps(r, to);
    if (cash?.payer === 'recipient') await must(r.token, 'POST', '/api/v1/rider/cash-report', {shipmentId, reportedMinor: cash.amountMinor, cashPayer: cash.payer, idempotencyKey: 'cash-' + randomUUID()});
    const dc = await must(r.token, 'POST', `/api/v1/shipments/${shipmentId}/delivery-challenge`, {});
    const done = await must(r.token, 'POST', `/api/v1/shipments/${shipmentId}/verify`, {challengeId: dc.challengeId, code: codeFor(dc.challengeId)});
    await mark('delivered');
    return {offer, timeline, done, trackingAfterAccept, trackingMidway};
  }
  async function riderMoney(r) {
    const earnings = await api(r.token, 'GET', '/api/v1/earnings');
    const wallet = await api(r.token, 'GET', '/api/v1/rider/wallet/summary');
    return {earnings: earnings.data, wallet: wallet.data};
  }
  const etaText = eta => eta && typeof eta === 'object' ? `${eta.low ?? eta.min}–${eta.high ?? eta.max} min` : eta;

  try {
    await db.query("UPDATE checkout_method_policies SET enabled=true WHERE method IN ('MOMO','CASH')");
    const customer = await account('customer');

    for (const p of PARCELS) {
      await offline();
      const from = PLACES[p.from], to = PLACES[p.to];
      const road = roadModel(from, to, {vehicle: p.vehicle});
      const row = {name: p.name, vehicle: p.vehicle, payment: p.pay + (p.cashPayer ? ` (${p.cashPayer})` : ''), roadKm: +(road.distanceMeters / 1000).toFixed(1), roadMinutes: Math.round(road.durationSeconds / 60)};
      try {
        const r = await rider(p.vehicle, {latitude: from.latitude + 0.004, longitude: from.longitude + 0.003});
        const quote = await must(customer.token, 'POST', '/api/v1/quotes', {pickup: from, destination: to, vehicle: p.vehicle, recipientPhone: simulationPhone(), weightG: p.weightG, description: 'SIMULATION ONLY parcel', paymentMethod: p.pay, ...(p.cashPayer ? {cashPayer: p.cashPayer} : {})});
        const amount = Number(quote.amount_minor ?? quote.amountMinor);
        Object.assign(row, {price: cedis(amount), priceMinor: amount, breakdown: quote.fareBreakdown, quoteEta: etaText(quote.etaMinutes), quoteEtaRaw: quote.etaMinutes});
        const s = await must(customer.token, 'POST', '/api/v1/shipments', {quoteId: quote.id}, {'Idempotency-Key': 'sim-' + randomUUID()});
        row.stateAfterBooking = await state(s.id);
        if (p.pay !== 'CASH') { await pay(customer, s.id); row.stateAfterPayment = await state(s.id); }
        const result = await deliver(r, s.id, from, to, {customer, cash: p.pay === 'CASH' ? {amountMinor: amount, payer: p.cashPayer} : null});
        row.riderOffer = {payout: cedis(result.offer.riderPayoutMinor ?? result.offer.payoutMinor ?? result.offer.earningsMinor), pickupKm: result.offer.pickupDistanceMeters != null ? +(result.offer.pickupDistanceMeters / 1000).toFixed(1) : result.offer.pickupKm, raw: Object.fromEntries(Object.entries(result.offer).filter(([k]) => /minor|eta|distance|km|minutes/i.test(k)))};
        row.trackingAfterAccept = result.trackingAfterAccept?.status === 200 ? pick(result.trackingAfterAccept.data) : result.trackingAfterAccept;
        row.trackingMidway = result.trackingMidway?.status === 200 ? pick(result.trackingMidway.data) : result.trackingMidway;
        row.timeline = result.timeline.map(t => `${t.step}: ${t.state}`).join(' → ');
        row.final = await state(s.id);
        const money = await riderMoney(r);
        row.rider = summarizeMoney(money);
        check(row.final === 'COMPLETED', `${p.name}: delivered`, row.final);
        check(amount > 0, `${p.name}: has a price`, amount);
        checkEta(check, p.name, quote.etaMinutes, road);
        checkFare(check, p.name, quote.fareBreakdown, amount);
      } catch (e) {
        row.error = e.message; check(false, `${p.name}: journey completes`, e.message);
      }
      report.parcels.push(row);
    }

    for (const p of REFUSED) {
      const from = typeof p.from === 'string' ? PLACES[p.from] : p.from, to = PLACES[p.to];
      const res = await api(customer.token, 'POST', '/api/v1/quotes', {pickup: from, destination: to, vehicle: p.vehicle, recipientPhone: simulationPhone(), weightG: p.weightG, description: 'SIMULATION ONLY parcel', paymentMethod: p.pay});
      report.refused.push({name: p.name, status: res.status, message: res.data.error ?? null, price: cedis(res.data.amount_minor)});
      check(res.status >= 400 && res.status < 500, `${p.name}: refused with a clear reason`, `${res.status} ${res.data.error ?? cedis(res.data.amount_minor)}`);
    }

    const admin = randomUUID();
    await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'simulation-only','admin',now())", [admin, simulationPhone()]);
    await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'verification:write')", [admin]);
    for (const f of FOOD) {
      await offline();
      const kitchenAt = PLACES[f.kitchen], to = PLACES[f.to];
      const row = {name: f.name};
      try {
        const owner = await account('business');
        const made = await must(owner.token, 'POST', '/api/v1/restaurants', {name: 'Simulation Kitchen ' + randomInt(1e6), phone: '0241234567', address: kitchenAt.address, latitude: kitchenAt.latitude, longitude: kitchenAt.longitude});
        await restaurantService(db).updateRestaurant({id: admin, kind: 'admin'}, made.id, {status: 'approved'});
        await db.query("UPDATE restaurants SET opening_hours=NULL WHERE id=$1", [made.id]).catch(() => {});
        const items = [];
        for (const [name, priceMinor, quantity] of f.items) items.push({itemId: (await must(owner.token, 'POST', `/api/v1/restaurants/${made.id}/items`, {name, priceMinor})).id, quantity});
        const order = {restaurantId: made.id, items, deliveryAddress: to.address, deliveryLatitude: to.latitude, deliveryLongitude: to.longitude, customerPhone: '0241234567'};
        const quote = await must(customer.token, 'POST', '/api/v1/food-orders/quote', order);
        row.quote = foodMoney(quote);
        const placed = await must(customer.token, 'POST', '/api/v1/food-orders', {...order, idempotencyKey: 'sim-' + randomUUID()}, {'Idempotency-Key': 'sim-' + randomUUID()});
        const orderId = placed.id ?? placed.order?.id, shipmentId = placed.shipment_id ?? placed.shipmentId ?? placed.order?.shipment_id;
        row.placed = foodMoney(placed);
        row.status = ['placed: ' + (placed.state ?? placed.order?.state)];
        await pay(customer, shipmentId);
        const statusOf = async () => { const o = await must(customer.token, 'GET', `/api/v1/food-orders/${orderId}`); return (o.order ?? o).state; };
        row.status.push('paid: ' + await statusOf());
        await must(owner.token, 'POST', `/api/v1/food-orders/${orderId}/accept`, {prepMinutes: 15});
        row.status.push('kitchen accepted: ' + await statusOf());
        await must(owner.token, 'POST', `/api/v1/food-orders/${orderId}/prepare`, {});
        row.status.push('cooking: ' + await statusOf());
        // Riders are already out when food is ready, as they would be at lunchtime.
        const r = await rider('motorcycle', {latitude: kitchenAt.latitude + 0.003, longitude: kitchenAt.longitude + 0.002});
        await must(owner.token, 'POST', `/api/v1/food-orders/${orderId}/ready`, {});
        row.status.push('ready: ' + await statusOf());
        const result = await deliver(r, shipmentId, kitchenAt, to, {customer});
        row.status.push('delivered: ' + await statusOf());
        row.riderOffer = Object.fromEntries(Object.entries(result.offer).filter(([k]) => /minor|eta|distance|km|minutes/i.test(k)));
        row.trackingAfterAccept = result.trackingAfterAccept?.status === 200 ? pick(result.trackingAfterAccept.data) : result.trackingAfterAccept;
        row.timeline = result.timeline.map(t => `${t.step}: ${t.state}`).join(' → ');
        row.rider = summarizeMoney(await riderMoney(r));
        const settlement = await api(owner.token, 'GET', `/api/v1/restaurants/${made.id}/settlements`);
        row.kitchenSettlement = settlement.status === 200 ? settlement.data : settlement;
        const finalState = await state(shipmentId);
        check(finalState === 'COMPLETED', `${f.name}: food delivered`, finalState);
        const itemsTotal = f.items.reduce((s, [, price, q]) => s + price * q, 0);
        check(Number(quote.subtotalMinor ?? quote.subtotal_minor ?? quote.itemsMinor) === itemsTotal, `${f.name}: food subtotal matches the menu`, {expected: itemsTotal, quote: row.quote});
      } catch (e) {
        row.error = e.message; check(false, `${f.name}: food journey completes`, e.message);
      }
      report.food.push(row);
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
  report.passed = report.checks.filter(c => c.ok).length;
  report.failed = report.checks.filter(c => !c.ok).length;
  return report;
}

function pick(t) {
  // What the customer app shows while waiting: the live arrival estimate and the stage.
  if (!t || typeof t !== 'object') return t;
  const e = t.deliveryEta ?? {};
  return {stage: e.stage ?? t.state ?? t.status, eta: e.status === 'estimated' ? `${e.minMinutes}–${e.maxMinutes} min` : e.status, confidence: e.confidence, message: e.message};
}
function foodMoney(q) {
  const out = {};
  for (const [k, v] of Object.entries(q?.order ?? q ?? {})) if (/minor|eta|minutes|status/i.test(k) && (typeof v !== 'object' || v === null)) out[k] = /minor/i.test(k) ? cedis(v) : v;
  return out;
}
function summarizeMoney({earnings, wallet}) {
  const out = {};
  for (const [k, v] of Object.entries(wallet ?? {})) if (/minor/i.test(k) && typeof v !== 'object') out['wallet.' + k] = cedis(v);
  for (const [k, v] of Object.entries(earnings ?? {})) if (/minor|total|count/i.test(k) && typeof v !== 'object') out['earnings.' + k] = /minor/i.test(k) ? cedis(v) : v;
  return out;
}
function checkEta(check, name, eta, road) {
  const low = Number(eta?.low ?? eta?.min), high = Number(eta?.high ?? eta?.max), ride = road.durationSeconds / 60;
  check(Number.isFinite(low) && Number.isFinite(high) && low > 0 && low <= high, `${name}: ETA is a sensible range`, eta);
  check(high >= ride * 0.8, `${name}: ETA is not shorter than the ride itself`, {eta, rideMinutes: Math.round(ride)});
  check(low <= ride * 3 + 45, `${name}: ETA is not wildly long`, {eta, rideMinutes: Math.round(ride)});
}
function checkFare(check, name, b, amount) {
  if (!b) return check(false, `${name}: fare has a breakdown`);
  const parts = Object.entries(b).filter(([k, v]) => /Minor$/.test(k) && typeof v === 'number');
  check(parts.length > 0, `${name}: fare has a breakdown`, b);
  if (Number.isFinite(b.totalMinor)) check(b.totalMinor === amount, `${name}: breakdown total equals the price`, {total: b.totalMinor, amount});
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  process.env.NODE_ENV ||= 'test';
  withSimulationDatabase(runFullJourneys).then(report => {
    const out = process.argv.indexOf('--json');
    if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report, null, 1));
    if (report.failed) process.exitCode = 1;
  }).catch(e => { console.error(e); process.exitCode = 1; });
}
