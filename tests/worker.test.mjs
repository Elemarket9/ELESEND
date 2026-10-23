import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorker, withAdvisoryLock, LOCK_ID_PAYMENT_RECON, LOCK_ID_FOOD_MAINTENANCE } from '../services/api/worker.mjs';

test('Worker advisory lock acquires and releases cleanly', async () => {
  const calls = [];
  const mockDb = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };

  let executed = false;
  const result = await withAdvisoryLock(mockDb, LOCK_ID_PAYMENT_RECON, async () => {
    executed = true;
  });

  assert.equal(result, true);
  assert.equal(executed, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].sql.includes('pg_try_advisory_lock'));
  assert.equal(calls[0].params[0], LOCK_ID_PAYMENT_RECON);
  assert.ok(calls[1].sql.includes('pg_advisory_unlock'));
  assert.equal(calls[1].params[0], LOCK_ID_PAYMENT_RECON);
});

test('Worker advisory lock skips task if lock is busy', async () => {
  const mockDb = {
    query: async (sql) => {
      if (sql.includes('schema_migrations')) return { rows: [{}], rowCount: 1 };
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: false }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };

  let executed = false;
  const result = await withAdvisoryLock(mockDb, LOCK_ID_FOOD_MAINTENANCE, async () => {
    executed = true;
  });

  assert.equal(result, false);
  assert.equal(executed, false);
});

test('startWorker bootstraps with mock db and cleanly stops timers', async () => {
  const mockDb = {
    query: async (sql) => {
      if (sql.includes('SELECT 1')) return { rows: [{ count: 1 }], rowCount: 1 };
      if (sql.includes('pricing_policies')) return { rows: [], rowCount: 0 };
      if (sql.includes('checkout_method_policies')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }
  };

  const config = {
    env: 'test',
    isProduction: false,
    isStaging: false,
    isTest: true,
    server: { host: '127.0.0.1', port: 3090, backgroundJobsEnabled: true },
    origins: { apiPublicOrigin: 'http://127.0.0.1:3090', webPublicOrigin: 'http://127.0.0.1:3090' },
    database: { url: 'postgres://localhost/test', ssl: false },
    security: { otpKey: 'a'.repeat(64), adminMfaEncryptionKey: 'b'.repeat(64) },
    routing: { osrmUrl: null, vehicleRoutes: null, profiles: { car: 'driving', motorcycle: 'driving' } },
    payment: { provider: null },
    sms: { provider: null },
    notifications: { endpoint: '', allowedHost: '', token: '' },
    food: { acceptanceTimeoutSeconds: 300, courierTimeoutSeconds: 1200, unpaidTimeoutSeconds: 1800 }
  };

  const worker = await startWorker({ db: mockDb, config, skipPing: true });
  assert.ok(worker);
  assert.equal(typeof worker.stop, 'function');
  assert.equal(worker.config.env, 'test');
  assert.equal(worker.dispatch, null);
  assert.equal(worker.paymentProvider, null);

  // Stop background timers
  assert.doesNotThrow(() => worker.stop());
});
