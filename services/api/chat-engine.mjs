import {randomUUID, createHash} from 'node:crypto';
import {z} from 'zod';
import {check, limit} from './security.mjs';
import {validateGhanaBoundary} from './pricing-surge.mjs';

const id = () => randomUUID();
const uuid = z.string().uuid();

export const QUICK_REPLIES = {
  rider: [
    { key: 'rider_on_way', text: "I'm on my way." },
    { key: 'rider_on_my_way', text: "I'm on my way." },
    { key: 'rider_arrived_pickup', text: "I've arrived at the pickup point." },
    { key: 'rider_confirm_entrance', text: 'Please confirm the entrance.' },
    { key: 'rider_traffic_delay', text: 'There is a delay due to traffic.' },
    { key: 'rider_waiting_gate', text: "I'm waiting at the gate." }
  ],
  restaurant: [
    { key: 'rest_preparing', text: 'Your order is being prepared.' },
    { key: 'rest_ready_pickup', text: 'Your food is ready for pickup.' },
    { key: 'rest_clarify_instructions', text: 'Please clarify your special instructions.' },
    { key: 'rest_prep_delay', text: 'We are experiencing a short preparation delay.' }
  ],
  customer: [
    { key: 'cust_call_arrival', text: 'Please message when you arrive.' },
    { key: 'cust_coming_outside', text: "I'm coming outside now." },
    { key: 'cust_main_entrance', text: 'Please use the main entrance.' },
    { key: 'cust_landmark_shop', text: 'The landmark is beside the shop.' }
  ],
  support: [
    { key: 'supp_investigating', text: 'ELESEND Support is reviewing your order details now.' },
    { key: 'supp_contacting_partner', text: 'We are contacting the courier/restaurant on your behalf.' }
  ]
};

function sanitizeText(raw) {
  if (typeof raw !== 'string') return '';
  // Strip control characters except newline/tab and neutralize script/html tags safely
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();
}

function detectOtpPattern(text) {
  if (!text) return false;
  return /\b(otp|verification\s*code|delivery\s*code|secret\s*code|pin\s*code)\b/i.test(text) ||
    /\b\d{6}\b/.test(text);
}

function detectAddressChangeRequest(text) {
  if (!text) return false;
  return /\b(change\s+(my\s+)?(delivery\s+)?(address|location|destination)|deliver\s+to\s+another\s+(place|address|location)|new\s+address|wrong\s+address|redirect\s+delivery)\b/i.test(text);
}

function maskDisplayName(userRow, role, restaurantRow = null) {
  if (role === 'restaurant') {
    return restaurantRow?.name ? `${restaurantRow.name} (Restaurant)` : 'Restaurant Partner';
  }
  if (role === 'support' || role === 'admin') {
    return 'ELESEND Support Agent';
  }
  if (role === 'rider') {
    return userRow?.name ? `${userRow.name} (Courier)` : 'Assigned Courier';
  }
  return userRow?.name ? `${userRow.name} (Customer)` : 'Customer';
}

// Shared in-process realtime pub/sub & ephemeral typing state across HTTP/SSE/WebSocket connections
const realtimeClients = new Map(); // userId -> Set<{ send(event, payload), conversationIds: Set, close() }>
const ephemeralTyping = new Map(); // `${conversationId}:${userId}` -> { userId, role, expiresAt }

export function publishRealtimeToUsers(userIds, event, payload) {
  const uniqueIds = [...new Set((userIds || []).filter(Boolean).map(String))];
  const now = Date.now();
  for (const uid of uniqueIds) {
    const conns = realtimeClients.get(uid);
    if (!conns) continue;
    for (const conn of [...conns]) {
      try {
        if (conn.expiresAt && conn.expiresAt < now) {
          try {
            conn.send('session.revoked', { reason: 'session_expired', timestamp: new Date().toISOString() });
            if (typeof conn.close === 'function') conn.close();
          } catch {}
          conns.delete(conn);
          continue;
        }
        if (!conn.conversationIds || conn.conversationIds.size === 0 || !payload?.conversationId || conn.conversationIds.has(payload.conversationId)) {
          conn.send(event, payload);
        }
      } catch {
        conns.delete(conn);
      }
    }
    if (conns.size === 0) realtimeClients.delete(uid);
  }
}

export function disconnectRevokedUserFromConversation(userId, conversationId, reason = 'access_revoked') {
  const conns = realtimeClients.get(String(userId));
  if (!conns) return;
  for (const conn of [...conns]) {
    try {
      conn.send('conversation.revoked', { conversationId, reason, timestamp: new Date().toISOString() });
      if (conn.conversationIds && conn.conversationIds.has(conversationId)) {
        conn.conversationIds.delete(conversationId);
        if (conn.singleConversationId === conversationId && typeof conn.close === 'function') {
          conn.close();
          conns.delete(conn);
        }
      }
    } catch {
      conns.delete(conn);
    }
  }
}

export function disconnectRealtimeSession(sessionToken, reason = 'session_revoked') {
  if (!sessionToken) return 0;
  let closed = 0;
  for (const [uid, conns] of realtimeClients.entries()) {
    for (const conn of [...conns]) {
      if (conn.sessionToken === sessionToken) {
        try {
          conn.send('session.revoked', { reason, timestamp: new Date().toISOString() });
          if (typeof conn.close === 'function') conn.close();
        } catch {}
        conns.delete(conn);
        closed++;
      }
    }
    if (conns.size === 0) realtimeClients.delete(uid);
  }
  return closed;
}

export function disconnectRealtimeUser(userId, reason = 'account_suspended') {
  if (!userId) return 0;
  const conns = realtimeClients.get(String(userId));
  if (!conns) return 0;
  let closed = 0;
  for (const conn of [...conns]) {
    try {
      conn.send('session.revoked', { reason, timestamp: new Date().toISOString() });
      if (typeof conn.close === 'function') conn.close();
    } catch {}
    conns.delete(conn);
    closed++;
  }
  realtimeClients.delete(String(userId));
  return closed;
}

export function registerRealtimeConnection(userId, conn, options = {}) {
  const uid = String(userId);
  if (options?.expiresAt && !conn.expiresAt) {
    conn.expiresAt = options.expiresAt;
  }
  if (!realtimeClients.has(uid)) realtimeClients.set(uid, new Set());
  realtimeClients.get(uid).add(conn);
  return () => {
    const set = realtimeClients.get(uid);
    if (set) {
      set.delete(conn);
      if (set.size === 0) realtimeClients.delete(uid);
    }
  };
}

/**
 * Minimal RFC 6455 WebSocket Frame Helper (Server-side text frames + ping/pong/close)
 * Enables zero-dependency native WebSocket upgrades on Node.js http.Server.
 */
export function upgradeToChatWebSocket(req, socket, head, { actor, sessionToken = null, initialConversationId = null, expiresAt = null, onClientMessage, onDisconnect }) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  function sendWsJson(obj) {
    if (socket.destroyed || !socket.writable) return;
    const json = JSON.stringify(obj);
    const payload = Buffer.from(json, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text frame
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  }

  const calculatedExpiresAt = expiresAt || (actor?.expires_at ? new Date(actor.expires_at).getTime() : (actor?.expiresAt ? new Date(actor.expiresAt).getTime() : null));
  const conn = {
    sessionToken: sessionToken || null,
    expiresAt: calculatedExpiresAt,
    conversationIds: initialConversationId ? new Set([initialConversationId]) : new Set(),
    singleConversationId: initialConversationId || null,
    send(event, data) {
      sendWsJson({ event, data, ts: new Date().toISOString() });
    },
    close() {
      try {
        if (!socket.destroyed) {
          socket.write(Buffer.from([0x88, 0x00])); // Close frame
          socket.end(() => socket.destroy());
        }
      } catch {}
    }
  };

  const unregister = registerRealtimeConnection(actor.id, conn, { expiresAt: calculatedExpiresAt });

  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);

  socket.on('data', async chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (payloadLen > 65536) {
        conn.close();
        return;
      }

      const maskLen = isMasked ? 4 : 0;
      if (buffer.length < offset + maskLen + payloadLen) return;

      const mask = isMasked ? buffer.subarray(offset, offset + 4) : null;
      offset += maskLen;
      const dataBuf = Buffer.from(buffer.subarray(offset, offset + payloadLen));
      buffer = buffer.subarray(offset + payloadLen);

      if (opcode === 0x08) {
        // Close frame
        conn.close();
        return;
      }
      if (opcode === 0x09) {
        // Ping -> Pong
        if (!socket.destroyed) socket.write(Buffer.from([0x8a, 0x00]));
        continue;
      }
      if (opcode === 0x01) {
        if (isMasked && mask) {
          for (let i = 0; i < dataBuf.length; i++) {
            dataBuf[i] ^= mask[i & 3];
          }
        }
        try {
          const parsed = JSON.parse(dataBuf.toString('utf8'));
          if (onClientMessage) {
            await onClientMessage(parsed, conn);
          }
        } catch (err) {
          conn.send('error', { message: err.message || 'Invalid WebSocket message' });
        }
      }
    }
  });

  const cleanup = () => {
    unregister();
    if (onDisconnect) onDisconnect();
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
  conn.send('connected', { userId: actor.id, role: actor.kind });
}

