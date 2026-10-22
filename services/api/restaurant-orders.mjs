import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check} from './security.mjs';
import {haversine} from './dispatch-geometry.mjs';
import {calculateQuote} from './pricing.mjs';
import {evaluateRestaurantBatch} from './algorithms/restaurant-batch.mjs';

const uuid = z.string().uuid();

export function restaurantOrderService(db, {platform = null, dispatcher = null, routing = null} = {}) {
  check(db && typeof db.query === 'function', 500, 'Database instance required');

  async function quoteFoodOrder(actor, input) {
    check(actor && ['customer', 'business', 'admin'].includes(actor.kind), 403, 'Customer credentials required');
    const schema = z.object({
      restaurantId: z.string().uuid(),
      items: z.array(z.object({
        itemId: z.string().uuid(),
        quantity: z.number().int().min(1).max(50),
        options: z.array(z.string().uuid()).default([])
      })).min(1).max(30),
      deliveryAddress: z.string().trim().min(3).max(255),
      deliveryLatitude: z.number().finite().min(4.5).max(11.5),
      deliveryLongitude: z.number().finite().min(-3.5).max(1.5),
      customerPhone: z.string().trim().transform(p => p.replace(/\s+/g, '')).pipe(z.string().regex(/^(\+233|0)[25][0-9]{8}$/, 'Valid Ghana phone number required')),
      specialInstructions: z.string().trim().max(300).optional().default('')
    }).strict();

    const data = schema.parse(input);

    const restaurant = (await db.query('SELECT * FROM restaurants WHERE id = $1', [data.restaurantId])).rows[0];
    check(restaurant, 404, 'Restaurant not found');
    check(restaurant.status === 'approved', 400, 'Restaurant is not currently approved');
    check(restaurant.is_open && !restaurant.is_paused, 400, 'Restaurant is currently closed or paused');

    // Check delivery distance against restaurant delivery radius
    const distM = Math.round(haversine(
      {latitude: restaurant.latitude, longitude: restaurant.longitude},
      {latitude: data.deliveryLatitude, longitude: data.deliveryLongitude}
    ));
    check(distM <= restaurant.delivery_radius_m, 400, `Delivery address is outside restaurant delivery radius (${Math.round(restaurant.delivery_radius_m / 1000)}km)`);

    const itemIds = [...new Set(data.items.map(i => i.itemId))];
    const dbItems = (await db.query(
      'SELECT * FROM menu_items WHERE id = ANY($1::uuid[]) AND restaurant_id = $2',
      [itemIds, data.restaurantId]
    )).rows;
    check(dbItems.length === itemIds.length, 400, 'One or more menu items are invalid or not from this restaurant');

    const itemMap = new Map(dbItems.map(i => [i.id, i]));
    for (const it of dbItems) {
      check(it.is_available, 400, `Item "${it.name}" is currently sold out`);
    }

    // Fetch modifiers and options for validation
    const dbModifiers = (await db.query(
      'SELECT * FROM menu_item_modifiers WHERE item_id = ANY($1::uuid[])',
      [itemIds]
    )).rows;
    const modMap = new Map();
    for (const m of dbModifiers) {
      if (!modMap.has(m.item_id)) modMap.set(m.item_id, []);
      modMap.get(m.item_id).push(m);
    }

    const allModIds = dbModifiers.map(m => m.id);
    let dbOptions = [];
    if (allModIds.length > 0) {
      dbOptions = (await db.query(
        'SELECT * FROM menu_modifier_options WHERE modifier_id = ANY($1::uuid[])',
        [allModIds]
      )).rows;
    }
    const optMap = new Map(dbOptions.map(o => [o.id, o]));

    let foodSubtotalMinor = 0n;
    let maxItemPrepMinutes = restaurant.prep_time_minutes;
    const orderItems = [];

    for (const requested of data.items) {
      const it = itemMap.get(requested.itemId);
      if (it.prep_time_minutes && it.prep_time_minutes > maxItemPrepMinutes) {
        maxItemPrepMinutes = it.prep_time_minutes;
      }

      const itemMods = modMap.get(it.id) || [];
      const selectedOpts = [];
      let modifierExtraMinor = 0n;

      const optsByMod = new Map();
      for (const optId of requested.options) {
        const opt = optMap.get(optId);
        check(opt, 400, `Invalid modifier option ID: ${optId}`);
        check(opt.is_available, 400, `Option "${opt.name}" is currently unavailable`);
        selectedOpts.push({id: opt.id, name: opt.name, price_minor: opt.price_minor});
        modifierExtraMinor += BigInt(opt.price_minor);

        if (!optsByMod.has(opt.modifier_id)) optsByMod.set(opt.modifier_id, 0);
        optsByMod.set(opt.modifier_id, optsByMod.get(opt.modifier_id) + 1);
      }

      // Check min/max required modifier selections
      for (const m of itemMods) {
        const count = optsByMod.get(m.id) || 0;
        if (m.is_required && count < Math.max(1, m.min_selections)) {
          check(false, 400, `Required choice missing for "${it.name}": ${m.name}`);
        }
        if (count > m.max_selections) {
          check(false, 400, `Too many choices selected for "${it.name}": ${m.name} (max ${m.max_selections})`);
        }
      }

      const unitPriceMinor = BigInt(it.price_minor) + modifierExtraMinor;
      const totalItemMinor = unitPriceMinor * BigInt(requested.quantity);
      foodSubtotalMinor += totalItemMinor;

      orderItems.push({
        itemId: it.id,
        name: it.name,
        quantity: requested.quantity,
        unitPriceMinor: Number(unitPriceMinor),
        totalPriceMinor: Number(totalItemMinor),
        options: selectedOpts
      });
    }

    // Independent food commission calculation (default 10%, strictly decoupled from delivery)
    const foodCommBps = BigInt(restaurant.food_commission_bps);
    const foodCommissionMinor = foodCommBps === 0n ? 0 : Math.min(Number(foodSubtotalMinor), Number((foodSubtotalMinor * foodCommBps + 5000n) / 10000n));

    // Calculate delivery quote using platform pricing policy
    const policy = (await db.query(
      "SELECT * FROM pricing_policies WHERE active AND (vehicle = 'motorcycle' OR vehicle IS NULL) ORDER BY vehicle = 'motorcycle' DESC LIMIT 1"
    )).rows[0];

    let roadDistanceMeters = distM;
    let roadDurationSeconds = Math.round(distM / 6.5); // ~23 km/h urban motorcycle speed in Accra
    if (routing && typeof routing.route === 'function') {
      try {
        const routeResult = await routing.route(
          {latitude: restaurant.latitude, longitude: restaurant.longitude},
          {latitude: data.deliveryLatitude, longitude: data.deliveryLongitude},
          {vehicle: 'motorcycle'}
        );
        if (routeResult?.distanceMeters) {
          roadDistanceMeters = routeResult.distanceMeters;
          roadDurationSeconds = routeResult.durationSeconds;
        }
      } catch {
        // Fall back to road-distance estimate
      }
    }

    const deliveryQuote = calculateQuote(policy, roadDistanceMeters, {durationSeconds: roadDurationSeconds});
    const deliveryFeeMinor = deliveryQuote.amountMinor;
    const totalMinor = Number(foodSubtotalMinor) + deliveryFeeMinor;

    return {
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      restaurantPhone: restaurant.phone,
      restaurantAddress: restaurant.address,
      restaurantLatitude: restaurant.latitude,
      restaurantLongitude: restaurant.longitude,
      deliveryAddress: data.deliveryAddress,
      deliveryLatitude: data.deliveryLatitude,
      deliveryLongitude: data.deliveryLongitude,
      customerPhone: data.customerPhone,
      items: orderItems,
      subtotalMinor: Number(foodSubtotalMinor),
      foodCommissionBps: Number(foodCommBps),
      foodCommissionMinor,
      deliveryFeeMinor,
      deliveryCommissionMinor: deliveryQuote.commissionMinor,
      totalMinor,
      estimatedPrepMinutes: maxItemPrepMinutes,
      specialInstructions: data.specialInstructions
    };
  }

  async function createFoodOrder(actor, quoteInput, {paymentMethod = 'CASH', specialInstructions = ''} = {}) {
    check(actor && ['customer', 'business', 'admin'].includes(actor.kind), 403, 'Customer credentials required');
    check(['CASH', 'MOMO', 'CARD', 'QR'].includes(paymentMethod), 400, 'Invalid payment method');

    // Re-verify quote freshly
    const quote = await quoteFoodOrder(actor, {
      restaurantId: quoteInput.restaurantId,
      items: quoteInput.items.map(i => ({
        itemId: i.itemId,
        quantity: i.quantity,
        options: (i.options || []).map(o => typeof o === 'string' ? o : o.id)
      })),
      deliveryAddress: quoteInput.deliveryAddress,
      deliveryLatitude: quoteInput.deliveryLatitude,
      deliveryLongitude: quoteInput.deliveryLongitude,
      customerPhone: quoteInput.customerPhone,
      specialInstructions: specialInstructions || quoteInput.specialInstructions || ''
    });

    return db.tx(async c => {
      const orderId = randomUUID();
      const idempotencyKey = `food-${orderId}`;

      // 1. Create a platform quote for the delivery leg
      const policy = (await c.query(
        "SELECT * FROM pricing_policies WHERE active AND (vehicle = 'motorcycle' OR vehicle IS NULL) ORDER BY vehicle = 'motorcycle' DESC LIMIT 1"
      )).rows[0];

      const deliveryQuoteId = randomUUID();
      const quotePayload = {
        pickup: {
          address: quote.restaurantAddress,
          latitude: quote.restaurantLatitude,
          longitude: quote.restaurantLongitude
        },
        destination: {
          address: quote.deliveryAddress,
          latitude: quote.deliveryLatitude,
          longitude: quote.deliveryLongitude
        },
        recipientPhone: quote.customerPhone,
        weightG: 2000,
        vehicle: 'motorcycle',
        parcelCategory: 'food',
        parcelSize: 'small',
        description: `Food Delivery: ${quote.restaurantName}`
      };

      await c.query(
        `INSERT INTO quotes (id, customer_id, policy_id, request, amount_minor, commission_minor, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + interval '30 minutes')`,
        [
          deliveryQuoteId, actor.id, policy.id, JSON.stringify(quotePayload),
          quote.deliveryFeeMinor, quote.deliveryCommissionMinor
        ]
      );

      // 2. Book delivery shipment
      const shipmentId = randomUUID();
      await c.query(
        `INSERT INTO shipments (
          id, customer_id, quote_id, idempotency_key, state, recipient_phone,
          amount_minor, commission_minor, payment_method, cash_payer, paid, created_at
        ) VALUES (
          $1, $2, $3, $4, 'AWAITING_ASSIGNMENT', $5, $6, $7, $8, $9, $10, now()
        )`,
        [
          shipmentId, actor.id, deliveryQuoteId, idempotencyKey, quote.customerPhone,
          quote.deliveryFeeMinor, quote.deliveryCommissionMinor, paymentMethod,
          paymentMethod === 'CASH' ? 'recipient' : null,
          paymentMethod !== 'CASH'
        ]
      );

      // 3. Create food order
      const order = (await c.query(
        `INSERT INTO food_orders (
          id, customer_id, restaurant_id, shipment_id, state,
          subtotal_minor, food_commission_bps, food_commission_minor,
          delivery_fee_minor, total_minor, payment_method, payment_status,
          estimated_prep_minutes, delivery_address, delivery_latitude, delivery_longitude,
          customer_phone, special_instructions
        ) VALUES (
          $1, $2, $3, $4, 'SUBMITTED', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
        ) RETURNING *`,
        [
          orderId, actor.id, quote.restaurantId, shipmentId,
          quote.subtotalMinor, quote.foodCommissionBps, quote.foodCommissionMinor,
          quote.deliveryFeeMinor, quote.totalMinor, paymentMethod,
          paymentMethod === 'CASH' ? 'PENDING' : 'PAID',
          quote.estimatedPrepMinutes, quote.deliveryAddress, quote.deliveryLatitude,
          quote.deliveryLongitude, quote.customerPhone, quote.specialInstructions
        ]
      )).rows[0];

      // 4. Create food order items
      for (const it of quote.items) {
        await c.query(
          `INSERT INTO food_order_items (
            id, order_id, item_id, name, quantity, unit_price_minor, total_price_minor, options_json
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            randomUUID(), orderId, it.itemId, it.name, it.quantity,
            it.unitPriceMinor, it.totalPriceMinor, JSON.stringify(it.options || [])
          ]
        );
      }

      await c.query(
        'INSERT INTO audit_logs (actor_id, action, entity_id) VALUES ($1, $2, $3)',
        [actor.id, 'food_order.created', orderId]
      );

      return {...order, items: quote.items};
    });
  }

  async function getFoodOrder(actor, orderId) {
    uuid.parse(orderId);
    const order = (await db.query('SELECT * FROM food_orders WHERE id = $1', [orderId])).rows[0];
    check(order, 404, 'Food order not found');

    const restaurant = (await db.query('SELECT * FROM restaurants WHERE id = $1', [order.restaurant_id])).rows[0];
    const isOwner = actor && (actor.kind === 'admin' || actor.id === restaurant.owner_id);
    const isCustomer = actor && actor.id === order.customer_id;

    // Check if actor is assigned rider on the delivery shipment
    let isRider = false;
    if (order.shipment_id) {
      const sh = (await db.query('SELECT rider_id FROM shipments WHERE id = $1', [order.shipment_id])).rows[0];
      if (sh && sh.rider_id === actor.id) isRider = true;
    }

    check(isOwner || isCustomer || isRider, 403, 'Permission denied to view this food order');

    const items = (await db.query(
      'SELECT * FROM food_order_items WHERE order_id = $1',
      [orderId]
    )).rows;

    return {
      ...order,
      restaurant: {
        id: restaurant.id,
        name: restaurant.name,
        phone: restaurant.phone,
        address: restaurant.address,
        latitude: restaurant.latitude,
        longitude: restaurant.longitude
      },
      items
    };
  }

  async function listFoodOrders(actor, {restaurantId = null, state = null, limit = 50} = {}) {
    check(actor, 403, 'Authentication required');
    const lim = Math.max(1, Math.min(100, Number(limit) || 50));
    const conditions = [];
    const params = [];

    if (actor.kind === 'customer') {
      params.push(actor.id);
      conditions.push(`customer_id = $${params.length}`);
    } else if (actor.kind === 'business') {
      if (restaurantId) {
        uuid.parse(restaurantId);
        const r = (await db.query('SELECT owner_id FROM restaurants WHERE id = $1', [restaurantId])).rows[0];
        check(r && r.owner_id === actor.id, 403, 'Permission denied');
        params.push(restaurantId);
        conditions.push(`restaurant_id = $${params.length}`);
      } else {
        const myRestaurants = (await db.query('SELECT id FROM restaurants WHERE owner_id = $1', [actor.id])).rows;
        const myIds = myRestaurants.map(r => r.id);
        params.push(myIds);
        conditions.push(`restaurant_id = ANY($${params.length}::uuid[])`);
      }
    } else if (actor.kind !== 'admin') {
      check(false, 403, 'Unauthorized account kind');
    }

    if (state) {
      params.push(state);
      conditions.push(`state = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(lim);
    const query = `SELECT * FROM food_orders ${whereClause} ORDER BY created_at DESC LIMIT $${params.length}`;

    return (await db.query(query, params)).rows;
  }

  // --- Restaurant Operations: Accept & Preparation-Aware Dispatch Sync ---
  async function acceptOrder(actor, orderId, {estimatedPrepMinutes = null} = {}) {
    uuid.parse(orderId);
    return db.tx(async c => {
      const order = (await c.query('SELECT * FROM food_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
      check(order, 404, 'Food order not found');
      check(order.state === 'SUBMITTED', 409, `Order cannot be accepted in state ${order.state}`);

      const restaurant = (await c.query('SELECT * FROM restaurants WHERE id = $1', [order.restaurant_id])).rows[0];
      check(actor && (actor.kind === 'admin' || restaurant.owner_id === actor.id), 403, 'Permission denied');

      const prepMin = Number.isInteger(estimatedPrepMinutes) && estimatedPrepMinutes >= 1 && estimatedPrepMinutes <= 180
        ? estimatedPrepMinutes
        : order.estimated_prep_minutes;

      // Preparation-Aware Dispatch Synchronization:
      // Rider travel buffer is assumed at 5-7 minutes.
      // If prep takes 20 minutes, don't ping riders immediately.
      // Set shipment.next_dispatch_at = ready_at - 5 minutes.
      const readyAt = new Date(Date.now() + prepMin * 60 * 1000);
      const dispatchBufferMs = Math.min(prepMin * 60 * 1000, 5 * 60 * 1000); // 5 min lead time
      const nextDispatchAt = new Date(readyAt.getTime() - dispatchBufferMs);

      const updated = (await c.query(
        `UPDATE food_orders SET
          state = 'ACCEPTED',
          accepted_at = now(),
          ready_at = $2,
          estimated_prep_minutes = $3,
          updated_at = now()
         WHERE id = $1 RETURNING *`,
        [orderId, readyAt, prepMin]
      )).rows[0];

      if (order.shipment_id) {
        await c.query(
          `UPDATE shipments SET next_dispatch_at = $2 WHERE id = $1`,
          [order.shipment_id, nextDispatchAt]
        );
      }

      await c.query(
        'INSERT INTO audit_logs (actor_id, action, entity_id) VALUES ($1, $2, $3)',
        [actor.id, `food_order.accepted:prep_${prepMin}m`, orderId]
      );

      return updated;
    });
  }

  async function startPreparing(actor, orderId) {
    uuid.parse(orderId);
    return db.tx(async c => {
      const order = (await c.query('SELECT * FROM food_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
      check(order, 404, 'Food order not found');
      check(order.state === 'ACCEPTED', 409, `Cannot start preparing from state ${order.state}`);

      const restaurant = (await c.query('SELECT * FROM restaurants WHERE id = $1', [order.restaurant_id])).rows[0];
      check(actor && (actor.kind === 'admin' || restaurant.owner_id === actor.id), 403, 'Permission denied');

      return (await c.query(
        `UPDATE food_orders SET state = 'PREPARING', updated_at = now() WHERE id = $1 RETURNING *`,
        [orderId]
      )).rows[0];
    });
  }

  async function markReadyForPickup(actor, orderId) {
    uuid.parse(orderId);
    return db.tx(async c => {
      const order = (await c.query('SELECT * FROM food_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
      check(order, 404, 'Food order not found');
      check(['ACCEPTED', 'PREPARING'].includes(order.state), 409, `Cannot mark ready from state ${order.state}`);

      const restaurant = (await c.query('SELECT * FROM restaurants WHERE id = $1', [order.restaurant_id])).rows[0];
      check(actor && (actor.kind === 'admin' || restaurant.owner_id === actor.id), 403, 'Permission denied');

      const updated = (await c.query(
        `UPDATE food_orders SET state = 'READY_FOR_PICKUP', ready_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
        [orderId]
      )).rows[0];

      // Priority Dispatch: Immediately make the delivery shipment dispatchable
      if (order.shipment_id) {
        await c.query(
          `UPDATE shipments SET next_dispatch_at = now() WHERE id = $1`,
          [order.shipment_id]
        );
      }

      await c.query(
        'INSERT INTO audit_logs (actor_id, action, entity_id) VALUES ($1, $2, $3)',
        [actor.id, 'food_order.ready_for_pickup', orderId]
      );

      return updated;
    });
  }

  async function completeFoodOrder(orderId) {
    uuid.parse(orderId);
    return db.tx(async c => {
      const order = (await c.query('SELECT * FROM food_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
      check(order, 404, 'Food order not found');
      if (order.state === 'DELIVERED') return order;

      const updated = (await c.query(
        `UPDATE food_orders SET
          state = 'DELIVERED',
          payment_status = 'PAID',
          completed_at = now(),
          updated_at = now()
         WHERE id = $1 RETURNING *`,
        [orderId]
      )).rows[0];

      // Record independent restaurant settlement ledger entry
      const grossSales = order.subtotal_minor;
      const commBps = order.food_commission_bps;
      const commMinor = order.food_commission_minor;
      const netPayable = grossSales - commMinor;

      await c.query(
        `INSERT INTO restaurant_settlements (
          order_id, restaurant_id, gross_sales_minor, commission_bps,
          commission_minor, net_payable_minor, status
        ) VALUES ($1, $2, $3, $4, $5, $6, 'accrued')
        ON CONFLICT (order_id) DO NOTHING`,
        [orderId, order.restaurant_id, grossSales, commBps, commMinor, netPayable]
      );

      await c.query(
        'INSERT INTO audit_logs (actor_id, action, entity_id) VALUES ($1, $2, $3)',
        [order.customer_id, 'food_order.delivered', orderId]
      );

      return updated;
    });
  }

  async function rejectOrder(actor, orderId, {reason = 'Kitchen busy'} = {}) {
    uuid.parse(orderId);
    return db.tx(async c => {
      const order = (await c.query('SELECT * FROM food_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
      check(order, 404, 'Food order not found');
      check(['SUBMITTED', 'ACCEPTED'].includes(order.state), 409, `Cannot reject order in state ${order.state}`);

      const restaurant = (await c.query('SELECT * FROM restaurants WHERE id = $1', [order.restaurant_id])).rows[0];
      check(actor && (actor.kind === 'admin' || restaurant.owner_id === actor.id), 403, 'Permission denied');

      const updated = (await c.query(
        `UPDATE food_orders SET state = 'REJECTED', updated_at = now() WHERE id = $1 RETURNING *`,
        [orderId]
      )).rows[0];

      if (order.shipment_id) {
        await c.query(`UPDATE shipments SET state = 'CANCELLED' WHERE id = $1 AND state = 'AWAITING_ASSIGNMENT'`, [order.shipment_id]);
      }

      await c.query(
        'INSERT INTO audit_logs (actor_id, action, entity_id) VALUES ($1, $2, $3)',
        [actor.id, `food_order.rejected:${reason}`, orderId]
      );

      return updated;
    });
  }

  async function cancelOrder(actor, orderId, {reason = 'Customer cancelled'} = {}) {
    uuid.parse(orderId);
    return db.tx(async c => {
      const order = (await c.query('SELECT * FROM food_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
      check(order, 404, 'Food order not found');
      check(order.state === 'SUBMITTED', 409, 'Orders can only be cancelled before kitchen acceptance');
      check(actor && (actor.kind === 'admin' || actor.id === order.customer_id), 403, 'Permission denied');

      const updated = (await c.query(
        `UPDATE food_orders SET state = 'CANCELLED', updated_at = now() WHERE id = $1 RETURNING *`,
        [orderId]
      )).rows[0];

      if (order.shipment_id) {
        await c.query(`UPDATE shipments SET state = 'CANCELLED' WHERE id = $1 AND state = 'AWAITING_ASSIGNMENT'`, [order.shipment_id]);
      }

      await c.query(
        'INSERT INTO audit_logs (actor_id, action, entity_id) VALUES ($1, $2, $3)',
        [actor.id, `food_order.cancelled:${reason}`, orderId]
      );

      return updated;
    });
  }

  async function getRestaurantSettlements(actor, restaurantId) {
    uuid.parse(restaurantId);
    const r = (await db.query('SELECT * FROM restaurants WHERE id = $1', [restaurantId])).rows[0];
    check(r, 404, 'Restaurant not found');
    check(actor && (actor.kind === 'admin' || r.owner_id === actor.id), 403, 'Permission denied');

    const settlements = (await db.query(
      `SELECT s.*, o.created_at AS order_date, o.payment_method
       FROM restaurant_settlements s
       JOIN food_orders o ON o.id = s.order_id
       WHERE s.restaurant_id = $1
       ORDER BY s.created_at DESC LIMIT 100`,
      [restaurantId]
    )).rows;

    const totals = (await db.query(
      `SELECT
        COALESCE(SUM(gross_sales_minor), 0)::bigint AS gross_sales_minor,
        COALESCE(SUM(commission_minor), 0)::bigint AS commission_minor,
        COALESCE(SUM(net_payable_minor), 0)::bigint AS net_payable_minor,
        COUNT(*)::int AS count
       FROM restaurant_settlements
       WHERE restaurant_id = $1`,
      [restaurantId]
    )).rows[0];

    return {
      restaurantId,
      restaurantName: r.name,
      foodCommissionBps: r.food_commission_bps,
      totals: {
        grossSalesMinor: Number(totals.gross_sales_minor),
        commissionMinor: Number(totals.commission_minor),
        netPayableMinor: Number(totals.net_payable_minor),
        totalOrders: totals.count
      },
      settlements
    };
  }

  async function evaluateBatchDispatch(actor, restaurantId, {riderId = null, maxPlannedMinutes = 30, targetPlannedMinutes = 25} = {}) {
    uuid.parse(restaurantId);
    const r = (await db.query('SELECT * FROM restaurants WHERE id = $1', [restaurantId])).rows[0];
    check(r, 404, 'Restaurant not found');
    check(actor && (actor.kind === 'admin' || r.owner_id === actor.id), 403, 'Permission denied');
    check(routing && typeof routing.route === 'function', 500, 'Routing engine not configured for batch dispatch');

    // 1. Fetch active queued orders for this restaurant awaiting pickup/delivery
    const ordersRes = await db.query(
      `SELECT o.*, s.rider_id AS shipment_rider_id, s.state AS shipment_state
       FROM food_orders o
       JOIN shipments s ON s.id = o.shipment_id
       WHERE o.restaurant_id = $1
         AND o.state IN ('ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP')
         AND s.state = 'AWAITING_ASSIGNMENT'
       ORDER BY o.ready_at ASC NULLS LAST, o.created_at ASC
       LIMIT 8`,
      [restaurantId]
    );

    const pendingOrders = ordersRes.rows;
    if (pendingOrders.length === 0) {
      return {feasible: false, reason: 'no_pending_orders', acceptedOrders: [], splitOrders: []};
    }

    // 2. Resolve rider
    let assignedRider = null;
    if (riderId) {
      uuid.parse(riderId);
      const riderRow = (await db.query(
        `SELECT r.id, r.vehicle, r.max_weight_g AS capacity_g, l.latitude, l.longitude
         FROM riders r
         LEFT JOIN locations l ON l.rider_id = r.id
         WHERE r.id = $1 AND r.status = 'approved'`,
        [riderId]
      )).rows[0];
      check(riderRow, 404, 'Eligible rider not found');
      assignedRider = {
        id: riderRow.id,
        latitude: riderRow.latitude ?? r.latitude,
        longitude: riderRow.longitude ?? r.longitude,
        vehicle: riderRow.vehicle || 'motorcycle',
        maxCapacityG: riderRow.capacity_g || 15000,
        currentLoadedG: 0
      };
    } else {
      // Find nearest approved active rider
      const riderRow = (await db.query(
        `SELECT r.id, r.vehicle, r.max_weight_g AS capacity_g, l.latitude, l.longitude
         FROM riders r
         JOIN locations l ON l.rider_id = r.id
         WHERE r.status = 'approved' AND r.online
         ORDER BY ( (l.latitude - $1)*(l.latitude - $1) + (l.longitude - $2)*(l.longitude - $2) ) ASC
         LIMIT 1`,
        [r.latitude, r.longitude]
      )).rows[0];

      assignedRider = riderRow ? {
        id: riderRow.id,
        latitude: riderRow.latitude,
        longitude: riderRow.longitude,
        vehicle: riderRow.vehicle || 'motorcycle',
        maxCapacityG: riderRow.capacity_g || 15000,
        currentLoadedG: 0
      } : {
        id: 'mock-dispatch-rider',
        latitude: r.latitude,
        longitude: r.longitude,
        vehicle: 'motorcycle',
        maxCapacityG: 15000,
        currentLoadedG: 0
      };
    }

    const batchPayload = pendingOrders.map(o => ({
      id: o.id,
      shipmentId: o.shipment_id,
      readyAt: o.ready_at || o.created_at,
      destination: {
        latitude: o.delivery_latitude,
        longitude: o.delivery_longitude,
        address: o.delivery_address
      },
      weightG: 1500
    }));

    const result = await evaluateRestaurantBatch({
      routing,
      restaurant: {
        id: r.id,
        name: r.name,
        latitude: r.latitude,
        longitude: r.longitude
      },
      orders: batchPayload,
      rider: assignedRider,
      options: {maxPlannedMinutes, targetPlannedMinutes}
    });

    await db.query(
      'INSERT INTO audit_logs (actor_id, action, entity_id) VALUES ($1, $2, $3)',
      [actor.id, `restaurant.batch_evaluated:feasible_${result.feasible}`, restaurantId]
    );

    return result;
  }

  return {
    quoteFoodOrder,
    createFoodOrder,
    getFoodOrder,
    listFoodOrders,
    acceptOrder,
    startPreparing,
    markReadyForPickup,
    completeFoodOrder,
    rejectOrder,
    cancelOrder,
    getRestaurantSettlements,
    evaluateBatchDispatch
  };
}
