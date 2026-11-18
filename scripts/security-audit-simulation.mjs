// SIMULATION ONLY: security sweep of every API route, plus targeted attacks, on a throwaway database.
//   1. Every route with no account: only routes meant to be public may answer.
//   2. Every admin route as a customer, a rider, a kitchen owner and an admin with no permissions: all refused.
//   3. Every route with junk input: none may fail with a server error.
//   4. Sign-in, codes, sessions, SMS cost, company API keys, uploads, promotions, withdrawals, headers.
//   NODE_ENV=test TEST_DATABASE_URL=postgres://.../elesend_test node scripts/security-audit-simulation.mjs [--json out.json]
import {randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {journeyHarness} from './full-journey-simulation.mjs';
import {simulationPhone, withSimulationDatabase} from './local-simulation-support.mjs';

// Routes anyone may call: sign-up and sign-in, public map data, signed tracking links, payment and identity
// providers' callbacks (which check their own signatures), and the token-protected document upload page.
export const PUBLIC_ROUTES = [
  'POST /api/v1/auth/login', 'POST /api/v1/auth/register', 'POST /api/v1/auth/password-recovery', 'POST /api/v1/auth/password-reset',
  'GET /api/v1/maps/config', 'GET /api/v1/maps/style.json', 'GET /api/v1/pricing/vehicles', 'GET /api/v1/payments/methods',
  'GET /track/:id', 'GET /api/v1/public-track/:id', 'GET /restaurant/manifest.json', 'GET /rider-documents',
  'POST /api/v1/rider-documents/required', 'POST /api/v1/rider-documents/upload',
  'POST /api/v1/payments/checkout-webhook', 'POST /api/v1/payments/commission-webhook', 'POST /api/v1/payments/webhook', 'POST /api/v1/identity/webhook'
];

export function apiRoutes(source = readFileSync(new URL('../services/api/http.mjs', import.meta.url), 'utf8')) {
  const routes = new Map();
  for (const m of source.matchAll(/method===?'(GET|POST|PUT|PATCH|DELETE)'&&path===?'([^']+)'/g)) routes.set(`${m[1]} ${m[2]}`, {method: m[1], path: m[2], label: `${m[1]} ${m[2]}`});
  for (const m of source.matchAll(/method===?'(GET|POST|PUT|PATCH|DELETE)'&&\(?(?:\w+=)?\/\^(.{0,200}?)\$\//g)) {
    const pattern = m[2].replaceAll('\\/', '/');
    const id = randomUUID();
    const path = pattern.replace(/\[0-9a-f\.?-\]\{36,100\}|\[0-9a-f-\]\{36\}|\[0-9a-f-\]\+|\[\^\/\]\+|\(\[\^\/\]\+\)|\(\[0-9a-f-\]\+\)/g, id).replace(/\\\./g, '.');
    if (/[\[\]()\\+*?{}^$|]/.test(path)) continue;
    const label = `${m[1]} ${pattern.replace(/\[[^\]]+\](\{[\d,]+\}|\+)?|\(\[\^\/\]\+\)/g, ':id')}`;
    routes.set(label, {method: m[1], path, label});
  }
  // Shipment actions share one pattern in the router.
  for (const action of ['', '/accept', '/handover', '/receipt', '/pickup-challenge', '/delivery-challenge', '/return-challenge', '/verify', '/transition', '/location', '/tracking', '/dispatch', '/disputes', '/cancel-terms', '/recipient', '/rider-photo']) {
    for (const method of action === '' || ['/tracking', '/dispatch', '/cancel-terms', '/rider-photo'].includes(action) ? ['GET'] : ['POST']) {
      routes.set(`${method} /api/v1/shipments/:id${action}`, {method, path: `/api/v1/shipments/${randomUUID()}${action}`, label: `${method} /api/v1/shipments/:id${action}`});
    }
  }
  routes.set('POST /api/v1/payments/webhook', {method: 'POST', path: '/api/v1/payments/webhook', label: 'POST /api/v1/payments/webhook'});
  return [...routes.values()];
}

export async function runSecurityAudit(db) {
  const h = await journeyHarness(db);
  const {api, must, account, rider, PLACES, base, texts} = h;
  const results = [];
  const expect = (area, what, ok, detail) => results.push({area, what, ok: Boolean(ok), ...(ok ? {} : {detail})});
  const routes = apiRoutes();
  const refused = s => s === 401 || s === 403 || s === 404;
  const raw = (method, path, {token, body, headers = {}} = {}) => fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {}), ...headers}, body: method === 'GET' ? undefined : body ?? '{}'});
  // Every simulated request comes from 127.0.0.1, so each section starts with fresh per-address limits,
  // as if it came from a different phone; limits are then tested inside the section.
  const safely = async (area, what, fn) => { await db.query('DELETE FROM rate_limits').catch(() => {}); try { await fn(); } catch (e) { expect(area, what, false, 'scenario error: ' + e.message); } };

  try {
    // ---------- 1. No account ----------
    await safely('signed-out', 'sweep', async () => {
      const answered = [];
      for (const r of routes) {
        if (PUBLIC_ROUTES.includes(r.label)) continue;
        const res = await raw(r.method, r.path);
        if (!refused(res.status) && res.status !== 400 && res.status !== 413 && res.status !== 405) answered.push(`${r.label} -> ${res.status}`);
        if (res.status >= 500) answered.push(`${r.label} -> ${res.status} (server error)`);
      }
      expect('signed-out', `no private route answers without an account (${routes.length} routes)`, answered.length === 0, answered);
    });

    await safely('cargo', 'truck approval and expiry', async () => {
      const prior = (await db.query("SELECT enabled,min_licence_class FROM vehicle_capabilities WHERE vehicle='box_truck'")).rows[0];
      const details = {plateNumber: 'GT 7421-26', make: 'MAN', model: 'TGS', color: 'White', payloadCapacityG: 7000000, bodyType: 'closed', roadworthyExpiresOn: '2027-12-31', insuranceExpiresOn: '2027-12-31'};
      try {
        await db.query("UPDATE vehicle_capabilities SET enabled=true,min_licence_class=NULL WHERE vehicle='box_truck'");
        const truck = await account('rider', {vehicle: 'box_truck', maxWeightG: 7000000, vehicleDetails: details});
        await db.query("UPDATE riders SET status='approved' WHERE id=$1", [truck.id]);
        const unreviewed = await api(truck.token, 'POST', '/api/v1/rider/availability', {online: true});
        expect('cargo', 'a truck with pending vehicle review cannot go online', unreviewed.status === 403, unreviewed);
        await db.query("UPDATE rider_vehicle_registrations SET verification_status='approved' WHERE rider_id=$1", [truck.id]);
        const approved = await api(truck.token, 'POST', '/api/v1/rider/availability', {online: true});
        expect('cargo', 'an approved truck with current papers can go online', approved.status === 200, approved);
        await db.query("UPDATE rider_vehicle_registrations SET roadworthy_expires_on=CURRENT_DATE-1 WHERE rider_id=$1", [truck.id]);
        const {suspendExpiredDocuments} = await import('../services/api/modules/riders/index.mjs');
        await suspendExpiredDocuments(db);
        const suspended = (await db.query('SELECT status,online FROM riders WHERE id=$1', [truck.id])).rows[0];
        expect('cargo', 'an expired roadworthy document suspends the truck and takes it offline', suspended?.status === 'suspended' && !suspended.online, suspended);
      } finally {
        await db.query("UPDATE vehicle_capabilities SET enabled=$1,min_licence_class=$2 WHERE vehicle='box_truck'", [prior.enabled, prior.min_licence_class]);
      }
    });

    await safely('cargo', 'helper and floor price tampering', async () => {
      const customer = await account('customer');
      const payload = {pickup: PLACES.accraMall, destination: PLACES.osuOxford, vehicle: 'motorcycle', recipientPhone: simulationPhone(), weightG: 1000, description: 'Simulation cargo', paymentMethod: 'CASH', helpers: 1, pickupFloorsNoLift: 1, dropoffFloorsNoLift: 1};
      const changedRates = await api(customer.token, 'POST', '/api/v1/quotes', {...payload, perHelperMinor: 1, perFloorMinor: 1, helperPriceMinor: 1, floorPriceMinor: 1});
      expect('cargo', 'the quote rejects client-supplied helper and floor prices', changedRates.status === 400, changedRates);
      const tooMany = await api(customer.token, 'POST', '/api/v1/quotes', {...payload, helpers: 5});
      expect('cargo', 'the quote rejects more than four helpers', tooMany.status === 400, tooMany);
      const tooManyFloors = await api(customer.token, 'POST', '/api/v1/quotes', {...payload, pickupFloorsNoLift: 101});
      expect('cargo', 'the quote rejects floor counts outside the configured bound', tooManyFloors.status === 400, tooManyFloors);
    });

    // ---------- 2. Admin routes as everyone else ----------
    await safely('admin', 'sweep', async () => {
      const customer = await account('customer'), business = await account('business');
      const riderAcct = await rider('motorcycle', PLACES.accraMall);
      // An admin who has passed MFA but holds no permissions: only the permission checks stand in the way.
      const bare = await account('customer');
      await db.query("UPDATE users SET kind='admin' WHERE id=$1", [bare.id]);
      await db.query("UPDATE sessions SET admin_mfa_verified=true,last_seen_at=now() WHERE user_id=$1", [bare.id]);
      expect('admin', 'the MFA-verified admin session works', (await api(bare.token, 'GET', '/api/v1/me')).status === 200);
      // Without MFA, an admin account gets nothing at all.
      const noMfa = await account('customer');
      await db.query("UPDATE users SET kind='admin' WHERE id=$1", [noMfa.id]);
      expect('admin', 'an admin session without MFA is refused everywhere', (await api(noMfa.token, 'GET', '/api/v1/me')).status === 401);
      const noCode = await api(null, 'POST', '/api/v1/auth/login', {phone: noMfa.phone, password: 'x'.repeat(12)});
      expect('admin', 'an admin cannot sign in without an authenticator code', noCode.status === 401 || noCode.status === 403 || noCode.status === 429, noCode.status);
      const admin = routes.filter(r => r.path.includes('/admin'));
      for (const [who, token] of [['customer', customer.token], ['rider', riderAcct.token], ['kitchen owner', business.token], ['admin with no permissions', bare.token]]) {
        const leaked = [];
        for (const r of admin) {
          const res = await raw(r.method, r.path, {token});
          if (res.status < 400 || res.status >= 500) leaked.push(`${r.label} -> ${res.status}`);
        }
        expect('admin', `a ${who} is refused by all ${admin.length} admin routes`, leaked.length === 0, leaked);
      }
      // An admin idle for over 30 minutes is signed out.
      await db.query("UPDATE sessions SET last_seen_at=now()-interval '31 minutes' WHERE user_id=$1", [bare.id]);
      expect('admin', 'an admin idle for 30 minutes is signed out', (await api(bare.token, 'GET', '/api/v1/me')).status === 401);
      // One permission opens only its own area: list what an admin with just 'verification:write' can reach.
      const narrow = await account('customer');
      await db.query("UPDATE users SET kind='admin' WHERE id=$1", [narrow.id]);
      await db.query("UPDATE sessions SET admin_mfa_verified=true,last_seen_at=now() WHERE user_id=$1", [narrow.id]);
      await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'verification:write')", [narrow.id]);
      const reached = [];
      for (const r of admin.filter(r => r.method === 'GET')) { const res = await raw(r.method, r.path, {token: narrow.token}); if (res.status === 200) reached.push(r.label); }
      const outside = reached.filter(l => /finance|payment|wallet|settlement|withdraw|refund|commission|pricing|promotion|dispatch|feature|audit-log|security/i.test(l));
      expect('admin', "an admin who may only verify riders and kitchens cannot read finance, pricing or dispatch", outside.length === 0, {outside, reached});
    });

    // ---------- 3. Junk input ----------
    await safely('robustness', 'sweep', async () => {
      const customer = await account('customer');
      const riderAcct = await rider('motorcycle', PLACES.accraMall);
      const junk = ['{}', '[]', '"x"', 'null', '{"__proto__":{"isAdmin":true}}', '{"a":' + '['.repeat(2000) + ']'.repeat(2000) + '}', 'not json', JSON.stringify({id: "' OR 1=1 --", limit: -1, latitude: 'NaN', amountMinor: 1e309})];
      const crashed = new Set();
      for (const r of routes.filter(r => r.method !== 'GET' && !r.path.includes('/admin'))) {
        for (const token of [customer.token, riderAcct.token]) {
          for (const body of junk) {
            const res = await raw(r.method, r.path, {token, body});
            if (res.status >= 500 && res.status !== 503) crashed.add(`${r.label} -> ${res.status} for ${body.slice(0, 30)}`);
          }
        }
      }
      expect('robustness', 'no route fails with a server error on junk input', crashed.size === 0, [...crashed]);
      // The sweep above also called logout with this account, so check with a fresh one.
      const fresh = await account('customer');
      await raw('POST', '/api/v1/me/terms', {token: fresh.token, body: '{"__proto__":{"isAdmin":true,"kind":"admin"},"constructor":{"prototype":{"isAdmin":true}}}'});
      await raw('POST', '/api/v1/quotes', {token: fresh.token, body: '{"__proto__":{"kind":"admin"}}'});
      const proto = await api(fresh.token, 'GET', '/api/v1/me');
      const adminList = await api(fresh.token, 'GET', '/api/v1/admin/restaurants');
      expect('robustness', 'sending __proto__ does not change anyone into an admin', proto.data.kind === 'customer' && proto.data.isAdmin === undefined && adminList.status === 403, {me: proto.data.kind, admin: adminList.status});
      expect('robustness', 'the server has not been polluted for other requests', ({}).isAdmin === undefined && ({}).kind === undefined);
    });

    // ---------- 4. Sign-in, codes and sessions ----------
    await safely('sign-in', 'sign-in', async () => {
      const phone = simulationPhone(), password = 'correct horse battery ' + randomUUID().slice(0, 4);
      await must(null, 'POST', '/api/v1/auth/register', {phone, password, kind: 'customer', termsVersion: '2026-11-09'});
      const statuses = [];
      for (let i = 0; i < 12; i++) statuses.push((await api(null, 'POST', '/api/v1/auth/login', {phone, password: 'wrong guess number ' + i})).status);
      expect('sign-in', 'guessing a password is stopped after a few tries', statuses.some(s => s === 429 || s === 423), statuses);
      const unknown = await api(null, 'POST', '/api/v1/auth/login', {phone: simulationPhone(), password: 'whatever password 1'});
      const wrong = await api(null, 'POST', '/api/v1/auth/login', {phone: simulationPhone(), password: 'another password 22'});
      expect('sign-in', 'sign-in does not reveal whether a phone number has an account', unknown.data.error === wrong.data.error, {unknown: unknown.data, wrong: wrong.data});
      const reg = await api(null, 'POST', '/api/v1/auth/register', {phone, password: 'another strong password', kind: 'customer', termsVersion: '2026-11-09'});
      expect('sign-in', 'registering an existing number does not sign anyone in as its owner', !reg.data.token, reg.status);
      const weak = await api(null, 'POST', '/api/v1/auth/register', {phone: simulationPhone(), password: 'short', kind: 'customer', termsVersion: '2026-11-09'});
      expect('sign-in', 'a 5-character password is refused', weak.status === 400);
      const selfAdmin = await api(null, 'POST', '/api/v1/auth/register', {phone: simulationPhone(), password: 'long enough password', kind: 'admin', termsVersion: '2026-11-09'});
      expect('sign-in', 'nobody can sign up as an admin', selfAdmin.status === 400 || selfAdmin.status === 403, selfAdmin.status);
    });

    await safely('sessions', 'sessions', async () => {
      const a = await account('customer');
      expect('sessions', 'a session works before logout', (await api(a.token, 'GET', '/api/v1/me')).status === 200);
      await must(a.token, 'POST', '/api/v1/auth/logout', {});
      expect('sessions', 'a session stops working after logout', (await api(a.token, 'GET', '/api/v1/me')).status === 401);
      const tampered = a.token.slice(0, -2) + (a.token.endsWith('a') ? 'bb' : 'aa');
      expect('sessions', 'a tampered session token is refused', (await api(tampered, 'GET', '/api/v1/me')).status === 401);
      expect('sessions', 'a session token in the address is not accepted', (await raw('GET', '/api/v1/me?token=' + a.token)).status === 401);
      // Password reset: old sessions end, and the code cannot be guessed.
      const phone = simulationPhone(), password = 'first password ' + randomUUID().slice(0, 6);
      await must(null, 'POST', '/api/v1/auth/register', {phone, password, kind: 'customer', termsVersion: '2026-11-09'});
      const login = await must(null, 'POST', '/api/v1/auth/login', {phone, password});
      await db.query('UPDATE users SET phone_verified_at=now() WHERE id=$1', [login.user.id]);
      const rec = await api(null, 'POST', '/api/v1/auth/password-recovery', {phone});
      const challengeId = rec.data.challengeId;
      // Wrong codes all get the same answer; after 5 the code is burned, so even the right one stops working.
      for (let i = 0; i < 5; i++) await api(null, 'POST', '/api/v1/auth/password-reset', {phone, challengeId, code: String(200000 + i), newPassword: 'attacker chosen password'});
      const realCode = texts.filter(t => t.challengeId === challengeId).at(-1)?.code;
      const late = await api(null, 'POST', '/api/v1/auth/password-reset', {phone, challengeId, code: realCode, newPassword: 'attacker chosen password'});
      expect('sessions', 'after 5 wrong password-reset codes even the right code is refused', !!realCode && late.status >= 400, {late: late.status, codeSent: !!realCode});
      if (challengeId) {
        await db.query('DELETE FROM rate_limits').catch(() => {});
        const rec2 = await api(null, 'POST', '/api/v1/auth/password-recovery', {phone});
        const code = texts.filter(t => t.phone === phone || t.challengeId === rec2.data.challengeId).at(-1)?.code;
        const reset = await api(null, 'POST', '/api/v1/auth/password-reset', {phone, challengeId: rec2.data.challengeId, code, newPassword: 'brand new password 99'});
        if (reset.status === 200) expect('sessions', 'resetting the password ends sessions signed in with the old one', (await api(login.token, 'GET', '/api/v1/me')).status === 401);
        else expect('sessions', 'a valid reset code works', false, reset);
      }
    });

    await safely('cost', 'sms', async () => {
      const a = await account('customer');
      await db.query('UPDATE users SET phone_verified_at=NULL WHERE id=$1', [a.id]);
      const sent = [];
      for (let i = 0; i < 10; i++) sent.push((await api(a.token, 'POST', '/api/v1/me/phone-challenge', {})).status);
      expect('cost', 'one account cannot trigger 10 confirmation texts in a row', sent.filter(s => s === 200).length <= 5, sent);
      const victim = simulationPhone(), floods = [];
      await must(null, 'POST', '/api/v1/auth/register', {phone: victim, password: 'victim password long', kind: 'customer', termsVersion: '2026-11-09'});
      for (let i = 0; i < 10; i++) floods.push((await api(null, 'POST', '/api/v1/auth/password-recovery', {phone: victim})).status);
      expect('cost', 'nobody can flood a phone with password-reset texts', floods.filter(s => s === 200).length <= 5, floods);
    });

    // ---------- 5. Company API keys ----------
    await safely('api-keys', 'keys', async () => {
      await db.query("UPDATE checkout_method_policies SET enabled=true WHERE method='MOMO'");
      const co = await account('company', {name: 'Audit Logistics', services: ['delivery']});
      await db.query("UPDATE companies SET status='approved' WHERE owner_id=$1", [co.id]);
      const made = await api(co.token, 'POST', '/api/v1/business/api-keys', {name: 'Audit key', scopes: ['quotes:write']});
      const key = made.data.key ?? made.data.apiKey ?? made.data.secret;
      if (made.status !== 200 || !key) { expect('api-keys', 'a company can create an API key', false, made); return; }
      const listed = await api(co.token, 'GET', '/api/v1/business/api-keys');
      expect('api-keys', 'listing keys never shows the secret again', !JSON.stringify(listed.data).includes(key));
      expect('api-keys', 'a key can quote', (await api(key, 'POST', '/api/v1/quotes', {pickup: PLACES.accraMall, destination: PLACES.osuOxford, vehicle: 'motorcycle', recipientPhone: simulationPhone(), weightG: 1000, description: 'Key quote test', paymentMethod: 'MOMO'})).status === 200);
      for (const [m, p, b] of [['POST', '/api/v1/business/api-keys', {name: 'Second', scopes: ['quotes:write']}], ['POST', '/api/v1/shipments', {quoteId: randomUUID()}], ['GET', '/api/v1/shipments'], ['POST', '/api/v1/me/delete-account', {password: 'x'}], ['GET', '/api/v1/rider/wallet/summary'], ['POST', '/api/v1/me/payout-beneficiary', {}], ['GET', '/api/v1/admin/restaurants']]) {
        const r = await api(key, m, p, b);
        expect('api-keys', `an API key cannot ${m} ${p}`, r.status >= 400 && r.status < 500, r.status);
      }
      const id = (Array.isArray(listed.data) ? listed.data : listed.data.keys ?? [])[0]?.id;
      if (id) {
        await must(co.token, 'POST', `/api/v1/business/api-keys/${id}/revoke`, {});
        expect('api-keys', 'a revoked key stops working', (await api(key, 'POST', '/api/v1/quotes', {pickup: PLACES.accraMall, destination: PLACES.osuOxford, vehicle: 'motorcycle', recipientPhone: simulationPhone(), weightG: 1000, description: 'Revoked', paymentMethod: 'MOMO'})).status === 401);
      }
      const other = await account('company', {name: 'Other Logistics', services: ['delivery']});
      await db.query("UPDATE companies SET status='approved' WHERE owner_id=$1", [other.id]);
      if (id) expect('api-keys', "a company cannot revoke another company's key", (await api(other.token, 'POST', `/api/v1/business/api-keys/${id}/revoke`, {})).status >= 400);
    });

    // ---------- 6. Uploads, outgoing webhooks, headers ----------
    await safely('uploads', 'uploads', async () => {
      const big = await fetch(base + '/api/v1/quotes', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{"x":"' + 'a'.repeat(200000) + '"}'});
      expect('uploads', 'a 200 KB request to an ordinary route is refused as too large', big.status === 413, big.status);
      const doc = await fetch(base + '/api/v1/rider-documents/upload', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token: 'x'.repeat(40), kind: 'profile_photo', imageBase64: Buffer.from('<?php system($_GET[1]); ?>').toString('base64')})});
      expect('uploads', 'an upload without a valid upload link is refused', doc.status >= 400 && doc.status < 500, doc.status);
    });
    await safely('webhooks', 'ssrf', async () => {
      const {validWebhookUrl} = await import('../services/api/modules/orders/api-webhooks.mjs').catch(() => ({}));
      if (typeof validWebhookUrl !== 'function') { expect('webhooks', 'webhook address rules can be checked', false, 'validWebhookUrl is not exported'); return; }
      for (const url of ['http://example.com/hook', 'https://127.0.0.1/hook', 'https://localhost/hook', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://user:pw@example.com/x', 'https://example.com:8443/x', 'https://0x7f000001/x']) {
        let ok = false; try { validWebhookUrl(url); } catch { ok = true; }
        expect('webhooks', `a company cannot point webhooks at ${url}`, ok);
      }
    });
    await safely('headers', 'headers', async () => {
      const res = await fetch(base + '/api/v1/maps/config');
      for (const [hname, test] of [['x-content-type-options', v => v === 'nosniff'], ['x-frame-options', v => v === 'DENY'], ['content-security-policy', v => /default-src/.test(v ?? '')], ['referrer-policy', v => v === 'no-referrer']]) expect('headers', `responses send ${hname}`, test(res.headers.get(hname)), res.headers.get(hname));
      expect('headers', 'responses do not say which server software runs', !res.headers.get('x-powered-by') && !/node|express/i.test(res.headers.get('server') ?? ''));
      const cors = await fetch(base + '/api/v1/me', {headers: {Origin: 'https://evil.example'}});
      expect('headers', 'browsers on other sites are not allowed to send cookies or credentials', cors.headers.get('access-control-allow-credentials') !== 'true');
      const err = await (await fetch(base + '/api/v1/quotes', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{bad'})).text();
      expect('headers', 'errors do not show code paths or stack traces', !/at \w+ \(|\.mjs:\d+|node_modules/.test(err), err.slice(0, 200));
    });

    // ---------- 7. Whose data: chat, sharing, ratings, references, company riders ----------
    await safely('ownership', 'ownership', async () => {
      await db.query("UPDATE checkout_method_policies SET enabled=true WHERE method='MOMO'");
      await h.offline();
      const alice = await account('customer'), bob = await account('customer');
      const r = await rider('motorcycle', PLACES.accraMall), stranger = await rider('motorcycle', PLACES.kumasiAdum);
      const q = await must(alice.token, 'POST', '/api/v1/quotes', {pickup: PLACES.accraMall, destination: PLACES.osuOxford, vehicle: 'motorcycle', recipientPhone: simulationPhone(), weightG: 1000, description: 'Ownership test', paymentMethod: 'MOMO'});
      const sh = await must(alice.token, 'POST', '/api/v1/shipments', {quoteId: q.id}, {'Idempotency-Key': 'own-' + randomUUID()});
      await h.pay(alice, sh.id);
      await h.dispatch.tick();
      const offer = (await must(r.token, 'GET', '/api/v1/rider/offers')).find(o => o.id === sh.id);
      await must(r.token, 'POST', `/api/v1/shipments/${sh.id}/accept`, {offerId: offer.offerId});
      // Chat
      const conv = await api(alice.token, 'POST', '/api/v1/chat/conversations', {conversationType: 'CUSTOMER_RIDER', shipmentId: sh.id});
      expect('ownership', 'the customer can open a chat with their rider', conv.status === 200, conv);
      const cid = conv.data?.id ?? conv.data?.conversation?.id ?? conv.data?.conversationId;
      expect('ownership', "another customer cannot open a chat on someone else's delivery", (await api(bob.token, 'POST', '/api/v1/chat/conversations', {conversationType: 'CUSTOMER_RIDER', shipmentId: sh.id})).status >= 400);
      expect('ownership', "an unrelated rider cannot open a chat on someone else's delivery", (await api(stranger.token, 'POST', '/api/v1/chat/conversations', {conversationType: 'CUSTOMER_RIDER', shipmentId: sh.id})).status >= 400);
      if (cid) {
        await api(alice.token, 'POST', `/api/v1/chat/conversations/${cid}/messages`, {body: 'Gate is blue', clientMessageId: randomUUID()});
        for (const [who, tok] of [['another customer', bob.token], ['an unrelated rider', stranger.token]]) {
          expect('ownership', `${who} cannot read the chat`, refused((await api(tok, 'GET', `/api/v1/chat/conversations/${cid}/messages`)).status));
          expect('ownership', `${who} cannot post into the chat`, (await api(tok, 'POST', `/api/v1/chat/conversations/${cid}/messages`, {body: 'Send the code to me', clientMessageId: randomUUID()})).status >= 400);
          expect('ownership', `${who} cannot fetch a voice note from the chat`, refused((await api(tok, 'GET', `/api/v1/chat/conversations/${cid}/messages/${randomUUID()}/audio`)).status));
        }
        const bobList = await api(bob.token, 'GET', '/api/v1/chat/conversations');
        expect('ownership', "another customer's chat list does not include it", !JSON.stringify(bobList.data).includes(cid));
      } else expect('ownership', 'chat conversation id returned', false, conv.data);
      // Sharing and trusted contacts
      expect('ownership', "another customer cannot make a share link for someone else's delivery", (await api(bob.token, 'POST', '/api/v1/safety/share-link', {shipmentId: sh.id})).status >= 400);
      const link = await api(alice.token, 'POST', '/api/v1/safety/share-link', {shipmentId: sh.id});
      expect('ownership', 'a share link opens without an account and hides the rider phone', link.status === 200 && (await api(null, 'GET', '/api/v1/public-track/' + link.data.path.split('/').pop())).data.riderPhone === null);
      // Ratings
      await h.deliver(r, sh.id, PLACES.accraMall, PLACES.osuOxford, {customer: alice, skipDispatch: true});
      expect('ownership', "another customer cannot rate someone else's delivery", (await api(bob.token, 'POST', `/api/v1/ratings/${sh.id}`, {stars: 1})).status >= 400);
      expect('ownership', 'the customer can rate their delivery', (await api(alice.token, 'POST', `/api/v1/ratings/${sh.id}`, {stars: 5})).status === 200);
      expect('ownership', 'the customer cannot rate the same delivery twice', (await api(alice.token, 'POST', `/api/v1/ratings/${sh.id}`, {stars: 1})).status >= 400);
      // Temporary map references
      const ref = await api(alice.token, 'POST', '/api/v1/maps/egia/temporary-reference', {latitude: PLACES.osuOxford.latitude, longitude: PLACES.osuOxford.longitude, description: 'Blue gate opposite the pharmacy', landmarkContext: 'Pharmacy'});
      const refId = ref.data?.id ?? ref.data?.referenceId;
      expect('ownership', 'a customer can save a delivery reference', !!refId, ref);
      if (refId) expect('ownership', "another customer cannot read someone's saved delivery reference", refused((await api(bob.token, 'GET', `/api/v1/maps/egia/temporary-reference/${refId}`)).status));
      // Company riders
      const coA = await account('company', {name: 'Company A', services: ['riders']}), coB = await account('company', {name: 'Company B', services: ['riders']});
      await db.query("UPDATE companies SET status='approved' WHERE owner_id=ANY($1)", [[coA.id, coB.id]]);
      const fleet = await rider('motorcycle', PLACES.accraMall);
      const coAId = (await db.query('SELECT id FROM companies WHERE owner_id=$1', [coA.id])).rows[0].id;
      await db.query('UPDATE riders SET company_id=$2 WHERE id=$1', [fleet.id, coAId]);
      expect('ownership', "a company cannot remove another company's rider", (await api(coB.token, 'POST', `/api/v1/company/riders/${fleet.id}/remove`, {})).status >= 400);
      expect('ownership', "a company cannot see another company's rider photo", refused((await api(coB.token, 'GET', `/api/v1/company/riders/${fleet.id}/photo`)).status));
      expect('ownership', "a company's rider list holds only its own riders", !JSON.stringify((await api(coB.token, 'GET', '/api/v1/company/riders')).data).includes(fleet.id));
      // Wallet top-ups and commission payments
      expect('ownership', "a rider cannot look up another rider's wallet top-up", refused((await api(stranger.token, 'GET', `/api/v1/rider/wallet/topups/${randomUUID()}`)).status));
    });

    // ---------- 8. Money abuse ----------
    await safely('money', 'promotions', async () => {
      const {restaurantService} = await import('../services/api/modules/food/index.mjs');
      const admin = randomUUID();
      await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'simulation-only','admin',now())", [admin, simulationPhone()]);
      await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'verification:write')", [admin]);
      const owner = await account('business');
      const k = await must(owner.token, 'POST', '/api/v1/restaurants', {name: 'Promo Kitchen ' + randomUUID().slice(0, 5), phone: '0241234567', address: PLACES.osuOxford.address, latitude: PLACES.osuOxford.latitude, longitude: PLACES.osuOxford.longitude});
      await restaurantService(db).updateRestaurant({id: admin, kind: 'admin'}, k.id, {status: 'approved'});
      // A price of 0 is allowed on purpose: free extras such as sauce or water.
      for (const priceMinor of [-500, 1e12, 12.5]) {
        const r = await api(owner.token, 'POST', `/api/v1/restaurants/${k.id}/items`, {name: 'Bad price ' + priceMinor, priceMinor});
        expect('money', `a menu price of ${priceMinor} pesewas is refused`, r.status === 400, r.status);
      }
      const item = await must(owner.token, 'POST', `/api/v1/restaurants/${k.id}/items`, {name: 'Fried rice', priceMinor: 4000});
      const c = await account('customer');
      const order = {restaurantId: k.id, deliveryAddress: PLACES.accraMall.address, deliveryLatitude: PLACES.accraMall.latitude, deliveryLongitude: PLACES.accraMall.longitude, customerPhone: '0241234567'};
      for (const quantity of [-2, 0, 1000000]) {
        const r = await api(c.token, 'POST', '/api/v1/food-orders/quote', {...order, items: [{itemId: item.id, quantity}]});
        expect('money', `a food quantity of ${quantity} is refused`, r.status === 400 || r.status === 422, {status: r.status, total: r.data.totalMinor});
      }
      for (const promo of [{type: 'percentage', valueBps: 15000}, {type: 'percentage', valueBps: -1000}, {type: 'fixed', valueMinor: -500}]) {
        const r = await api(owner.token, 'POST', `/api/v1/restaurants/${k.id}/promotions/preview`, {name: 'Bad promo', ...promo});
        expect('money', `a promotion of ${JSON.stringify(promo)} is refused`, r.status >= 400 && r.status < 500, r.status);
      }
    });
    await safely('money', 'withdrawals', async () => {
      const r = await rider('motorcycle', PLACES.accraMall);
      const tries = await Promise.all([1, 2, 3, 4, 5].map(() => api(r.token, 'POST', '/api/v1/rider/wallet/withdraw', {idempotencyKey: 'wd-' + randomUUID(), password: 'wrong password'})));
      expect('money', 'a withdrawal with the wrong password is refused', tries.every(t => t.status === 403 || t.status === 503 || t.status === 429), tries.map(t => t.status));
      const top = await api(r.token, 'POST', '/api/v1/rider/wallet/topups', {amountMinor: -5000, idempotencyKey: 'tp-' + randomUUID()});
      expect('money', 'a negative wallet top-up is refused', top.status === 400, top.status);
      const settle = await api(r.token, 'POST', '/api/v1/rider/finance/settle', {amountMinor: -100});
      expect('money', 'a negative settlement is refused', settle.status >= 400 && settle.status < 500, settle.status);
    });
  } finally {
    await h.close();
  }
  const failed = results.filter(r => !r.ok);
  return {SIMULATED_ONLY: true, ranAt: new Date().toISOString(), routes: routes.length, total: results.length, passed: results.length - failed.length, failed: failed.length, failures: failed, results};
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  process.env.NODE_ENV ||= 'test';
  withSimulationDatabase(runSecurityAudit).then(report => {
    const out = process.argv.indexOf('--json');
    if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify(report, null, 1));
    console.log(JSON.stringify({routes: report.routes, total: report.total, passed: report.passed, failed: report.failed, failures: report.failures}, null, 1));
    if (report.failed) process.exitCode = 1;
  }).catch(e => { console.error(e); process.exitCode = 1; });
}