export function chatEngine(db) {
  check(db && typeof db.query === 'function', 500, 'Database instance required for chatEngine');

  async function loadPolicy(c = db) {
    const row = (await c.query('SELECT * FROM chat_messaging_policy WHERE id = true')).rows[0];
    return row || {
      post_delivery_resolution_minutes: 15,
      retention_days: 90,
      max_message_length: 1000,
      rate_limit_per_minute: 25,
      allow_location_pins: true
    };
  }

  async function logChatAudit(c, { conversationId = null, actor = null, actorRole = null, action, justification = null, metadata = {} }) {
    await c.query(
      `INSERT INTO chat_audit_logs (
         id, conversation_id, actor_id, actor_role, action, justification, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id(),
        conversationId,
        actor?.id || null,
        actorRole || actor?.kind || 'system',
        action,
        justification,
        JSON.stringify(metadata)
      ]
    );
  }

  /**
   * Synchronizes conversation state with the underlying shipment / food order lifecycle,
   * and verifies whether the actor is an authorized active participant.
   */
  async function authorizeConversationAccess(c, actor, conversationId, { requireSendable = false, supportJustification = null } = {}) {
    check(actor && actor.id, 401, 'Authentication required');
    check(uuid.safeParse(conversationId).success, 400, 'Invalid conversation ID');

    const conv = (await c.query('SELECT * FROM chat_conversations WHERE id = $1', [conversationId])).rows[0];
    check(conv, 404, 'Conversation not found');

    const policy = await loadPolicy(c);
    const now = new Date();

    // Load authoritative shipment and food order state
    const shipment = conv.shipment_id
      ? (await c.query('SELECT * FROM shipments WHERE id = $1', [conv.shipment_id])).rows[0]
      : null;
    const foodOrder = conv.food_order_id
      ? (await c.query('SELECT * FROM food_orders WHERE id = $1', [conv.food_order_id])).rows[0]
      : null;
    const restaurant = conv.restaurant_id
      ? (await c.query('SELECT * FROM restaurants WHERE id = $1', [conv.restaurant_id])).rows[0]
      : null;

    // 1. Check if rider on a rider-scoped conversation is no longer the assigned rider on the shipment!
    if (conv.conversation_type === 'CUSTOMER_RIDER' || conv.conversation_type === 'RIDER_RESTAURANT') {
      if (!shipment || !shipment.rider_id || (conv.active_rider_id && shipment.rider_id !== conv.active_rider_id)) {
        // Auto-revoke the old rider if still marked active
        if (conv.active_rider_id) {
          await c.query(
            `UPDATE chat_participants
             SET membership_status = 'revoked', revoked_at = COALESCE(revoked_at, now()), revoked_reason = 'rider_reassigned'
             WHERE conversation_id = $1 AND user_id = $2 AND membership_status = 'active'`,
            [conv.id, conv.active_rider_id]
          );
          disconnectRevokedUserFromConversation(conv.active_rider_id, conv.id, 'rider_reassigned');
        }
        if (conv.state !== 'CLOSED' && conv.state !== 'ARCHIVED') {
          await c.query(
            `UPDATE chat_conversations SET state = 'CLOSED', closed_at = COALESCE(closed_at, now()), updated_at = now() WHERE id = $1`,
            [conv.id]
          );
          conv.state = 'CLOSED';
        }
      }
    }

    // 2. Check post-delivery resolution window expiration for non-support conversations
    if (conv.conversation_type !== 'CUSTOMER_SUPPORT') {
      const isCancelledOrRejected =
        (shipment && ['CANCELLED', 'RETURNED'].includes(shipment.state)) ||
        (foodOrder && ['CANCELLED', 'REJECTED'].includes(foodOrder.state));

      if (isCancelledOrRejected && conv.state !== 'CLOSED' && conv.state !== 'ARCHIVED') {
        await c.query(
          `UPDATE chat_conversations SET state = 'CLOSED', closed_at = COALESCE(closed_at, now()), updated_at = now() WHERE id = $1`,
          [conv.id]
        );
        conv.state = 'CLOSED';
      }

      const isCompleted =
        (shipment && shipment.state === 'COMPLETED') ||
        (foodOrder && foodOrder.state === 'DELIVERED');

      if (isCompleted && !conv.restricted_after) {
        const resAfter = new Date((shipment?.completed_at || foodOrder?.completed_at || now).getTime() + policy.post_delivery_resolution_minutes * 60 * 1000);
        await c.query(
          `UPDATE chat_conversations SET restricted_after = $2, updated_at = now() WHERE id = $1`,
          [conv.id, resAfter]
        );
        conv.restricted_after = resAfter;
      }

      if (conv.restricted_after && new Date(conv.restricted_after) <= now && conv.state === 'ACTIVE') {
        await c.query(
          `UPDATE chat_conversations SET state = 'RESTRICTED', updated_at = now() WHERE id = $1`,
          [conv.id]
        );
        conv.state = 'RESTRICTED';
      }
    }

    // 3. Check retention expiration
    if (conv.retention_expires_at && new Date(conv.retention_expires_at) <= now && conv.state !== 'ARCHIVED') {
      await c.query(`UPDATE chat_conversations SET state = 'ARCHIVED', archived_at = now(), updated_at = now() WHERE id = $1`, [conv.id]);
      conv.state = 'ARCHIVED';
    }

    // 4. Verify participant authorization
    let participant = (await c.query(
      'SELECT * FROM chat_participants WHERE conversation_id = $1 AND user_id = $2',
      [conv.id, actor.id]
    )).rows[0];

    if (actor.kind === 'admin') {
      const hasSupportPerm = (await c.query(
        "SELECT 1 FROM permissions WHERE user_id = $1 AND permission IN ('support:chat', 'support:moderate', 'verification:write', 'dispatch:configure')",
        [actor.id]
      )).rowCount;
      check(hasSupportPerm, 403, 'Support chat permission required for administrative conversation access');

      if (!participant && conv.conversation_type !== 'CUSTOMER_SUPPORT') {
        check(
          supportJustification && typeof supportJustification === 'string' && supportJustification.trim().length >= 8,
          403,
          'Support access to non-support conversations requires an explicit investigation justification reason (min 8 characters)'
        );
        await logChatAudit(c, {
          conversationId: conv.id,
          actor,
          actorRole: 'support',
          action: 'support.investigate_conversation',
          justification: supportJustification.trim()
        });
      }
      if (!participant) {
        participant = {
          conversation_id: conv.id,
          user_id: actor.id,
          role: 'support',
          membership_status: 'active',
          muted: false,
          last_read_seq: conv.last_message_seq,
          last_delivered_seq: conv.last_message_seq
        };
      }
    } else {
      if (actor.kind === 'rider' || participant?.role === 'rider') {
        const riderRow = (await c.query(
          'SELECT r.status, c.status AS company_status, r.company_id FROM riders r LEFT JOIN companies c ON c.id = r.company_id WHERE r.id = $1',
          [actor.id]
        )).rows[0];
        check(riderRow && riderRow.status === 'approved' && (!riderRow.company_id || riderRow.company_status === 'approved'), 403, 'Rider account suspended or not approved');
      }
      check(participant, 403, 'You are not a participant in this conversation');
      check(participant.membership_status === 'active', 403, 'Your access to this conversation has been revoked');

      // Double-check live object-level role ownership!
      if (participant.role === 'rider') {
        check(
          shipment && shipment.rider_id === actor.id && conv.active_rider_id === actor.id,
          403,
          'You are no longer the assigned courier for this delivery'
        );
      } else if (participant.role === 'restaurant') {
        check(
          restaurant && restaurant.owner_id === actor.id,
          403,
          'You are not the authorized owner of the restaurant for this conversation'
        );
      } else if (participant.role === 'customer') {
        check(
          conv.customer_id === actor.id,
          403,
          'You are not the customer who owns this order'
        );
      }
    }

    if (conv.state === 'ARCHIVED' && actor.kind !== 'admin') {
      check(false, 410, 'This conversation has expired under the data retention policy');
    }

    if (requireSendable) {
      check(
        conv.state === 'ACTIVE' || conv.state === 'CREATED',
        409,
        `Cannot send new messages because this conversation is ${conv.state.toLowerCase()}`
      );
    }

    return { conv, participant, shipment, foodOrder, restaurant, policy };
  }

  return {
    async getMessagingPolicy(actor) {
      check(actor?.kind === 'admin', 403, 'Administrator required');
      const row = await loadPolicy(db);
      return {
        postDeliveryResolutionMinutes: row.post_delivery_resolution_minutes,
        retentionDays: row.retention_days,
        maxMessageLength: row.max_message_length,
        rateLimitPerMinute: row.rate_limit_per_minute,
        allowLocationPins: row.allow_location_pins
      };
    },

    async updateMessagingPolicy(actor, input) {
      check(actor?.kind === 'admin', 403, 'Administrator required');
      const hasPerm = (await db.query(
        "SELECT 1 FROM permissions WHERE user_id = $1 AND permission IN ('support:moderate', 'dispatch:configure', 'finance:configure')",
        [actor.id]
      )).rowCount;
      check(hasPerm, 403, 'Permission required to update messaging policy');

      const schema = z.object({
        postDeliveryResolutionMinutes: z.number().int().min(0).max(1440).optional(),
        retentionDays: z.number().int().min(7).max(3650).optional(),
        maxMessageLength: z.number().int().min(50).max(4000).optional(),
        rateLimitPerMinute: z.number().int().min(3).max(200).optional(),
        allowLocationPins: z.boolean().optional()
      }).strict();
      const v = schema.parse(input);

      return db.tx(async c => {
        const cur = await loadPolicy(c);
        const nextRes = v.postDeliveryResolutionMinutes ?? cur.post_delivery_resolution_minutes;
        const nextRet = v.retentionDays ?? cur.retention_days;
        const nextLen = v.maxMessageLength ?? cur.max_message_length;
        const nextRate = v.rateLimitPerMinute ?? cur.rate_limit_per_minute;
        const nextPins = v.allowLocationPins ?? cur.allow_location_pins;

        await c.query(
          `UPDATE chat_messaging_policy
           SET post_delivery_resolution_minutes = $1,
               retention_days = $2,
               max_message_length = $3,
               rate_limit_per_minute = $4,
               allow_location_pins = $5,
               updated_by = $6,
               updated_at = now()
           WHERE id = true`,
          [nextRes, nextRet, nextLen, nextRate, nextPins, actor.id]
        );

        await logChatAudit(c, {
          actor,
          action: 'policy.updated',
          metadata: { nextRes, nextRet, nextLen, nextRate, nextPins }
        });

        return {
          postDeliveryResolutionMinutes: nextRes,
          retentionDays: nextRet,
          maxMessageLength: nextLen,
          rateLimitPerMinute: nextRate,
          allowLocationPins: nextPins
        };
      });
    },

    /**
     * Open or create an order-scoped conversation for one of the 4 permitted categories:
     * - CUSTOMER_RIDER
     * - CUSTOMER_RESTAURANT
     * - RIDER_RESTAURANT
     * - CUSTOMER_SUPPORT
     */
    async openOrCreateConversation(actor, input) {
      check(actor && actor.id, 401, 'Authentication required');
      const schema = z.object({
        conversationType: z.enum(['CUSTOMER_RIDER', 'CUSTOMER_RESTAURANT', 'RIDER_RESTAURANT', 'CUSTOMER_SUPPORT']),
        shipmentId: z.string().uuid().nullable().optional(),
        foodOrderId: z.string().uuid().nullable().optional(),
        supportCategory: z.enum([
          'order_issue', 'rider_issue', 'restaurant_issue', 'address_change_request',
          'payment_dispute', 'safety_report', 'general'
        ]).optional(),
        escalatedFromConversationId: z.string().uuid().nullable().optional()
      }).strict();
      const v = schema.parse(input);
      check(v.shipmentId || v.foodOrderId, 400, 'Every conversation must be linked to an authorized shipmentId or foodOrderId');

      return db.tx(async c => {
        let foodOrder = v.foodOrderId
          ? (await c.query('SELECT * FROM food_orders WHERE id = $1 FOR UPDATE', [v.foodOrderId])).rows[0]
          : null;
        let shipment = v.shipmentId
          ? (await c.query('SELECT * FROM shipments WHERE id = $1 FOR UPDATE', [v.shipmentId])).rows[0]
          : null;

        if (foodOrder && !shipment && foodOrder.shipment_id) {
          shipment = (await c.query('SELECT * FROM shipments WHERE id = $1 FOR UPDATE', [foodOrder.shipment_id])).rows[0];
        }
        if (shipment && !foodOrder) {
          foodOrder = (await c.query('SELECT * FROM food_orders WHERE shipment_id = $1 FOR UPDATE', [shipment.id])).rows[0] || null;
        }

        check(shipment || foodOrder, 404, 'Referenced order or shipment not found');
        if (foodOrder && shipment) {
          check(foodOrder.shipment_id === shipment.id, 400, 'Mismatched foodOrderId and shipmentId');
        }

        const restaurant = foodOrder
          ? (await c.query('SELECT * FROM restaurants WHERE id = $1', [foodOrder.restaurant_id])).rows[0]
          : null;

        const customerId = foodOrder?.customer_id || shipment?.customer_id;
        const activeRiderId = shipment?.rider_id || null;
        const restaurantOwnerId = restaurant?.owner_id || null;

        // Validate category-specific eligibility and caller authorization
        if (v.conversationType === 'CUSTOMER_RIDER') {
          check(shipment, 400, 'Customer-to-Rider chat requires an active shipment');
          check(activeRiderId, 409, 'Customer-to-Rider chat requires an active courier assignment and is only available after a courier has been assigned');
          check(
            !['CANCELLED', 'RETURNED'].includes(shipment.state),
            409,
            `Customer-to-Rider chat is unavailable for ${shipment.state} shipments`
          );
          if (actor.kind === 'rider') {
            check(actor.id === activeRiderId, 403, 'Only the currently assigned courier may access Customer-to-Rider chat');
          } else {
            const isAuthorized = actor.id === customerId || actor.kind === 'admin';
            check(isAuthorized, 403, 'Only the customer on this order may access Customer-to-Rider chat');
          }

          // Look for an existing open conversation for this exact shipment AND current active_rider_id
          const existing = (await c.query(
            `SELECT * FROM chat_conversations
             WHERE shipment_id = $1
               AND conversation_type = 'CUSTOMER_RIDER'
               AND active_rider_id = $2
               AND state IN ('CREATED', 'ACTIVE', 'RESTRICTED')
             ORDER BY created_at DESC LIMIT 1`,
            [shipment.id, activeRiderId]
          )).rows[0];

          if (existing) {
            const auth = await authorizeConversationAccess(c, actor, existing.id, { supportJustification: 'Opening existing conversation' });
            return this.formatConversationSummary(c, auth.conv, actor);
          }

          // Compute assignment epoch (1 + number of prior CUSTOMER_RIDER threads on this shipment)
          const priorConvs = (await c.query(
            `SELECT id, active_rider_id, assignment_epoch
             FROM chat_conversations
             WHERE shipment_id = $1 AND conversation_type = 'CUSTOMER_RIDER'`,
            [shipment.id]
          )).rows;
          let priorEpoch = 0;
          for (const pc of priorConvs) {
            if (Number(pc.assignment_epoch) > priorEpoch) priorEpoch = Number(pc.assignment_epoch);
            if (pc.active_rider_id && pc.active_rider_id !== activeRiderId) {
              disconnectRevokedUserFromConversation(pc.active_rider_id, pc.id, 'rider_reassigned');
            }
          }

          const convId = id();
          const conv = (await c.query(
            `INSERT INTO chat_conversations (
               id, conversation_type, shipment_id, food_order_id, restaurant_id,
               customer_id, active_rider_id, assignment_epoch, state
             ) VALUES ($1, 'CUSTOMER_RIDER', $2, $3, $4, $5, $6, $7, 'ACTIVE')
             RETURNING *`,
            [convId, shipment.id, foodOrder?.id || null, restaurant?.id || null, customerId, activeRiderId, priorEpoch + 1]
          )).rows[0];

          await c.query(
            `INSERT INTO chat_participants (id, conversation_id, user_id, role, membership_status)
             VALUES ($1, $2, $3, 'customer', 'active'),
                    ($4, $2, $5, 'rider', 'active')
             ON CONFLICT (conversation_id, user_id) DO UPDATE SET membership_status = 'active', revoked_at = NULL`,
            [id(), convId, customerId, id(), activeRiderId]
          );

          await logChatAudit(c, {
            conversationId: convId,
            actor,
            action: 'conversation.created',
            metadata: { conversationType: 'CUSTOMER_RIDER', shipmentId: shipment.id, activeRiderId, epoch: priorEpoch + 1 }
          });

          return this.formatConversationSummary(c, conv, actor);
        }

        if (v.conversationType === 'CUSTOMER_RESTAURANT') {
          check(foodOrder && restaurant, 400, 'Customer-to-Restaurant chat requires an active food order');
          check(
            !['CANCELLED', 'REJECTED'].includes(foodOrder.state),
            409,
            `Customer-to-Restaurant chat is unavailable for ${foodOrder.state} orders`
          );
          if (actor.kind === 'business') {
            check(actor.id === restaurantOwnerId, 403, 'Only the owning restaurant may access Customer-to-Restaurant chat');
          } else {
            const isAuthorized = actor.id === customerId || actor.id === restaurantOwnerId || actor.kind === 'admin';
            check(isAuthorized, 403, 'Only the customer on this food order may access Customer-to-Restaurant chat');
          }

          const existing = (await c.query(
            `SELECT * FROM chat_conversations
             WHERE food_order_id = $1
               AND conversation_type = 'CUSTOMER_RESTAURANT'
               AND state IN ('CREATED', 'ACTIVE', 'RESTRICTED')
             ORDER BY created_at DESC LIMIT 1`,
            [foodOrder.id]
          )).rows[0];

          if (existing) {
            const auth = await authorizeConversationAccess(c, actor, existing.id, { supportJustification: 'Opening existing conversation' });
            return this.formatConversationSummary(c, auth.conv, actor);
          }

          const convId = id();
          const conv = (await c.query(
            `INSERT INTO chat_conversations (
               id, conversation_type, shipment_id, food_order_id, restaurant_id,
               customer_id, state
             ) VALUES ($1, 'CUSTOMER_RESTAURANT', $2, $3, $4, $5, 'ACTIVE')
             RETURNING *`,
            [convId, shipment?.id || null, foodOrder.id, restaurant.id, customerId]
          )).rows[0];

          await c.query(
            `INSERT INTO chat_participants (id, conversation_id, user_id, role, membership_status)
             VALUES ($1, $2, $3, 'customer', 'active'),
                    ($4, $2, $5, 'restaurant', 'active')
             ON CONFLICT (conversation_id, user_id) DO UPDATE SET membership_status = 'active', revoked_at = NULL`,
            [id(), convId, customerId, id(), restaurantOwnerId]
          );

          await logChatAudit(c, {
            conversationId: convId,
            actor,
            action: 'conversation.created',
            metadata: { conversationType: 'CUSTOMER_RESTAURANT', foodOrderId: foodOrder.id, restaurantId: restaurant.id }
          });

          return this.formatConversationSummary(c, conv, actor);
        }

        if (v.conversationType === 'RIDER_RESTAURANT') {
          check(foodOrder && restaurant && shipment, 400, 'Rider-to-Restaurant chat requires a food order with an active delivery shipment');
          check(activeRiderId, 409, 'Rider-to-Restaurant chat requires an assigned courier');
          check(
            !['CANCELLED', 'REJECTED'].includes(foodOrder.state) && !['CANCELLED', 'RETURNED'].includes(shipment.state),
            409,
            'Rider-to-Restaurant chat is unavailable for cancelled/rejected orders'
          );
          const isAuthorized = actor.id === activeRiderId || actor.id === restaurantOwnerId || actor.kind === 'admin';
          check(isAuthorized, 403, 'Only the currently assigned courier and the fulfilling restaurant may access Rider-to-Restaurant chat');

          const existing = (await c.query(
            `SELECT * FROM chat_conversations
             WHERE food_order_id = $1
               AND conversation_type = 'RIDER_RESTAURANT'
               AND active_rider_id = $2
               AND state IN ('CREATED', 'ACTIVE', 'RESTRICTED')
             ORDER BY created_at DESC LIMIT 1`,
            [foodOrder.id, activeRiderId]
          )).rows[0];

          if (existing) {
            const auth = await authorizeConversationAccess(c, actor, existing.id, { supportJustification: 'Opening existing conversation' });
            return this.formatConversationSummary(c, auth.conv, actor);
          }

          const priorConvs = (await c.query(
            `SELECT id, active_rider_id, assignment_epoch
             FROM chat_conversations
             WHERE food_order_id = $1 AND conversation_type = 'RIDER_RESTAURANT'`,
            [foodOrder.id]
          )).rows;
          let priorEpoch = 0;
          for (const pc of priorConvs) {
            if (Number(pc.assignment_epoch) > priorEpoch) priorEpoch = Number(pc.assignment_epoch);
            if (pc.active_rider_id && pc.active_rider_id !== activeRiderId) {
              disconnectRevokedUserFromConversation(pc.active_rider_id, pc.id, 'rider_reassigned');
            }
          }

          const convId = id();
          const conv = (await c.query(
            `INSERT INTO chat_conversations (
               id, conversation_type, shipment_id, food_order_id, restaurant_id,
               customer_id, active_rider_id, assignment_epoch, state
             ) VALUES ($1, 'RIDER_RESTAURANT', $2, $3, $4, $5, $6, $7, 'ACTIVE')
             RETURNING *`,
            [convId, shipment.id, foodOrder.id, restaurant.id, customerId, activeRiderId, priorEpoch + 1]
          )).rows[0];

          await c.query(
            `INSERT INTO chat_participants (id, conversation_id, user_id, role, membership_status)
             VALUES ($1, $2, $3, 'rider', 'active'),
                    ($4, $2, $5, 'restaurant', 'active')
             ON CONFLICT (conversation_id, user_id) DO UPDATE SET membership_status = 'active', revoked_at = NULL`,
            [id(), convId, activeRiderId, id(), restaurantOwnerId]
          );

          await logChatAudit(c, {
            conversationId: convId,
            actor,
            action: 'conversation.created',
            metadata: { conversationType: 'RIDER_RESTAURANT', foodOrderId: foodOrder.id, activeRiderId, epoch: priorEpoch + 1 }
          });

          return this.formatConversationSummary(c, conv, actor);
        }

        // CUSTOMER_SUPPORT
        const isAuthorizedForSupport =
          actor.id === customerId ||
          (activeRiderId && actor.id === activeRiderId) ||
          (restaurantOwnerId && actor.id === restaurantOwnerId) ||
          actor.kind === 'admin';
        check(isAuthorizedForSupport, 403, 'You are not authorized to open a support case for this order');

        const existingSupport = (await c.query(
          `SELECT c.* FROM chat_conversations c
           JOIN chat_participants p ON p.conversation_id = c.id AND p.user_id = $1 AND p.membership_status = 'active'
           WHERE c.conversation_type = 'CUSTOMER_SUPPORT'
             AND (c.shipment_id = $2 OR c.food_order_id = $3)
             AND c.state IN ('CREATED', 'ACTIVE')
           ORDER BY c.created_at DESC LIMIT 1`,
          [actor.id, shipment?.id || null, foodOrder?.id || null]
        )).rows[0];

        if (existingSupport) {
          return this.formatConversationSummary(c, existingSupport, actor);
        }

        const convId = id();
        const initiatorRole = actor.kind === 'admin'
          ? 'support'
          : actor.id === customerId
          ? 'customer'
          : actor.id === activeRiderId
          ? 'rider'
          : 'restaurant';

        const conv = (await c.query(
          `INSERT INTO chat_conversations (
             id, conversation_type, shipment_id, food_order_id, restaurant_id,
             customer_id, active_rider_id, support_category,
             escalated_from_conversation_id, state
           ) VALUES ($1, 'CUSTOMER_SUPPORT', $2, $3, $4, $5, $6, $7, $8, 'ACTIVE')
           RETURNING *`,
          [
            convId,
            shipment?.id || null,
            foodOrder?.id || null,
            restaurant?.id || null,
            customerId,
            activeRiderId,
            v.supportCategory || 'general',
            v.escalatedFromConversationId || null
          ]
        )).rows[0];

        await c.query(
          `INSERT INTO chat_participants (id, conversation_id, user_id, role, membership_status)
           VALUES ($1, $2, $3, $4, 'active')`,
          [id(), convId, actor.id, initiatorRole]
        );

        // Also enroll authorized support admins so they receive notifications and can respond
        const supportAdmins = (await c.query(
          `SELECT u.id FROM users u
           JOIN permissions p ON p.user_id = u.id
           WHERE u.kind = 'admin' AND p.permission = 'support:chat'
           LIMIT 10`
        )).rows;
        for (const adm of supportAdmins) {
          await c.query(
            `INSERT INTO chat_participants (id, conversation_id, user_id, role, membership_status)
             VALUES ($1, $2, $3, 'support', 'active')
             ON CONFLICT (conversation_id, user_id) DO NOTHING`,
            [id(), convId, adm.id]
          );
        }

        await logChatAudit(c, {
          conversationId: convId,
          actor,
          action: 'support_conversation.created',
          metadata: {
            supportCategory: v.supportCategory || 'general',
            escalatedFromConversationId: v.escalatedFromConversationId || null,
            shipmentId: shipment?.id || null,
            foodOrderId: foodOrder?.id || null
          }
        });

        return this.formatConversationSummary(c, conv, actor);
      });
    },

    async formatConversationSummary(c, conv, actor) {
      const parts = (await c.query(
        `SELECT p.user_id, p.role, p.membership_status, p.muted, p.last_read_seq, p.last_delivered_seq, u.kind
         FROM chat_participants p
         JOIN users u ON u.id = p.user_id
         WHERE p.conversation_id = $1`,
        [conv.id]
      )).rows;

      const rest = conv.restaurant_id
        ? (await c.query('SELECT id, name FROM restaurants WHERE id = $1', [conv.restaurant_id])).rows[0]
        : null;
      const sh = conv.shipment_id
        ? (await c.query('SELECT id, state FROM shipments WHERE id = $1', [conv.shipment_id])).rows[0]
        : null;
      const fo = conv.food_order_id
        ? (await c.query('SELECT id, state FROM food_orders WHERE id = $1', [conv.food_order_id])).rows[0]
        : null;

      const myPart = parts.find(p => p.user_id === actor.id);
      const unreadCount = myPart
        ? (await c.query(
            `SELECT COUNT(*)::int AS cnt
             FROM chat_messages
             WHERE conversation_id = $1
               AND seq > $2
               AND sender_id <> $3`,
            [conv.id, Number(myPart.last_read_seq || 0), actor.id]
          )).rows[0].cnt
        : 0;

      // Privacy-safe participant list (NEVER exposes personal phone numbers!)
      const participants = parts
        .filter(p => p.membership_status === 'active')
        .map(p => ({
          userId: p.user_id,
          role: p.role,
          displayName: maskDisplayName({ name: p.name }, p.role, rest),
          lastReadSeq: Number(p.last_read_seq || 0),
          lastDeliveredSeq: Number(p.last_delivered_seq || 0)
        }));

      const myRole = myPart?.role || (actor.kind === 'admin' ? 'support' : actor.kind);

      return {
        id: conv.id,
        conversationType: conv.conversation_type,
        shipmentId: conv.shipment_id,
        foodOrderId: conv.food_order_id,
        restaurantId: conv.restaurant_id,
        restaurantName: rest?.name || null,
        assignmentEpoch: Number(conv.assignment_epoch || 1),
        orderReference: (conv.food_order_id || conv.shipment_id || '').slice(0, 8).toUpperCase(),
        shipmentState: sh?.state || null,
        foodOrderState: fo?.state || null,
        state: conv.state,
        restrictedAfter: conv.restricted_after || null,
        closedAt: conv.closed_at || null,
        lastMessageSeq: Number(conv.last_message_seq || 0),
        lastMessageAt: conv.last_message_at || null,
        lastMessagePreview: conv.last_message_preview || null,
        unreadCount,
        muted: Boolean(myPart?.muted),
        myRole,
        quickReplies: QUICK_REPLIES[myRole] || QUICK_REPLIES.customer,
        participants,
        createdAt: conv.created_at,
        updatedAt: conv.updated_at
      };
    },

    /**
     * List active/recent conversations for the authenticated user.
     */
    async listMyConversations(actor, { shipmentId = null, foodOrderId = null, restaurantId = null, includeClosed = false } = {}) {
      check(actor && actor.id, 401, 'Authentication required');
      const conds = [`p.user_id = $1`, `p.membership_status = 'active'`];
      const params = [actor.id];

      if (!includeClosed) {
        conds.push(`c.state IN ('CREATED', 'ACTIVE', 'RESTRICTED')`);
      } else {
        conds.push(`c.state <> 'ARCHIVED'`);
      }
      if (shipmentId) {
        params.push(shipmentId);
        conds.push(`c.shipment_id = $${params.length}`);
      }
      if (foodOrderId) {
        params.push(foodOrderId);
        conds.push(`c.food_order_id = $${params.length}`);
      }
      if (restaurantId) {
        params.push(restaurantId);
        conds.push(`c.restaurant_id = $${params.length}`);
      }

      const rows = (await db.query(
        `SELECT c.*
         FROM chat_conversations c
         JOIN chat_participants p ON p.conversation_id = c.id
         WHERE ${conds.join(' AND ')}
         ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
         LIMIT 50`,
        params
      )).rows;

      const results = [];
      for (const row of rows) {
        try {
          const auth = await authorizeConversationAccess(db, actor, row.id, { supportJustification: 'Listing conversations' });
          results.push(await this.formatConversationSummary(db, auth.conv, actor));
        } catch {
          // Skip conversations where live authorization was revoked (e.g. reassigned rider)
        }
      }
      return results;
    },

    /**
     * Send a real-time message (text, quick_reply, or confirmed advisory location_pin) with:
     * - Server-side participant & order lifecycle validation
     * - Client idempotency deduplication (clientMessageId)
     * - Rate limiting & message-length enforcement
     * - OTP & Paid-Address safety guards (never triggers OTP or alters paid address)
     * - Push notification enqueueing for authorized recipients
     */
    async sendMessage(actor, conversationId, input) {
      check(actor && actor.id, 401, 'Authentication required');
      const schema = z.object({
        clientMessageId: z.string().trim().min(4).max(120),
        messageType: z.enum(['text', 'quick_reply', 'location_pin']).default('text'),
        body: z.string().optional(),
        bodyText: z.string().optional(),
        quickReplyKey: z.string().trim().max(60).optional(),
        locationPin: z.object({
          latitude: z.number().finite().min(-90).max(90),
          longitude: z.number().finite().min(-180).max(180),
          label: z.string().trim().max(200).optional(),
          confirmed: z.boolean().optional()
        }).strict().optional()
      }).strict();
      const v = schema.parse(input);
      const rawBodyText = v.body ?? v.bodyText ?? '';

      return db.tx(async c => {
        const { conv, participant, shipment, policy } = await authorizeConversationAccess(c, actor, conversationId, {
          requireSendable: true,
          supportJustification: 'Support agent sending message'
        });

        // Check idempotency BEFORE rate-limiting so retries of already-accepted messages always succeed
        const existingMsg = (await c.query(
          `SELECT * FROM chat_messages
           WHERE conversation_id = $1 AND sender_id = $2 AND client_message_id = $3`,
          [conv.id, actor.id, v.clientMessageId]
        )).rows[0];
        if (existingMsg) {
          return { ...this.formatMessage(existingMsg), duplicate: true };
        }

        // Enforce per-user rate limit
        await limit(c, `chat-send:${actor.id}`, policy.rate_limit_per_minute || 25, 60);

        let messageBody = '';
        let locationPinPayload = null;

        if (v.messageType === 'quick_reply') {
          const allReplies = [...QUICK_REPLIES.rider, ...QUICK_REPLIES.restaurant, ...QUICK_REPLIES.customer, ...QUICK_REPLIES.support];
          const preset = v.quickReplyKey ? allReplies.find(q => q.key === v.quickReplyKey) : null;
          messageBody = preset ? preset.text : sanitizeText(rawBodyText);
          check(messageBody.length >= 1, 400, 'Quick reply message content required');
        } else if (v.messageType === 'location_pin') {
          check(policy.allow_location_pins, 403, 'Location pin sharing is disabled by policy');
          check(v.locationPin && v.locationPin.confirmed === true, 400, 'Location pin must be explicitly confirmed (confirmed: true)');
          validateGhanaBoundary(v.locationPin.latitude, v.locationPin.longitude);
          locationPinPayload = {
            latitude: v.locationPin.latitude,
            longitude: v.locationPin.longitude,
            label: sanitizeText(v.locationPin.label || 'Shared Map Pin (Advisory Only — Does Not Change Paid Order Destination)'),
            confirmed: true,
            advisoryOnly: true
          };
          messageBody = sanitizeText(rawBodyText || `📍 Shared map pin: ${locationPinPayload.label}`);
        } else {
          messageBody = sanitizeText(rawBodyText);
        }

        check(messageBody.length >= 1, 400, 'Message cannot be empty');
        check(
          messageBody.length <= (policy.max_message_length || 1000),
          400,
          `Message exceeds maximum length of ${policy.max_message_length || 1000} characters`
        );

        const otpWarning = detectOtpPattern(messageBody);
        const addressChangeWarning = detectAddressChangeRequest(messageBody);

        // Lock conversation to allocate next monotonic sequence number atomically
        const lockedConv = (await c.query(
          'SELECT last_message_seq FROM chat_conversations WHERE id = $1 FOR UPDATE',
          [conv.id]
        )).rows[0];
        const nextSeq = Number(lockedConv.last_message_seq || 0) + 1;
        const msgId = id();
        const senderRole = participant.role || (actor.kind === 'admin' ? 'support' : actor.kind);

        const msgRow = (await c.query(
          `INSERT INTO chat_messages (
             id, conversation_id, seq, sender_id, sender_role,
             client_message_id, message_type, body, quick_reply_key,
             location_pin, delivery_status, otp_warning, address_change_warning
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'SENT', $11, $12)
           RETURNING *`,
          [
            msgId,
            conv.id,
            nextSeq,
            actor.id,
            senderRole,
            v.clientMessageId,
            v.messageType,
            messageBody,
            v.quickReplyKey || null,
            locationPinPayload ? JSON.stringify(locationPinPayload) : null,
            otpWarning,
            addressChangeWarning
          ]
        )).rows[0];

        const preview = messageBody.slice(0, 120);
        await c.query(
          `UPDATE chat_conversations
           SET last_message_seq = $2,
               last_message_at = now(),
               last_message_preview = $3,
               state = CASE WHEN state = 'CREATED' THEN 'ACTIVE' ELSE state END,
               updated_at = now()
           WHERE id = $1`,
          [conv.id, nextSeq, preview]
        );

        // Update sender's own read/delivered watermark
        await c.query(
          `UPDATE chat_participants
           SET last_read_seq = GREATEST(last_read_seq, $3),
               last_delivered_seq = GREATEST(last_delivered_seq, $3),
               last_read_at = now(),
               last_delivered_at = now()
           WHERE conversation_id = $1 AND user_id = $2`,
          [conv.id, actor.id, nextSeq]
        );

        // Identify currently active authorized recipient participants
        const activeRecipients = (await c.query(
          `SELECT user_id, role, muted
           FROM chat_participants
           WHERE conversation_id = $1
             AND membership_status = 'active'
             AND user_id <> $2`,
          [conv.id, actor.id]
        )).rows.filter(r => {
          // Extra guard: if recipient is a rider, ensure they are STILL the shipment's current rider!
          if (r.role === 'rider' && (!shipment || shipment.rider_id !== r.user_id)) return false;
          return true;
        });

        // Enqueue privacy-safe push notifications for unmuted authorized recipients
        for (const rec of activeRecipients) {
          if (rec.muted) continue;
          const jobId = `chat:${msgId}:${rec.user_id}`;
          const lockScreenSafePayload = {
            conversationId: conv.id,
            conversationType: conv.conversation_type,
            shipmentId: conv.shipment_id || null,
            foodOrderId: conv.food_order_id || null,
            messageId: msgId,
            seq: nextSeq,
            senderRole,
            // Privacy rule: minimal lock-screen message, never leaks phone numbers, addresses, or full private text
            message: senderRole === 'rider'
              ? 'ELESEND: New message from your assigned courier. Open the app to view.'
              : senderRole === 'restaurant'
              ? 'ELESEND: New message from the restaurant preparing your order.'
              : senderRole === 'support'
              ? 'ELESEND Support: New response regarding your order.'
              : 'ELESEND: New message regarding your active order.'
          };
          await c.query(
            `INSERT INTO notification_jobs (id, recipient_id, kind, payload)
             VALUES ($1, $2, 'chat_message', $3)
             ON CONFLICT (id) DO NOTHING`,
            [jobId, rec.user_id, JSON.stringify(lockScreenSafePayload)]
          );
        }

        // Clear sender typing indicator
        ephemeralTyping.delete(`${conv.id}:${actor.id}`);

        const formatted = this.formatMessage(msgRow);
        const notifyUserIds = [actor.id, ...activeRecipients.map(r => r.user_id)];
        queueMicrotask(() => {
          publishRealtimeToUsers(notifyUserIds, 'message.created', formatted);
        });

        return { ...formatted, duplicate: false };
      });
    },

    formatMessage(row) {
      return {
        id: row.id,
        conversationId: row.conversation_id,
        seq: Number(row.seq),
        senderId: row.sender_id,
        senderRole: row.sender_role,
        clientMessageId: row.client_message_id,
        messageType: row.message_type,
        body: row.moderation_status === 'redacted'
          ? '[Message removed by ELESEND Safety Moderation]'
          : row.body,
        quickReplyKey: row.quick_reply_key || null,
        locationPin: row.location_pin || null,
        deliveryStatus: row.delivery_status,
        deliveredAt: row.delivered_at || null,
        readAt: row.read_at || null,
        moderationStatus: row.moderation_status,
        otpWarning: Boolean(row.otp_warning),
        addressChangeWarning: Boolean(row.address_change_warning),
        metadata: {
          otpWarning: Boolean(row.otp_warning),
          addressChangeWarning: Boolean(row.address_change_warning)
        },
        safetyNotice: row.otp_warning
          ? 'SECURITY REMINDER: Never share your 6-digit delivery OTP in chat. Enter verification codes only in the official confirmation prompt.'
          : row.address_change_warning
          ? 'ORDER POLICY: Chat messages cannot change a paid delivery destination. Use the official Support Escalation button if you need assistance.'
          : null,
        createdAt: row.created_at
      };
    },

    /**
     * Retrieve paginated message history & delta synchronization (afterSeq / beforeSeq).
     */
    async listMessages(actor, conversationId, { afterSeq = null, beforeSeq = null, limit: reqLimit = 50, supportJustification = null, supportReason = null } = {}) {
      const lim = Math.max(1, Math.min(100, Number(reqLimit) || 50));
      const effectiveJustification = supportJustification ?? supportReason ?? null;
      return db.tx(async c => {
        const { conv } = await authorizeConversationAccess(c, actor, conversationId, {
          requireSendable: false,
          supportJustification: effectiveJustification
        });

        const conds = ['conversation_id = $1'];
        const params = [conv.id];

        if (afterSeq !== null && afterSeq !== undefined && Number.isFinite(Number(afterSeq))) {
          params.push(Number(afterSeq));
          conds.push(`seq > $${params.length}`);
        }
        if (beforeSeq !== null && beforeSeq !== undefined && Number.isFinite(Number(beforeSeq))) {
          params.push(Number(beforeSeq));
          conds.push(`seq < $${params.length}`);
        }

        params.push(lim);
        const orderDir = afterSeq !== null && afterSeq !== undefined ? 'ASC' : 'DESC';
        const rows = (await c.query(
          `SELECT * FROM chat_messages
           WHERE ${conds.join(' AND ')}
           ORDER BY seq ${orderDir}
           LIMIT $${params.length}`,
          params
        )).rows;

        const ordered = orderDir === 'DESC' ? rows.reverse() : rows;
        const summary = await this.formatConversationSummary(c, conv, actor);

        // Collect active ephemeral typing indicators for this conversation
        const nowMs = Date.now();
        const typingUsers = [];
        for (const [k, val] of ephemeralTyping.entries()) {
          if (val.expiresAt <= nowMs) {
            ephemeralTyping.delete(k);
          } else if (k.startsWith(`${conv.id}:`) && val.userId !== actor.id) {
            typingUsers.push({ userId: val.userId, role: val.role });
          }
        }

        return {
          conversation: summary,
          messages: ordered.map(r => this.formatMessage(r)),
          typing: typingUsers,
          hasMore: rows.length === lim
        };
      });
    },

    /**
     * Verifiable recipient delivery acknowledgement (transitions SENT -> DELIVERED).
     */
    async acknowledgeDelivered(actor, conversationId, { upToSeq } = {}) {
      return db.tx(async c => {
        const { conv } = await authorizeConversationAccess(c, actor, conversationId, {
          requireSendable: false,
          supportJustification: 'Support delivery ack'
        });
        const targetSeq = Number.isInteger(Number(upToSeq)) ? Number(upToSeq) : Number(conv.last_message_seq || 0);
        if (targetSeq <= 0) return { deliveredSeq: 0, updatedCount: 0 };

        await c.query(
          `UPDATE chat_participants
           SET last_delivered_seq = GREATEST(last_delivered_seq, $3),
               last_delivered_at = now()
           WHERE conversation_id = $1 AND user_id = $2`,
          [conv.id, actor.id, targetSeq]
        );

        const updated = await c.query(
          `UPDATE chat_messages
           SET delivery_status = 'DELIVERED',
               delivered_at = COALESCE(delivered_at, now())
           WHERE conversation_id = $1
             AND seq <= $2
             AND sender_id <> $3
             AND delivery_status = 'SENT'
           RETURNING id, seq, sender_id`,
          [conv.id, targetSeq, actor.id]
        );

        if (updated.rowCount > 0) {
          const senderIds = [...new Set(updated.rows.map(r => r.sender_id))];
          queueMicrotask(() => {
            publishRealtimeToUsers(senderIds, 'message.delivered', {
              conversationId: conv.id,
              deliveredByUserId: actor.id,
              upToSeq: targetSeq,
              deliveredAt: new Date().toISOString()
            });
          });
        }

        return { conversationId: conv.id, deliveredSeq: targetSeq, updatedCount: updated.rowCount };
      });
    },

    /**
     * Verifiable read receipt (transitions SENT/DELIVERED -> READ only when recipient marks read).
     */
    async markRead(actor, conversationId, { upToSeq } = {}) {
      return db.tx(async c => {
        const { conv } = await authorizeConversationAccess(c, actor, conversationId, {
          requireSendable: false,
          supportJustification: 'Support read ack'
        });
        const targetSeq = Number.isInteger(Number(upToSeq)) ? Number(upToSeq) : Number(conv.last_message_seq || 0);
        if (targetSeq <= 0) return { readSeq: 0, updatedCount: 0 };

        await c.query(
          `UPDATE chat_participants
           SET last_read_seq = GREATEST(last_read_seq, $3),
               last_delivered_seq = GREATEST(last_delivered_seq, $3),
               last_read_at = now(),
               last_delivered_at = COALESCE(last_delivered_at, now())
           WHERE conversation_id = $1 AND user_id = $2`,
          [conv.id, actor.id, targetSeq]
        );

        const updated = await c.query(
          `UPDATE chat_messages
           SET delivery_status = 'READ',
               delivered_at = COALESCE(delivered_at, now()),
               read_at = COALESCE(read_at, now())
           WHERE conversation_id = $1
             AND seq <= $2
             AND sender_id <> $3
             AND delivery_status IN ('SENT', 'DELIVERED')
           RETURNING id, seq, sender_id`,
          [conv.id, targetSeq, actor.id]
        );

        if (updated.rowCount > 0) {
          const senderIds = [...new Set(updated.rows.map(r => r.sender_id))];
          queueMicrotask(() => {
            publishRealtimeToUsers(senderIds, 'message.read', {
              conversationId: conv.id,
              readByUserId: actor.id,
              upToSeq: targetSeq,
              readAt: new Date().toISOString()
            });
          });
        }

        return { conversationId: conv.id, readSeq: targetSeq, updatedCount: updated.rowCount };
      });
    },

    /**
     * Ephemeral Typing Indicator (in-memory only, zero database writes!).
     */
    async sendTypingIndicator(actor, conversationId, { isTyping = true } = {}) {
      const { conv, participant } = await authorizeConversationAccess(db, actor, conversationId, {
        requireSendable: true
      });
      const key = `${conv.id}:${actor.id}`;
      if (isTyping) {
        ephemeralTyping.set(key, {
          userId: actor.id,
          role: participant.role,
          expiresAt: Date.now() + 5000
        });
      } else {
        ephemeralTyping.delete(key);
      }

      const activeParts = (await db.query(
        `SELECT user_id FROM chat_participants
         WHERE conversation_id = $1 AND membership_status = 'active' AND user_id <> $2`,
        [conv.id, actor.id]
      )).rows;

      publishRealtimeToUsers(
        activeParts.map(p => p.user_id),
        'typing.updated',
        {
          conversationId: conv.id,
          userId: actor.id,
          role: participant.role,
          isTyping: Boolean(isTyping)
        }
      );

      return { ok: true, isTyping: Boolean(isTyping) };
    },

    /**
     * Mute or unmute push notifications for a conversation.
     */
    async setConversationMute(actor, conversationId, { muted } = {}) {
      const { conv } = await authorizeConversationAccess(db, actor, conversationId);
      await db.query(
        'UPDATE chat_participants SET muted = $3 WHERE conversation_id = $1 AND user_id = $2',
        [conv.id, actor.id, Boolean(muted)]
      );
      return { conversationId: conv.id, muted: Boolean(muted) };
    },

    /**
     * Report abusive message or conversation to ELESEND Safety & Support.
     */
    async reportAbuse(actor, conversationId, input) {
      const normalizedInput = {
        messageId: input?.messageId ?? input?.reportedMessageId ?? null,
        category: input?.category ?? input?.reasonCategory,
        details: input?.details
      };
      const schema = z.object({
        messageId: z.string().uuid().nullable().optional(),
        category: z.enum([
          'harassment', 'threats', 'fraudulent_payment_request',
          'unsafe_delivery_instructions', 'inappropriate_messages',
          'spam', 'disputed_order_info'
        ]),
        details: z.string().trim().min(5).max(1000)
      }).strict();
      const v = schema.parse(normalizedInput);

      return db.tx(async c => {
        const { conv, participant } = await authorizeConversationAccess(c, actor, conversationId, {
          requireSendable: false,
          supportJustification: 'Reporting abuse'
        });

        if (v.messageId) {
          const msg = (await c.query(
            'SELECT id FROM chat_messages WHERE id = $1 AND conversation_id = $2',
            [v.messageId, conv.id]
          )).rows[0];
          check(msg, 404, 'Reported message not found in this conversation');
          await c.query(
            "UPDATE chat_messages SET moderation_status = 'flagged' WHERE id = $1 AND moderation_status = 'clean'",
            [v.messageId]
          );
        }

        const reportId = id();
        const row = (await c.query(
          `INSERT INTO chat_abuse_reports (
             id, conversation_id, message_id, reporter_id, reporter_role, category, details, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
           RETURNING *`,
          [reportId, conv.id, v.messageId || null, actor.id, participant.role, v.category, v.details]
        )).rows[0];

        await logChatAudit(c, {
          conversationId: conv.id,
          actor,
          actorRole: participant.role,
          action: 'abuse.reported',
          justification: v.details,
          metadata: { reportId, category: v.category, messageId: v.messageId || null }
        });

        return row;
      });
    },

    /**
     * Escalate an unresolved Rider or Restaurant conversation to ELESEND Support.
     */
    async escalateToSupport(actor, conversationId, input) {
      const schema = z.object({
        supportCategory: z.enum([
          'order_issue', 'rider_issue', 'restaurant_issue', 'address_change_request',
          'payment_dispute', 'safety_report', 'general'
        ]).default('order_issue'),
        summary: z.string().trim().min(5).max(1000)
      }).strict();
      const v = schema.parse(input);

      const { conv } = await authorizeConversationAccess(db, actor, conversationId);
      const supportConv = await this.openOrCreateConversation(actor, {
        conversationType: 'CUSTOMER_SUPPORT',
        shipmentId: conv.shipment_id,
        foodOrderId: conv.food_order_id,
        supportCategory: v.supportCategory,
        escalatedFromConversationId: conv.id
      });

      const initialMessage = await this.sendMessage(actor, supportConv.id, {
        clientMessageId: `escalate-${conv.id}-${Date.now()}`,
        messageType: 'text',
        body: `[Escalated ${v.supportCategory.replace(/_/g, ' ')}]: ${v.summary}`
      });

      return {
        supportConversation: supportConv,
        initialMessage
      };
    },

    /**
     * Admin / Support Operations: List Support Queue & Abuse Reports, Inspect with Justification, Moderate.
     */
    async listSupportQueue(actor, { status = null } = {}) {
      check(actor?.kind === 'admin', 403, 'Administrator access required');
      const hasPerm = (await db.query(
        "SELECT 1 FROM permissions WHERE user_id = $1 AND permission IN ('support:chat', 'support:moderate', 'verification:write', 'dispatch:configure')",
        [actor.id]
      )).rowCount;
      check(hasPerm, 403, 'Support chat permission required');

      const supportConversations = (await db.query(
        `SELECT * FROM chat_conversations
         WHERE conversation_type = 'CUSTOMER_SUPPORT'
           AND state IN ('CREATED', 'ACTIVE', 'RESTRICTED')
         ORDER BY COALESCE(last_message_at, created_at) DESC
         LIMIT 100`
      )).rows;

      const abuseReports = (await db.query(
        `SELECT r.*, c.conversation_type, c.shipment_id, c.food_order_id, m.body AS message_body
         FROM chat_abuse_reports r
         JOIN chat_conversations c ON c.id = r.conversation_id
         LEFT JOIN chat_messages m ON m.id = r.message_id
         ${status ? 'WHERE r.status = $1' : ''}
         ORDER BY r.created_at DESC
         LIMIT 100`,
        status ? [status] : []
      )).rows;

      const formattedConvs = [];
      for (const c of supportConversations) {
        formattedConvs.push(await this.formatConversationSummary(db, c, actor));
      }

      return {
        supportConversations: formattedConvs,
        abuseReports
      };
    },

    async moderateAbuseReport(actor, reportId, input) {
      check(actor?.kind === 'admin', 403, 'Administrator access required');
      const hasPerm = (await db.query(
        "SELECT 1 FROM permissions WHERE user_id = $1 AND permission IN ('support:moderate', 'verification:write', 'dispatch:configure')",
        [actor.id]
      )).rowCount;
      check(hasPerm, 403, 'Support moderation permission required');

      const schema = z.object({
        status: z.enum(['investigating', 'resolved', 'dismissed']),
        redactMessage: z.boolean().optional().default(false),
        restrictConversation: z.boolean().optional().default(false),
        resolutionNotes: z.string().trim().min(8).max(1000)
      }).strict();
      const v = schema.parse(input);

      return db.tx(async c => {
        const rep = (await c.query('SELECT * FROM chat_abuse_reports WHERE id = $1 FOR UPDATE', [reportId])).rows[0];
        check(rep, 404, 'Abuse report not found');

        const updated = (await c.query(
          `UPDATE chat_abuse_reports
           SET status = $2,
               assigned_support_id = $3,
               resolution_notes = $4,
               resolved_at = CASE WHEN $2 IN ('resolved', 'dismissed') THEN now() ELSE resolved_at END
           WHERE id = $1
           RETURNING *`,
          [reportId, v.status, actor.id, v.resolutionNotes]
        )).rows[0];

        if (v.redactMessage && rep.message_id) {
          await c.query(
            "UPDATE chat_messages SET moderation_status = 'redacted' WHERE id = $1",
            [rep.message_id]
          );
        }
        if (v.restrictConversation) {
          await c.query(
            "UPDATE chat_conversations SET state = 'RESTRICTED', updated_at = now() WHERE id = $1",
            [rep.conversation_id]
          );
        }

        await logChatAudit(c, {
          conversationId: rep.conversation_id,
          actor,
          actorRole: 'support',
          action: `abuse_report.${v.status}`,
          justification: v.resolutionNotes,
          metadata: { reportId, redactMessage: v.redactMessage, restrictConversation: v.restrictConversation }
        });

        return updated;
      });
    },

    async revokeRiderConversations(clientOrDb, { shipmentId, oldRiderUserId = null, reason = 'rider_reassigned' } = {}) {
      const c = clientOrDb || db;
      if (!shipmentId) return { revokedCount: 0 };
      const convs = (await c.query(
        `SELECT id, active_rider_id, state FROM chat_conversations
         WHERE shipment_id = $1
           AND conversation_type IN ('CUSTOMER_RIDER', 'RIDER_RESTAURANT')
           AND state IN ('CREATED', 'ACTIVE', 'RESTRICTED', 'CLOSED')`,
        [shipmentId]
      )).rows;

      for (const conv of convs) {
        const riderToRevoke = oldRiderUserId || conv.active_rider_id;
        if (riderToRevoke) {
          await c.query(
            `UPDATE chat_participants
             SET membership_status = 'revoked', revoked_at = COALESCE(revoked_at, now()), revoked_reason = $3
             WHERE conversation_id = $1 AND user_id = $2`,
            [conv.id, riderToRevoke, reason]
          );
          await c.query(
            `UPDATE notification_jobs
             SET state = 'expired', lease_until = NULL
             WHERE recipient_id = $1 AND kind = 'chat_message' AND state IN ('pending', 'sending')
               AND payload->>'conversationId' = $2`,
            [riderToRevoke, conv.id]
          );
          disconnectRevokedUserFromConversation(riderToRevoke, conv.id, reason);
        }
        if (conv.state !== 'CLOSED') {
          await c.query(
            `UPDATE chat_conversations
             SET state = 'CLOSED', closed_at = COALESCE(closed_at, now()), updated_at = now()
             WHERE id = $1`,
            [conv.id]
          );
        }
      }
      return { revokedCount: convs.length };
    },

    authorizeConversationAccess
  };
}
