import {randomUUID,createHash} from 'node:crypto';
import {lockFoodOrder,requireFoodPayment,restaurantOpenNow} from './food-payment.mjs';
import {requestCheckoutRefund} from './checkout-accounting.mjs';
import {z} from 'zod';
import {marketService} from './markets.mjs';
import {check} from './security.mjs';
import {haversine} from './dispatch-geometry.mjs';
import {calculateQuote} from './pricing.mjs';
import {evaluateRestaurantBatch} from './algorithms/restaurant-batch.mjs';
import {promotionEngine} from './promotion-engine.mjs';
import {commissionEngine} from './commission-engine.mjs';
import {chatEngine} from './chat-engine.mjs';

const uuid = z.string().uuid();

export function restaurantOrderService(db, options = {}) {
  const {platform = null, dispatcher = null, routing = null, sms = undefined, acceptanceTimeoutSeconds=300,courierTimeoutSeconds=1200,unpaidTimeoutSeconds=1800} = options;
  check(db && typeof db.query === 'function', 500, 'Database instance required');
  for(const value of [acceptanceTimeoutSeconds,courierTimeoutSeconds,unpaidTimeoutSeconds])check(Number.isInteger(value)&&value>=60&&value<=86400,500,'Invalid food order timeout');
  const promos = promotionEngine(db);
  const commissions = commissionEngine(db);
  const chat = chatEngine(db);
  const hasSmsOption = 'sms' in options || (platform && 'sms' in platform);
  const hasDispatcherOption = ('dispatcher' in options && options.dispatcher === null) || ('dispatch' in options && options.dispatch === null) || (platform && 'dispatch' in platform && platform.dispatch === null);
  const effectiveSms = sms !== undefined ? sms : platform?.sms;
  const effectiveDispatcher = dispatcher ?? options.dispatch ?? platform?.dispatch ?? null;

  function assertDeliveryCapabilities() {
    check(routing && typeof routing.route === 'function', 503, 'Road routing service required for delivery quotation');
    if (process.env.NODE_ENV === 'production' || hasSmsOption) {
      check(effectiveSms && typeof effectiveSms.send === 'function', 503, 'Food ordering paused: custody-verification SMS unavailable');
    }
    if (process.env.NODE_ENV === 'production' || hasDispatcherOption) {
      check(Boolean(effectiveDispatcher), 503, 'Food ordering paused: dispatch engine unavailable');
    }
  }

  async function quoteFoodOrder(actor, input) {
    await marketService(db).assertGhanaOperating();
    assertDeliveryCapabilities();
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
      customerPhone: z.string().trim().transform(p => {
        const clean = p.replace(/\s+/g, '');
        if (/^0[25][0-9]{8}$/.test(clean)) return '+233' + clean.slice(1);
        if (/^233[25][0-9]{8}$/.test(clean)) return '+' + clean;
        return clean;
      }).pipe(z.string().regex(/^\+233[25][0-9]{8}$/, 'Valid Ghana phone number required')),
      specialInstructions: z.string().trim().max(300).optional().default(''),
      promoCode: z.string().trim().max(40).nullable().optional(),
      promoCodes: z.array(z.string().trim().max(40)).max(5).optional(),
      campaignIds: z.array(z.string().uuid()).max(5).optional(),
      paymentMethod: z.enum(['MOMO', 'CARD', 'QR', 'BANK_QR']).optional().default('MOMO'),
      requireValidPromoCode: z.boolean().optional()
    }).strict();

    const data = schema.parse(input);

    const restaurant = (await db.query('SELECT * FROM restaurants WHERE id = $1', [data.restaurantId])).rows[0];
    check(restaurant, 404, 'Restaurant not found');
    check(restaurant.status === 'approved', 400, 'Restaurant is not currently approved');
    check(restaurant.is_open && !restaurant.is_paused, 400, 'Restaurant is currently closed or paused');
    check(restaurantOpenNow(restaurant),400,'Restaurant is outside its operating hours');

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
        check(itemMods.some(m=>m.id===opt.modifier_id),400,'Option does not belong to this menu item');
        check(!selectedOpts.some(o=>o.id===optId),400,'Duplicate modifier option');
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
        menuItemId: it.id,
        categoryId: it.category_id || null,
        name: it.name,
        quantity: requested.quantity,
        unitPriceMinor: Number(unitPriceMinor),
        totalPriceMinor: Number(totalItemMinor),
        lineTotalMinor: Number(totalItemMinor),
        options: selectedOpts
      });
    }

    // Calculate delivery quote using platform pricing policy
    const policy = (await db.query(
      "SELECT * FROM pricing_policies WHERE active AND (vehicle = 'motorcycle' OR vehicle IS NULL) ORDER BY vehicle = 'motorcycle' DESC LIMIT 1"
    )).rows[0];

    check(routing && typeof routing.route === 'function', 503, 'Road routing service required for delivery quotation');
    let routeResult;
    try {
      routeResult = await routing.route(
        {latitude: restaurant.latitude, longitude: restaurant.longitude},
        {latitude: data.deliveryLatitude, longitude: data.deliveryLongitude},
        {vehicle: 'motorcycle'}
      );
    } catch (err) {
      check(false, 503, 'Routing service could not resolve road path: ' + (err.message || 'unreachable'));
    }
    check(Number.isSafeInteger(routeResult?.distanceMeters) && routeResult.distanceMeters >= 0, 503, 'Invalid road distance from routing service');
    check(Number.isSafeInteger(routeResult?.durationSeconds) && routeResult.durationSeconds >= 0, 503, 'Invalid road duration from routing service');
    const roadDistanceMeters = routeResult.distanceMeters;
    const roadDurationSeconds = routeResult.durationSeconds;

    const deliveryQuote = calculateQuote(policy, roadDistanceMeters, {durationSeconds: roadDurationSeconds});
    const deliveryFeeMinor = deliveryQuote.amountMinor;

    const mergedPromoCodes = [
      ...(data.promoCode ? [data.promoCode] : []),
      ...(Array.isArray(data.promoCodes) ? data.promoCodes : [])
    ];
    const normPaymentMethod = data.paymentMethod === 'QR' ? 'BANK_QR' : (data.paymentMethod || 'MOMO');

    const promoEval = await promos.evaluateCheckoutPromotions(db, {
      actor,
      restaurant,
      orderItems,
      foodSubtotalMinor: Number(foodSubtotalMinor),
      deliveryFeeMinor,
      promoCodes: mergedPromoCodes,
      campaignIds: data.campaignIds || [],
      paymentMethod: normPaymentMethod,
      deliveryAddress: data.deliveryAddress
    });

    if ((data.requireValidPromoCode ?? (mergedPromoCodes.length > 0 || (Array.isArray(data.campaignIds) && data.campaignIds.length > 0))) && promoEval.rejectedPromotions.length > 0) {
      check(false, 400, promoEval.rejectedPromotions[0].message);
    }

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
      originalSubtotalMinor: Number(foodSubtotalMinor),
      foodDiscountMinor: promoEval.foodDiscountMinor,
      deliveryDiscountMinor: promoEval.deliveryDiscountMinor,
      totalDiscountMinor: promoEval.totalDiscountMinor,
      elesendFundedDiscountMinor: promoEval.elesendFundedDiscountMinor,
      restaurantFundedDiscountMinor: promoEval.restaurantFundedDiscountMinor,
      elesendFoodDiscountMinor: promoEval.elesendFoodDiscountMinor,
      restaurantFoodDiscountMinor: promoEval.restaurantFoodDiscountMinor,
      elesendDeliveryDiscountMinor: promoEval.elesendDeliveryDiscountMinor,
      restaurantDeliveryDiscountMinor: promoEval.restaurantDeliveryDiscountMinor,
      customerFoodPayableMinor: promoEval.customerFoodPayableMinor,
      customerDeliveryPayableMinor: promoEval.customerDeliveryPayableMinor,
      foodCommissionBps: promoEval.foodCommissionBps,
      foodCommissionRateBps: promoEval.foodCommissionBps,
      foodCommissionMinor: promoEval.foodCommissionMinor,
      commissionCalculationBasis: promoEval.commissionCalculationBasis,
      commissionBaseMinor: promoEval.commissionBaseMinor,
      commissionRuleId: promoEval.commissionRuleId,
      commissionPolicy: promoEval.commissionPolicy,
      restaurantNetSettlementMinor: promoEval.restaurantNetSettlementMinor,
      netRestaurantSettlementMinor: promoEval.restaurantNetSettlementMinor,
      deliveryFeeMinor,
      deliveryCommissionMinor: deliveryQuote.commissionMinor,
      totalMinor: promoEval.totalCustomerPayableMinor,
      appliedPromotions: promoEval.appliedPromotions,
      rejectedPromotions: promoEval.rejectedPromotions,
      appliedPromoCodes: promoEval.appliedPromoCodes,
      estimatedPrepMinutes: maxItemPrepMinutes,
      specialInstructions: data.specialInstructions
    };
  }

  async function createFoodOrder(actor, quoteInput, {paymentMethod = 'MOMO', specialInstructions = '', idempotencyKey, promoCode = null, promoCodes = [], campaignIds = []} = {}) {
    check(actor && ['customer', 'business'].includes(actor.kind), 403, 'Customer credentials required');
    check(['MOMO', 'CARD', 'QR'].includes(paymentMethod), 400, 'Food orders require upfront payment for food and delivery; cash is not accepted');
    check(typeof idempotencyKey==='string'&&/^[a-zA-Z0-9_-]{8,128}$/.test(idempotencyKey),400,'Food order idempotency key required');
    assertDeliveryCapabilities();
    check((await db.query('SELECT phone_verified_at FROM users WHERE id=$1',[actor.id])).rows[0]?.phone_verified_at,403,'Verify your phone before placing a food order');
    const mergedPromoCodes = [
      ...(promoCode ? [promoCode] : []),
      ...(quoteInput.promoCode ? [quoteInput.promoCode] : []),
      ...(Array.isArray(promoCodes) ? promoCodes : []),
      ...(Array.isArray(quoteInput.promoCodes) ? quoteInput.promoCodes : [])
    ];
    const mergedCampaignIds = [
      ...(Array.isArray(campaignIds) ? campaignIds : []),
      ...(Array.isArray(quoteInput.campaignIds) ? quoteInput.campaignIds : [])
    ];
    const hasExplicitPromo = mergedPromoCodes.length > 0 || mergedCampaignIds.length > 0;
    const requestHash=createHash('sha256').update(JSON.stringify({quoteInput,paymentMethod,specialInstructions,mergedPromoCodes,mergedCampaignIds})).digest('hex');
    const existing=(await db.query('SELECT * FROM food_orders WHERE customer_id=$1 AND request_key=$2',[actor.id,idempotencyKey])).rows[0];
    if(existing){check(existing.request_hash===requestHash,409,'Idempotency key reused with different food order');return existing;}

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
      specialInstructions: specialInstructions || quoteInput.specialInstructions || '',
      promoCodes: mergedPromoCodes,
      campaignIds: mergedCampaignIds,
      paymentMethod,
      requireValidPromoCode: hasExplicitPromo
    });

    return db.tx(async c => {
      const market=(await c.query("SELECT service_enabled FROM service_markets WHERE country_code='GH' FOR SHARE")).rows[0];
      check(market?.service_enabled===true,503,'Ghana bookings administratively paused');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[actor.id+':food:'+idempotencyKey]);
      const previous=(await c.query('SELECT * FROM food_orders WHERE customer_id=$1 AND request_key=$2',[actor.id,idempotencyKey])).rows[0];
      if(previous){check(previous.request_hash===requestHash,409,'Idempotency key reused with different food order');return previous;}
      const orderId = randomUUID();
      const shipmentKey = `food-${orderId}`;

      const restaurant = (await c.query('SELECT * FROM restaurants WHERE id = $1 FOR UPDATE', [quote.restaurantId])).rows[0];
      check(restaurant && restaurant.status==='approved' && restaurantOpenNow(restaurant),409,'Restaurant availability changed; refresh your order');
      check(Number(restaurant.latitude)===Number(quote.restaurantLatitude) && Number(restaurant.longitude)===Number(quote.restaurantLongitude),409,'Restaurant location changed; request a new quote');
      const ids=[...new Set(quote.items.map(i=>i.itemId))];
      const catalog=(await c.query('SELECT * FROM menu_items WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids])).rows;
      const mods=(await c.query('SELECT * FROM menu_item_modifiers WHERE item_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids])).rows;
      const opts=(await c.query('SELECT * FROM menu_modifier_options WHERE modifier_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[mods.map(m=>m.id)])).rows;
      for(const item of quote.items){
        const current=catalog.find(i=>i.id===item.itemId);
        check(current?.is_available,409,'Menu availability changed; refresh your order');
        let price=Number(current.price_minor);
        for(const opt of item.options||[]){
          const live=opts.find(o=>o.id===opt.id);
          check(live?.is_available && mods.some(m=>m.id===live.modifier_id && m.item_id===item.itemId),409,'Menu options changed; refresh your order');
          price+=Number(live.price_minor);
        }
        for(const mod of mods.filter(m=>m.item_id===item.itemId)){
          const count=(item.options||[]).filter(o=>opts.find(v=>v.id===o.id)?.modifier_id===mod.id).length;
          check((!mod.is_required || count>=Math.max(1,mod.min_selections)) && count<=mod.max_selections,409,'Menu choices changed; refresh your order');
        }
        check(price===Number(item.unitPriceMinor),409,'Menu prices changed; refresh your order');
      }

      const normPayMethod = paymentMethod === 'QR' ? 'BANK_QR' : (paymentMethod || 'MOMO');
      const txPromoEval = await promos.evaluateCheckoutPromotions(c, {
        actor,
        restaurant,
        orderItems: quote.items,
        foodSubtotalMinor: quote.subtotalMinor,
        deliveryFeeMinor: quote.deliveryFeeMinor,
        promoCodes: mergedPromoCodes,
        campaignIds: mergedCampaignIds,
        paymentMethod: normPayMethod,
        deliveryAddress: quote.deliveryAddress
      });
      if (hasExplicitPromo && txPromoEval.rejectedPromotions.length > 0) {
        check(false, 409, txPromoEval.rejectedPromotions[0].message);
      }

      // 1. Create a platform quote for the delivery leg
      // Rider delivery tariff & commission remain 100% intact (never reduced by delivery discounts)
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
        description: quote.specialInstructions
          ? `Food Delivery: ${quote.restaurantName} (Notes: ${quote.specialInstructions})`
          : `Food Delivery: ${quote.restaurantName}`
      };

      await c.query(
        `INSERT INTO quotes (id, customer_id, policy_id, request, amount_minor, commission_minor, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + interval '30 minutes')`,
        [
          deliveryQuoteId, actor.id, policy.id, JSON.stringify(quotePayload),
          quote.deliveryFeeMinor, quote.deliveryCommissionMinor
        ]
      );

      // 2. Book delivery shipment awaiting upfront payment and kitchen acceptance
      const shipmentState = 'AWAITING_PAYMENT';
      const initialDispatchHold = 'infinity'; // Only paid kitchen acceptance releases dispatch
      const shipmentId = randomUUID();
      await c.query(
        `INSERT INTO shipments (
          id, customer_id, quote_id, idempotency_key, state, recipient_phone,
          amount_minor, commission_minor, payment_method, cash_payer, paid, next_dispatch_at, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11, now()
        )`,
        [
          shipmentId, actor.id, deliveryQuoteId, shipmentKey, shipmentState, quote.customerPhone,
          quote.deliveryFeeMinor, quote.deliveryCommissionMinor, paymentMethod,
          null,
          initialDispatchHold
        ]
      );

      // 3. Create food order with full immutable commission & promotion snapshots
      const order = (await c.query(
        `INSERT INTO food_orders (
          id, customer_id, restaurant_id, shipment_id, state,
          subtotal_minor, food_commission_bps, food_commission_minor,
          delivery_fee_minor, total_minor, payment_method, payment_status,
          estimated_prep_minutes, delivery_address, delivery_latitude, delivery_longitude,
          customer_phone, special_instructions, request_key, request_hash,
          food_discount_minor, delivery_discount_minor,
          restaurant_funded_discount_minor, elesend_funded_discount_minor,
          customer_food_payable_minor, customer_delivery_payable_minor,
          restaurant_net_settlement_minor, commission_calculation_basis,
          commission_base_minor, commission_rule_id,
          commission_snapshot, promotion_snapshot, applied_promo_codes
        ) VALUES (
          $1, $2, $3, $4, 'SUBMITTED',
          $5, $6, $7,
          $8, $9, $10, 'PENDING',
          $11, $12, $13, $14,
          $15, $16, $17, $18,
          $19, $20,
          $21, $22,
          $23, $24,
          $25, $26,
          $27, $28,
          $29, $30, $31
        ) RETURNING *`,
        [
          orderId, actor.id, quote.restaurantId, shipmentId,
          quote.subtotalMinor, txPromoEval.foodCommissionBps, txPromoEval.foodCommissionMinor,
          quote.deliveryFeeMinor, txPromoEval.totalCustomerPayableMinor, paymentMethod,
          quote.estimatedPrepMinutes, quote.deliveryAddress, quote.deliveryLatitude,
          quote.deliveryLongitude, quote.customerPhone, quote.specialInstructions, idempotencyKey, requestHash,
          txPromoEval.foodDiscountMinor, txPromoEval.deliveryDiscountMinor,
          txPromoEval.restaurantFundedDiscountMinor, txPromoEval.elesendFundedDiscountMinor,
          txPromoEval.customerFoodPayableMinor, txPromoEval.customerDeliveryPayableMinor,
          txPromoEval.restaurantNetSettlementMinor, txPromoEval.commissionCalculationBasis,
          txPromoEval.commissionBaseMinor, txPromoEval.commissionRuleId,
          JSON.stringify(txPromoEval.commissionPolicy || {}),
          JSON.stringify({
            appliedPromotions: txPromoEval.appliedPromotions,
            foodDiscountMinor: txPromoEval.foodDiscountMinor,
            deliveryDiscountMinor: txPromoEval.deliveryDiscountMinor,
            elesendFundedDiscountMinor: txPromoEval.elesendFundedDiscountMinor,
            restaurantFundedDiscountMinor: txPromoEval.restaurantFundedDiscountMinor
          }),
          txPromoEval.appliedPromoCodes || []
        ]
      )).rows[0];

      // 4. Atomically reserve promotional redemptions and budgets under row locks
      if (txPromoEval.appliedPromotions.length > 0) {
        await promos.reservePromotionsForOrder(c, {
          orderId,
          actor,
          restaurant,
          evaluation: txPromoEval
        });
      }

      if (txPromoEval.commissionRuleId) {
        await commissions.recordOrderCommissionApplied(c, txPromoEval.commissionRuleId, {
          orderAmountMinor: txPromoEval.commissionBaseMinor,
          standardRateBps: txPromoEval.commissionPolicy?.standardRateBps ?? 1000,
          appliedRateBps: txPromoEval.foodCommissionBps
        });
      }

      // 5. Create food order items
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

      return {
        ...order,
        net_restaurant_settlement_minor: order.restaurant_net_settlement_minor,
        restaurant_food_discount_minor: txPromoEval.restaurantFoodDiscountMinor,
        elesend_food_discount_minor: txPromoEval.elesendFoodDiscountMinor,
        items: quote.items,
        appliedPromotions: txPromoEval.appliedPromotions
      };
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
    let isRider = false, sh = null;
    if (order.shipment_id) {
      sh = (await db.query('SELECT state, rider_id FROM shipments WHERE id = $1', [order.shipment_id])).rows[0];
      if (sh && sh.rider_id === actor?.id) isRider = true;
    }

    check(isOwner || isCustomer || isRider, 403, 'Permission denied to view this food order');

    const items = (await db.query(
      'SELECT * FROM food_order_items WHERE order_id = $1',
      [orderId]
    )).rows;

    return {
      ...order,
      shipment_state: sh?.state ?? null,
      rider_id: sh?.rider_id ?? null,
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
      conditions.push(`f.customer_id = $${params.length}`);
    } else if (actor.kind === 'business') {
      if (restaurantId) {
        uuid.parse(restaurantId);
        const r = (await db.query('SELECT owner_id FROM restaurants WHERE id = $1', [restaurantId])).rows[0];
        check(r && r.owner_id === actor.id, 403, 'Permission denied');
        params.push(restaurantId);
        conditions.push(`f.restaurant_id = $${params.length}`);
      } else {
        const myRestaurants = (await db.query('SELECT id FROM restaurants WHERE owner_id = $1', [actor.id])).rows;
        const myIds = myRestaurants.map(r => r.id);
        params.push(myIds,actor.id);
        conditions.push(`(f.restaurant_id = ANY($${params.length-1}::uuid[]) OR f.customer_id=$${params.length})`);
      }
    } else if (actor.kind === 'rider') {
      params.push(actor.id);
      conditions.push(`s.rider_id = $${params.length}`);
    } else if (actor.kind === 'admin') { if (restaurantId) { uuid.parse(restaurantId); params.push(restaurantId); conditions.push(`f.restaurant_id = $${params.length}`); } } else if (actor.kind !== 'admin') {
      check(false, 403, 'Unauthorized account kind');
    }

    if (state) {
      params.push(state);
      conditions.push(`f.state = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(lim);
    const query = `SELECT f.*, s.state AS shipment_state, s.rider_id, s.paid AS shipment_paid
      FROM food_orders f
      LEFT JOIN shipments s ON s.id = f.shipment_id
      ${whereClause} ORDER BY f.created_at DESC LIMIT $${params.length}`;

    const rows = (await db.query(query, params)).rows;
    if (rows.length === 0) return [];
    const orderIds = rows.map(r => r.id);
    const itemsRes = await db.query(
      'SELECT * FROM food_order_items WHERE order_id = ANY($1::uuid[]) ORDER BY id ASC',
      [orderIds]
    );
    const itemsByOrder = new Map();
    for (const item of itemsRes.rows) {
      const list = itemsByOrder.get(item.order_id) || [];
      list.push({
        ...item,
        options: Array.isArray(item.options_json) ? item.options_json : []
      });
      itemsByOrder.set(item.order_id, list);
    }
    return rows.map(r => ({
      ...r,
      items: itemsByOrder.get(r.id) || []
    }));
  }

  // --- Restaurant Operations: Accept & Preparation-Aware Dispatch Sync ---
  async function acceptOrder(actor, orderId, {estimatedPrepMinutes = null} = {}) {
    uuid.parse(orderId);
    return db.tx(async c => {
      const order = await lockFoodOrder(c,orderId);
      check(order, 404, 'Food order not found');
      check(order.state === 'SUBMITTED', 409, `Order cannot be accepted in state ${order.state}`);
      await requireFoodPayment(c,order);

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
          dispatch_started_at = $4,
          estimated_prep_minutes = $3,
          updated_at = now()
         WHERE id = $1 RETURNING *`,
        [orderId, readyAt, prepMin, nextDispatchAt]
      )).rows[0];

      if (order.shipment_id) {
        const sh = (await c.query('SELECT paid, payment_method FROM shipments WHERE id = $1', [order.shipment_id])).rows[0];
        if (sh && sh.paid) {
          await c.query(
            `UPDATE shipments SET next_dispatch_at = $2 WHERE id = $1`,
            [order.shipment_id, nextDispatchAt]
          );
        }
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
      const order = await lockFoodOrder(c,orderId);
      check(order, 404, 'Food order not found');
      check(order.state === 'ACCEPTED', 409, `Cannot start preparing from state ${order.state}`);
      await requireFoodPayment(c,order);

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
      const order = await lockFoodOrder(c,orderId);
      check(order, 404, 'Food order not found');
      check(['ACCEPTED', 'PREPARING'].includes(order.state), 409, `Cannot mark ready from state ${order.state}`);
      await requireFoodPayment(c,order);

      const restaurant = (await c.query('SELECT * FROM restaurants WHERE id = $1', [order.restaurant_id])).rows[0];
      check(actor && (actor.kind === 'admin' || restaurant.owner_id === actor.id), 403, 'Permission denied');

      const updated = (await c.query(
        `UPDATE food_orders SET
          state = 'READY_FOR_PICKUP',
          ready_at = now(),
          dispatch_started_at = LEAST(COALESCE(dispatch_started_at, now()), now()),
          updated_at = now()
         WHERE id = $1 RETURNING *`,
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

  async function rejectOrder(actor, orderId, {reason = 'Kitchen busy'} = {}) {
    uuid.parse(orderId);
    return db.tx(async c => {
      const order = await lockFoodOrder(c,orderId);
      check(order, 404, 'Food order not found');
      check(['SUBMITTED', 'ACCEPTED'].includes(order.state), 409, `Cannot reject order in state ${order.state}`);

      const restaurant = (await c.query('SELECT * FROM restaurants WHERE id = $1', [order.restaurant_id])).rows[0];
      check(actor && (actor.kind === 'admin' || restaurant.owner_id === actor.id), 403, 'Permission denied');

      const updated = (await c.query(
        `UPDATE food_orders SET state = 'REJECTED', updated_at = now() WHERE id = $1 RETURNING *`,
        [orderId]
      )).rows[0];

      if (order.shipment_id) {
        const shipment=(await c.query('SELECT * FROM shipments WHERE id=$1',[order.shipment_id])).rows[0];
        check(shipment&&['AWAITING_PAYMENT','AWAITING_ASSIGNMENT'].includes(shipment.state),409,'Courier already assigned; operational cancellation required');
        await requestCheckoutRefund(c,shipment,reason);
        await c.query("UPDATE shipments SET state='CANCELLED' WHERE id=$1",[order.shipment_id]);
        await c.query("UPDATE dispatch_offers SET status='expired' WHERE shipment_id=$1 AND status='offered'",[order.shipment_id]);
        await promos.releaseOrderPromotions(c, orderId, {reason: `rejected:${reason}`, isRefund: Boolean(shipment.paid)});
      } else {
        await promos.releaseOrderPromotions(c, orderId, {reason: `rejected:${reason}`, isRefund: false});
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
      const order = await lockFoodOrder(c,orderId);
      check(order, 404, 'Food order not found');
      check(order.state === 'SUBMITTED', 409, 'Orders can only be cancelled before kitchen acceptance');
      check(actor && (actor.kind === 'admin' || actor.id === order.customer_id), 403, 'Permission denied');

      const updated = (await c.query(
        `UPDATE food_orders SET state = 'CANCELLED', updated_at = now() WHERE id = $1 RETURNING *`,
        [orderId]
      )).rows[0];

      if (order.shipment_id) {
        const shipment=(await c.query('SELECT * FROM shipments WHERE id=$1',[order.shipment_id])).rows[0];
        check(shipment&&['AWAITING_PAYMENT','AWAITING_ASSIGNMENT'].includes(shipment.state),409,'Courier already assigned; operational cancellation required');
        await requestCheckoutRefund(c,shipment,reason);
        await c.query("UPDATE shipments SET state='CANCELLED' WHERE id=$1",[order.shipment_id]);
        await c.query("UPDATE dispatch_offers SET status='expired' WHERE shipment_id=$1 AND status='offered'",[order.shipment_id]);
        await promos.releaseOrderPromotions(c, orderId, {reason: `cancelled:${reason}`, isRefund: Boolean(shipment.paid)});
      } else {
        await promos.releaseOrderPromotions(c, orderId, {reason: `cancelled:${reason}`, isRefund: false});
      }

      await c.query(
        'INSERT INTO audit_logs (actor_id, action, entity_id) VALUES ($1, $2, $3)',
        [actor.id, `food_order.cancelled:${reason}`, orderId]
      );

      return updated;
    });
  }

  async function clearRiderAssignmentArtifacts(c, shipment) {
    if (shipment.rider_id) {
      const plan = (await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id = $1 FOR UPDATE', [shipment.rider_id])).rows[0];
      if (plan && Array.isArray(plan.stops)) {
        const nextStops = plan.stops.filter(x => x.shipmentId !== shipment.id);
        await c.query('UPDATE rider_dispatch_plans SET stops = $2, revision = revision + 1, updated_at = now() WHERE rider_id = $1', [shipment.rider_id, JSON.stringify(nextStops)]);
      }
    }
    await c.query('UPDATE challenges SET expires_at = now() WHERE shipment_id = $1 AND consumed_at IS NULL', [shipment.id]);
    await c.query('DELETE FROM locations WHERE shipment_id = $1', [shipment.id]);
    await c.query('DELETE FROM dispatch_commitments WHERE shipment_id = $1', [shipment.id]);
    await c.query("UPDATE dispatch_offers SET status = 'invalidated' WHERE shipment_id = $1 AND status IN ('offered', 'accepted')", [shipment.id]);
  }

  async function resolveOrder(actor, orderId, input = {}) {
    uuid.parse(orderId);
    const v = z.object({
      action: z.enum(['reassign', 'cancel_refund', 'return', 'returned']),
      reason: z.string().trim().min(3).max(1000)
    }).strict().parse(input);
    return db.tx(async c => {
      // Enforce canonical delivery lock hierarchy: companies -> riders -> shipments -> rider_dispatch_plans -> food_orders
      const pre = (await c.query(
        `SELECT f.shipment_id, s.rider_id, r.company_id
           FROM food_orders f
           LEFT JOIN shipments s ON s.id = f.shipment_id
           LEFT JOIN riders r ON r.id = s.rider_id
          WHERE f.id = $1`,
        [orderId]
      )).rows[0];
      check(pre, 404, 'Food order not found');
      check(pre.shipment_id, 409, 'Food order has no delivery shipment');
      if (pre.company_id) await c.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [pre.company_id]);
      if (pre.rider_id) await c.query('SELECT id FROM riders WHERE id = $1 FOR UPDATE', [pre.rider_id]);
      const shipment = (await c.query('SELECT * FROM shipments WHERE id = $1 FOR UPDATE', [pre.shipment_id])).rows[0];
      check(shipment, 404, 'Delivery shipment not found');
      check(!shipment.rider_id || shipment.rider_id === pre.rider_id, 409, 'Shipment rider assignment changed concurrently; retry');
      if (shipment.rider_id) {
        await c.query('SELECT rider_id FROM rider_dispatch_plans WHERE rider_id = $1 FOR UPDATE', [shipment.rider_id]);
      }
      const order = await lockFoodOrder(c, orderId);
      check(order, 404, 'Food order not found');
      check(!['DELIVERED', 'CANCELLED', 'REJECTED'].includes(order.state), 409, `Food order is already terminal (${order.state})`);
      const restaurant = (await c.query('SELECT * FROM restaurants WHERE id = $1', [order.restaurant_id])).rows[0];
      const isAdmin = actor?.kind === 'admin';
      const isOwner = Boolean(actor && restaurant && restaurant.owner_id === actor.id);
      const isRider = Boolean(actor && shipment.rider_id && shipment.rider_id === actor.id);
      const isCustomer = Boolean(actor && order.customer_id === actor.id);
      const pickedUp = Boolean((await c.query("SELECT 1 FROM challenges WHERE shipment_id = $1 AND purpose = 'pickup' AND consumed_at IS NOT NULL", [shipment.id])).rowCount) ||
        ['PICKUP_VERIFIED', 'IN_TRANSIT', 'AWAITING_DELIVERY_OTP', 'RETURN_REQUESTED', 'RETURNED'].includes(shipment.state) ||
        order.state === 'IN_TRANSIT';

      if (v.action === 'reassign') {
        check(isAdmin || isOwner || isRider, 403, 'Only restaurant owner, assigned rider, or administrator may reassign pre-pickup');
        check(!pickedUp && ['RIDER_ASSIGNED', 'FAILED'].includes(shipment.state) && ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(order.state), 409, 'Order can only be reassigned when rider assignment failed before pickup');
        await clearRiderAssignmentArtifacts(c, shipment);
        await c.query("UPDATE shipments SET state = 'AWAITING_ASSIGNMENT', rider_id = NULL, company_id = NULL, next_dispatch_at = now(), dispatch_attempts = 0 WHERE id = $1", [shipment.id]);
        await c.query('UPDATE food_orders SET dispatch_started_at = now(), updated_at = now() WHERE id = $1', [orderId]);
        await c.query("INSERT INTO outbox(shipment_id, kind, payload) VALUES($1, 'AWAITING_ASSIGNMENT', $2)", [shipment.id, JSON.stringify({shipmentId: shipment.id, kind: 'AWAITING_ASSIGNMENT'})]);
        await c.query('INSERT INTO audit_logs(actor_id, action, entity_id) VALUES($1, $2, $3)', [actor.id, `food_order.reassigned:${v.reason}`, orderId]);
        return {orderId, state: order.state, shipmentState: 'AWAITING_ASSIGNMENT', riderId: null, refundReviewRequired: false};
      }

      if (v.action === 'return') {
        check(isAdmin || isOwner || isRider || isCustomer, 403, 'Permission denied to request return');
        check(pickedUp && ['FAILED', 'RETURN_REQUESTED'].includes(shipment.state), 409, 'Return request requires a post-pickup failed shipment');
        if (shipment.state === 'FAILED') {
          await c.query("UPDATE shipments SET state = 'RETURN_REQUESTED' WHERE id = $1", [shipment.id]);
          await c.query("INSERT INTO outbox(shipment_id, kind, payload) VALUES($1, 'RETURN_REQUESTED', $2)", [shipment.id, JSON.stringify({shipmentId: shipment.id, kind: 'RETURN_REQUESTED'})]);
        }
        await c.query('INSERT INTO audit_logs(actor_id, action, entity_id) VALUES($1, $2, $3)', [actor.id, `food_order.return_requested:${v.reason}`, orderId]);
        return {orderId, state: order.state, shipmentState: 'RETURN_REQUESTED', riderId: shipment.rider_id, refundReviewRequired: false};
      }

      if (v.action === 'returned') {
        check(isAdmin || isOwner, 403, 'Only restaurant owner or administrator may confirm physical return');
        check(pickedUp && (['FAILED', 'RETURN_REQUESTED', 'RETURNED'].includes(shipment.state) || (isAdmin && ['PICKUP_VERIFIED', 'IN_TRANSIT', 'AWAITING_DELIVERY_OTP'].includes(shipment.state))), 409, 'Return confirmation requires a post-pickup failed or return-requested shipment');
        await clearRiderAssignmentArtifacts(c, shipment);
        if (['PICKUP_VERIFIED', 'IN_TRANSIT', 'AWAITING_DELIVERY_OTP'].includes(shipment.state)) {
          await c.query("UPDATE shipments SET state = 'FAILED' WHERE id = $1", [shipment.id]);
          await c.query("INSERT INTO outbox(shipment_id, kind, payload) VALUES($1, 'FAILED', $2)", [shipment.id, JSON.stringify({shipmentId: shipment.id, kind: 'FAILED'})]);
          shipment.state = 'FAILED';
        }
        if (shipment.state === 'FAILED') {
          await c.query("UPDATE shipments SET state = 'RETURN_REQUESTED' WHERE id = $1", [shipment.id]);
          await c.query("INSERT INTO outbox(shipment_id, kind, payload) VALUES($1, 'RETURN_REQUESTED', $2)", [shipment.id, JSON.stringify({shipmentId: shipment.id, kind: 'RETURN_REQUESTED'})]);
        }
        if (shipment.state !== 'RETURNED') {
          await c.query("UPDATE shipments SET state = 'RETURNED' WHERE id = $1", [shipment.id]);
          await c.query("INSERT INTO outbox(shipment_id, kind, payload) VALUES($1, 'RETURNED', $2)", [shipment.id, JSON.stringify({shipmentId: shipment.id, kind: 'RETURNED'})]);
        }
        await requestCheckoutRefund(c, shipment, v.reason);
        const updated = (await c.query("UPDATE food_orders SET state = 'CANCELLED', updated_at = now() WHERE id = $1 RETURNING *", [orderId])).rows[0];
        await promos.releaseOrderPromotions(c, orderId, {reason: `returned_cancelled:${v.reason}`, isRefund: Boolean(shipment.paid)});
        await c.query('INSERT INTO audit_logs(actor_id, action, entity_id) VALUES($1, $2, $3)', [actor.id, `food_order.returned_cancelled:${v.reason}`, orderId]);
        return {orderId, state: updated.state, shipmentState: 'RETURNED', riderId: shipment.rider_id, refundReviewRequired: Boolean(shipment.paid)};
      }

      // action === 'cancel_refund'
      if (!pickedUp) {
        check(isAdmin || isOwner || (isCustomer && (shipment.state === 'FAILED' || order.state === 'SUBMITTED')), 403, 'Permission denied to cancel and refund this order');
        check(['AWAITING_PAYMENT', 'AWAITING_ASSIGNMENT', 'RIDER_ASSIGNED', 'FAILED'].includes(shipment.state), 409, `Cannot cancel pre-pickup shipment in state ${shipment.state}`);
        await clearRiderAssignmentArtifacts(c, shipment);
        await requestCheckoutRefund(c, shipment, v.reason);
        await c.query("UPDATE shipments SET state = 'CANCELLED', rider_id = NULL, company_id = NULL WHERE id = $1", [shipment.id]);
        await c.query("INSERT INTO outbox(shipment_id, kind, payload) VALUES($1, 'CANCELLED', $2)", [shipment.id, JSON.stringify({shipmentId: shipment.id, kind: 'CANCELLED'})]);
        const updated = (await c.query("UPDATE food_orders SET state = 'CANCELLED', updated_at = now() WHERE id = $1 RETURNING *", [orderId])).rows[0];
        await promos.releaseOrderPromotions(c, orderId, {reason: `resolved_cancelled:${v.reason}`, isRefund: Boolean(shipment.paid)});
        await c.query('INSERT INTO audit_logs(actor_id, action, entity_id) VALUES($1, $2, $3)', [actor.id, `food_order.resolved_cancelled:${v.reason}`, orderId]);
        return {orderId, state: updated.state, shipmentState: 'CANCELLED', riderId: null, refundReviewRequired: Boolean(shipment.paid)};
      } else {
        check(isAdmin || isOwner || (isCustomer && shipment.state === 'RETURNED'), 403, 'Post-pickup refund requires restaurant return confirmation or operator decision');
        check(['FAILED', 'RETURN_REQUESTED', 'RETURNED'].includes(shipment.state) || (isAdmin && ['PICKUP_VERIFIED', 'IN_TRANSIT', 'AWAITING_DELIVERY_OTP'].includes(shipment.state)), 409, 'Post-pickup order can only be cancelled after delivery failure or return');
        await clearRiderAssignmentArtifacts(c, shipment);
        if (['PICKUP_VERIFIED', 'IN_TRANSIT', 'AWAITING_DELIVERY_OTP'].includes(shipment.state)) {
          await c.query("UPDATE shipments SET state = 'FAILED' WHERE id = $1", [shipment.id]);
          await c.query("INSERT INTO outbox(shipment_id, kind, payload) VALUES($1, 'FAILED', $2)", [shipment.id, JSON.stringify({shipmentId: shipment.id, kind: 'FAILED'})]);
          shipment.state = 'FAILED';
        }
        if (shipment.state === 'FAILED') {
          await c.query("UPDATE shipments SET state = 'RETURN_REQUESTED' WHERE id = $1", [shipment.id]);
          await c.query("INSERT INTO outbox(shipment_id, kind, payload) VALUES($1, 'RETURN_REQUESTED', $2)", [shipment.id, JSON.stringify({shipmentId: shipment.id, kind: 'RETURN_REQUESTED'})]);
        }
        if (shipment.state !== 'RETURNED') {
          await c.query("UPDATE shipments SET state = 'RETURNED' WHERE id = $1", [shipment.id]);
          await c.query("INSERT INTO outbox(shipment_id, kind, payload) VALUES($1, 'RETURNED', $2)", [shipment.id, JSON.stringify({shipmentId: shipment.id, kind: 'RETURNED'})]);
        }
        await requestCheckoutRefund(c, shipment, v.reason);
        const updated = (await c.query("UPDATE food_orders SET state = 'CANCELLED', updated_at = now() WHERE id = $1 RETURNING *", [orderId])).rows[0];
        await promos.releaseOrderPromotions(c, orderId, {reason: `post_pickup_cancelled:${v.reason}`, isRefund: Boolean(shipment.paid)});
        await c.query('INSERT INTO audit_logs(actor_id, action, entity_id) VALUES($1, $2, $3)', [actor.id, `food_order.post_pickup_cancelled:${v.reason}`, orderId]);
        return {orderId, state: updated.state, shipmentState: 'RETURNED', riderId: shipment.rider_id, refundReviewRequired: Boolean(shipment.paid)};
      }
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
        COALESCE(SUM(restaurant_discount_minor), 0)::bigint AS restaurant_discount_minor,
        COALESCE(SUM(elesend_subsidy_minor), 0)::bigint AS elesend_subsidy_minor,
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
        restaurantDiscountMinor: Number(totals.restaurant_discount_minor),
        elesendSubsidyMinor: Number(totals.elesend_subsidy_minor),
        commissionMinor: Number(totals.commission_minor),
        netPayableMinor: Number(totals.net_payable_minor),
        totalOrders: totals.count
      },
      settlements
    };
  }

  async function monitorAssignedDeliveries({limit=25,staleGpsSeconds=null,pickupGraceSeconds=null,reviewIntervalSeconds=60,autoReassignPreCustody=true,onlyDueReviews=false}={}){
    check(Number.isInteger(limit)&&limit>=1&&limit<=100,400,'Invalid watchdog batch size');
    const dp=(await db.query('SELECT fresh_seconds,delivery_slack_seconds FROM dispatch_policy WHERE id=1')).rows[0]||{};
    const staleSec=Number.isInteger(staleGpsSeconds)&&staleGpsSeconds>0?staleGpsSeconds:Math.max(Number(dp.fresh_seconds||120)*2,180);
    const pickupGraceSec=Number.isInteger(pickupGraceSeconds)&&pickupGraceSeconds>0?pickupGraceSeconds:Math.max(Number(dp.delivery_slack_seconds||600),300);
    const reviewSec=Number.isInteger(reviewIntervalSeconds)&&reviewIntervalSeconds>=1?reviewIntervalSeconds:60;
    const rows=(await db.query(`
      SELECT f.id AS order_id, s.id AS shipment_id, s.rider_id, r.company_id
      FROM food_orders f
      JOIN shipments s ON s.id=f.shipment_id
      JOIN riders r ON r.id=s.rider_id
      LEFT JOIN locations l ON l.shipment_id=s.id AND l.rider_id=s.rider_id
      LEFT JOIN dispatch_commitments dc ON dc.shipment_id=s.id AND dc.rider_id=s.rider_id
      WHERE f.state IN ('ACCEPTED','PREPARING','READY_FOR_PICKUP','IN_TRANSIT')
        AND s.rider_id IS NOT NULL
        AND s.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP')
        AND (NOT $4::boolean OR COALESCE(f.watchdog_next_review_at, s.watchdog_next_review_at, '-infinity'::timestamptz) <= clock_timestamp())
        AND (
          r.online = false
          OR GREATEST(COALESCE(r.position_at, '-infinity'::timestamptz), COALESCE(l.updated_at, '-infinity'::timestamptz)) < now() - ($1::int * interval '1 second')
          OR (s.state='RIDER_ASSIGNED' AND f.ready_at IS NOT NULL AND f.ready_at < now() - ($2::int * interval '1 second'))
          OR (s.state='RIDER_ASSIGNED' AND EXISTS (
            SELECT 1 FROM dispatch_offers o
            WHERE o.shipment_id=s.id AND o.rider_id=s.rider_id AND o.status='accepted'
              AND o.accepted_at + ((COALESCE(o.pickup_eta_seconds, 300) + $2::int) * interval '1 second') < now()
          ))
          OR (s.state IN ('PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP') AND (
            (dc.promised_delivery_before IS NOT NULL AND dc.promised_delivery_before < now())
            OR (dc.promised_delivery_before IS NULL AND COALESCE(f.ready_at, f.accepted_at, f.created_at) < now() - interval '45 minutes')
          ))
        )
      ORDER BY
        CASE WHEN COALESCE(f.watchdog_next_review_at, s.watchdog_next_review_at, '-infinity'::timestamptz) <= clock_timestamp() THEN 0 ELSE 1 END ASC,
        COALESCE(f.watchdog_last_inspected_at, s.watchdog_last_inspected_at) ASC NULLS FIRST,
        COALESCE(f.watchdog_next_review_at, s.watchdog_next_review_at) ASC NULLS FIRST,
        f.created_at ASC
      LIMIT $3
    `,[staleSec,pickupGraceSec,limit,Boolean(onlyDueReviews)])).rows;
    const watched=[];
    for(const row of rows){
      try{
        const entry=await db.tx(async c=>{
          // Enforce canonical lock hierarchy: companies -> riders -> shipments -> rider_dispatch_plans -> food_orders
          if(row.company_id)await c.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[row.company_id]);
          const r=(await c.query('SELECT * FROM riders WHERE id=$1 FOR UPDATE',[row.rider_id])).rows[0];
          const s=(await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[row.shipment_id])).rows[0];
          if(!s||!s.rider_id||s.rider_id!==row.rider_id||!['RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP'].includes(s.state))return null;
          await c.query('SELECT rider_id FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE',[s.rider_id]);
          const f=await lockFoodOrder(c,row.order_id);
          if(!f||!['ACCEPTED','PREPARING','READY_FOR_PICKUP','IN_TRANSIT'].includes(f.state))return null;
          const loc=(await c.query('SELECT updated_at FROM locations WHERE shipment_id=$1 AND rider_id=$2',[s.id,s.rider_id])).rows[0];
          const dc=(await c.query('SELECT promised_delivery_before FROM dispatch_commitments WHERE shipment_id=$1 AND rider_id=$2',[s.id,s.rider_id])).rows[0];
          const accOffer=(await c.query("SELECT id,accepted_at,pickup_eta_seconds FROM dispatch_offers WHERE shipment_id=$1 AND rider_id=$2 AND status='accepted' ORDER BY accepted_at DESC LIMIT 1",[s.id,s.rider_id])).rows[0];
          const pickedUp=s.state!=='RIDER_ASSIGNED'||f.state==='IN_TRANSIT'||
            Boolean((await c.query("SELECT 1 FROM challenges WHERE shipment_id=$1 AND purpose='pickup' AND consumed_at IS NOT NULL",[s.id])).rowCount);
          const nowMs=Date.now();
          const latestGpsMs=Math.max(
            r?.position_at?new Date(r.position_at).getTime():-Infinity,
            loc?.updated_at?new Date(loc.updated_at).getTime():-Infinity
          );
          const isStaleGps=!r?.online||!Number.isFinite(latestGpsMs)||(nowMs-latestGpsMs)>staleSec*1000;
          const pickupDeadlineMs=Math.min(
            f.ready_at?new Date(f.ready_at).getTime()+pickupGraceSec*1000:Infinity,
            accOffer?.accepted_at?new Date(accOffer.accepted_at).getTime()+(Number(accOffer.pickup_eta_seconds||300)+pickupGraceSec)*1000:Infinity
          );
          const isOverduePickup=!pickedUp&&Number.isFinite(pickupDeadlineMs)&&nowMs>pickupDeadlineMs;
          const deliveryDeadlineMs=dc?.promised_delivery_before
            ?new Date(dc.promised_delivery_before).getTime()
            :(new Date(f.ready_at||f.accepted_at||f.created_at).getTime()+45*60*1000);
          const isOverdueDelivery=pickedUp&&Number.isFinite(deliveryDeadlineMs)&&nowMs>deliveryDeadlineMs;
          const reasons=[];
          const signals=[];
          if(isStaleGps){reasons.push('stale_gps');signals.push({code:'STALE_GPS',severity:pickedUp?'high':'medium'});}
          if(isOverduePickup){reasons.push('overdue_pickup');signals.push({code:'OVERDUE_PICKUP',severity:'medium'});}
          if(isOverdueDelivery){reasons.push('overdue_delivery');signals.push({code:'OVERDUE_DELIVERY',severity:'high'});}
          if(!reasons.length)return null;
          const oldRiderId=s.rider_id;
          for(const sig of signals){
            const existingSig=(await c.query("SELECT id FROM operational_risk_signals WHERE rider_id=$1 AND shipment_id=$2 AND signal_code=$3 AND review_status='pending' LIMIT 1",[oldRiderId,s.id,sig.code])).rows[0];
            if(!existingSig){
              await c.query('INSERT INTO operational_risk_signals(rider_id,shipment_id,signal_code,severity,evidence) VALUES($1,$2,$3,$4,$5)',
                [oldRiderId,s.id,sig.code,sig.severity,JSON.stringify({orderId:f.id,reasons,state:s.state,lastGpsAt:Number.isFinite(latestGpsMs)?new Date(latestGpsMs).toISOString():null})]);
            }
          }
          const reasonSummary=`Assigned food delivery watchdog detected ${reasons.join(', ')} for rider ${oldRiderId}`;
          if(!pickedUp){
            await c.query("INSERT INTO dispatch_exceptions(shipment_id,actor_id,kind,reason) VALUES($1,NULL,'reassignment_review',$2)",[s.id,reasonSummary]);
            await c.query("INSERT INTO notification_jobs(id,recipient_id,kind,payload) VALUES($1,$2,'delivery_watchdog_alert',$3) ON CONFLICT(id) DO NOTHING",
              [`food-watchdog-pre:${f.id}:${oldRiderId}`,f.customer_id,JSON.stringify({orderId:f.id,shipmentId:s.id,reasons,action:autoReassignPreCustody?'reassigned_pre_pickup':'reassignment_offered',message:'Your assigned courier became unresponsive before pickup. We are reassigning your food order to the next available courier.'})]);
            if(autoReassignPreCustody){
              await clearRiderAssignmentArtifacts(c,s);
              await c.query("UPDATE shipments SET state='AWAITING_ASSIGNMENT',rider_id=NULL,company_id=NULL,next_dispatch_at=now(),dispatch_attempts=0,watchdog_last_inspected_at=clock_timestamp(),watchdog_next_review_at=NULL WHERE id=$1",[s.id]);
              await c.query('UPDATE food_orders SET dispatch_started_at=now(),watchdog_last_inspected_at=clock_timestamp(),watchdog_next_review_at=NULL,updated_at=now() WHERE id=$1',[f.id]);
              await c.query("INSERT INTO outbox(shipment_id,kind,payload) VALUES($1,'AWAITING_ASSIGNMENT',$2)",[s.id,JSON.stringify({shipmentId:s.id,kind:'AWAITING_ASSIGNMENT',watchdogReassigned:true})]);
              await c.query('INSERT INTO audit_logs(action,entity_id) VALUES($1,$2)',[`food_order.watchdog_reassigned:${reasons.join(',')}`,f.id]);
              if(chat&&typeof chat.revokeRiderConversations==='function'){
                await chat.revokeRiderConversations(c,{shipmentId:s.id,oldRiderUserId:oldRiderId,reason:'watchdog_reassigned'});
              }
              return {id:f.id,orderId:f.id,shipmentId:s.id,previousRiderId:oldRiderId,reassigned:true,status:'reassigned_pre_pickup',reason:reasons[0],reasons,shipmentState:'AWAITING_ASSIGNMENT',supportAlerted:true,reassignmentOffered:true};
            }
            const sched=(await c.query("UPDATE food_orders SET watchdog_last_inspected_at=clock_timestamp(),watchdog_next_review_at=clock_timestamp()+($2::int*interval '1 second') WHERE id=$1 RETURNING watchdog_last_inspected_at,watchdog_next_review_at",[f.id,reviewSec])).rows[0];
            await c.query("UPDATE shipments SET watchdog_last_inspected_at=$2,watchdog_next_review_at=$3 WHERE id=$1",[s.id,sched?.watchdog_last_inspected_at??new Date(),sched?.watchdog_next_review_at??new Date(Date.now()+reviewSec*1000)]);
            await c.query('INSERT INTO audit_logs(action,entity_id) VALUES($1,$2)',[`food_order.watchdog_pre_pickup_alert:${reasons.join(',')}`,f.id]);
            return {id:f.id,orderId:f.id,shipmentId:s.id,riderId:oldRiderId,status:'escalated_pre_pickup',reason:reasons[0],reasons,shipmentState:s.state,supportAlerted:true,reassignmentOffered:true,lastInspectedAt:sched?.watchdog_last_inspected_at??null,nextReviewAt:sched?.watchdog_next_review_at??null};
          }
          const existingEx=(await c.query("SELECT 1 FROM dispatch_exceptions WHERE shipment_id=$1 AND kind='reassignment_review' AND created_at>now()-interval '15 minutes' LIMIT 1",[s.id])).rowCount;
          if(!existingEx){
            await c.query("INSERT INTO dispatch_exceptions(shipment_id,actor_id,kind,reason) VALUES($1,NULL,'reassignment_review',$2)",[s.id,reasonSummary]);
          }
          const sched=(await c.query("UPDATE food_orders SET watchdog_last_inspected_at=clock_timestamp(),watchdog_next_review_at=clock_timestamp()+($2::int*interval '1 second') WHERE id=$1 RETURNING watchdog_last_inspected_at,watchdog_next_review_at",[f.id,reviewSec])).rows[0];
          await c.query("UPDATE shipments SET watchdog_last_inspected_at=$2,watchdog_next_review_at=$3 WHERE id=$1",[s.id,sched?.watchdog_last_inspected_at??new Date(),sched?.watchdog_next_review_at??new Date(Date.now()+reviewSec*1000)]);
          await c.query("INSERT INTO notification_jobs(id,recipient_id,kind,payload) VALUES($1,$2,'delivery_watchdog_alert',$3) ON CONFLICT(id) DO NOTHING",
            [`food-watchdog-custody:${f.id}:${oldRiderId}:${reasons.join('_')}`,f.customer_id,JSON.stringify({orderId:f.id,shipmentId:s.id,riderId:oldRiderId,reasons,action:'support_escalated',message:'Delivery monitoring flagged a delay on your active food order and alerted operations support.'})]);
          await c.query('INSERT INTO audit_logs(action,entity_id) VALUES($1,$2)',[`food_order.watchdog_escalated_in_custody:${reasons.join(',')}`,f.id]);
          return {id:f.id,orderId:f.id,shipmentId:s.id,riderId:oldRiderId,status:'escalated_in_custody',reason:reasons[0],reasons,shipmentState:s.state,supportAlerted:true,reassignmentOffered:false,lastInspectedAt:sched?.watchdog_last_inspected_at??null,nextReviewAt:sched?.watchdog_next_review_at??null};
        });
        if(entry)watched.push(entry);
      }catch(e){watched.push({id:row.order_id,orderId:row.order_id,shipmentId:row.shipment_id,status:'error',code:e.code||e.status||'internal'});}
    }
    return watched;
  }

  async function expireUnfulfilledOrders({limit=25,includeAssignedWatchdog=true,staleGpsSeconds=null,pickupGraceSeconds=null,autoReassignPreCustody=true}={}){
    check(Number.isInteger(limit)&&limit>=1&&limit<=100,400,'Invalid expiry batch size');
    const results=[];
    if(includeAssignedWatchdog){
      const watchdogResults=await monitorAssignedDeliveries({limit,staleGpsSeconds,pickupGraceSeconds,autoReassignPreCustody});
      results.push(...watchdogResults);
    }
    const ids=(await db.query(`SELECT f.id FROM food_orders f JOIN shipments s ON s.id=f.shipment_id
      WHERE (f.state='SUBMITTED' AND f.payment_status='PENDING' AND f.created_at<now()-$1::int*interval '1 second')
      OR (f.state='SUBMITTED' AND f.payment_status='PAID' AND EXISTS(SELECT 1 FROM shipment_checkout_intents i WHERE i.shipment_id=s.id AND i.status='confirmed' AND i.confirmed_at<now()-$2::int*interval '1 second'))
      OR (f.state IN ('ACCEPTED','PREPARING','READY_FOR_PICKUP') AND s.state='AWAITING_ASSIGNMENT' AND s.rider_id IS NULL AND LEAST(COALESCE(f.dispatch_started_at,f.ready_at,s.next_dispatch_at),COALESCE(f.ready_at,s.next_dispatch_at),s.next_dispatch_at)<now()-$3::int*interval '1 second')
      ORDER BY f.created_at LIMIT $4`,[unpaidTimeoutSeconds,acceptanceTimeoutSeconds,courierTimeoutSeconds,limit])).rows;
    for(const {id} of ids){
      try{results.push(await db.tx(async c=>{
        const f=await lockFoodOrder(c,id);
        const s=(await c.query('SELECT * FROM shipments WHERE id=$1',[f.shipment_id])).rows[0];
        if(!s||!['AWAITING_PAYMENT','AWAITING_ASSIGNMENT'].includes(s.state)||s.rider_id)return {id,status:'changed'};
        const receipt=(await c.query("SELECT confirmed_at FROM shipment_checkout_intents WHERE shipment_id=$1 AND status='confirmed' ORDER BY confirmed_at LIMIT 1",[s.id])).rows[0];
        const now=Date.now();
        const dispatchOriginMs=Math.min(...[f.dispatch_started_at,f.ready_at,s.next_dispatch_at].filter(Boolean).map(v=>new Date(v).getTime()));
        const reason=f.state==='SUBMITTED'&&f.payment_status==='PENDING'&&new Date(f.created_at).getTime()<now-unpaidTimeoutSeconds*1000?'payment_deadline':
          f.state==='SUBMITTED'&&f.payment_status==='PAID'&&receipt&&new Date(receipt.confirmed_at).getTime()<now-acceptanceTimeoutSeconds*1000?'kitchen_acceptance_deadline':
          ['ACCEPTED','PREPARING','READY_FOR_PICKUP'].includes(f.state)&&dispatchOriginMs<now-courierTimeoutSeconds*1000?'courier_unavailable':null;
        if(!reason)return {id,status:'changed'};
        await requestCheckoutRefund(c,s,reason);
        await c.query("UPDATE food_orders SET state='CANCELLED',updated_at=now() WHERE id=$1",[id]);
        await c.query("UPDATE shipments SET state='CANCELLED' WHERE id=$1",[s.id]);
        await c.query("UPDATE dispatch_offers SET status='expired' WHERE shipment_id=$1 AND status='offered'",[s.id]);
        await promos.releaseOrderPromotions(c, id, {reason: `auto_cancelled:${reason}`, isRefund: Boolean(s.paid)});
        await c.query("INSERT INTO notification_jobs(id,recipient_id,kind,payload) VALUES($1,$2,'food_order_cancelled',$3) ON CONFLICT(id) DO NOTHING",['food-expired:'+id,f.customer_id,JSON.stringify({orderId:id,reason,message:s.paid?'Your food order could not be fulfilled. It was cancelled and a full refund is due.':'Your unpaid food order expired.'})]);
        await c.query("INSERT INTO audit_logs(action,entity_id) VALUES($1,$2)",['food_order.auto_cancelled:'+reason,id]);
        return {id,status:'cancelled',reason};
      }));}catch(e){results.push({id,status:'error',code:e.code||e.status||'internal'});}
    }
    return results;
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
        `SELECT r.id, r.vehicle, r.max_weight_g AS capacity_g,
                COALESCE(l.latitude, ST_Y(r.current_position::geometry)) AS latitude,
                COALESCE(l.longitude, ST_X(r.current_position::geometry)) AS longitude
         FROM riders r
         LEFT JOIN locations l ON l.rider_id = r.id
         LEFT JOIN commission_accounts ca ON ca.rider_id = r.id
         WHERE r.id = $1
           AND r.status = 'approved'
           AND r.financial_restriction IS NULL
           AND COALESCE(ca.blocked, false) = false`,
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
      // Find nearest approved, debt-eligible active rider using live current_position or active location pin
      const riderRow = (await db.query(
        `SELECT r.id, r.vehicle, r.max_weight_g AS capacity_g,
                COALESCE(l.latitude, ST_Y(r.current_position::geometry)) AS latitude,
                COALESCE(l.longitude, ST_X(r.current_position::geometry)) AS longitude
         FROM riders r
         LEFT JOIN locations l ON l.rider_id = r.id
         LEFT JOIN commission_accounts ca ON ca.rider_id = r.id
         WHERE r.status = 'approved'
           AND r.online = true
           AND r.financial_restriction IS NULL
           AND COALESCE(ca.blocked, false) = false
           AND (l.latitude IS NOT NULL OR r.current_position IS NOT NULL)
         ORDER BY (
           (COALESCE(l.latitude, ST_Y(r.current_position::geometry)) - $1) * (COALESCE(l.latitude, ST_Y(r.current_position::geometry)) - $1) +
           (COALESCE(l.longitude, ST_X(r.current_position::geometry)) - $2) * (COALESCE(l.longitude, ST_X(r.current_position::geometry)) - $2)
         ) ASC
         LIMIT 1`,
        [r.latitude, r.longitude]
      )).rows[0];

      assignedRider = riderRow ? {
        id: riderRow.id,
        latitude: Number(riderRow.latitude),
        longitude: Number(riderRow.longitude),
        vehicle: riderRow.vehicle || 'motorcycle',
        maxCapacityG: riderRow.capacity_g || 15000,
        currentLoadedG: 0,
        riderSimulated: false
      } : {
        id: null,
        latitude: r.latitude,
        longitude: r.longitude,
        vehicle: 'motorcycle',
        maxCapacityG: 15000,
        currentLoadedG: 0,
        riderSimulated: true
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

    return {
      ...result,
      riderId: assignedRider.id,
      riderSimulated: Boolean(assignedRider.riderSimulated)
    };
  }

  return {
    quoteFoodOrder,
    createFoodOrder,
    getFoodOrder,
    listFoodOrders,
    acceptOrder,
    startPreparing,
    markReadyForPickup,
    rejectOrder,
    cancelOrder,
    resolveOrder,
    getRestaurantSettlements,
    evaluateBatchDispatch,
    monitorAssignedDeliveries,
    expireUnfulfilledOrders
  };
}
