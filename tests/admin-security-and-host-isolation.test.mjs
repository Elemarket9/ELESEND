import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {httpServer} from '../services/api/http.mjs';

function createMockDb() {
  const counts = new Map();
  return {
    async query(sql, args) {
      if (sql && sql.startsWith('INSERT INTO rate_limits')) {
        const count = (counts.get(args[0]) ?? 0) + 1;
        counts.set(args[0], count);
        return { rows: [{ count }] };
      }
      return { rows: [], rowCount: 0 };
    }
  };
}

test('Admin security and hostname isolation audit', async (t) => {
  const originalAdminHost = process.env.ADMIN_HOST;
  process.env.ADMIN_HOST = 'control.elesend.com';

  const actors = {
    customer: { id: 'cust-1234', kind: 'customer' },
    rider: { id: 'rider-1234', kind: 'rider' },
    merchant: { id: 'biz-1234', kind: 'business', api_client_id: 'client-1234', scopes: ['quotes:write', 'shipments:read'] },
    admin: { id: 'admin-1234', kind: 'admin' }
  };

  const app = {
    async authenticate(token) {
      if (!token) throw Object.assign(new Error('Authentication required'), { status: 401 });
      const actor = actors[token];
      if (!actor) throw Object.assign(new Error('Authentication required'), { status: 401 });
      return actor;
    }
  };

  const dispatcher = {
    async algorithmFeatures(actor) {
      return [{ feature_key: 'vrp_optimization', enabled: true }];
    }
  };

  const server = httpServer(createMockDb(), app, dispatcher, null, null);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    server.close();
    if (originalAdminHost) process.env.ADMIN_HOST = originalAdminHost;
    else delete process.env.ADMIN_HOST;
  });

  await t.test('dedicated ADMIN_HOST blocks /admin from public host', async () => {
    const res = await fetch(`${baseUrl}/admin`, {
      headers: { 'x-forwarded-host': 'api.elesend.com' }
    });
    assert.equal(res.status, 404, 'Public host request to /admin must be 404');
  });

  await t.test('dedicated ADMIN_HOST blocks /api/v1/admin/* from public host', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/algorithm-features`, {
      headers: { 'x-forwarded-host': 'api.elesend.com', authorization: 'Bearer admin' }
    });
    assert.equal(res.status, 404, 'Public host request to /api/v1/admin/* must be 404');
  });

  await t.test('dedicated ADMIN_HOST allows /admin from authorized admin host', async () => {
    const res = await fetch(`${baseUrl}/admin`, {
      headers: { 'x-forwarded-host': 'control.elesend.com' }
    });
    assert.equal(res.status, 200, 'Authorized host request to /admin must be 200');
    const text = await res.text();
    assert.ok(text.includes('ELESEND CONTROL CENTER'));
  });

  await t.test('unauthenticated request to /api/v1/admin/* fails with 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/algorithm-features`, {
      headers: { 'x-forwarded-host': 'control.elesend.com' }
    });
    assert.equal(res.status, 401, 'Unauthenticated access to admin API must be 401');
  });

  await t.test('authenticated customer request to /api/v1/admin/* fails with 403', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/algorithm-features`, {
      headers: { 'x-forwarded-host': 'control.elesend.com', authorization: 'Bearer customer' }
    });
    assert.equal(res.status, 403, 'Customer access to admin API must be 403');
  });

  await t.test('authenticated rider request to /api/v1/admin/* fails with 403', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/algorithm-features`, {
      headers: { 'x-forwarded-host': 'control.elesend.com', authorization: 'Bearer rider' }
    });
    assert.equal(res.status, 403, 'Rider access to admin API must be 403');
  });

  await t.test('authenticated business merchant request to /api/v1/admin/* fails with 403', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/algorithm-features`, {
      headers: { 'x-forwarded-host': 'control.elesend.com', authorization: 'Bearer merchant' }
    });
    assert.equal(res.status, 403, 'Merchant access to admin API must be 403');
  });

  await t.test('authenticated admin request to /api/v1/admin/* succeeds on admin host', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/algorithm-features`, {
      headers: { 'x-forwarded-host': 'control.elesend.com', authorization: 'Bearer admin' }
    });
    assert.equal(res.status, 200, 'Admin access on authorized host must succeed with 200');
    const data = await res.json();
    assert.ok(Array.isArray(data));
  });

  await t.test('forged x-forwarded-host from untrusted peer is ignored and blocked', async () => {
    const savedProxyCidrs = process.env.TRUSTED_PROXY_CIDRS;
    try {
      // Configure trusted proxy to a remote IP only (10.0.0.1); local loopback 127.0.0.1 is not trusted proxy
      process.env.TRUSTED_PROXY_CIDRS = '10.0.0.1';
      const res = await fetch(`${baseUrl}/admin`, {
        headers: { 'x-forwarded-host': 'control.elesend.com' }
      });
      // The wire connection is 127.0.0.1 (not in TRUSTED_PROXY_CIDRS), so x-forwarded-host is ignored!
      // The host defaults to 127.0.0.1, which does not match ADMIN_HOST (control.elesend.com) -> 404!
      assert.equal(res.status, 404, 'Forged X-Forwarded-Host from untrusted peer must be rejected with 404');
    } finally {
      if (savedProxyCidrs) process.env.TRUSTED_PROXY_CIDRS = savedProxyCidrs;
      else delete process.env.TRUSTED_PROXY_CIDRS;
    }
  });

  await t.test('direct access with forged Host header without credentials still fails closed', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/algorithm-features`, {
      headers: { 'x-forwarded-host': 'control.elesend.com' }
    });
    assert.equal(res.status, 401, 'Direct access to admin endpoints without auth must fail with 401');
  });

  await t.test('direct access with forged Host header with customer token fails with 403', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/algorithm-features`, {
      headers: { 'x-forwarded-host': 'control.elesend.com', authorization: 'Bearer customer' }
    });
    assert.equal(res.status, 403, 'Customer token on admin endpoint must fail with 403');
  });
});
