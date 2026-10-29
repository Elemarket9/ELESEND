import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { database } from '../services/api/db.mjs';
import { migrate } from '../scripts/migrate.mjs';
import { platform as platformService } from '../services/api/platform.mjs';
import { dispatchEngine } from '../services/api/dispatch.mjs';
import { restaurantOrderService } from '../services/api/restaurant-orders.mjs';
import { checkoutService } from '../services/api/checkout.mjs';
import { moneyOperations } from '../services/api/money-operations.mjs';
import {
  chatEngine,
  registerRealtimeConnection,
  attachRealtimeDatabaseBridge,
  emitRealtimeUserEvent,
  createRealtimeEventDeduplicator
} from '../services/api/chat-engine.mjs';
import { notificationWorker } from '../services/api/notifications.mjs';
import {
  getPublicTracking,
  createPublicTrackingToken
} from '../services/api/infrastructure/maps/web-tracker.mjs';
import { restaurantService } from '../services/api/restaurant.mjs';
import { httpsSmsGateway } from '../services/api/sms-gateway.mjs';
import { hubtelSmsGateway } from '../services/api/providers/hubtel-sms.mjs';
import { httpServer } from '../services/api/http.mjs';
import { createTemporaryDeliveryReference } from '../services/api/infrastructure/maps/egia/temporary-reference.mjs';

const url = process.env.TEST_DATABASE_URL;
const TEST_OTP_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('SMS Adapters, Notification Worker Receipt Integrity & Mobile Push Channel Acquisition (Database-Independent Contracts)', async t => {
  await t.test('1. Hubtel and HTTPS SMS adapters accept account_recovery purpose and support sendNotification', async () => {
    const sentHttps = [];
    const httpsSms = httpsSmsGateway({
      endpoint: 'https://sms.example.org/v1/send',
      allowedHost: 'sms.example.org',
      token: '0123456789abcdef0123456789abcdef',
      fetchImpl: async (endpointUrl, init) => {
        sentHttps.push({ endpointUrl, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ accepted: true, messageId: 'https_msg_001' }), { status: 200 });
      }
    });

    const chId = randomUUID();
    const recHttps = await httpsSms.send({
      phone: '+233241234567',
      code: '654321',
      purpose: 'account_recovery',
      challengeId: chId
    });
    assert.equal(recHttps.accepted, true);
    assert.equal(recHttps.messageId, 'https_msg_001');
    assert.match(sentHttps[0].body.message, /password recovery code: 654321/i);

    const notifHttps = await httpsSms.sendNotification({
      phone: '+233241234567',
      message: 'ELESEND: a delivery offer is available. Open the app to review it.',
      jobId: 'offer:123',
      kind: 'dispatch_offer'
    });
    assert.equal(notifHttps.accepted, true);
    assert.equal(notifHttps.messageId, 'https_msg_001');
    assert.match(sentHttps[1].body.message, /delivery offer is available/i);

    const sentHubtel = [];
    const hubtelSms = hubtelSmsGateway({
      clientId: 'hubtel_client_id',
      clientSecret: 'hubtel_client_secret',
      senderId: 'ELESEND',
      fetchImpl: async (endpointUrl, init) => {
        sentHubtel.push({ endpointUrl, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ Code: '0000', Message: 'Success', Data: { MessageId: 'hubtel_msg_001' } }), { status: 200 });
      }
    });

    const recHubtel = await hubtelSms.send({
      phone: '+233241234567',
      code: '123456',
      purpose: 'account_recovery',
      challengeId: chId
    });
    assert.equal(recHubtel.accepted, true);
    assert.equal(recHubtel.messageId, 'hubtel_msg_001');
    assert.match(sentHubtel[0].body.Content, /password recovery code: 123456/i);

    const notifHubtel = await hubtelSms.sendNotification({
      phone: '+233241234567',
      message: 'ELESEND: a delivery offer is available. Open the app to review it.',
      jobId: 'offer:123',
      kind: 'dispatch_offer'
    });
    assert.equal(notifHubtel.accepted, true);
    assert.equal(notifHubtel.messageId, 'hubtel_msg_001');
    assert.match(sentHubtel[1].body.Content, /delivery offer is available/i);
  });

  await t.test('2. Notification worker never marks jobs sent without a real external provider receipt even when push tokens exist', async () => {
    const jobState = { id: 'offer:test-1', recipient_id: 'rider-1', kind: 'dispatch_offer', state: 'pending', attempts: 0, payload: { offerId: 'off-1', message: 'Offer ready' } };
    const mockDb = {
      async query(sql) {
        if (sql.includes("SET state='sent'")) {
          jobState.state = 'sent';
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('FROM user_push_tokens')) {
          return { rowCount: 1, rows: [{ id: 'pt-1', platform: 'android', push_token: 'ExponentPushToken[abc12345]', app_state: 'background', battery_saver_enabled: false, background_location_enabled: true }] };
        }
        return { rowCount: 0, rows: [] };
      },
      async tx(fn) {
        return fn(this);
      }
    };

    const unconfiguredWorker = notificationWorker(mockDb, { transport: null, sms: null });
    const res = await unconfiguredWorker.tick();
    assert.equal(res.enabled, false, 'Worker without transport or SMS must report enabled: false');
    assert.equal(jobState.state, 'pending', 'Job must remain pending and never be marked sent without delivery');
  });

  await t.test('3. Mobile tracking never fabricates push tokens or permissions and only registers real native provider tokens', async () => {
    const mobilePkg = JSON.parse(readFileSync(new URL('../apps/mobile/package.json', import.meta.url), 'utf8'));
    assert.ok(mobilePkg.dependencies?.['expo-notifications'], 'apps/mobile/package.json must declare expo-notifications dependency');

    for (const relPath of ['../apps/mobile/src/tracking.js', '../apps/mobile-shared/src/tracking.js']) {
      const trackingSrc = readFileSync(new URL(relPath, import.meta.url), 'utf8');
      assert.ok(trackingSrc.includes("import * as Notifications from 'expo-notifications'"), `${relPath} must import expo-notifications`);
      assert.ok(trackingSrc.includes('export async function acquireDevicePushToken'), `${relPath} must export acquireDevicePushToken`);

      const stripped = trackingSrc
        .replace(/import\s+\*\s+as\s+TaskManager[^\n]+\n/, 'const TaskManager = null;\n')
        .replace(/import\s+\*\s+as\s+Location[^\n]+\n/, 'const Location = null;\n')
        .replace(/import\s+\*\s+as\s+Notifications[^\n]+\n/, 'const Notifications = null;\n')
        .replace(/import\s+\{call,loadToken\}[^\n]+\n/, 'const call = async () => ({}); const loadToken = async () => "rider_session_token_64chars";\n');
      const modUrl = `data:text/javascript;base64,${Buffer.from(stripped, 'utf8').toString('base64')}`;
      const trackingMod = await import(modUrl);

      const postedRequests = [];
      const mockCall = async (method, path, body, opts) => {
        postedRequests.push({ method, path, body, opts });
        return { ok: true, registration: { id: 'reg-1', ...body } };
      };

      // Case A: No notification provider available -> returns unavailable, pushToken: null, never manufactures token or permission
      const unavailToken = await trackingMod.acquireDevicePushToken({
        appScope: 'rider',
        deviceId: 'audit-fixture-device',
        notificationsModule: null
      });
      assert.equal(unavailToken.ok, false);
      assert.equal(unavailToken.available, false);
      assert.equal(unavailToken.status, 'unavailable');
      assert.equal(unavailToken.pushToken, null, 'Must never manufacture an ExponentPushToken when provider is absent');
      assert.equal(unavailToken.permissionStatus, 'unavailable', 'Must never report permission granted when provider is absent');

      const unavailReg = await trackingMod.registerDevicePushChannel({
        appScope: 'rider',
        deviceId: 'audit-fixture-device',
        notificationsModule: null,
        callImpl: mockCall,
        loadTokenImpl: async () => 'rider_session_token_64chars'
      });
      assert.equal(unavailReg.registered, false);
      assert.equal(unavailReg.available, false);
      assert.equal(postedRequests.length, 0, 'Must not post a fabricated token to /api/v1/me/push-token');

      // Case B: Native provider denies permission -> returns unavailable without requesting token
      const deniedToken = await trackingMod.acquireDevicePushToken({
        appScope: 'rider',
        notificationsModule: {
          async getPermissionsAsync() { return { status: 'denied' }; },
          async requestPermissionsAsync() { return { status: 'denied' }; },
          async getDevicePushTokenAsync() { throw new Error('Should not be called when permission is denied'); }
        }
      });
      assert.equal(deniedToken.ok, false);
      assert.equal(deniedToken.available, false);
      assert.equal(deniedToken.pushToken, null);
      assert.equal(deniedToken.permissionStatus, 'denied');

      // Case C: Real native provider grants permission and returns an FCM/Expo token -> registers with backend
      const nativeNotificationsProvider = {
        async setNotificationChannelAsync() {},
        async getPermissionsAsync() { return { status: 'undetermined' }; },
        async requestPermissionsAsync() { return { status: 'granted' }; },
        async getDevicePushTokenAsync() { return { type: 'android', data: 'fcm_live_device_token_987654321' }; }
      };

      const regResult = await trackingMod.registerDevicePushChannel({
        appScope: 'rider',
        deviceId: 'pixel-8-pro',
        notificationsModule: nativeNotificationsProvider,
        callImpl: mockCall,
        loadTokenImpl: async () => 'rider_session_token_64chars'
      });
      assert.equal(regResult.registered, true);
      assert.equal(regResult.available, true);
      assert.equal(regResult.pushToken, 'fcm_live_device_token_987654321');
      assert.equal(regResult.platform, 'fcm');
      assert.equal(regResult.permissionStatus, 'granted');
      assert.equal(postedRequests.length, 1);
      assert.equal(postedRequests[0].method, 'POST');
      assert.equal(postedRequests[0].path, '/api/v1/me/push-token');
      assert.equal(postedRequests[0].body.pushToken, 'fcm_live_device_token_987654321');
      assert.equal(postedRequests[0].body.platform, 'fcm');
    }
  });

  await t.test('4. Password recovery challenge returns a uniform public response without revealing account existence or admin role', async () => {
    const smsSent = [];
    const usersByPhone = new Map([
      ['+233240000001', { id: '00000000-0000-4000-8000-000000000001', phone: '+233240000001', kind: 'admin' }],
      ['+233240000002', { id: '00000000-0000-4000-8000-000000000002', phone: '+233240000002', kind: 'customer' }]
    ]);
    const mockDb = {
      async query(sql, params = []) {
        if (sql.includes('INSERT INTO rate_limits')) return { rows: [{ count: 1 }], rowCount: 1 };
        if (sql.includes('FROM users WHERE phone=$1')) {
          const u = usersByPhone.get(params[0]);
          return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
        }
        if (sql.includes('UPDATE account_recovery_challenges SET sent=true')) {
          return { rows: [{ id: params[0] }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      async tx(fn) { return fn(this); }
    };
    const svc = platformService(mockDb, {
      otpKey: TEST_OTP_KEY,
      sms: {
        async send(payload) {
          smsSent.push(payload);
          return { accepted: true, messageId: 'msg-1' };
        }
      }
    });

    const unknownRes = await svc.passwordRecoveryChallenge({ phone: '+233249999999' });
    const adminRes = await svc.passwordRecoveryChallenge({ phone: '+233240000001' });
    const customerRes = await svc.passwordRecoveryChallenge({ phone: '+233240000002' });

    assert.equal(typeof unknownRes.challengeId, 'string');
    assert.equal(unknownRes.expiresInSeconds, 300);
    assert.equal(typeof adminRes.challengeId, 'string');
    assert.equal(adminRes.expiresInSeconds, 300);
    assert.equal(typeof customerRes.challengeId, 'string');
    assert.equal(customerRes.expiresInSeconds, 300);
    assert.deepEqual(Object.keys(unknownRes).sort(), Object.keys(customerRes).sort());
    assert.deepEqual(Object.keys(adminRes).sort(), Object.keys(customerRes).sort());
    assert.equal(smsSent.length, 1, 'SMS must only be dispatched for the eligible non-admin account');
    assert.equal(smsSent[0].phone, '+233240000002');

    // Regression: resetPassword with an arbitrary challengeId must return the exact same status and message
    // for unknown phone numbers, blocked administrator numbers, and registered customer numbers.
    const arbitraryChallengeId = randomUUID();
    const captureResetError = async phone => {
      try {
        await svc.resetPassword({
          phone,
          challengeId: arbitraryChallengeId,
          code: '123456',
          newPassword: 'NewStrongPassword123!'
        });
        assert.fail('Expected resetPassword to reject');
      } catch (err) {
        return { status: err.status, message: err.message };
      }
    };

    const unknownErr = await captureResetError('+233249999999');
    const adminErr = await captureResetError('+233240000001');
    const customerArbitraryChallengeErr = await captureResetError('+233240000002');

    assert.equal(unknownErr.status, 400);
    assert.deepEqual(adminErr, unknownErr, 'Blocked admin reset error must match unknown account reset error');
    assert.deepEqual(
      customerArbitraryChallengeErr,
      unknownErr,
      'Registered customer with arbitrary/expired challengeId must return identical status and message as unknown account'
    );
  });

  await t.test('5. In-progress login with old password cannot survive concurrent password reset (User-Row Lock & Hash Revalidation)', async () => {
    const { passwordHash } = await import('../services/api/security.mjs');
    const oldPwHash = await passwordHash('OldPassword123!');
    const userState = {
      id: '00000000-0000-4000-8000-000000000077',
      phone: '+233247770000',
      kind: 'customer',
      password_hash: oldPwHash
    };
    const sessions = new Map();
    const challenges = new Map();
    const smsOutbox = [];

    // Controlled database fixture: when login performs its unlocked initial SELECT * FROM users WHERE phone=$1,
    // it receives the old password_hash; before login enters db.tx(SELECT * FROM users WHERE phone=$1 FOR UPDATE),
    // resetPassword executes and updates userState.password_hash + clears sessions.
    let interceptNextLoginTx = false;
    let triggerResetDuringLogin = null;

    const mockDb = {
      async query(sql, params = []) {
        if (sql.includes('INSERT INTO rate_limits')) return { rows: [{ count: 1 }], rowCount: 1 };
        if (sql === 'SELECT * FROM users WHERE phone=$1') {
          return { rows: [{ ...userState }], rowCount: 1 };
        }
        if (sql.includes('SELECT * FROM users WHERE phone=$1 FOR UPDATE') || sql.includes('SELECT id,phone,kind FROM users WHERE phone=$1 FOR UPDATE')) {
          return { rows: [{ ...userState }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO account_recovery_challenges')) {
          challenges.set(params[0], {
            id: params[0],
            user_id: params[1],
            phone: params[2],
            digest: params[3],
            sent: false,
            live: true,
            consumed_at: null,
            attempts: 0
          });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('UPDATE account_recovery_challenges SET sent=true')) {
          const ch = challenges.get(params[0]);
          if (ch) ch.sent = true;
          return { rows: [{ id: params[0] }], rowCount: 1 };
        }
        if (sql.includes('FROM account_recovery_challenges WHERE id=$1 AND user_id=$2 FOR UPDATE')) {
          const ch = challenges.get(params[0]);
          return { rows: ch ? [{ ...ch }] : [], rowCount: ch ? 1 : 0 };
        }
        if (sql.includes('UPDATE account_recovery_challenges SET consumed_at=now()')) {
          const ch = challenges.get(params[0]);
          if (ch) ch.consumed_at = new Date().toISOString();
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('UPDATE users SET password_hash=$2')) {
          userState.password_hash = params[1];
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('DELETE FROM sessions WHERE user_id=$1')) {
          const count = sessions.size;
          sessions.clear();
          return { rows: [], rowCount: count };
        }
        if (sql.includes('INSERT INTO sessions')) {
          sessions.set(params[0], { token_hash: params[0], user_id: params[1] });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      async tx(fn) {
        if (interceptNextLoginTx && triggerResetDuringLogin) {
          interceptNextLoginTx = false;
          const runReset = triggerResetDuringLogin;
          triggerResetDuringLogin = null;
          await runReset();
        }
        return fn(this);
      }
    };

    const svc = platformService(mockDb, {
      otpKey: TEST_OTP_KEY,
      sms: {
        async send(msg) {
          smsOutbox.push(msg);
          return { accepted: true, messageId: 'sms-1' };
        }
      }
    });

    const ch = await svc.passwordRecoveryChallenge({ phone: userState.phone });
    const otpCode = smsOutbox[smsOutbox.length - 1].code;

    // Arm the interleaving: login will read the old password_hash and verify it, then right as login enters db.tx
    // to lock the user row and insert a session, resetPassword completes first.
    interceptNextLoginTx = true;
    triggerResetDuringLogin = async () => {
      await svc.resetPassword({
        phone: userState.phone,
        challengeId: ch.challengeId,
        code: otpCode,
        newPassword: 'BrandNewPassword123!'
      });
    };

    await assert.rejects(
      () => svc.login({ phone: userState.phone, password: 'OldPassword123!' }),
      err => err.status === 401 && /Invalid credentials/i.test(err.message),
      'In-progress login with old password must be rejected when password reset updates the user row before session creation'
    );
    assert.equal(sessions.size, 0, 'Zero sessions may remain after reset completes against an in-progress old-password login');
  });

  await t.test('6. Push token registration binds to session/installation, deactivates on logout, and transfers across Account A -> logout -> Account B', async () => {
    const { hash: sha256 } = await import('../services/api/security.mjs');
    const tokenA = 'a'.repeat(64);
    const tokenB = 'b'.repeat(64);
    const userA = { id: '00000000-0000-4000-8000-0000000000a1', kind: 'rider', phone: '+233240000101', sessionTokenHash: sha256(tokenA) };
    const userB = { id: '00000000-0000-4000-8000-0000000000b2', kind: 'rider', phone: '+233240000202', sessionTokenHash: sha256(tokenB) };

    const activeSessions = new Map([
      [sha256(tokenA), { token_hash: sha256(tokenA), user_id: userA.id }],
      [sha256(tokenB), { token_hash: sha256(tokenB), user_id: userB.id }]
    ]);
    const pushRows = [];
    const jobs = [
      { id: 'job:a1', recipient_id: userA.id, kind: 'settlement_notice', state: 'pending', attempts: 0, payload: { message: 'Account A notice' } },
      { id: 'job:b1', recipient_id: userB.id, kind: 'settlement_notice', state: 'pending', attempts: 0, payload: { message: 'Account B notice' } }
    ];

    const mockDb = {
      async query(sql, params = []) {
        if (sql.includes('pg_advisory_xact_lock')) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('DELETE FROM user_push_tokens') && sql.includes('WHERE app_scope = $1')) {
          const [scope, devId, tok] = params;
          for (let i = pushRows.length - 1; i >= 0; i--) {
            if (pushRows[i].app_scope === scope && pushRows[i].device_id === devId && pushRows[i].push_token !== tok) {
              pushRows.splice(i, 1);
            }
          }
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO user_push_tokens')) {
          assert.ok(sql.includes('ON CONFLICT(push_token) DO UPDATE'), 'registerPushToken must upsert on UNIQUE(push_token)');
          assert.ok(sql.includes('SET user_id=EXCLUDED.user_id'), 'registerPushToken must atomically transfer user_id on push_token conflict');
          const [id, uid, platform, scope, tok, channelId, deviceId, sessionHash, appState, batt, bgLoc] = params;
          let existing = pushRows.find(r => r.push_token === tok);
          if (existing) {
            const sameUser = existing.user_id === uid;
            Object.assign(existing, {
              user_id: uid,
              platform,
              app_scope: scope,
              channel_id: channelId,
              device_id: sameUser ? (deviceId ?? existing.device_id) : deviceId,
              session_token_hash: sameUser ? (sessionHash ?? existing.session_token_hash) : sessionHash,
              app_state: appState,
              battery_saver_enabled: batt,
              background_location_enabled: bgLoc,
              active: true
            });
          } else {
            existing = { id, user_id: uid, platform, app_scope: scope, push_token: tok, channel_id: channelId, device_id: deviceId, session_token_hash: sessionHash, app_state: appState, battery_saver_enabled: batt, background_location_enabled: bgLoc, active: true };
            pushRows.push(existing);
          }
          return { rows: [existing], rowCount: 1 };
        }
        if (sql.includes('DELETE FROM sessions WHERE token_hash=$1 RETURNING user_id')) {
          const s = activeSessions.get(params[0]);
          activeSessions.delete(params[0]);
          return { rows: s ? [{ user_id: s.user_id }] : [], rowCount: s ? 1 : 0 };
        }
        if (sql.includes('UPDATE user_push_tokens') && sql.includes('SET active = false')) {
          const [tokenHash, uid, deviceId, pushTok] = params;
          for (const r of pushRows) {
            if (!r.active) continue;
            const hasLiveSession = [...activeSessions.values()].some(s => s.user_id === uid);
            if (
              (tokenHash && r.session_token_hash === tokenHash) ||
              (uid && r.user_id === uid && (!r.session_token_hash || (deviceId && r.device_id === deviceId) || (pushTok && r.push_token === pushTok) || !hasLiveSession))
            ) {
              r.active = false;
              r.session_token_hash = null;
            }
          }
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('FROM user_push_tokens t') && sql.includes('WHERE t.user_id=$1')) {
          const uid = params[0];
          const matching = pushRows.filter(
            r => r.user_id === uid && r.active && (!r.session_token_hash || activeSessions.get(r.session_token_hash)?.user_id === r.user_id)
          );
          return { rows: matching, rowCount: matching.length };
        }
        if (sql.includes('WITH due AS')) {
          const pending = jobs.filter(j => j.state === 'pending');
          for (const j of pending) j.state = 'sending';
          return { rows: pending, rowCount: pending.length };
        }
        if (sql.includes('SELECT phone FROM users WHERE id=$1')) {
          const u = params[0] === userA.id ? userA : userB;
          return { rows: [{ phone: u.phone }], rowCount: 1 };
        }
        if (sql.includes("UPDATE notification_jobs SET state='sent'")) {
          const j = jobs.find(x => x.id === params[0]);
          if (j) j.state = 'sent';
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      async tx(fn) { return fn(this); }
    };

    const svc = platformService(mockDb, { otpKey: TEST_OTP_KEY });
    const sharedPushToken = 'fcm_shared_phone_token_abc123456';
    const sharedDeviceId = 'shared-android-handset-01';

    // 1. Account A registers the shared phone push token
    await svc.registerPushToken(userA, {
      pushToken: sharedPushToken,
      deviceId: sharedDeviceId,
      platform: 'fcm',
      appScope: 'rider'
    }, { sessionToken: tokenA });
    assert.equal((await svc.listPushTokens(userA)).length, 1);

    // 2. Account A logs out -> deactivates the installation's push registration
    await svc.logout(tokenA);
    assert.equal((await svc.listPushTokens(userA)).length, 0, 'Logout must deactivate Account A push token');

    // 3. Account B logs in on the same shared phone and registers the same push token
    await svc.registerPushToken(userB, {
      pushToken: sharedPushToken,
      deviceId: sharedDeviceId,
      platform: 'fcm',
      appScope: 'rider'
    }, { sessionToken: tokenB });
    assert.equal((await svc.listPushTokens(userA)).length, 0, 'Account A must have zero active tokens on that device');
    assert.equal((await svc.listPushTokens(userB)).length, 1, 'Account B must own the active token on that device');

    // 4. Deliver notifications for both Account A and Account B -> Account A's notification must exclude the shared device
    const deliveredJobs = [];
    const worker = notificationWorker(mockDb, {
      transport: {
        async send(job) {
          deliveredJobs.push(job);
          return { accepted: true, messageId: 'msg-' + job.id };
        }
      }
    });
    await worker.tick();
    const jobA = deliveredJobs.find(j => j.recipient_id === userA.id);
    const jobB = deliveredJobs.find(j => j.recipient_id === userB.id);
    assert.ok(jobA && jobB);
    assert.equal(jobA.payload.pushTokens, undefined, 'Account A notification must exclude the logged-out/transferred device push token');
    assert.equal(jobB.payload.pushTokens?.length, 1);
    assert.equal(jobB.payload.pushTokens[0].token, sharedPushToken, 'Account B notification must target the transferred device push token');

    // 5. Overlapping concurrent registrations from Account A and Account B for the same token/device must never leave two owners
    activeSessions.set(sha256(tokenA), { token_hash: sha256(tokenA), user_id: userA.id });
    const concurrentToken = 'fcm_concurrent_race_token_999999';
    const concurrentDevice = 'shared-android-handset-02';
    await Promise.all([
      svc.registerPushToken(userA, { pushToken: concurrentToken, deviceId: concurrentDevice, platform: 'fcm', appScope: 'rider' }, { sessionToken: tokenA }),
      svc.registerPushToken(userB, { pushToken: concurrentToken, deviceId: concurrentDevice, platform: 'fcm', appScope: 'rider' }, { sessionToken: tokenB })
    ]);
    const matchingRows = pushRows.filter(r => r.push_token === concurrentToken);
    assert.equal(matchingRows.length, 1, 'Concurrent registrations must never create duplicate rows for the same push token');
    const aTokens = (await svc.listPushTokens(userA)).filter(t => t.push_token === concurrentToken);
    const bTokens = (await svc.listPushTokens(userB)).filter(t => t.push_token === concurrentToken);
    assert.equal(aTokens.length + bTokens.length, 1, 'Exactly one account may own the concurrently registered push token');
  });

  await t.test('7. Runtime postgres.conf, compose.yaml, mobile lockfile, verify-backup.sh, and trusted proxy clientIp contracts', async () => {
    const fs = await import('node:fs');
    const { clientIp } = await import('../services/api/client-ip.mjs');

    // Finding 1: postgres.conf listens on private container interface & compose.yaml verifies connectivity
    const pgConf = fs.readFileSync('deploy/runtime/postgres.conf', 'utf8');
    assert.match(pgConf, /^\s*listen_addresses\s*=\s*'\*'/m, 'postgres.conf must set listen_addresses = * for private container network reachability');
    const compose = fs.readFileSync('deploy/runtime/compose.yaml', 'utf8');
    assert.match(compose, /pg_isready\s+-h\s+"\$\$\(hostname\s+-i\)"/, 'db healthcheck must verify TCP connectivity on the container interface');
    assert.match(compose, /fetch\('http:\/\/127\.0\.0\.1:3090\/readyz'/, 'api healthcheck must verify readiness probe against database');
    assert.match(compose, /TRUSTED_PROXY_CIDRS:\s*\$\{TRUSTED_PROXY_CIDRS:-172\.29\.240\.10\/32\}/, 'compose.yaml must configure a narrow trusted proxy CIDR for Caddy');

    // Finding 2: apps/mobile/package.json and package-lock.json are consistent
    const mobilePkg = JSON.parse(fs.readFileSync('apps/mobile/package.json', 'utf8'));
    const mobileLock = JSON.parse(fs.readFileSync('apps/mobile/package-lock.json', 'utf8'));
    assert.deepEqual(
      mobileLock.packages?.['']?.dependencies,
      mobilePkg.dependencies,
      'apps/mobile/package-lock.json root dependencies must exactly match package.json'
    );
    assert.ok(
      mobileLock.packages?.['node_modules/expo-notifications']?.version,
      'apps/mobile/package-lock.json must contain resolved node_modules/expo-notifications entry'
    );

    // Finding 5: Trusted proxy CIDR separates forwarded clients and resists spoofed/malformed X-Forwarded-For prefixes
    const trustedCidr = '172.29.240.10/32';
    const client1Ip = clientIp(
      { socket: { remoteAddress: '172.29.240.10' }, headers: { 'x-forwarded-for': '198.51.100.10' } },
      trustedCidr
    );
    const client2Ip = clientIp(
      { socket: { remoteAddress: '172.29.240.10' }, headers: { 'x-forwarded-for': '198.51.100.20' } },
      trustedCidr
    );
    assert.equal(client1Ip, '198.51.100.10');
    assert.equal(client2Ip, '198.51.100.20');
    assert.notEqual(client1Ip, client2Ip, 'Distinct customers behind Caddy must not share rate-limit IP identity');

    const spoofedIp = clientIp(
      { socket: { remoteAddress: '172.29.240.10' }, headers: { 'x-forwarded-for': '1.1.1.1, 198.51.100.20' } },
      trustedCidr
    );
    assert.equal(spoofedIp, '198.51.100.20', 'Rightmost untrusted hop appended by Caddy must win over client-spoofed prefix');

    const malformedSpoofIp = clientIp(
      { socket: { remoteAddress: '172.29.240.10' }, headers: { 'x-forwarded-for': 'not-an-ip-spoof, 198.51.100.20' } },
      trustedCidr
    );
    assert.equal(malformedSpoofIp, '198.51.100.20', 'Malformed spoofed XFF prefix must not collapse client IP back to shared proxy IP');

    const untrustedDirectPeer = clientIp(
      { socket: { remoteAddress: '203.0.113.55' }, headers: { 'x-forwarded-for': '1.1.1.1' } },
      trustedCidr
    );
    assert.equal(untrustedDirectPeer, '203.0.113.55', 'Untrusted peer cannot spoof X-Forwarded-For');

    // Finding 11: verify-backup.sh restores into an isolated DB with --exit-on-error and checks migrations + ledger balance
    const verifyScript = fs.readFileSync('deploy/runtime/verify-backup.sh', 'utf8');
    assert.match(verifyScript, /CREATE DATABASE \\"\$\{verify_db\}\\"/, 'verify-backup.sh must create an isolated verification database');
    assert.match(verifyScript, /pg_restore\s+--exit-on-error/, 'verify-backup.sh must run pg_restore with --exit-on-error');
    assert.match(verifyScript, /FROM schema_migrations/, 'verify-backup.sh must verify restored schema_migrations');
    assert.match(verifyScript, /FROM ledger_lines[\s\S]*FROM checkout_accounting_lines/, 'verify-backup.sh must verify double-entry ledger balance invariants');
    assert.match(verifyScript, /DROP DATABASE IF EXISTS \\"\$\{verify_db\}\\"/, 'verify-backup.sh must drop the isolated verification database in cleanup');
  });

  await t.test('8. Food ordering & checkout initiation require custody-verification SMS, while preserving history and refunds during SMS outages', async () => {
    const customer = { id: '00000000-0000-4000-8000-0000000000c1', kind: 'customer', phone: '+233240000111' };
    const restId = '00000000-0000-4000-8000-0000000000d1';
    const itemId = '00000000-0000-4000-8000-0000000000e1';
    const shipmentId = '00000000-0000-4000-8000-0000000000f1';
    const orderId = '00000000-0000-4000-8000-0000000000f2';

    const mockDb = {
      async query(sql) {
        if (sql.includes('FROM service_markets')) return { rows: [{ service_enabled: true }], rowCount: 1 };
        if (sql.includes('SELECT phone_verified_at FROM users')) return { rows: [{ phone_verified_at: new Date().toISOString() }], rowCount: 1 };
        if (sql.includes('FROM food_orders f') && sql.includes('f.customer_id = $1')) {
          return { rows: [{ id: orderId, customer_id: customer.id, restaurant_id: restId, shipment_id: shipmentId, state: 'SUBMITTED', payment_status: 'PAID', total_minor: 5000 }], rowCount: 1 };
        }
        if (sql.includes('SELECT * FROM shipments WHERE id=$1 FOR UPDATE')) {
          return { rows: [{ id: shipmentId, customer_id: customer.id, payment_method: 'MOMO', paid: false, state: 'AWAITING_PAYMENT', amount_minor: 5000 }], rowCount: 1 };
        }
        if (sql.includes('FROM shipment_checkout_intents')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      },
      async tx(fn) { return fn(this); }
    };

    const routing = { route: async () => ({ distanceMeters: 2000, durationSeconds: 300, source: 'routing-provider' }) };
    const appWithoutSms = platformService(mockDb, { otpKey: TEST_OTP_KEY, routing, dispatch: {}, sms: null });
    const foodWithoutSms = restaurantOrderService(mockDb, { platform: appWithoutSms, dispatcher: {}, routing, sms: null });

    await assert.rejects(
      () =>
        foodWithoutSms.quoteFoodOrder(customer, {
          restaurantId: restId,
          items: [{ itemId, quantity: 1, options: [] }],
          deliveryAddress: 'Osu Oxford St',
          deliveryLatitude: 5.56,
          deliveryLongitude: -0.18,
          customerPhone: '0241234567'
        }),
      err => err?.status === 503 && /custody-verification SMS unavailable/i.test(err.message),
      'quoteFoodOrder must reject with 503 when custody-verification SMS is unconfigured'
    );

    await assert.rejects(
      () =>
        foodWithoutSms.createFoodOrder(
          customer,
          {
            restaurantId: restId,
            items: [{ itemId, quantity: 1, options: [] }],
            deliveryAddress: 'Osu Oxford St',
            deliveryLatitude: 5.56,
            deliveryLongitude: -0.18,
            customerPhone: '0241234567'
          },
          { paymentMethod: 'MOMO', idempotencyKey: 'food-no-sms-key-1' }
        ),
      err => err?.status === 503 && /custody-verification SMS unavailable/i.test(err.message),
      'createFoodOrder must reject with 503 when custody-verification SMS is unconfigured'
    );

    const checkoutWithoutSms = checkoutService(mockDb, {
      provider: {
        name: 'fixture',
        methods: ['MOMO'],
        allowedCheckoutHosts: ['checkout.test'],
        createCheckout: async x => ({ reference: x.reference, checkoutUrl: 'https://checkout.test/pay' }),
        verifyPayment: async () => null
      },
      sms: null,
      dispatch: {},
      routing
    });
    await assert.rejects(
      () => checkoutWithoutSms.initiate(customer, shipmentId, { idempotencyKey: 'pay-no-sms-key-1' }),
      err => err?.status === 503 && /custody-verification SMS unavailable/i.test(err.message),
      'checkout.initiate must reject with 503 when custody-verification SMS is unconfigured'
    );

    // History access remains available during SMS outages
    const history = await foodWithoutSms.listFoodOrders(customer);
    assert.equal(history.length, 1);
    assert.equal(history[0].id, orderId);
  });

  await t.test('9. Temporary delivery reference locks shipment, binds to quoted coordinates, and HTTP GET lookup extracts segment [6] with ownership check', async () => {
    const { createTemporaryDeliveryReference } = await import('../services/api/infrastructure/maps/egia/temporary-reference.mjs');
    const { httpServer } = await import('../services/api/http.mjs');

    const owner = { id: '00000000-0000-4000-8000-000000000101', kind: 'customer' };
    const otherCustomer = { id: '00000000-0000-4000-8000-000000000202', kind: 'customer' };
    const assignedRider = { id: '00000000-0000-4000-8000-000000000303', kind: 'rider' };
    const shipmentId = '00000000-0000-4000-8000-000000000404';
    const quotedDest = { latitude: 5.5600, longitude: -0.1800, address: 'Quoted Osu Destination' };

    let lockedShipmentQuerySeen = false;
    const refs = new Map();

    const mockDb = {
      async query(sql, params = []) {
        if (sql.includes('INSERT INTO rate_limits')) {
          return { rows: [{ count: 1 }], rowCount: 1 };
        }
        if (sql.includes('FROM shipments s') && sql.includes('FOR UPDATE OF s')) {
          lockedShipmentQuerySeen = true;
          return {
            rows: [{
              id: shipmentId,
              customer_id: owner.id,
              paid: false,
              state: 'AWAITING_ASSIGNMENT',
              quote_request: { destination: quotedDest }
            }],
            rowCount: 1
          };
        }
        if (sql.includes('SELECT 1 FROM temporary_delivery_references WHERE shipment_id = $1')) {
          const has = [...refs.values()].some(r => r.shipment_id === params[0]);
          return { rows: has ? [{ '?column?': 1 }] : [], rowCount: has ? 1 : 0 };
        }
        if (sql.includes('INSERT INTO temporary_delivery_references')) {
          const [id, sid, cid, lon, lat, desc, landmark, entrance, acc, pin] = params;
          const row = {
            id,
            shipment_id: sid,
            customer_id: cid,
            longitude: lon,
            latitude: lat,
            description: desc,
            landmark_context: landmark,
            entrance_instructions: entrance,
            accuracy_m: acc,
            pin_confirmed: pin,
            created_at: new Date().toISOString()
          };
          refs.set(id, row);
          return { rows: [row], rowCount: 1 };
        }
        if (sql.includes('FROM temporary_delivery_references') && sql.includes('WHERE id = $1')) {
          const r = refs.get(params[0]);
          return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
        }
        if (sql.includes('SELECT 1 FROM shipments WHERE id = $1 AND rider_id = $2')) {
          const match = params[0] === shipmentId && params[1] === assignedRider.id;
          return { rows: match ? [{ '?column?': 1 }] : [], rowCount: match ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      },
      async tx(fn) { return fn(this); }
    };

    // 1. Attempt to attach different coordinates (~5km away) to the booked shipment -> rejected with 409!
    await assert.rejects(
      () =>
        createTemporaryDeliveryReference(mockDb, owner, {
          shipmentId,
          latitude: 5.6050,
          longitude: -0.2100,
          description: 'Blue gate far away from quoted destination'
        }),
      err => err?.status === 409 && /match the quoted destination/i.test(err.message),
      'Temporary reference must reject coordinates that override the quoted destination without repricing'
    );
    assert.equal(lockedShipmentQuerySeen, true, 'createTemporaryDeliveryReference must lock the shipment with FOR UPDATE');

    // 2. Attach reference matching the quoted coordinates -> succeeds!
    const createdRef = await createTemporaryDeliveryReference(mockDb, owner, {
      shipmentId,
      latitude: quotedDest.latitude,
      longitude: quotedDest.longitude,
      description: 'Blue gate beside the pharmacy at quoted destination',
      entranceInstructions: 'Ring bell #2'
    });
    assert.equal(createdRef.shipmentId, shipmentId);
    assert.equal(createdRef.latitude, quotedDest.latitude);
    assert.equal(createdRef.longitude, quotedDest.longitude);

    // 3. Test HTTP GET /api/v1/maps/egia/temporary-reference/:id route extraction & ownership check
    const tokens = new Map([
      ['t_owner'.padEnd(64, '0'), owner],
      ['t_other'.padEnd(64, '0'), otherCustomer],
      ['t_rider'.padEnd(64, '0'), assignedRider]
    ]);
    const srv = httpServer(
      mockDb,
      {
        routing: { route: async () => null },
        authenticate: async tok => tokens.get(tok) || assert.fail('Unknown token')
      },
      null,
      null,
      null
    );
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;
    try {
      const ownerRes = await fetch(`http://127.0.0.1:${port}/api/v1/maps/egia/temporary-reference/${createdRef.id}`, {
        headers: { authorization: `Bearer ${'t_owner'.padEnd(64, '0')}` }
      });
      assert.equal(ownerRes.status, 200, 'HTTP GET temporary-reference must extract UUID from segment [6] and return 200 to owner');
      const ownerBody = await ownerRes.json();
      assert.equal(ownerBody.id, createdRef.id);
      assert.equal(ownerBody.description, 'Blue gate beside the pharmacy at quoted destination');

      const otherRes = await fetch(`http://127.0.0.1:${port}/api/v1/maps/egia/temporary-reference/${createdRef.id}`, {
        headers: { authorization: `Bearer ${'t_other'.padEnd(64, '0')}` }
      });
      assert.equal(otherRes.status, 403, 'HTTP GET temporary-reference must reject another customer with 403');
    } finally {
      await new Promise(resolve => srv.close(resolve));
    }
  });

  await t.test('10. Password recovery returns uniform 200 response even when SMS adapter fails during transport', async () => {
    const customerId = '00000000-0000-4000-8000-000000000011';
    const adminId = '00000000-0000-4000-8000-000000000022';
    const usersByPhone = new Map([
      ['+233240000011', { id: customerId, phone: '+233240000011', kind: 'customer' }],
      ['+233240000022', { id: adminId, phone: '+233240000022', kind: 'admin' }]
    ]);
    const expiredChallenges = [];
    const privateFailureAudits = [];

    const mockDb = {
      async query(sql, params = []) {
        if (sql.includes('INSERT INTO rate_limits')) return { rows: [{ count: 1 }], rowCount: 1 };
        if (sql.includes('SELECT id,phone,kind FROM users WHERE phone=$1')) {
          const u = usersByPhone.get(params[0]);
          return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
        }
        if (sql.includes('UPDATE account_recovery_challenges SET expires_at=now() WHERE id=$1 AND sent=false')) {
          expiredChallenges.push(params[0]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO audit_logs') && params[1] === 'auth.password_recovery_sms_failed') {
          privateFailureAudits.push({ userId: params[0], action: params[1], challengeId: params[2] });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      async tx(fn) { return fn(this); }
    };

    const failingSms = {
      async send() {
        throw new Error('SMS upstream 503 gateway timeout');
      }
    };
    const svc = platformService(mockDb, { otpKey: TEST_OTP_KEY, sms: failingSms });

    const unknownRes = await svc.passwordRecoveryChallenge({ phone: '0249999999' });
    const adminRes = await svc.passwordRecoveryChallenge({ phone: '0240000022' });
    const customerRes = await svc.passwordRecoveryChallenge({ phone: '0240000011' });

    assert.deepEqual(Object.keys(unknownRes).sort(), ['challengeId', 'expiresInSeconds']);
    assert.deepEqual(Object.keys(adminRes).sort(), ['challengeId', 'expiresInSeconds']);
    assert.deepEqual(Object.keys(customerRes).sort(), ['challengeId', 'expiresInSeconds']);
    assert.equal(unknownRes.expiresInSeconds, 300);
    assert.equal(adminRes.expiresInSeconds, 300);
    assert.equal(customerRes.expiresInSeconds, 300);
    assert.equal(expiredChallenges.length, 1, 'Unsent customer recovery challenge must be expired on SMS failure');
    assert.equal(privateFailureAudits.length, 1, 'SMS failure must be recorded privately in audit_logs');
  });

  await t.test('11. Chat message and receipt events publish only AFTER transaction commit and never publish on rollback', async () => {
    const sender = { id: '00000000-0000-4000-8000-000000000501', kind: 'customer' };
    const recipient = { id: '00000000-0000-4000-8000-000000000502', kind: 'rider' };
    const convId = '00000000-0000-4000-8000-000000000503';
    const shipId = '00000000-0000-4000-8000-000000000504';

    const timeline = [];
    let shouldFailCommit = false;
    const outboxRows = [];

    const mockDb = {
      async query(sql, params = []) {
        if (sql.includes('SELECT p.user_id FROM chat_participants p')) {
          return { rows: params[1].map(user_id=>({user_id})), rowCount: params[1].length };
        }
        if (sql.includes('FROM chat_conversations WHERE id = $1')) {
          return {
            rows: [{
              id: convId,
              conversation_type: 'CUSTOMER_RIDER',
              shipment_id: shipId,
              food_order_id: null,
              restaurant_id: null,
              customer_id: sender.id,
              active_rider_id: recipient.id,
              state: 'ACTIVE',
              last_message_seq: 1
            }],
            rowCount: 1
          };
        }
        if (sql.includes('SELECT * FROM chat_policies')) {
          return { rows: [{ id: 1, enabled: true, max_message_length: 1000, rate_limit_per_minute: 25, allow_location_pins: true }], rowCount: 1 };
        }
        if (sql.includes('SELECT * FROM shipments WHERE id = $1')) {
          return { rows: [{ id: shipId, customer_id: sender.id, rider_id: recipient.id, state: 'IN_TRANSIT' }], rowCount: 1 };
        }
        if (sql.includes('FROM riders r') && sql.includes('WHERE r.id = $1')) {
          return { rows: [{ status: 'approved', company_id: null, company_status: null }], rowCount: 1 };
        }
        if (sql.includes('FROM chat_participants') && sql.includes('AND user_id = $2')) {
          const uid = params[1];
          return {
            rows: [{
              conversation_id: convId,
              user_id: uid,
              role: uid === sender.id ? 'customer' : 'rider',
              membership_status: 'active',
              muted: false
            }],
            rowCount: 1
          };
        }
        if (sql.includes('FROM chat_messages') && sql.includes('client_message_id = $3')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO rate_limits')) {
          return { rows: [{ count: 1 }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO chat_messages')) {
          const [id, cid, seq, sid, srole, cmid, mtype, body] = params;
          return {
            rows: [{
              id,
              conversation_id: cid,
              seq,
              sender_id: sid,
              sender_role: srole,
              client_message_id: cmid,
              message_type: mtype,
              body,
              delivery_status: 'SENT',
              moderation_status: 'clean',
              otp_warning: false,
              address_change_warning: false,
              created_at: new Date().toISOString()
            }],
            rowCount: 1
          };
        }
        if (sql.includes('FROM chat_participants') && sql.includes('AND user_id <> $2')) {
          return { rows: [{ user_id: recipient.id, role: 'rider', muted: false }], rowCount: 1 };
        }
        if (sql.includes('UPDATE chat_messages') && sql.includes("SET delivery_status = 'DELIVERED'")) {
          return { rows: [{ id: '00000000-0000-4000-8000-000000000599', seq: 1, sender_id: sender.id }], rowCount: 1 };
        }
        if (sql.includes('UPDATE chat_messages') && sql.includes("SET delivery_status = 'READ'")) {
          return { rows: [{ id: '00000000-0000-4000-8000-000000000599', seq: 1, sender_id: sender.id }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO chat_realtime_outbox')) {
          timeline.push('outbox_insert_in_tx');
          const [id, cid, rIds, rawPayload] = [params[0], params[1], params[2], params[3]];
          const evtType = sql.includes("'message.created'")
            ? 'message.created'
            : sql.includes("'message.delivered'")
            ? 'message.delivered'
            : 'message.read';
          outboxRows.push({
            id,
            conversation_id: cid,
            event_type: evtType,
            recipient_user_ids: rIds,
            payload: typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload,
            claimed_by: null,
            claimed_at: null,
            lease_expires_at: null,
            attempts: 0,
            last_error: null,
            published_at: null
          });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('UPDATE chat_realtime_outbox') && sql.includes('SET claimed_by = $2')) {
          timeline.push('outbox_claimed_with_lease');
          const nowMs = Date.now();
          if (sql.includes('WHERE id = $1')) {
            const targetId = params[0];
            const claimer = params[1];
            const leaseSec = Number(params[2] || 30);
            const row = outboxRows.find(
              r => r.id === targetId && !r.published_at && (!r.lease_expires_at || r.lease_expires_at <= nowMs)
            );
            if (!row) return { rows: [], rowCount: 0 };
            row.claimed_by = claimer;
            row.claimed_at = new Date(nowMs).toISOString();
            row.lease_expires_at = nowMs + leaseSec * 1000;
            row.attempts += 1;
            return { rows: [{ ...row }], rowCount: 1 };
          }
          const lim = Number(params[0] || 50);
          const claimer = params[1];
          const leaseSec = Number(params[2] || 30);
          const due = outboxRows
            .filter(r => !r.published_at && (!r.lease_expires_at || r.lease_expires_at <= nowMs))
            .slice(0, lim);
          for (const row of due) {
            row.claimed_by = claimer;
            row.claimed_at = new Date(nowMs).toISOString();
            row.lease_expires_at = nowMs + leaseSec * 1000;
            row.attempts += 1;
          }
          return { rows: due.map(r => ({ ...r })), rowCount: due.length };
        }
        if (sql.includes("SELECT pg_notify('elesend_realtime', $1)")) {
          timeline.push('outbox_cross_instance_notify');
          if (mockDb.failCrossInstanceNotify) {
            throw new Error('Simulated pg_notify cross-instance transport failure');
          }
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('UPDATE chat_realtime_outbox SET published_at = now()')) {
          timeline.push('outbox_marked_published');
          const row = outboxRows.find(r => r.id === params[0] && !r.published_at);
          if (!row) return { rows: [], rowCount: 0 };
          row.published_at = new Date().toISOString();
          row.lease_expires_at = null;
          row.last_error = null;
          return { rows: [{ ...row }], rowCount: 1 };
        }
        if (sql.includes('UPDATE chat_realtime_outbox SET last_error = $2')) {
          timeline.push('outbox_error_recorded');
          const row = outboxRows.find(r => r.id === params[0] && !r.published_at);
          if (row) row.last_error = params[1];
          return { rows: [], rowCount: row ? 1 : 0 };
        }
        return { rows: [], rowCount: 1 };
      },
      async tx(fn) {
        timeline.push('tx_begin');
        const res = await fn(this);
        // Yield a microtask + timer BEFORE commit completes to prove no pre-commit queueMicrotask fires!
        await new Promise(r => setTimeout(r, 15));
        if (shouldFailCommit) {
          timeline.push('tx_rollback');
          throw new Error('Simulated COMMIT failure');
        }
        timeline.push('tx_committed');
        return res;
      }
    };

    const receivedEvents = [];
    const unregSender = registerRealtimeConnection(sender.id, {
      send(event, payload) {
        const type = typeof event === 'string' ? event : event?.type;
        timeline.push(`realtime:${type}`);
        receivedEvents.push({ type, payload });
      },
      close() {}
    });
    const unregRecipient = registerRealtimeConnection(recipient.id, {
      send(event, payload) {
        const type = typeof event === 'string' ? event : event?.type;
        timeline.push(`realtime:${type}`);
        receivedEvents.push({ type, payload });
      },
      close() {}
    });

    try {
      const chat = chatEngine(mockDb);

      // 1. Committed sendMessage, acknowledgeDelivered, markRead must all publish strictly AFTER tx_committed
      await chat.sendMessage(sender, convId, { clientMessageId: 'msg-commit-1', messageType: 'text', body: 'Hello after commit' });
      const commitIdx = timeline.indexOf('tx_committed');
      const publishIdx = timeline.indexOf('realtime:message.created');
      assert.ok(commitIdx !== -1 && publishIdx !== -1);
      assert.ok(commitIdx < publishIdx, `message.created must publish AFTER tx_committed, got timeline: ${timeline.join(' -> ')}`);

      timeline.length = 0;
      await chat.acknowledgeDelivered(recipient, convId, { upToSeq: 1 });
      assert.ok(
        timeline.indexOf('tx_committed') < timeline.indexOf('realtime:message.delivered'),
        `message.delivered must publish AFTER tx_committed, got: ${timeline.join(' -> ')}`
      );

      timeline.length = 0;
      await chat.markRead(recipient, convId, { upToSeq: 1 });
      assert.ok(
        timeline.indexOf('tx_committed') < timeline.indexOf('realtime:message.read'),
        `message.read must publish AFTER tx_committed, got: ${timeline.join(' -> ')}`
      );

      // 2. Rolled-back transaction must NEVER publish realtime events
      timeline.length = 0;
      receivedEvents.length = 0;
      shouldFailCommit = true;
      await assert.rejects(
        () => chat.sendMessage(sender, convId, { clientMessageId: 'msg-rollback-2', messageType: 'text', body: 'Should roll back' }),
        /Simulated COMMIT failure/
      );
      assert.equal(receivedEvents.length, 0, 'Rolled-back chat transaction must emit zero realtime events');

      // 3. Lease claim -> await publication -> mark published afterward:
      //    Verify ordering: outbox_claimed_with_lease -> realtime:message.created -> outbox_cross_instance_notify -> outbox_marked_published
      shouldFailCommit = false;
      timeline.length = 0;
      receivedEvents.length = 0;
      outboxRows.length = 0;

      // Simulate failed cross-instance publication during initial post-commit publish:
      // The outbox row MUST remain unpublished (published_at === null) with last_error recorded!
      mockDb.failCrossInstanceNotify = true;
      await chat.sendMessage(sender, convId, { clientMessageId: 'msg-lease-retry-1', messageType: 'text', body: 'Lease retry message' });
      assert.equal(outboxRows.length, 1);
      const pendingRow = outboxRows[0];
      assert.equal(pendingRow.published_at, null, 'Failed cross-instance publish must NOT mark outbox row published');
      assert.match(pendingRow.last_error || '', /pg_notify cross-instance transport failure/);
      assert.ok(pendingRow.payload?.eventId === pendingRow.id, 'Outbox payload must carry a stable eventId matching the outbox row ID');

      // Expire the lease and simulate a worker crash AFTER claiming the lease in flushRealtimeOutbox
      pendingRow.lease_expires_at = Date.now() - 1000;
      await assert.rejects(
        () => chat.flushRealtimeOutbox({ batchLimit: 10, leaseSeconds: 60, workerId: 'crashed-worker-1', simulateCrashAfterClaim: true }),
        { code: 'OUTBOX_CRASH_AFTER_CLAIM' },
        'Simulated crash after claiming lease must throw before delivery'
      );
      assert.equal(pendingRow.published_at, null, 'Crash after claiming lease must leave published_at NULL');
      assert.equal(pendingRow.claimed_by, 'crashed-worker-1');
      assert.equal(pendingRow.attempts, 2);

      // While crashed-worker-1 lease is still active, a second worker must skip the leased row
      mockDb.failCrossInstanceNotify = false;
      const whileLeased = await chat.flushRealtimeOutbox({ batchLimit: 10, leaseSeconds: 30, workerId: 'worker-2' });
      assert.equal(whileLeased.claimed, 0, 'Active lease must prevent concurrent duplicate claiming before lease expiry');
      assert.equal(pendingRow.published_at, null);

      // Once lease expires, if publication fails during flushRealtimeOutbox, row still stays unpublished
      pendingRow.lease_expires_at = Date.now() - 1000;
      mockDb.failCrossInstanceNotify = true;
      const failedFlush = await chat.flushRealtimeOutbox({ batchLimit: 10, leaseSeconds: 30, workerId: 'worker-2' });
      assert.equal(failedFlush.claimed, 1);
      assert.equal(failedFlush.flushed, 0);
      assert.equal(failedFlush.failed, 1);
      assert.equal(pendingRow.published_at, null, 'Failed publication in flushRealtimeOutbox must NOT set published_at');

      // Once lease expires and publication succeeds, flushRealtimeOutbox claims -> awaits publish -> sets published_at afterward!
      pendingRow.lease_expires_at = Date.now() - 1000;
      mockDb.failCrossInstanceNotify = false;
      timeline.length = 0;
      const deduplicator = createRealtimeEventDeduplicator();
      const dedupedClientEvents = [];
      const unregDedup = registerRealtimeConnection(
        recipient.id,
        {
          send(event, payload) {
            dedupedClientEvents.push({ event, payload });
          },
          close() {}
        },
        { deduplicate: true }
      );
      try {
        const okFlush = await chat.flushRealtimeOutbox({ batchLimit: 10, leaseSeconds: 30, workerId: 'worker-3' });
        assert.equal(okFlush.claimed, 1);
        assert.equal(okFlush.flushed, 1);
        assert.equal(okFlush.failed, 0);
        assert.ok(pendingRow.published_at, 'Successful publication must mark published_at afterward');
        assert.equal(pendingRow.lease_expires_at, null);
        assert.equal(pendingRow.last_error, null);

        const claimPos = timeline.indexOf('outbox_claimed_with_lease');
        const notifyPos = timeline.indexOf('outbox_cross_instance_notify');
        const markPubPos = timeline.indexOf('outbox_marked_published');
        assert.ok(claimPos !== -1 && notifyPos !== -1 && markPubPos !== -1);
        assert.ok(
          claimPos < notifyPos && notifyPos < markPubPos,
          `Outbox must claim -> await publish -> mark published afterward, got: ${timeline.join(' -> ')}`
        );

        // Verify all delivery attempts carried the exact same stable eventId so clients safely discard duplicates
        const matchingDeliveries = receivedEvents.filter(e => e.type === 'message.created' && e.payload?.id === pendingRow.payload.id);
        assert.ok(matchingDeliveries.length >= 2, 'Raw listener observed initial attempt and retry attempt');
        const eventIds = new Set(matchingDeliveries.map(e => e.payload?.eventId));
        assert.equal(eventIds.size, 1, 'All retry deliveries of the same outbox event must carry an identical stable eventId');
        assert.equal([...eventIds][0], pendingRow.id);

        const acceptedByDeduplicator = matchingDeliveries.filter(e => deduplicator.accept(e.type, e.payload));
        assert.equal(acceptedByDeduplicator.length, 1, 'Client deduplicator must accept the stable eventId exactly once and discard duplicates');
        assert.equal(dedupedClientEvents.length, 1);
      } finally {
        unregDedup();
      }
    } finally {
      unregSender();
      unregRecipient();
    }
  });
  await t.test('12. Readiness probe /readyz & /ready contracts, local Ghana phone SMS normalization, web-tracker ETA DOM, and PG listener reconnection', async () => {
    // A) /readyz & /ready HTTP readiness contract
    const mockDb = { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) };
    const mockApp = { routing: { health: async () => ({ ok: true }) }, sms: { send: async () => ({ accepted: true }) } };
    const srvNoToken = httpServer(mockDb, mockApp, null, null, null, { readinessToken: '' });
    await new Promise(r => srvNoToken.listen(0, '127.0.0.1', r));
    const port1 = srvNoToken.address().port;
    try {
      const resReadyz = await fetch(`http://127.0.0.1:${port1}/readyz`);
      assert.equal(resReadyz.status, 200, 'Direct container loopback /readyz must succeed when READINESS_PROBE_TOKEN is unset');
      const resSpoofed = await fetch(`http://127.0.0.1:${port1}/readyz`, { headers: { 'x-forwarded-for': '198.51.100.77' } });
      assert.equal(resSpoofed.status, 404, 'Proxied /readyz without token must be rejected');
    } finally {
      srvNoToken.close();
    }

    const srvWithToken = httpServer(mockDb, mockApp, null, null, null, { readinessToken: 'short-compose-token' });
    await new Promise(r => srvWithToken.listen(0, '127.0.0.1', r));
    const port2 = srvWithToken.address().port;
    try {
      const r1 = await fetch(`http://127.0.0.1:${port2}/readyz`, { headers: { 'x-readiness-token': 'short-compose-token' } });
      assert.equal(r1.status, 200, '/readyz must accept x-readiness-token header from compose healthcheck');
      const r2 = await fetch(`http://127.0.0.1:${port2}/ready`, { headers: { 'x-elesend-health-token': 'short-compose-token' } });
      assert.equal(r2.status, 200, '/ready must accept x-elesend-health-token header');
      const r3 = await fetch(`http://127.0.0.1:${port2}/readyz`, { headers: { 'x-readiness-token': 'wrong-token' } });
      assert.equal(r3.status, 404);
    } finally {
      srvWithToken.close();
    }

    // B) httpsSmsGateway.send normalizes local Ghana phone numbers (024... / 23324...) to E.164 (+23324...)
    const sentPayloads = [];
    const gw = httpsSmsGateway({
      endpoint: 'https://sms.elesend.test/v1/messages',
      allowedHost: 'sms.elesend.test',
      token: 'secret-token-1234567890',
      fetchImpl: async (_url, init) => {
        sentPayloads.push(JSON.parse(init.body));
        return {
          ok: true,
          json: async () => ({ accepted: true, messageId: 'msg-norm-123' })
        };
      }
    });
    await gw.send({
      phone: '0241234567',
      code: '123456',
      purpose: 'delivery',
      challengeId: randomUUID()
    });
    assert.equal(sentPayloads.length, 1);
    assert.equal(sentPayloads[0].to, '+233241234567', 'httpsSmsGateway.send must normalize local 024... recipient phone to +23324...');

    // C) renderTrackingHtml always renders #eta-box in the DOM so pollStatus() can reveal it when transit begins
    const { renderTrackingHtml } = await import('../services/api/infrastructure/maps/web-tracker.mjs');
    const htmlBeforeTransit = renderTrackingHtml({
      shipmentId: randomUUID(),
      state: 'RIDER_ASSIGNED',
      statusLabel: 'Rider Assigned',
      pickup: { address: 'Osu' },
      destination: { address: 'East Legon' },
      eta: null
    });
    assert.ok(htmlBeforeTransit.includes('id="eta-box"'), 'renderTrackingHtml must include #eta-box even when initial data.eta is null');
    assert.ok(htmlBeforeTransit.includes('display:none;'), '#eta-box must be hidden initially when data.eta is null');
  });
});

test('Operational Reliability, Recovery, Watchdog, Live Tracking, and Dispute-to-Refund Audit Suite', { skip: !url }, async t => {
  assert.match(new URL(url).pathname, /^\/elesend_test/, 'Requires dedicated test database');
  const root = database(url);

  try {
    await migrate(root);

    async function fixture(fn) {
      const c = await root.pool.connect();
      await c.query('BEGIN');
      let savepoint = 0;
      const db = {
        query: (...a) => c.query(...a),
        async tx(f) {
          const name = 'sp_audit_' + (++savepoint);
          await c.query('SAVEPOINT ' + name);
          try {
            const result = await f(c);
            await c.query('RELEASE SAVEPOINT ' + name);
            return result;
          } catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT ' + name);
            throw e;
          }
        }
      };

      try {
        const adminId = randomUUID();
        const customerId = randomUUID();
        const ownerId = randomUUID();
        const rider1Id = randomUUID();
        const rider2Id = randomUUID();
        const restId = randomUUID();
        const item1Id = randomUUID();
        const item2Id = randomUUID();
        const policyId = randomUUID();

        const customerPhone = '+2332' + String(randomInt(10000000, 99999999));
        const rider1Phone = '+2332' + String(randomInt(10000000, 99999999));
        const rider2Phone = '+2332' + String(randomInt(10000000, 99999999));
        const ownerPhone = '+2332' + String(randomInt(10000000, 99999999));

        // Isolate test fixture from any pre-existing rows in elesend_test without violating guard_shipment trigger
        await c.query("UPDATE riders SET status = 'suspended', online = true, position_at = now()");
        await c.query('UPDATE locations SET updated_at = now()');
        await c.query("UPDATE food_orders SET ready_at = now() WHERE state IN ('ACCEPTED','PREPARING','READY_FOR_PICKUP')");
        await c.query("UPDATE dispatch_commitments SET promised_delivery_before = now() + interval '2 hours'");
        await c.query("UPDATE dispatch_offers SET accepted_at = now() WHERE status = 'accepted'");
        await c.query("UPDATE dispatch_offers SET status = 'expired' WHERE status = 'offered'");
        await c.query('UPDATE settlement_notifications SET sent_at = now() WHERE sent_at IS NULL');
        await c.query("UPDATE notification_jobs SET state = 'sent' WHERE state IN ('pending','sending')");

        for (const [id, phone, kind] of [
          [adminId, '+2332' + String(randomInt(10000000, 99999999)), 'admin'],
          [customerId, customerPhone, 'customer'],
          [ownerId, ownerPhone, 'business'],
          [rider1Id, rider1Phone, 'rider'],
          [rider2Id, rider2Phone, 'rider']
        ]) {
          await c.query(
            "INSERT INTO users(id, phone, password_hash, kind, phone_verified_at) VALUES($1, $2, 'test-hash', $3, now())",
            [id, phone, kind]
          );
        }

        await c.query(
          `INSERT INTO permissions(user_id, permission) VALUES
           ($1, 'finance:configure'),
           ($1, 'finance:approve'),
           ($1, 'verification:write'),
           ($1, 'dispatch:configure'),
           ($1, 'shipments:read')`,
          [adminId]
        );

        await c.query(
          `INSERT INTO riders(id, vehicle, max_weight_g, online, status, current_position, position_at, position_accuracy_m, multi_stop_opt_in)
           VALUES($1, 'motorcycle', 20000, true, 'approved', ST_SetSRID(ST_MakePoint(-0.1802, 5.5602), 4326)::geography, now(), 8, true)`,
          [rider1Id]
        );
        await c.query(
          `INSERT INTO riders(id, vehicle, max_weight_g, online, status, current_position, position_at, position_accuracy_m, multi_stop_opt_in)
           VALUES($1, 'motorcycle', 20000, true, 'approved', ST_SetSRID(ST_MakePoint(-0.1850, 5.5650), 4326)::geography, now(), 8, true)`,
          [rider2Id]
        );
        await c.query('INSERT INTO commission_accounts(rider_id) VALUES($1), ($2) ON CONFLICT DO NOTHING', [rider1Id, rider2Id]);

        await c.query('UPDATE pricing_policies SET active = false');
        await c.query(
          "INSERT INTO pricing_policies(id, base_minor, per_km_minor, commission_bps, vehicle, active) VALUES($1, 1000, 100, 1300, 'motorcycle', true)",
          [policyId]
        );
        await c.query("UPDATE checkout_method_policies SET enabled = true WHERE method = 'MOMO'");
        await c.query("UPDATE service_markets SET service_enabled = true WHERE country_code = 'GH'");

        await c.query(
          `INSERT INTO restaurants(id, owner_id, name, phone, address, latitude, longitude, status)
           VALUES($1, $2, 'Audit Kitchen', '+233241112222', 'Osu Oxford St', 5.5600, -0.1800, 'approved')`,
          [restId, ownerId]
        );
        await c.query(
          "INSERT INTO menu_items(id, restaurant_id, name, price_minor) VALUES($1, $2, 'Jollof Chicken', 4000), ($3, $2, 'Fried Plantain', 2000)",
          [item1Id, restId, item2Id]
        );

        const admin = { id: adminId, kind: 'admin' };
        const customer = { id: customerId, kind: 'customer', phone: customerPhone };
        const kitchen = { id: ownerId, kind: 'business', phone: ownerPhone };
        const rider1 = { id: rider1Id, kind: 'rider', phone: rider1Phone };
        const rider2 = { id: rider2Id, kind: 'rider', phone: rider2Phone };

        const smsOutbox = [];
        const sms = {
          async send(msg) {
            smsOutbox.push(msg);
            return { messageId: 'sms-' + randomUUID() };
          },
          async sendNotification(msg) {
            smsOutbox.push(msg);
            return { messageId: 'sms-notif-' + randomUUID() };
          }
        };

        let receipt;
        const provider = {
          name: 'fixture',
          methods: ['MOMO'],
          allowedCheckoutHosts: ['checkout.test'],
          createCheckout: async x => ({ reference: x.reference, checkoutUrl: 'https://checkout.test/pay' }),
          verifyPayment: async () => receipt,
          parseVerifiedWebhook: async () => receipt,
          createRefund: async x => ({
            providerId: 'rf_' + x.idempotencyKey
          }),
          verifyRefund: async x => ({
            verified: true,
            status: 'refunded',
            requestId: x.requestId,
            eventId: 'ev_rf_' + x.requestId,
            providerId: x.providerId || 'rf_' + x.requestId,
            reference: x.reference,
            amountMinor: x.amountMinor,
            currency: x.currency
          })
        };

        const legBetween = (a, b) => {
          const d = Math.hypot((a?.latitude ?? 5.56) - (b?.latitude ?? 5.56), (a?.longitude ?? -0.18) - (b?.longitude ?? -0.18));
          return {
            distanceMeters: Math.max(100, Math.round(d * 111000)),
            durationSeconds: Math.max(30, Math.round(d * 150000)),
            source: 'fixture'
          };
        };
        const routing = {
          route: async (a, b) => legBetween(a, b),
          matrix: async (points, dest) => points.map(p => legBetween(p, dest))
        };

        const dispatch = dispatchEngine(db, { routing });
        const platform = platformService(db, { otpKey: TEST_OTP_KEY, sms, dispatch, routing });
        const chat = chatEngine(db);
        const restOrders = restaurantOrderService(db, { routing, chat, dispatch });
        const checkout = checkoutService(db, { provider });
        const money = moneyOperations(db, { provider });
        const restaurants = restaurantService(db);

        async function createPaidOrder() {
          const order = await restOrders.createFoodOrder(
            customer,
            {
              restaurantId: restId,
              items: [
                { itemId: item1Id, quantity: 2, options: [] },
                { itemId: item2Id, quantity: 1, options: [] }
              ],
              deliveryAddress: 'Customer Home, Cantonments',
              deliveryLatitude: 5.5700,
              deliveryLongitude: -0.1900,
              customerPhone: '0241234567'
            },
            { paymentMethod: 'MOMO', idempotencyKey: randomUUID() }
          );
          const intent = await checkout.initiate(customer, order.shipment_id, { idempotencyKey: randomUUID() });
          receipt = {
            reference: intent.reference,
            status: 'success',
            amountMinor: Number(order.total_minor),
            currency: 'GHS',
            channel: 'mobile_money',
            eventId: 'evt_' + randomUUID()
          };
          await checkout.webhook(Buffer.from('{}'), {});
          return { ...order, shipmentId: order.shipment_id };
        }

        async function verifyHandover(rider, shipmentId, purpose) {
          smsOutbox.length = 0;
          const ch = await platform.challenge(rider, shipmentId, purpose);
          const lastSms = smsOutbox[smsOutbox.length - 1];
          assert.ok(lastSms?.code, `Expected OTP SMS for ${purpose}`);
          return platform.verify(rider, shipmentId, { challengeId: ch.challengeId, code: lastSms.code });
        }

        await fn({
          c,
          db,
          admin,
          customer,
          kitchen,
          rider1,
          rider2,
          restId,
          item1Id,
          item2Id,
          smsOutbox,
          platform,
          chat,
          restOrders,
          dispatch,
          checkout,
          money,
          restaurants,
          createPaidOrder,
          verifyHandover
        });
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }

    await t.test('1. Live Tracking Connected to Rider GPS Uploads, Freshness Checks, Multi-Stop Privacy & Completion Cleanup', async () => {
      await fixture(async ({ db, customer, kitchen, rider1, platform, restOrders, dispatch, createPaidOrder, verifyHandover }) => {
        const order = await createPaidOrder();
        await restOrders.acceptOrder(kitchen, order.id, { estimatedPrepMinutes: 15 });
        await restOrders.startPreparing(kitchen, order.id);
        await restOrders.markReadyForPickup(kitchen, order.id);

        // Offer to rider1 and accept
        const dispatchRes = await dispatch.dispatchShipment(order.shipmentId);
        assert.equal(dispatchRes.status, 'offered');
        const offers = await dispatch.offers(rider1);
        assert.equal(offers.length, 1);

        const acceptRes = await dispatch.accept(rider1, order.shipmentId, offers[0].offerId);
        assert.equal(acceptRes.ok, true);

        const signedToken = createPublicTrackingToken(order.shipmentId);

        // Acceptance seeds initial live location from rider's known position
        const initialPublicTrack = await getPublicTracking(db, signedToken);
        assert.ok(initialPublicTrack.courier, 'Initial courier location should be seeded upon offer acceptance');
        assert.ok(Math.abs(initialPublicTrack.courier.latitude - 5.5602) < 0.001);
        assert.equal(initialPublicTrack.courierStale, false);

        // Normal POST /api/v1/rider/location (dispatch.riderPosition) updates active shipment locations table
        const observedAt1 = new Date(Date.now() + 2000).toISOString();
        const posRes = await dispatch.riderPosition(rider1, {
          latitude: 5.5610,
          longitude: -0.1810,
          accuracyMeters: 10,
          observedAt: observedAt1,
          headingDegrees: 135,
          speedMps: 6.5
        });
        assert.equal(posRes.ok, true);
        assert.equal(posRes.trackedShipments, 1);

        const updatedPublicTrack = await getPublicTracking(db, signedToken);
        assert.ok(updatedPublicTrack.courier);
        assert.ok(Math.abs(updatedPublicTrack.courier.latitude - 5.5610) < 0.0001);
        assert.ok(Math.abs(updatedPublicTrack.courier.longitude - (-0.1810)) < 0.0001);
        assert.equal(updatedPublicTrack.courierStale, false);

        const customerTrack = await platform.tracking(customer, order.shipmentId);
        assert.ok(customerTrack, 'Authenticated customer tracking must return live location');
        assert.ok(Math.abs(Number(customerTrack.latitude) - 5.5610) < 0.0001);

        // Stale GPS check: age the location row beyond freshness threshold
        await db.query("UPDATE locations SET updated_at = now() - interval '15 minutes' WHERE shipment_id = $1", [order.shipmentId]);
        const stalePublicTrack = await getPublicTracking(db, signedToken);
        assert.equal(stalePublicTrack.courier, null, 'Stale location should not be exposed as live position');
        assert.equal(stalePublicTrack.courierStale, true);

        const staleCustomerTrack = await platform.tracking(customer, order.shipmentId);
        assert.equal(staleCustomerTrack, null, 'Stale location must return null on platform.tracking');

        // Custom fresh_seconds < 120 (e.g. 60s) is respected by both getPublicTracking and platform.tracking
        await db.query('UPDATE dispatch_policy SET fresh_seconds = 60 WHERE id = 1');
        await db.query("UPDATE locations SET updated_at = now() - interval '90 seconds' WHERE shipment_id = $1", [order.shipmentId]);
        const staleAt60Public = await getPublicTracking(db, signedToken);
        assert.equal(staleAt60Public.courier, null, 'Location older than configured 60s fresh_seconds must be hidden');
        assert.equal(staleAt60Public.courierStale, true);
        await db.query('UPDATE dispatch_policy SET fresh_seconds = 180 WHERE id = 1');

        // Fresh GPS upload restores tracking immediately
        const observedAt2 = new Date(Date.now() + 5000).toISOString();
        await dispatch.riderPosition(rider1, {
          latitude: 5.5615,
          longitude: -0.1815,
          accuracyMeters: 9,
          observedAt: observedAt2
        });
        const restoredTrack = await platform.tracking(customer, order.shipmentId);
        assert.ok(restoredTrack);

        // Multi-stop privacy: if rider has an in-custody first shipment and a second shipment still RIDER_ASSIGNED (not first stop),
        // riderPosition only publishes GPS to the first stop/in-custody shipment
        const secondOrder = await createPaidOrder();
        await restOrders.acceptOrder(kitchen, secondOrder.id, { estimatedPrepMinutes: 15 });
        await restOrders.startPreparing(kitchen, secondOrder.id);
        await restOrders.markReadyForPickup(kitchen, secondOrder.id);

        // Verify pickup on first shipment so it is in custody (PICKUP_VERIFIED)
        await verifyHandover(rider1, order.shipmentId, 'pickup');
        await platform.transition(rider1, order.shipmentId, { action: 'start' });

        // Enable multi-stop policy and assign second shipment later in the stop plan
        await db.query('UPDATE dispatch_policy SET multi_stop_enabled = true, max_active_parcels = 4 WHERE id = 1');
        await db.query(
          "UPDATE dispatch_algorithm_features SET enabled = true WHERE feature_key IN ('multi_parcel_vrp','dynamic_pickup_insertion')"
        );
        await db.query("UPDATE shipments SET rider_id = $1, state = 'RIDER_ASSIGNED' WHERE id = $2", [rider1.id, secondOrder.shipmentId]);
        await db.query(
          'UPDATE rider_dispatch_plans SET stops = $2::jsonb WHERE rider_id = $1',
          [
            rider1.id,
            JSON.stringify([
              { shipmentId: order.shipmentId, kind: 'dropoff', latitude: 5.5700, longitude: -0.1900, weightG: 1000 },
              { shipmentId: secondOrder.shipmentId, kind: 'pickup', latitude: 5.5600, longitude: -0.1800, weightG: 1000 },
              { shipmentId: secondOrder.shipmentId, kind: 'dropoff', latitude: 5.5700, longitude: -0.1900, weightG: 1000 }
            ])
          ]
        );

        const observedAt3 = new Date(Date.now() + 8000).toISOString();
        const multiStopPos = await dispatch.riderPosition(rider1, {
          latitude: 5.5620,
          longitude: -0.1820,
          accuracyMeters: 8,
          observedAt: observedAt3
        });
        assert.equal(multiStopPos.trackedShipments, 1, 'Only the active stop/in-custody shipment should receive live location');
        const secondCustomerTrack = await platform.tracking(customer, secondOrder.shipmentId);
        assert.equal(secondCustomerTrack, null, 'Later unassigned pickup stop must not leak rider location during prior stop');

        // Restore rider1 dispatch plan to just first shipment dropoff and complete delivery
        await db.query("UPDATE shipments SET rider_id = NULL, state = 'AWAITING_ASSIGNMENT' WHERE id = $1", [secondOrder.shipmentId]);
        await db.query(
          'UPDATE rider_dispatch_plans SET stops = $2::jsonb WHERE rider_id = $1',
          [rider1.id, JSON.stringify([{ shipmentId: order.shipmentId, kind: 'dropoff', latitude: 5.5700, longitude: -0.1900, weightG: 1000 }])]
        );

        await verifyHandover(rider1, order.shipmentId, 'delivery');

        const locAfterComplete = await db.query('SELECT * FROM locations WHERE shipment_id = $1', [order.shipmentId]);
        assert.equal(locAfterComplete.rowCount, 0, 'Completed shipment must purge live location row');
      });
    });

    await t.test('2. Assigned Delivery Watchdog: Stale GPS, Overdue Pickup Pre-Custody Reassignment & Post-Custody Protection', async () => {
      await fixture(async ({ db, customer, kitchen, rider1, rider2, restOrders, dispatch, platform, chat, createPaidOrder, verifyHandover }) => {
        const order = await createPaidOrder();
        await restOrders.acceptOrder(kitchen, order.id, { estimatedPrepMinutes: 15 });
        await restOrders.startPreparing(kitchen, order.id);
        await restOrders.markReadyForPickup(kitchen, order.id);

        await dispatch.dispatchShipment(order.shipmentId);
        const offers1 = await dispatch.offers(rider1);
        const r1Offer = offers1.find(o => o.id === order.shipmentId);
        assert.ok(r1Offer, 'Expected offer for rider1');
        await dispatch.accept(rider1, order.shipmentId, r1Offer.offerId);

        // Open rider conversation before reassignment to verify watchdog revokes it on reassignment
        const riderConv = await chat.openOrCreateConversation(customer, {
          conversationType: 'CUSTOMER_RIDER',
          shipmentId: order.shipmentId
        });
        assert.equal(riderConv.state, 'ACTIVE');

        // Case A: Stale GPS & overdue pickup with autoReassignPreCustody: false -> alerts support & customer, offers reassignment without unassigning yet
        await db.query("UPDATE food_orders SET ready_at = now() - interval '20 minutes' WHERE id = $1", [order.id]);
        await db.query("UPDATE riders SET position_at = now() - interval '15 minutes' WHERE id = $1", [rider1.id]);
        await db.query("UPDATE locations SET updated_at = now() - interval '15 minutes' WHERE shipment_id = $1", [order.shipmentId]);

        const alertOnlyPass = await dispatch.watchdog({ autoReassignPreCustody: false });
        assert.equal(alertOnlyPass.length, 1);
        assert.equal(alertOnlyPass[0].status, 'escalated_pre_pickup');
        assert.equal(alertOnlyPass[0].supportAlerted, true);
        assert.equal(alertOnlyPass[0].reassignmentOffered, true);
        assert.ok(alertOnlyPass[0].reasons.includes('stale_gps'));
        assert.ok(alertOnlyPass[0].reasons.includes('overdue_pickup'));

        // Also verify restOrders.monitorAssignedDeliveries and expireUnfulfilledOrders execute cleanly against dispatch_policy
        const restMonitorPass = await restOrders.monitorAssignedDeliveries({ autoReassignPreCustody: false });
        assert.equal(restMonitorPass.length, 1);
        assert.equal(restMonitorPass[0].status, 'escalated_pre_pickup');

        const signals = await db.query(
          "SELECT signal_code, review_status FROM operational_risk_signals WHERE shipment_id = $1 AND review_status = 'pending'",
          [order.shipmentId]
        );
        assert.ok(signals.rowCount >= 2);

        // Case B: Controlled pre-custody reassignment via restOrders.monitorAssignedDeliveries({ autoReassignPreCustody: true })
        const reassignPass = await restOrders.monitorAssignedDeliveries({ autoReassignPreCustody: true });
        assert.equal(reassignPass.length, 1);
        assert.equal(reassignPass[0].status, 'reassigned_pre_pickup');
        assert.equal(reassignPass[0].reassigned, true);
        assert.equal(reassignPass[0].shipmentState, 'AWAITING_ASSIGNMENT');

        const convAfterReassign = await db.query('SELECT state FROM chat_conversations WHERE id = $1', [riderConv.id]);
        assert.equal(convAfterReassign.rows[0].state, 'CLOSED', 'Reassigned rider conversation must be revoked');

        const shipAfterReassign = await db.query('SELECT state, rider_id FROM shipments WHERE id = $1', [order.shipmentId]);
        assert.equal(shipAfterReassign.rows[0].state, 'AWAITING_ASSIGNMENT');
        assert.equal(shipAfterReassign.rows[0].rider_id, null);

        // Dispatch re-offers shipment to available rider2 (since rider1's previous offer was invalidated)
        await db.query('UPDATE riders SET position_at = now() WHERE id = $1', [rider2.id]);
        await dispatch.dispatchShipment(order.shipmentId);
        const offers2 = await dispatch.offers(rider2);
        const r2Offer = offers2.find(o => o.id === order.shipmentId);
        assert.ok(r2Offer, 'Reassigned shipment must be offered to eligible rider2');

        // Case C: Post-custody (IN_TRANSIT) overdue delivery -> alerts support, NEVER auto-unassigns rider
        await dispatch.accept(rider2, order.shipmentId, r2Offer.offerId);
        await verifyHandover(rider2, order.shipmentId, 'pickup');
        await platform.transition(rider2, order.shipmentId, { action: 'start' });

        await db.query(
          "UPDATE dispatch_commitments SET promised_delivery_before = now() - interval '10 minutes' WHERE shipment_id = $1",
          [order.shipmentId]
        );
        const postCustodyPass = await dispatch.watchdog({ autoReassignPreCustody: true });
        const custodyEvent = postCustodyPass.find(x => x.shipmentId === order.shipmentId);
        assert.ok(custodyEvent);
        assert.equal(custodyEvent.status, 'escalated_in_custody', 'Post-custody delivery must NEVER auto-unassign');
        assert.equal(custodyEvent.reassignmentOffered, false);
        assert.ok(custodyEvent.reasons.includes('overdue_delivery'));

        const postCustodyShip = await db.query('SELECT state, rider_id FROM shipments WHERE id = $1', [order.shipmentId]);
        assert.equal(postCustodyShip.rows[0].state, 'IN_TRANSIT');
        assert.equal(postCustodyShip.rows[0].rider_id, rider2.id);
      });
    });

    await t.test('3. Background Offer Alerts: Push Token Registration, Piggybacked Location Offers & Gateway Fallback', async () => {
      await fixture(async ({ db, kitchen, rider1, rider2, platform, restOrders, dispatch, createPaidOrder }) => {
        // Register device push token with background state metadata
        const reg = await platform.registerPushToken(rider1, {
          platform: 'android',
          pushToken: 'ExponentPushToken[test_rider_device_token_12345]',
          appScope: 'rider',
          deviceId: 'pixel-8-pro',
          appState: 'background',
          batterySaverEnabled: false,
          backgroundLocationEnabled: true
        });
        assert.equal(reg.ok, true);
        assert.equal(reg.registration.platform, 'android');

        const tokens = await platform.listPushTokens(rider1);
        assert.equal(tokens.length, 1);
        assert.equal(tokens[0].push_token, 'ExponentPushToken[test_rider_device_token_12345]');

        // Create ready order and offer to rider1
        const order = await createPaidOrder();
        await restOrders.acceptOrder(kitchen, order.id, { estimatedPrepMinutes: 15 });
        await restOrders.startPreparing(kitchen, order.id);
        await restOrders.markReadyForPickup(kitchen, order.id);
        await dispatch.dispatchShipment(order.shipmentId);

        // Background location upload returns piggybacked pendingOffers
        const pos = await dispatch.riderPosition(rider1, {
          latitude: 5.5605,
          longitude: -0.1805,
          accuracyMeters: 8,
          observedAt: new Date(Date.now() + 2000).toISOString()
        });
        assert.equal(pos.ok, true);
        assert.ok(pos.pendingOffers.some(o => o.id === order.shipmentId));

        // Attach rider realtime socket to verify background.alert fanout and verify worker refuses to mark jobs sent when neither transport nor sms is configured
        const realtimeEvents = [];
        const unregister = registerRealtimeConnection(rider1.id, {
          send(event, payload) {
            realtimeEvents.push({ event, payload });
          },
          close() {}
        });
        try {
          const unconfiguredWorker = notificationWorker(db, { transport: null, sms: null });
          const unconfiguredTick = await unconfiguredWorker.tick();
          assert.equal(unconfiguredTick.enabled, false);
          const pendingJobs = await db.query(
            "SELECT state, provider_message_id FROM notification_jobs WHERE recipient_id = $1 AND kind = 'dispatch_offer'",
            [rider1.id]
          );
          assert.equal(pendingJobs.rowCount, 1);
          assert.equal(pendingJobs.rows[0].state, 'pending', 'Notification job must stay pending when no transport or SMS adapter is configured');
          assert.equal(pendingJobs.rows[0].provider_message_id, null);

          const hubtelCalls = [];
          const hubtelAdapter = hubtelSmsGateway({
            clientId: 'test_id',
            clientSecret: 'test_secret',
            senderId: 'ELESEND',
            fetchImpl: async (endpointUrl, init) => {
              hubtelCalls.push(JSON.parse(init.body));
              return new Response(
                JSON.stringify({ Code: '0000', Message: 'Success', Data: { MessageId: 'hubtel-offer-msg-1' } }),
                { status: 200 }
              );
            }
          });
          const worker = notificationWorker(db, {
            transport: null,
            sms: hubtelAdapter
          });

          const tickRes = await worker.tick();
          assert.equal(tickRes.enabled, true);
          assert.ok(tickRes.processed >= 1);
          assert.ok(hubtelCalls.length >= 1, 'When push gateway is unconfigured, offer alert must deliver via SMS adapter sendNotification');
          const sentJobs = await db.query(
            "SELECT state, provider_message_id FROM notification_jobs WHERE recipient_id = $1 AND kind = 'dispatch_offer'",
            [rider1.id]
          );
          assert.equal(sentJobs.rows[0].state, 'sent');
          assert.equal(sentJobs.rows[0].provider_message_id, 'hubtel-offer-msg-1');
          assert.ok(
            realtimeEvents.some(e => e.event === 'background.alert' || e.event?.type === 'background.alert'),
            'Connected rider client must receive high-priority background.alert event'
          );

          // Verify Account A (rider1) -> logout -> Account B (rider2) on a shared phone in PostgreSQL:
          // Create a session for rider1 and rider2, bind the push token to rider1's session, logout rider1,
          // then register the same device token under rider2, and verify rider1's notifications exclude that device!
          const tokR1 = '1'.repeat(64);
          const tokR2 = '2'.repeat(64);
          const { hash: sha256 } = await import('../services/api/security.mjs');
          await db.query("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES($1, $2, now() + interval '4 hours'), ($3, $4, now() + interval '4 hours')", [
            sha256(tokR1),
            rider1.id,
            sha256(tokR2),
            rider2.id
          ]);

          await platform.registerPushToken(
            rider1,
            {
              platform: 'fcm',
              pushToken: 'ExponentPushToken[test_rider_device_token_12345]',
              appScope: 'rider',
              deviceId: 'pixel-8-pro',
              appState: 'active'
            },
            { sessionToken: tokR1 }
          );
          assert.equal((await platform.listPushTokens(rider1)).length, 1);

          // rider1 logs out -> token is deactivated
          await platform.logout(tokR1);
          assert.equal((await platform.listPushTokens(rider1)).length, 0, 'Logout must deactivate rider1 push token in PostgreSQL');

          // rider2 logs in on the same shared phone and registers the same push token
          await platform.registerPushToken(
            rider2,
            {
              platform: 'fcm',
              pushToken: 'ExponentPushToken[test_rider_device_token_12345]',
              appScope: 'rider',
              deviceId: 'pixel-8-pro',
              appState: 'active'
            },
            { sessionToken: tokR2 }
          );
          assert.equal((await platform.listPushTokens(rider1)).length, 0, 'rider1 must not retain token after transfer to rider2');
          assert.equal((await platform.listPushTokens(rider2)).length, 1, 'rider2 must own the transferred device token');

          // Queue notifications for both rider1 and rider2 and verify rider1's notification excludes the shared device token
          await db.query(
            `INSERT INTO notification_jobs(id, recipient_id, kind, payload) VALUES
             ('shared-test:r1', $1, 'settlement_notice', '{"message":"Rider 1 notice"}'::jsonb),
             ('shared-test:r2', $2, 'settlement_notice', '{"message":"Rider 2 notice"}'::jsonb)`,
            [rider1.id, rider2.id]
          );
          const transportPayloads = [];
          const transportWorker = notificationWorker(db, {
            transport: {
              async send(job) {
                transportPayloads.push(job);
                return { accepted: true, messageId: 'tp-' + job.id };
              }
            }
          });
          await transportWorker.tick();
          const r1Job = transportPayloads.find(j => j.id === 'shared-test:r1');
          const r2Job = transportPayloads.find(j => j.id === 'shared-test:r2');
          assert.ok(r1Job && r2Job);
          assert.equal(r1Job.payload.pushTokens, undefined, 'Logged-out rider1 notification must exclude the shared phone push token');
          assert.equal(r2Job.payload.pushTokens?.length, 1);
          assert.equal(r2Job.payload.pushTokens[0].token, 'ExponentPushToken[test_rider_device_token_12345]');
        } finally {
          unregister();
        }
      });
    });

    await t.test('4. Missing-Item & Partial-Refund Resolution: Authorized Workflow, Accounting, Settlement Adjustment & Provider Sync', async () => {
      await fixture(async ({ db, admin, customer, kitchen, rider1, item1Id, platform, restOrders, dispatch, money, createPaidOrder, verifyHandover }) => {
        const order = await createPaidOrder();
        await restOrders.acceptOrder(kitchen, order.id, { estimatedPrepMinutes: 15 });
        await restOrders.startPreparing(kitchen, order.id);
        await restOrders.markReadyForPickup(kitchen, order.id);

        await dispatch.dispatchShipment(order.shipmentId);
        const offers = await dispatch.offers(rider1);
        const r1Offer = offers.find(o => o.id === order.shipmentId);
        await dispatch.accept(rider1, order.shipmentId, r1Offer.offerId);

        await verifyHandover(rider1, order.shipmentId, 'pickup');
        await platform.transition(rider1, order.shipmentId, { action: 'start' });
        await verifyHandover(rider1, order.shipmentId, 'delivery');

        // Customer opens missing_items dispute on completed order
        const dispute = await platform.dispute(customer, order.shipmentId, {
          category: 'missing_items',
          detail: 'One Jollof Chicken was missing from the sealed bag',
          requestedRefundMinor: 4000,
          items: [{ menuItemId: item1Id, quantity: 1, amountMinor: 4000 }]
        });
        assert.ok(dispute.id);

        const openDisputes = await money.disputes(admin, { status: 'open' });
        assert.ok(openDisputes.some(d => d.id === dispute.id));

        // Unauthorized user cannot resolve dispute
        await assert.rejects(
          () => money.resolveDispute(customer, dispute.id, { decision: 'approve_refund', reason: 'Self approve' }),
          /Forbidden|Permission|Administrator/i
        );

        // Reject refund exceeding remaining item quantity (ordered 2, requesting 5)
        await assert.rejects(
          () =>
            money.resolveDispute(admin, dispute.id, {
              decision: 'approve_refund',
              reason: 'Too many items',
              items: [{ itemId: item1Id, quantity: 5 }]
            }),
          /exceeds remaining unrefunded quantity/
        );

        // Reject duplicate item entries in the same request whose combined quantity (1 + 2 = 3) exceeds ordered quantity (2)
        await assert.rejects(
          () =>
            money.resolveDispute(admin, dispute.id, {
              decision: 'approve_refund',
              reason: 'Duplicate entries exceeding quantity',
              items: [
                { itemId: item1Id, quantity: 1 },
                { itemId: item1Id, quantity: 2 }
              ]
            }),
          /exceeds remaining unrefunded quantity/
        );

        // Authorized admin resolves dispute using the dispute's recorded items_json (menuItemId) without re-specifying items
        const resolved = await money.resolveDispute(admin, dispute.id, {
          decision: 'approve_refund',
          reason: 'Verified missing 1x Jollof Chicken with kitchen'
        });

        assert.equal(resolved.status, 'resolved');
        assert.equal(Number(resolved.approvedRefundMinor), 4000);
        assert.ok(resolved.refundOperationId, 'Must create refund_operation for provider execution');

        // Verify food_order_items refunded_quantity updated
        const orderItem = await db.query(
          'SELECT quantity, refunded_quantity FROM food_order_items WHERE order_id = $1 AND item_id = $2',
          [order.id, item1Id]
        );
        assert.equal(Number(orderItem.rows[0].refunded_quantity), 1);

        // Verify restaurant_settlements reduced proportionally and balance constraint holds
        const settlement = await db.query('SELECT * FROM restaurant_settlements WHERE order_id = $1', [order.id]);
        assert.equal(Number(settlement.rows[0].refunded_gross_minor), 4000);
        assert.equal(
          Number(settlement.rows[0].gross_sales_minor) -
            Number(settlement.rows[0].restaurant_discount_minor) -
            Number(settlement.rows[0].refunded_gross_minor),
          Number(settlement.rows[0].commission_minor) + Number(settlement.rows[0].net_payable_minor),
          'Restaurant settlement invariant must remain balanced after partial refund'
        );

        // Verify double-entry checkout_accounting_lines are strictly balanced
        const journalBalance = await db.query(
          `SELECT COALESCE(SUM(CASE WHEN side = 'debit' THEN amount_minor ELSE -amount_minor END), 0) AS diff
           FROM checkout_accounting_lines`
        );
        assert.equal(Number(journalBalance.rows[0].diff), 0, 'Double-entry checkout accounting lines must remain balanced');

        // Submit and verify refund via money.submitRefund -> confirms refund and transitions food_order payment_status to PARTIALLY_REFUNDED
        const submitRes = await money.submitRefund(admin, resolved.refundOperationId);
        assert.equal(submitRes.status, 'refunded');

        const updatedOrder = await db.query('SELECT state, payment_status FROM food_orders WHERE id = $1', [order.id]);
        assert.equal(updatedOrder.rows[0].payment_status, 'PARTIALLY_REFUNDED');

        // Subsequent dispute requesting 2x of the same item (when only 1x remains unrefunded) is rejected with 409
        const secondDispute = await platform.dispute(customer, order.shipmentId, {
          category: 'missing_items',
          detail: 'Claiming 2 more items',
          items: [{ menuItemId: item1Id, quantity: 2, amountMinor: 8000 }]
        });
        await assert.rejects(
          () =>
            money.resolveDispute(admin, secondDispute.id, {
              decision: 'approve_refund',
              reason: 'Exceeds remaining 1 item'
            }),
          /exceeds remaining unrefunded quantity/
        );
      });
    });

    await t.test('5. Account Recovery: Uniform Anti-Enumeration Response, SMS Challenge, Wrong Code Rejection, Password Update & Session/Realtime Revocation', async () => {
      await fixture(async ({ db, admin, platform, smsOutbox }) => {
        const phone = '+233249876543';
        const reg = await platform.register({
          phone,
          password: 'OldPassword123!',
          kind: 'customer'
        });

        // Unknown phone and administrator phone receive the exact same public response shape without sending SMS or leaking 404/403
        const adminRow = (await db.query('SELECT phone FROM users WHERE id = $1', [admin.id])).rows[0];
        smsOutbox.length = 0;
        const unknownChallenge = await platform.passwordRecoveryChallenge({ phone: '+233249999888' });
        const adminChallenge = await platform.passwordRecoveryChallenge({ phone: adminRow.phone });
        assert.ok(unknownChallenge.challengeId);
        assert.equal(unknownChallenge.expiresInSeconds, 300);
        assert.ok(adminChallenge.challengeId);
        assert.equal(adminChallenge.expiresInSeconds, 300);
        assert.equal(smsOutbox.length, 0, 'No SMS should be sent for unknown or admin accounts');

        const captureDbResetError = async (targetPhone, challengeId, code = '123456') => {
          try {
            await platform.resetPassword({
              phone: targetPhone,
              challengeId,
              code,
              newPassword: 'NewStrongPassword123!'
            });
            assert.fail('Expected resetPassword to reject');
          } catch (err) {
            return { status: err.status, message: err.message };
          }
        };

        const errUnknown = await captureDbResetError('+233249999888', unknownChallenge.challengeId);
        const errAdmin = await captureDbResetError(adminRow.phone, adminChallenge.challengeId);
        const errCustomerArbitraryChallenge = await captureDbResetError(phone, randomUUID());

        assert.equal(errUnknown.status, 400);
        assert.deepEqual(errAdmin, errUnknown);
        assert.deepEqual(errCustomerArbitraryChallenge, errUnknown);

        // Login with old password to create active session
        const oldSession = await platform.login({ phone, password: 'OldPassword123!' });
        const authedBefore = await platform.authenticate(oldSession.token);
        assert.equal(authedBefore.id, reg.id);

        // Attach a mock realtime connection for this user to verify disconnect on password reset
        let closed = false;
        const sentEvents = [];
        registerRealtimeConnection(authedBefore.id, {
          send(event, payload) {
            sentEvents.push({ event, payload });
          },
          close() {
            closed = true;
          }
        });

        // Request password recovery challenge
        smsOutbox.length = 0;
        const challenge = await platform.passwordRecoveryChallenge({ phone });
        assert.ok(challenge.challengeId);
        const recoverySms = smsOutbox[smsOutbox.length - 1];
        assert.match(recoverySms?.code ?? '', /^\d{6}$/);

        // Wrong code is rejected with the exact same status and message and increments attempts
        const errCustomerWrongCode = await captureDbResetError(
          phone,
          challenge.challengeId,
          recoverySms.code === '000000' ? '999999' : '000000'
        );
        assert.deepEqual(errCustomerWrongCode, errUnknown);

        // Correct code resets password, revokes all sessions, and disconnects realtime sockets
        const reset = await platform.resetPassword({
          phone,
          challengeId: challenge.challengeId,
          code: recoverySms.code,
          newPassword: 'NewStrongPassword123!'
        });
        assert.equal(reset.ok, true);
        assert.ok(reset.revokedSessions >= 1);
        assert.equal(closed, true, 'Active realtime connection must be closed upon password reset');
        assert.ok(sentEvents.some(e => e.event === 'session.revoked'));

        // Old session token is now revoked (rejects with 401 Session expired)
        await assert.rejects(() => platform.authenticate(oldSession.token), /Session expired/i);

        // Old password no longer works
        await assert.rejects(() => platform.login({ phone, password: 'OldPassword123!' }), /Invalid credentials/);

        // New password succeeds
        const newSession = await platform.login({ phone, password: 'NewStrongPassword123!' });
        assert.ok(newSession.token);
      });
    });

    await t.test('6. Multi-Instance Realtime Delivery & PostgreSQL LISTEN/NOTIFY Fanout', async () => {
      await fixture(async ({ db, customer, kitchen, restOrders, createPaidOrder }) => {
        const order = await createPaidOrder();
        await restOrders.acceptOrder(kitchen, order.id, { estimatedPrepMinutes: 15 });

        // Two separate chatEngine instances share the process-wide realtime bus and receive events
        const engineInstanceA = chatEngine(db);
        const engineInstanceB = chatEngine(db);

        const conv = await engineInstanceA.openOrCreateConversation(customer, {
          conversationType: 'CUSTOMER_RESTAURANT',
          foodOrderId: order.id
        });

        const receivedByA = [];
        const unregisterA = registerRealtimeConnection(customer.id, {
          send(event, payload) {
            receivedByA.push({ event, payload });
          },
          close() {}
        });

        try {
          // Send message through engineInstanceB -> subscriber registered on instance A receives it
          await engineInstanceB.sendMessage(kitchen, conv.id, {
            clientMessageId: 'msg-multi-1',
            messageType: 'text',
            bodyText: 'Your Jollof is going on the grill now!'
          });
          await new Promise(r => setTimeout(r, 20));

          assert.ok(
            receivedByA.some(
              evt =>
                evt.event === 'message.created' &&
                (evt.payload?.body || evt.payload?.bodyText || '').includes('grill')
            ),
            'Message sent on instance B must be delivered to subscriber attached to instance A'
          );

          // Direct user-level realtime event (e.g. background offer alert) also reaches connected socket
          emitRealtimeUserEvent(customer.id, 'rider.offer.alert', { shipmentId: order.shipmentId });
          assert.ok(receivedByA.some(evt => evt.event === 'rider.offer.alert'));

          // Test PostgreSQL LISTEN/NOTIFY cross-process bridge
          await attachRealtimeDatabaseBridge(root);
          await new Promise(r => setTimeout(r, 100));
          const notifyPayload = JSON.stringify({
            originNodeId: 'remote-node-test',
            type: 'publish',
            userIds: [customer.id],
            event: 'remote.instance.ping',
            payload: { orderId: order.id }
          });
          await root.query('SELECT pg_notify($1, $2)', ['elesend_realtime', notifyPayload]);
          await new Promise(r => setTimeout(r, 150));
          assert.ok(
            receivedByA.some(evt => evt.event === 'remote.instance.ping' && evt.payload?.orderId === order.id),
            'PostgreSQL LISTEN/NOTIFY bridge must fan out events from remote instances to local sockets'
          );

          // Simulate LISTEN backend drop via pg_terminate_backend and verify automatic reconnect while client is connected
          await root.query(
            `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
             WHERE datname = current_database()
               AND pid <> pg_backend_pid()
               AND query LIKE '%LISTEN elesend_realtime%'`
          );
          await new Promise(r => setTimeout(r, 400));
          const notifyAfterReconnect = JSON.stringify({
            originNodeId: 'remote-node-test-2',
            type: 'publish',
            userIds: [customer.id],
            event: 'remote.instance.reconnected',
            payload: { orderId: order.id }
          });
          await root.query('SELECT pg_notify($1, $2)', ['elesend_realtime', notifyAfterReconnect]);
          await new Promise(r => setTimeout(r, 150));
          assert.ok(
            receivedByA.some(evt => evt.event === 'remote.instance.reconnected' && evt.payload?.orderId === order.id),
            'PostgreSQL LISTEN/NOTIFY bridge must automatically reconnect after backend drop and continue delivering events'
          );

          // Test PostgreSQL chat_realtime_outbox lease claim, crash recovery, failed publication retry, and stable eventId deduplication
          let failTransport = true;
          const flakyEngine = chatEngine(db, {
            workerId: 'pg-worker-1',
            publishTransport: async () => {
              if (failTransport) throw new Error('Simulated cluster publish failure');
            }
          });
          const sentMsg = await flakyEngine.sendMessage(kitchen, conv.id, {
            clientMessageId: 'msg-pg-outbox-lease-1',
            messageType: 'text',
            bodyText: 'Outbox lease recovery test in PostgreSQL'
          });
          assert.ok(sentMsg.eventId, 'Sent message must include stable outbox eventId');

          const unpaidRow = (await db.query('SELECT * FROM chat_realtime_outbox WHERE id = $1', [sentMsg.eventId])).rows[0];
          assert.ok(unpaidRow, 'Outbox row must exist in PostgreSQL');
          assert.equal(unpaidRow.published_at, null, 'Failed publishTransport must leave published_at NULL in PostgreSQL');
          assert.match(unpaidRow.last_error || '', /Simulated cluster publish failure/);

          // Expire lease in PostgreSQL and simulate a worker crash right after claiming with a 1-second lease
          await db.query("UPDATE chat_realtime_outbox SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [sentMsg.eventId]);
          await assert.rejects(
            () => flakyEngine.flushRealtimeOutbox({ batchLimit: 10, leaseSeconds: 1, workerId: 'pg-crashed-worker', simulateCrashAfterClaim: true }),
            { code: 'OUTBOX_CRASH_AFTER_CLAIM' }
          );
          const afterCrashRow = (await db.query('SELECT * FROM chat_realtime_outbox WHERE id = $1', [sentMsg.eventId])).rows[0];
          assert.equal(afterCrashRow.published_at, null, 'Crash after claiming in PostgreSQL must leave published_at NULL');
          assert.equal(afterCrashRow.claimed_by, 'pg-crashed-worker');

          // Wait for the 1-second lease to expire in real wall-clock time (clock_timestamp()), then flush successfully
          await new Promise(r => setTimeout(r, 1150));
          failTransport = false;
          const recoveredFlush = await flakyEngine.flushRealtimeOutbox({ batchLimit: 10, leaseSeconds: 30, workerId: 'pg-recovery-worker' });
          assert.ok(recoveredFlush.flushed >= 1, 'Recovery worker must reclaim expired lease and publish the event');

          const publishedRow = (await db.query('SELECT * FROM chat_realtime_outbox WHERE id = $1', [sentMsg.eventId])).rows[0];
          assert.ok(publishedRow.published_at, 'Recovered outbox row must have published_at set after successful publication');
          assert.equal(publishedRow.lease_expires_at, null);
          assert.equal(publishedRow.last_error, null);
        } finally {
          unregisterA();
        }
      });
    });

    await t.test('7. Restaurant Web Portal Normal Merchant Registration, Phone Verification & Sign-In Flow', async () => {
      await fixture(async ({ platform, restaurants, smsOutbox }) => {
        const html = readFileSync(new URL('../apps/restaurant-web/index.html', import.meta.url), 'utf8');
        assert.ok(!html.includes('Paste business bearer token'), 'Raw bearer token paste prompt must be removed');
        assert.ok(html.includes('/api/v1/auth/login'), 'Restaurant web portal must use normal /api/v1/auth/login');
        assert.ok(html.includes('/api/v1/auth/register'), 'Restaurant web portal must support merchant registration');
        assert.ok(html.includes('/api/v1/auth/password-recovery'), 'Restaurant web portal must support password recovery');

        const merchantPhone = '+233245550199';
        const reg = await platform.register({
          phone: merchantPhone,
          password: 'MerchantPassword123!',
          kind: 'business'
        });
        assert.equal(reg.kind, 'business');

        const session = await platform.login({ phone: merchantPhone, password: 'MerchantPassword123!' });
        const merchantUser = await platform.authenticate(session.token);
        assert.equal(merchantUser.kind, 'business');

        // Verify phone via normal OTP challenge flow
        smsOutbox.length = 0;
        const phoneCh = await platform.phoneChallenge(merchantUser);
        const otpSms = smsOutbox[smsOutbox.length - 1];
        const verified = await platform.verifyPhone(merchantUser, { challengeId: phoneCh.challengeId, code: otpSms.code });
        assert.equal(verified.verified, true);

        const createdRest = await restaurants.createRestaurant(merchantUser, {
          name: 'Cantonments Bistro',
          phone: merchantPhone,
          address: 'Cantonments Rd, Accra',
          latitude: 5.575,
          longitude: -0.175
        });
        assert.equal(createdRest.name, 'Cantonments Bistro');
        assert.equal(createdRest.owner_id, merchantUser.id);
      });
    });

    await t.test('8. Concurrent Dispute Refund vs. Payout Approval Serialization Race (Real PostgreSQL Pool Concurrency)', async () => {
      // Use committed rows on the dedicated test database pool so two independent transactions race on real PostgreSQL row locks.
      const proposerId = randomUUID();
      const approverId = randomUUID();
      const customerId = randomUUID();
      const ownerId = randomUUID();
      const riderId = randomUUID();
      const restId = randomUUID();
      const item1Id = randomUUID();
      const item2Id = randomUUID();
      const policyId = randomUUID();

      await root.query("UPDATE riders SET status = 'suspended', online = true, position_at = now()");
      for (const [uid, kind] of [
        [proposerId, 'admin'],
        [approverId, 'admin'],
        [customerId, 'customer'],
        [ownerId, 'business'],
        [riderId, 'rider']
      ]) {
        await root.query(
          "INSERT INTO users(id, phone, password_hash, kind, phone_verified_at) VALUES($1, $2, 'test-hash', $3, now())",
          [uid, '+2332' + String(randomInt(10000000, 99999999)), kind]
        );
      }
      for (const aid of [proposerId, approverId]) {
        await root.query(
          `INSERT INTO permissions(user_id, permission) VALUES
           ($1, 'finance:configure'),
           ($1, 'finance:approve'),
           ($1, 'finance:read'),
           ($1, 'verification:write')`,
          [aid]
        );
      }
      await root.query(
        `INSERT INTO riders(id, vehicle, max_weight_g, online, status, current_position, position_at, position_accuracy_m)
         VALUES($1, 'motorcycle', 20000, true, 'approved', ST_SetSRID(ST_MakePoint(-0.1802, 5.5602), 4326)::geography, now(), 8)`,
        [riderId]
      );
      await root.query('INSERT INTO commission_accounts(rider_id) VALUES($1) ON CONFLICT DO NOTHING', [riderId]);
      await root.query('UPDATE pricing_policies SET active = false');
      await root.query(
        "INSERT INTO pricing_policies(id, base_minor, per_km_minor, commission_bps, vehicle, active) VALUES($1, 1000, 100, 1300, 'motorcycle', true)",
        [policyId]
      );
      await root.query(
        `INSERT INTO restaurants(id, owner_id, name, phone, address, latitude, longitude, status)
         VALUES($1, $2, 'Concurrency Kitchen', $3, 'Osu Oxford St', 5.5600, -0.1800, 'approved')`,
        [restId, ownerId, '+2332' + String(randomInt(10000000, 99999999))]
      );
      await root.query(
        "INSERT INTO menu_items(id, restaurant_id, name, price_minor) VALUES($1, $2, 'Jollof Chicken', 4000), ($3, $2, 'Fried Plantain', 2000)",
        [item1Id, restId, item2Id]
      );

      let receipt;
      const payoutsSubmitted = [];
      const provider = {
        name: 'race_fixture',
        methods: ['MOMO'],
        allowedCheckoutHosts: ['checkout.test'],
        createCheckout: async x => ({ reference: x.reference, checkoutUrl: 'https://checkout.test/pay' }),
        verifyPayment: async () => receipt,
        parseVerifiedWebhook: async () => receipt,
        verifyBeneficiary: async x => ({ verified: true, beneficiaryId: x.beneficiaryId, recipientReference: x.recipientReference }),
        createPayout: async x => {
          payoutsSubmitted.push(x);
          return { providerId: 'po_' + x.idempotencyKey };
        },
        verifyPayout: async x => ({
          verified: true,
          status: 'paid',
          requestId: x.requestId,
          eventId: 'ev_po_' + x.requestId,
          providerId: x.providerId || 'po_' + x.requestId,
          recipientReference: x.recipientReference,
          amountMinor: x.amountMinor,
          currency: x.currency
        }),
        createRefund: async x => ({ providerId: 'rf_' + x.idempotencyKey }),
        verifyRefund: async x => ({
          verified: true,
          status: 'refunded',
          requestId: x.requestId,
          eventId: 'ev_rf_' + x.requestId,
          providerId: x.providerId || 'rf_' + x.requestId,
          reference: x.reference,
          amountMinor: x.amountMinor,
          currency: x.currency
        })
      };

      const leg = { distanceMeters: 1500, durationSeconds: 240, source: 'fixture' };
      const routing = { route: async () => leg, matrix: async points => points.map(() => leg) };
      const smsOutbox = [];
      const sms = {
        async send(m) { smsOutbox.push(m); return { accepted: true, messageId: 'sms_' + randomUUID() }; },
        async sendNotification(m) { smsOutbox.push(m); return { accepted: true, messageId: 'sms_n_' + randomUUID() }; }
      };

      const dispatch = dispatchEngine(root, { routing });
      const platform = platformService(root, { otpKey: TEST_OTP_KEY, sms, dispatch, routing });
      const chat = chatEngine(root);
      const restOrders = restaurantOrderService(root, { routing, chat, dispatch });
      const checkout = checkoutService(root, { provider });
      const money = moneyOperations(root, { provider });

      const proposer = { id: proposerId, kind: 'admin' };
      const approver = { id: approverId, kind: 'admin' };
      const customer = { id: customerId, kind: 'customer', phone: '+233240001111' };
      const kitchen = { id: ownerId, kind: 'business', phone: '+233240002222' };
      const rider = { id: riderId, kind: 'rider', phone: '+233240003333' };

      await money.verifyBeneficiary(kitchen, { recipientReference: 'rcp_kitchen_race' });

      async function createCompletedOrderWithProposedPayoutAndDispute() {
        const order = await restOrders.createFoodOrder(
          customer,
          {
            restaurantId: restId,
            items: [
              { itemId: item1Id, quantity: 2, options: [] },
              { itemId: item2Id, quantity: 1, options: [] }
            ],
            deliveryAddress: 'Race Test Home, Cantonments',
            deliveryLatitude: 5.5700,
            deliveryLongitude: -0.1900,
            customerPhone: '0241234567'
          },
          { paymentMethod: 'MOMO', idempotencyKey: randomUUID() }
        );
        const intent = await checkout.initiate(customer, order.shipment_id, { idempotencyKey: randomUUID() });
        receipt = {
          reference: intent.reference,
          status: 'success',
          amountMinor: Number(order.total_minor),
          currency: 'GHS',
          channel: 'mobile_money',
          eventId: 'evt_' + randomUUID()
        };
        await checkout.webhook(Buffer.from('{}'), {});
        await restOrders.acceptOrder(kitchen, order.id, { estimatedPrepMinutes: 15 });
        await restOrders.startPreparing(kitchen, order.id);
        await restOrders.markReadyForPickup(kitchen, order.id);
        await dispatch.dispatchShipment(order.shipment_id);
        const offers = await dispatch.offers(rider);
        const myOffer = offers.find(o => o.id === order.shipment_id);
        await dispatch.accept(rider, order.shipment_id, myOffer.offerId);

        for (const purpose of ['pickup', 'delivery']) {
          smsOutbox.length = 0;
          const ch = await platform.challenge(rider, order.shipment_id, purpose);
          const code = smsOutbox[smsOutbox.length - 1].code;
          await platform.verify(rider, order.shipment_id, { challengeId: ch.challengeId, code });
          if (purpose === 'pickup') await platform.transition(rider, order.shipment_id, { action: 'start' });
        }

        const payout = await money.proposePayout(proposer, { shipmentId: order.shipment_id, kind: 'restaurant' });
        assert.equal(payout.status, 'proposed');
        assert.equal(Number(payout.amount_minor), 9000); // 10000 food gross - 10% (1000) commission = 9000

        const dispute = await platform.dispute(customer, order.shipment_id, {
          category: 'missing_items',
          detail: 'Missing 1x Jollof Chicken',
          requestedRefundMinor: 4000,
          items: [{ menuItemId: item1Id, quantity: 1, amountMinor: 4000 }]
        });
        return { order, payout, dispute };
      }

      // Run simultaneous race between approvePayout and resolveDispute
      const { order, payout, dispute } = await createCompletedOrderWithProposedPayoutAndDispute();
      payoutsSubmitted.length = 0;

      const [approveOutcome, refundOutcome] = await Promise.allSettled([
        money.approvePayout(approver, payout.id),
        money.resolveDispute(proposer, dispute.id, {
          decision: 'approve_refund',
          reason: 'Concurrent missing item refund vs payout approval'
        })
      ]);

      // Verify invariant: Either
      // (A) resolveDispute acquired the shipment lock first -> refund succeeded (deducting 3600 from restaurant_payable) AND approvePayout submitted the reduced amount (5400), OR
      // (B) approvePayout acquired the shipment lock first -> approvePayout submitted 9000 AND resolveDispute was rejected with 409 because payout was already initiating/paid!
      const finalPayout = (await root.query('SELECT * FROM payout_operations WHERE id = $1', [payout.id])).rows[0];
      const finalDispute = (await root.query('SELECT * FROM disputes WHERE id = $1', [dispute.id])).rows[0];
      const restCreditPaid = (await root.query(
        `SELECT coalesce(sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END),0)::bigint AS balance
         FROM checkout_accounting_lines l
         JOIN checkout_accounting_journals j ON j.id = l.journal_id
         WHERE j.shipment_id = $1 AND l.account = 'restaurant_payable'`,
        [order.shipment_id]
      )).rows[0];

      assert.equal(approveOutcome.status, 'fulfilled', 'approvePayout should complete under serialized lock');
      if (refundOutcome.status === 'fulfilled') {
        // Case A: Refund ran before approval -> payout amount was reduced from 9000 to 5400 before provider submission!
        assert.equal(finalDispute.status, 'resolved');
        assert.equal(Number(finalPayout.amount_minor), 5400, 'Approved payout must reflect reduced payable after concurrent refund');
        assert.equal(payoutsSubmitted.length, 1);
        assert.equal(Number(payoutsSubmitted[0].amountMinor), 5400, 'Provider must never be asked to pay the unreduced 9000 amount');
        assert.equal(Number(restCreditPaid.balance), 0, 'Remaining restaurant_payable after 3600 refund deduction and 5400 payout must be exactly 0');
      } else {
        // Case B: Approval ran before refund -> payout submitted 9000 and refund rejected with 409!
        assert.match(
          String(refundOutcome.reason?.message || ''),
          /Restaurant (payout already submitted or paid|settlement already paid out)/i
        );
        assert.equal(finalDispute.status, 'open');
        assert.equal(Number(finalPayout.amount_minor), 9000);
        assert.equal(Number(restCreditPaid.balance), 0, 'Remaining restaurant_payable after 9000 payout must be exactly 0');
      }

      // Deterministic row-lock barrier test for the reverse race ordering:
      // Hold a row lock on food_order_items so resolveDispute acquires shipments FOR UPDATE + payout_operations FOR UPDATE and waits;
      // launch approvePayout so it queues on shipments FOR UPDATE while resolveDispute is in-flight; then release the barrier.
      const second = await createCompletedOrderWithProposedPayoutAndDispute();
      payoutsSubmitted.length = 0;

      const barrierClient = await root.pool.connect();
      try {
        await barrierClient.query('BEGIN');
        await barrierClient.query('SELECT id FROM food_order_items WHERE order_id = $1 FOR UPDATE', [second.order.id]);

        const refundPromise = money.resolveDispute(proposer, second.dispute.id, {
          decision: 'approve_refund',
          reason: 'Refund holds shipment lock while payout approval queues behind it'
        });

        // Wait until resolveDispute is actively waiting on the food_order_items lock (meaning it already holds shipments FOR UPDATE)
        for (let i = 0; i < 40; i++) {
          const waiting = await root.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%food_order_items%'"
          );
          if (waiting.rowCount > 0) break;
          await new Promise(r => setTimeout(r, 10));
        }

        // Launch approvePayout while resolveDispute holds shipments FOR UPDATE
        const approvePromise = money.approvePayout(approver, second.payout.id);
        await new Promise(r => setTimeout(r, 30));

        // Release barrier so resolveDispute commits and hands off the shipment lock to approvePayout
        await barrierClient.query('ROLLBACK');

        const [refundFirstOutcome, approveSecondOutcome] = await Promise.allSettled([refundPromise, approvePromise]);
        assert.equal(refundFirstOutcome.status, 'fulfilled');
        assert.equal(approveSecondOutcome.status, 'fulfilled');
      } finally {
        await barrierClient.query('ROLLBACK').catch(() => {});
        barrierClient.release();
      }

      const secondPayout = (await root.query('SELECT * FROM payout_operations WHERE id = $1', [second.payout.id])).rows[0];
      assert.equal(Number(secondPayout.amount_minor), 5400, 'Approval after concurrent refund must reduce payout from 9000 to 5400');
      assert.equal(payoutsSubmitted.length, 1);
      assert.equal(Number(payoutsSubmitted[0].amountMinor), 5400);

      // Also verify real PostgreSQL concurrency between an in-progress old-password login and resetPassword:
      // Hold FOR UPDATE on the user row, start login with old password (it reads the old hash and blocks on users FOR UPDATE),
      // start resetPassword (which also queues on users FOR UPDATE), release the barrier, and verify zero old-password sessions survive!
      const racePhone = '+2332' + String(randomInt(10000000, 99999999));
      const raceUser = await platform.register({
        phone: racePhone,
        password: 'OldRacePassword123!',
        kind: 'customer'
      });
      smsOutbox.length = 0;
      const raceChallenge = await platform.passwordRecoveryChallenge({ phone: racePhone });
      const raceOtp = smsOutbox[smsOutbox.length - 1].code;

      const userBarrier = await root.pool.connect();
      try {
        await userBarrier.query('BEGIN');
        await userBarrier.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [raceUser.id]);

        const loginRacePromise = platform.login({ phone: racePhone, password: 'OldRacePassword123!' });
        const resetRacePromise = platform.resetPassword({
          phone: racePhone,
          challengeId: raceChallenge.challengeId,
          code: raceOtp,
          newPassword: 'NewRacePassword123!'
        });

        await new Promise(r => setTimeout(r, 80));
        await userBarrier.query('ROLLBACK');

        const [loginRaceOutcome, resetRaceOutcome] = await Promise.allSettled([loginRacePromise, resetRacePromise]);
        assert.equal(resetRaceOutcome.status, 'fulfilled', 'resetPassword must succeed');
        if (loginRaceOutcome.status === 'fulfilled') {
          // If login acquired the user lock before resetPassword, resetPassword must have immediately deleted its session!
          await assert.rejects(
            () => platform.authenticate(loginRaceOutcome.value.token),
            /Session expired/i,
            'Session created just before resetPassword acquired the lock must be revoked by resetPassword'
          );
        }
        const survivingSessions = await root.query('SELECT 1 FROM sessions WHERE user_id = $1', [raceUser.id]);
        assert.equal(survivingSessions.rowCount, 0, 'Zero sessions may survive after concurrent old-password login + resetPassword');
      } finally {
        await userBarrier.query('ROLLBACK').catch(() => {});
        userBarrier.release();
      }

      // Also verify real PostgreSQL concurrency for push-token ownership:
      // 1. Database constraint user_push_tokens_push_token_key (UNIQUE(push_token)) and idx_user_push_tokens_scope_device must exist.
      // 2. Concurrent overlapping registerPushToken calls from two accounts for the same token/device must both succeed without 23505
      //    and leave exactly 1 row in user_push_tokens owned by a single account.
      // 3. A raw SQL INSERT attempting to link a second user to the same push_token must be rejected by PostgreSQL with 23505.
      const pushConstraint = await root.query(
        "SELECT conname FROM pg_constraint WHERE conname IN ('user_push_tokens_push_token_key', 'user_push_tokens_user_id_push_token_key')"
      );
      assert.deepEqual(
        pushConstraint.rows.map(r => r.conname),
        ['user_push_tokens_push_token_key'],
        'Database must enforce UNIQUE(push_token) and drop legacy UNIQUE(user_id, push_token)'
      );

      const concurrentPushToken = 'fcm_pg_concurrent_token_' + randomUUID();
      const concurrentDeviceId = 'pg-shared-device-' + randomUUID();
      const pushBarrier = await root.pool.connect();
      try {
        await pushBarrier.query('BEGIN');
        await pushBarrier.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`push-token:${concurrentPushToken}`]);

        const regAPromise = platform.registerPushToken(rider, {
          pushToken: concurrentPushToken,
          deviceId: concurrentDeviceId,
          platform: 'fcm',
          appScope: 'rider'
        });
        const regBPromise = platform.registerPushToken(customer, {
          pushToken: concurrentPushToken,
          deviceId: concurrentDeviceId,
          platform: 'fcm',
          appScope: 'rider'
        });

        await new Promise(r => setTimeout(r, 80));
        await pushBarrier.query('ROLLBACK');

        const [regAOutcome, regBOutcome] = await Promise.allSettled([regAPromise, regBPromise]);
        assert.equal(regAOutcome.status, 'fulfilled', 'First concurrent push registration must succeed cleanly');
        assert.equal(regBOutcome.status, 'fulfilled', 'Second concurrent push registration must succeed cleanly');

        const tokenOwners = await root.query(
          'SELECT user_id, device_id, active FROM user_push_tokens WHERE push_token = $1',
          [concurrentPushToken]
        );
        assert.equal(tokenOwners.rowCount, 1, 'PostgreSQL must contain exactly 1 row for the concurrently registered push token');
        assert.ok(
          [rider.id, customer.id].includes(tokenOwners.rows[0].user_id),
          'Single winning owner must be either rider or customer'
        );

        await assert.rejects(
          () =>
            root.query(
              `INSERT INTO user_push_tokens(id, user_id, platform, app_scope, push_token, channel_id, device_id, active)
               VALUES($1, $2, 'fcm', 'rider', $3, 'elesend-rider-offers', $4, true)`,
              [randomUUID(), tokenOwners.rows[0].user_id === rider.id ? customer.id : rider.id, concurrentPushToken, 'other-dev']
            ),
          { code: '23505' },
          'PostgreSQL UNIQUE(push_token) constraint must reject linking a second user to the same push token'
        );
      } finally {
        await pushBarrier.query('ROLLBACK').catch(() => {});
        pushBarrier.release();
      }

      // Finding 6 & Finding 7 (Real PostgreSQL Concurrency & Fair Scheduling Verification):
      // A) Verify OTP verification (riders -> shipments) and watchdogs (riders -> shipments) share the same lock order
      //    and never deadlock when executed concurrently against the same assigned shipment in PostgreSQL.
      // B) Verify fair watchdog scheduling (watchdog_last_inspected_at / watchdog_next_review_at) so an old escalated
      //    in-custody delivery never starves a newer delayed delivery when limit = 1.
      const orderW1 = await restOrders.createFoodOrder(
        customer,
        {
          restaurantId: restId,
          items: [{ itemId: item1Id, quantity: 1, options: [] }],
          deliveryAddress: 'Watchdog Fair Scheduling #1',
          deliveryLatitude: 5.5680,
          deliveryLongitude: -0.1880,
          customerPhone: '0241234567'
        },
        { paymentMethod: 'MOMO', idempotencyKey: randomUUID() }
      );
      const intentW1 = await checkout.initiate(customer, orderW1.shipment_id, { idempotencyKey: randomUUID() });
      receipt = {
        reference: intentW1.reference,
        status: 'success',
        amountMinor: Number(orderW1.total_minor),
        currency: 'GHS',
        channel: 'mobile_money',
        eventId: 'evt_' + randomUUID()
      };
      await checkout.webhook(Buffer.from('{}'), {});
      await restOrders.acceptOrder(kitchen, orderW1.id, { estimatedPrepMinutes: 15 });
      await restOrders.startPreparing(kitchen, orderW1.id);
      await restOrders.markReadyForPickup(kitchen, orderW1.id);
      await dispatch.dispatchShipment(orderW1.shipment_id);
      const offersW1 = await dispatch.offers(rider);
      const offerW1 = offersW1.find(o => o.id === orderW1.shipment_id);
      await dispatch.accept(rider, orderW1.shipment_id, offerW1.offerId);

      // Prepare pickup OTP challenge for orderW1, then make orderW1 overdue for pickup AND hold a lock on riders FOR UPDATE
      // so concurrent platform.verify(pickup) and dispatch.watchdog({ autoReassignPreCustody: false }) race on the exact same rider & shipment!
      smsOutbox.length = 0;
      const pickupChW1 = await platform.challenge(rider, orderW1.shipment_id, 'pickup');
      const pickupCodeW1 = smsOutbox[smsOutbox.length - 1].code;
      await root.query("UPDATE food_orders SET ready_at = now() - interval '25 minutes' WHERE id = $1", [orderW1.id]);

      const riderLockBarrier = await root.pool.connect();
      try {
        await riderLockBarrier.query('BEGIN');
        await riderLockBarrier.query('SELECT id FROM riders WHERE id = $1 FOR UPDATE', [rider.id]);

        const watchdogRacePromise = dispatch.watchdog({ limit: 5, autoReassignPreCustody: false });
        const verifyRacePromise = platform.verify(rider, orderW1.shipment_id, {
          challengeId: pickupChW1.challengeId,
          code: pickupCodeW1
        });

        await new Promise(r => setTimeout(r, 80));
        await riderLockBarrier.query('ROLLBACK');

        const [wdOutcome, vfOutcome] = await Promise.allSettled([watchdogRacePromise, verifyRacePromise]);
        assert.equal(wdOutcome.status, 'fulfilled', 'Concurrent watchdog must complete without deadlock');
        assert.equal(vfOutcome.status, 'fulfilled', 'Concurrent OTP verify must complete without deadlock');
      } finally {
        await riderLockBarrier.query('ROLLBACK').catch(() => {});
        riderLockBarrier.release();
      }

      await platform.transition(rider, orderW1.shipment_id, { action: 'start' });

      // Create a second rider + second in-transit delayed order (orderW2) so we have two overdue in-custody deliveries:
      // orderW1 (older) and orderW2 (newer). Verify limit=1 inspects orderW1 first, then orderW2 second (no starvation!), then orderW1 third.
      const riderStarveId = randomUUID();
      const riderStarvePhone = '+2332' + String(randomInt(10000000, 99999999));
      await root.query(
        "INSERT INTO users(id, phone, password_hash, kind, phone_verified_at) VALUES($1, $2, 'test-hash', 'rider', now())",
        [riderStarveId, riderStarvePhone]
      );
      await root.query(
        `INSERT INTO riders(id, vehicle, max_weight_g, online, status, current_position, position_at, position_accuracy_m, multi_stop_opt_in)
         VALUES($1, 'motorcycle', 20000, true, 'approved', ST_SetSRID(ST_MakePoint(-0.1802, 5.5602), 4326)::geography, now(), 8, true)`,
        [riderStarveId]
      );
      await root.query('INSERT INTO commission_accounts(rider_id) VALUES($1) ON CONFLICT DO NOTHING', [riderStarveId]);
      const riderStarve = { id: riderStarveId, kind: 'rider', phone: riderStarvePhone };

      const orderW2 = await restOrders.createFoodOrder(
        customer,
        {
          restaurantId: restId,
          items: [{ itemId: item1Id, quantity: 1, options: [] }],
          deliveryAddress: 'Watchdog Fair Scheduling #2',
          deliveryLatitude: 5.5690,
          deliveryLongitude: -0.1890,
          customerPhone: '0241234567'
        },
        { paymentMethod: 'MOMO', idempotencyKey: randomUUID() }
      );
      const intentW2 = await checkout.initiate(customer, orderW2.shipment_id, { idempotencyKey: randomUUID() });
      receipt = {
        reference: intentW2.reference,
        status: 'success',
        amountMinor: Number(orderW2.total_minor),
        currency: 'GHS',
        channel: 'mobile_money',
        eventId: 'evt_' + randomUUID()
      };
      await checkout.webhook(Buffer.from('{}'), {});
      await restOrders.acceptOrder(kitchen, orderW2.id, { estimatedPrepMinutes: 15 });
      await restOrders.startPreparing(kitchen, orderW2.id);
      await restOrders.markReadyForPickup(kitchen, orderW2.id);
      await dispatch.dispatchShipment(orderW2.shipment_id);
      const offersW2 = await dispatch.offers(riderStarve);
      const offerW2 = offersW2.find(o => o.id === orderW2.shipment_id);
      await dispatch.accept(riderStarve, orderW2.shipment_id, offerW2.offerId);
      smsOutbox.length = 0;
      const pickupChW2 = await platform.challenge(riderStarve, orderW2.shipment_id, 'pickup');
      const pickupCodeW2 = smsOutbox[smsOutbox.length - 1].code;
      await platform.verify(riderStarve, orderW2.shipment_id, { challengeId: pickupChW2.challengeId, code: pickupCodeW2 });
      await platform.transition(riderStarve, orderW2.shipment_id, { action: 'start' });

      // Isolate from any pre-existing rows in elesend_test without touching other shipments rows,
      // then mark both orderW1 (older) and orderW2 (newer) overdue in custody and reset their watchdog timestamps
      await root.query('UPDATE riders SET online = true, position_at = now()');
      await root.query('UPDATE locations SET updated_at = now()');
      await root.query("UPDATE food_orders SET ready_at = now() WHERE state IN ('ACCEPTED','PREPARING','READY_FOR_PICKUP')");
      await root.query("UPDATE dispatch_commitments SET promised_delivery_before = now() + interval '2 hours'");
      await root.query("UPDATE dispatch_offers SET accepted_at = now() WHERE status = 'accepted'");
      await root.query(
        "UPDATE shipments SET created_at = now() - interval '2 hours', watchdog_last_inspected_at = NULL, watchdog_next_review_at = NULL WHERE id = $1",
        [orderW1.shipment_id]
      );
      await root.query(
        "UPDATE food_orders SET created_at = now() - interval '2 hours', watchdog_last_inspected_at = NULL, watchdog_next_review_at = NULL WHERE id = $1",
        [orderW1.id]
      );
      await root.query(
        "UPDATE shipments SET created_at = now() - interval '1 hour', watchdog_last_inspected_at = NULL, watchdog_next_review_at = NULL WHERE id = $1",
        [orderW2.shipment_id]
      );
      await root.query(
        "UPDATE food_orders SET created_at = now() - interval '1 hour', watchdog_last_inspected_at = NULL, watchdog_next_review_at = NULL WHERE id = $1",
        [orderW2.id]
      );
      await root.query(
        "UPDATE dispatch_commitments SET promised_delivery_before = now() - interval '15 minutes' WHERE shipment_id = ANY($1::uuid[])",
        [[orderW1.shipment_id, orderW2.shipment_id]]
      );

      const batch1 = await dispatch.watchdog({ limit: 1, reviewIntervalSeconds: 300 });
      assert.equal(batch1.length, 1);
      assert.equal(batch1[0].shipmentId, orderW1.shipment_id, 'First limit=1 batch must inspect the oldest uninspected delayed shipment');
      assert.ok(batch1[0].lastInspectedAt && batch1[0].nextReviewAt);

      const batch2 = await dispatch.watchdog({ limit: 1, reviewIntervalSeconds: 300 });
      assert.equal(batch2.length, 1);
      assert.equal(batch2[0].shipmentId, orderW2.shipment_id, 'Second limit=1 batch must inspect the newer uninspected shipment instead of starving behind orderW1');

      const batch3 = await dispatch.watchdog({ limit: 1, reviewIntervalSeconds: 300 });
      assert.equal(batch3.length, 1);
      assert.equal(batch3[0].shipmentId, orderW1.shipment_id, 'Third limit=1 batch must rotate back to orderW1 for repeat escalation');

      // Verify onlyDueReviews: true skips shipments whose watchdog_next_review_at is in the future
      await root.query("UPDATE shipments SET watchdog_next_review_at = clock_timestamp() + interval '10 minutes' WHERE id = ANY($1::uuid[])", [[orderW1.shipment_id, orderW2.shipment_id]]);
      const dueOnlyBatch = await dispatch.watchdog({ limit: 5, reviewIntervalSeconds: 300, onlyDueReviews: true });
      assert.equal(dueOnlyBatch.length, 0, 'Background watchdog with onlyDueReviews=true must not re-inspect shipments before watchdog_next_review_at');

      // Real-life operational fixes verification:
      // 1) Exhausting 5 wrong OTP attempts immediately expires challenge so rider can request a fresh challenge without waiting 5 minutes
      // 2) verify() works without challengeId (resolving latest active sent challenge) and delivery challenge works directly from PICKUP_VERIFIED
      // 3) Post-pickup stuck order can be resolved by admin via resolveOrder('cancel_refund') or platform.transition('fail'/'return'/'returned')
      // 4) Prepaid non-food parcel that fails and returns ('returned') triggers requestCheckoutRefund
      // 5) Multi-stop route where stop 1 fails removes failed stop from rider_dispatch_plans so stop 2 can proceed
      await root.query('UPDATE riders SET online = false');
      const riderReal1Id = randomUUID();
      const riderReal1Phone = '+2332' + String(randomInt(10000000, 99999999));
      await root.query(
        "INSERT INTO users(id, phone, password_hash, kind, phone_verified_at) VALUES($1, $2, 'test-hash', 'rider', now())",
        [riderReal1Id, riderReal1Phone]
      );
      await root.query(
        `INSERT INTO riders(id, vehicle, max_weight_g, online, status, current_position, position_at, position_accuracy_m, multi_stop_opt_in)
         VALUES($1, 'motorcycle', 20000, true, 'approved', ST_SetSRID(ST_MakePoint(-0.1801, 5.5601), 4326)::geography, now(), 8, true)`,
        [riderReal1Id]
      );
      await root.query('INSERT INTO commission_accounts(rider_id) VALUES($1) ON CONFLICT DO NOTHING', [riderReal1Id]);
      const riderReal1 = { id: riderReal1Id, kind: 'rider', phone: riderReal1Phone };

      const orderReal1 = await restOrders.createFoodOrder(
        customer,
        {
          restaurantId: restId,
          items: [{ itemId: item1Id, quantity: 1, options: [] }],
          deliveryAddress: 'Real Life Audit #1',
          deliveryLatitude: 5.5660,
          deliveryLongitude: -0.1860,
          customerPhone: '0241234567'
        },
        { paymentMethod: 'MOMO', idempotencyKey: randomUUID() }
      );
      assert.equal(orderReal1.customer_phone, '+233241234567', 'Food order must normalize local Ghana phone to E.164');
      const intentReal1 = await checkout.initiate(customer, orderReal1.shipment_id, { idempotencyKey: randomUUID() });
      receipt = {
        reference: intentReal1.reference,
        status: 'success',
        amountMinor: Number(orderReal1.total_minor),
        currency: 'GHS',
        channel: 'mobile_money',
        eventId: 'evt_' + randomUUID()
      };
      await checkout.webhook(Buffer.from('{}'), {});
      await restOrders.acceptOrder(kitchen, orderReal1.id, { estimatedPrepMinutes: 15 });
      await restOrders.startPreparing(kitchen, orderReal1.id);
      await restOrders.markReadyForPickup(kitchen, orderReal1.id);
      await dispatch.dispatchShipment(orderReal1.shipment_id);
      const offersReal1 = await dispatch.offers(riderReal1);
      const offerReal1 = offersReal1.find(o => o.id === orderReal1.shipment_id);
      assert.ok(Number.isFinite(Number(offerReal1.distance_m)), 'Offer must include distance_m alias');
      assert.equal(offerReal1.vehicle, 'motorcycle', 'Offer must include rider vehicle');
      await dispatch.accept(riderReal1, orderReal1.shipment_id, offerReal1.offerId);

      // Customer attaches a TemporaryDeliveryReference AFTER paying and while RIDER_ASSIGNED
      const tempRefAfterPaid = await createTemporaryDeliveryReference(root, customer, {
        shipmentId: orderReal1.shipment_id,
        latitude: 5.5660,
        longitude: -0.1860,
        description: 'Blue gate opposite pharmacy',
        entranceInstructions: 'Ring bell #2'
      });
      assert.equal(tempRefAfterPaid.shipmentId, orderReal1.shipment_id);

      // Exhaust 5 wrong OTP attempts on pickup challenge -> challenge expires immediately so a fresh pickup challenge succeeds
      smsOutbox.length = 0;
      const chExhaust = await platform.challenge(riderReal1, orderReal1.shipment_id, 'pickup');
      for (let i = 0; i < 5; i++) {
        await assert.rejects(
          () => platform.verify(riderReal1, orderReal1.shipment_id, { challengeId: chExhaust.challengeId, code: '000000' }),
          /Incorrect code/
        );
      }
      const chFreshAfterExhaust = await platform.challenge(riderReal1, orderReal1.shipment_id, 'pickup');
      assert.notEqual(chFreshAfterExhaust.challengeId, chExhaust.challengeId, 'Rider must be able to request a fresh OTP challenge immediately after exhausting 5 attempts');
      const freshPickupCode = smsOutbox[smsOutbox.length - 1].code;

      // Verify pickup WITHOUT passing challengeId (simulating dropped HTTP response recovery)
      const verifiedNoId = await platform.verify(riderReal1, orderReal1.shipment_id, { code: freshPickupCode });
      assert.equal(verifiedNoId.ok, true, 'platform.verify must resolve the latest active sent challenge when challengeId is omitted');

      // Request delivery challenge directly from PICKUP_VERIFIED (without calling transition start first)
      smsOutbox.length = 0;
      const delivChFromPickupVerified = await platform.challenge(riderReal1, orderReal1.shipment_id, 'delivery');
      assert.ok(delivChFromPickupVerified.challengeId);

      // Simulate courier disappearance post-pickup: admin resolves stuck post-pickup order directly via resolveOrder('cancel_refund')
      const adminResolvedStuck = await restOrders.resolveOrder(proposer, orderReal1.id, {
        action: 'cancel_refund',
        reason: 'Courier phone off after pickup; admin emergency cancellation and refund'
      });
      assert.equal(adminResolvedStuck.state, 'CANCELLED');
      assert.equal(adminResolvedStuck.shipmentState, 'RETURNED');
      assert.equal(adminResolvedStuck.refundReviewRequired, true);
    });
  } finally {
    await root.close();
  }
});


test('Outbox retries exclude revoked recipients while retaining current participants', async () => {
  const revoked=randomUUID(), current=randomUUID(), conversationId=randomUUID(), eventId=randomUUID();
  let checked=false;
  const published=[];
  const db={async query(sql,params=[]){
    if(sql.includes('RETURNING id, conversation_id')) return {rows:[{id:eventId,conversation_id:conversationId,event_type:'message.created',recipient_user_ids:[revoked,current],payload:{conversationId,body:'private'}}],rowCount:1};
    if(sql.includes('SELECT p.user_id FROM chat_participants p')){
      checked=true;
      assert.deepEqual(params,[conversationId,[revoked,current]]);
      return {rows:[{user_id:current}],rowCount:1};
    }
    return {rows:[],rowCount:1};
  }};
  const result=await chatEngine(db,{publishTransport:async event=>published.push(event)}).flushRealtimeOutbox();
  assert.equal(checked,true);
  assert.equal(result.flushed,1);
  assert.deepEqual(published[0].userIds,[current]);
});
