import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { database } from '../services/api/db.mjs';
import { migrate } from '../scripts/migrate.mjs';
import { commissionEngine, computeRestaurantCommissionBreakdown } from '../services/api/commission-engine.mjs';
import { promotionEngine } from '../services/api/promotion-engine.mjs';
import { restaurantOrderService } from '../services/api/restaurant-orders.mjs';
import { checkoutService } from '../services/api/checkout.mjs';
import { digitalDeliveryCompleted } from '../services/api/checkout-accounting.mjs';
import { restaurantService } from '../services/api/restaurant.mjs';

const url = process.env.TEST_DATABASE_URL;

test('Restaurant Commission, Promotions, Campaign Partnerships, and Financial Settlement Engine', { skip: !url }, async t => {
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
          const name = 'sp_promo_' + (++savepoint);
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
        const customer2Id = randomUUID();
        const ownerAId = randomUUID();
        const ownerBId = randomUUID();
        const riderId = randomUUID();
        const restAId = randomUUID();
        const restBId = randomUUID();
        const itemA1 = randomUUID();
        const itemA2 = randomUUID();
        const itemB1 = randomUUID();
        const policyId = randomUUID();

        for (const [id, kind] of [
          [adminId, 'admin'],
          [customerId, 'customer'],
          [customer2Id, 'customer'],
          [ownerAId, 'business'],
          [ownerBId, 'business'],
          [riderId, 'rider']
        ]) {
          await c.query(
            "INSERT INTO users(id, phone, password_hash, kind, phone_verified_at) VALUES($1, $2, 'test-hash', $3, now())",
            [id, '+2332' + String(randomInt(10000000, 99999999)), kind]
          );
        }

        await c.query(
          "INSERT INTO permissions(user_id, permission) VALUES($1, 'finance:configure'), ($1, 'finance:approve'), ($1, 'verification:write'), ($1, 'pricing:write')",
          [adminId]
        );
        await c.query("INSERT INTO riders(id, vehicle, max_weight_g, online, status) VALUES($1, 'motorcycle', 20000, true, 'approved')", [riderId]);

        await c.query('UPDATE pricing_policies SET active = false');
        await c.query(
          "INSERT INTO pricing_policies(id, base_minor, per_km_minor, commission_bps, vehicle, active) VALUES($1, 1000, 100, 1300, 'motorcycle', true)",
          [policyId]
        );
        await c.query("UPDATE checkout_method_policies SET enabled = true WHERE method = 'MOMO'");
        await c.query("UPDATE service_markets SET service_enabled = true WHERE country_code = 'GH'");

        // Reset commission settings to default 10% (1000 bps) on gross_subtotal
        await c.query(
          `UPDATE restaurant_commission_settings
              SET default_rate_bps = 1000,
                  default_calculation_basis = 'gross_subtotal',
                  min_permitted_rate_bps = 0,
                  max_permitted_rate_bps = 3000,
                  updated_at = now()
            WHERE id = true`
        );
        await c.query("UPDATE commission_rules SET status = 'revoked' WHERE category != 'restaurant_default'");
        await c.query("UPDATE commission_rules SET rate_bps = 1000, status = 'active' WHERE category = 'restaurant_default'");

        await c.query(
          `INSERT INTO restaurants(id, owner_id, name, phone, address, latitude, longitude, status, merchant_tier, cuisine_category, commission_calculation_basis)
           VALUES($1, $2, 'Osu Jollof House', '+233241112222', 'Osu Oxford St', 5.5600, -0.1800, 'approved', 'standard', 'local_ghanaian', 'gross_subtotal')`,
          [restAId, ownerAId]
        );
        await c.query(
          `INSERT INTO restaurants(id, owner_id, name, phone, address, latitude, longitude, status, merchant_tier, cuisine_category, commission_calculation_basis)
           VALUES($1, $2, 'East Legon Grill', '+233243334444', 'East Legon', 5.6300, -0.1600, 'approved', 'gold', 'grill', 'gross_subtotal')`,
          [restBId, ownerBId]
        );

        // GH₵ 100.00 = 10000 pesewas
        await c.query("INSERT INTO menu_items(id, restaurant_id, name, price_minor) VALUES($1, $2, 'Family Jollof Platter', 10000)", [itemA1, restAId]);
        await c.query("INSERT INTO menu_items(id, restaurant_id, name, price_minor) VALUES($1, $2, 'Fried Kelewele Side', 2500)", [itemA2, restAId]);
        await c.query("INSERT INTO menu_items(id, restaurant_id, name, price_minor) VALUES($1, $2, 'Tilapia Special', 10000)", [itemB1, restBId]);

        const admin = { id: adminId, kind: 'admin' };
        const customer = { id: customerId, kind: 'customer' };
        const customer2 = { id: customer2Id, kind: 'customer' };
        const kitchenA = { id: ownerAId, kind: 'business' };
        const kitchenB = { id: ownerBId, kind: 'business' };
        const rider = { id: riderId, kind: 'rider' };

        const comm = commissionEngine(db);
        const promo = promotionEngine(db);
        const restSvc = restaurantService(db);
        const food = restaurantOrderService(db, {
          routing: { route: async () => ({ distanceMeters: 2000, durationSeconds: 300 }) } // delivery fee = 1000 + 2*100 = 1200 minor (GH₵ 12.00)
        });

        let receipt;
        const provider = {
          name: 'fixture',
          methods: ['MOMO'],
          allowedCheckoutHosts: ['checkout.test'],
          createCheckout: async x => ({ reference: x.reference, checkoutUrl: 'https://checkout.test/pay' }),
          verifyPayment: async () => receipt,
          parseVerifiedWebhook: async () => receipt
        };
        const checkout = checkoutService(db, { provider });

        const payOrder = async (order, amount = Number(order.total_minor)) => {
          const intent = await checkout.initiate(customer, order.shipment_id, { idempotencyKey: randomUUID() });
          receipt = {
            reference: intent.reference,
            status: 'success',
            amountMinor: amount,
            currency: 'GHS',
            channel: 'mobile_money',
            eventId: 'evt_' + randomUUID()
          };
          return checkout.webhook(Buffer.from('{}'), {});
        };

        await fn({
          db, c, admin, customer, customer2, kitchenA, kitchenB, rider,
          restAId, restBId, itemA1, itemA2, itemB1,
          comm, promo, restSvc, food, checkout, payOrder
        });
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }

    await t.test('1. Global default 10% (1000 bps) restaurant commission & deterministic precedence hierarchy', () =>
      fixture(async ({ admin, comm, restAId }) => {
        // Default 10% (1000 bps) on GH₵ 100.00 (10000 minor) -> 1000 minor commission, 9000 minor net payout
        const defRes = await comm.resolveRestaurantCommission({ restaurantId: restAId });
        assert.equal(defRes.rateBps, 1000);
        assert.equal(defRes.source, 'restaurant_default');

        const calc10 = computeRestaurantCommissionBreakdown({
          subtotalMinor: 10000,
          rateBps: defRes.rateBps,
          calculationBasis: defRes.calculationBasis
        });
        assert.equal(calc10.commissionMinor, 1000);
        assert.equal(calc10.netRestaurantSettlementMinor, 9000);

        // Add Category rule (12% = 1200 bps) -> beats global default
        await comm.createRule(admin, {
          name: 'Local Ghanaian Cuisine 12%',
          category: 'restaurant_category',
          scopeType: 'cuisine_category',
          scopeId: 'local_ghanaian',
          rateBps: 1200,
          reason: 'Category rate for local Ghanaian'
        });
        const catRes = await comm.resolveRestaurantCommission({ restaurantId: restAId });
        assert.equal(catRes.rateBps, 1200);
        assert.equal(catRes.source, 'restaurant_category');

        // Add Partner Tier rule (9% = 900 bps) -> beats category
        await comm.createRule(admin, {
          name: 'Standard Tier 9%',
          category: 'restaurant_tier',
          scopeType: 'tier',
          scopeId: 'standard',
          rateBps: 900,
          reason: 'Tier rate for standard partners'
        });
        const tierRes = await comm.resolveRestaurantCommission({ restaurantId: restAId });
        assert.equal(tierRes.rateBps, 900);
        assert.equal(tierRes.source, 'restaurant_tier');

        // Add Introductory rate (5% = 500 bps, limit 2 orders) -> beats tier
        await comm.setRestaurantAgreement(admin, restAId, {
          category: 'restaurant_introductory',
          rateBps: 500,
          maxOrders: 2,
          reason: 'Onboarding intro rate for first 2 orders'
        });
        const introRes = await comm.resolveRestaurantCommission({ restaurantId: restAId });
        assert.equal(introRes.rateBps, 500);
        assert.equal(introRes.source, 'restaurant_introductory');

        // Add Custom Contract Agreement (8% = 800 bps) -> highest precedence
        await comm.setRestaurantAgreement(admin, restAId, {
          category: 'restaurant_contract',
          rateBps: 800,
          calculationBasis: 'gross_subtotal',
          merchantTier: 'gold',
          reason: 'Enterprise 8% contract agreement'
        });
        const contractRes = await comm.resolveRestaurantCommission({ restaurantId: restAId });
        assert.equal(contractRes.rateBps, 800);
        assert.equal(contractRes.source, 'restaurant_contract');

        // Campaign concession (e.g. 600 bps during joint campaign) reduces 800 -> 600 bps
        const withConcession = await comm.resolveRestaurantCommission({
          restaurantId: restAId,
          campaignConcessionBps: 600
        });
        assert.equal(withConcession.rateBps, 600);
        assert.equal(withConcession.source, 'campaign_concession');
      })
    );

    await t.test('2. Commission calculation basis (gross_subtotal vs net_after_restaurant_discount vs net_after_all_discounts)', () =>
      fixture(async () => {
        // GH₵ 100.00 subtotal (10000), GH₵ 15.00 restaurant discount (1500), GH₵ 5.00 ELESEND discount (500), 10% commission (1000 bps)
        const gross = computeRestaurantCommissionBreakdown({
          subtotalMinor: 10000,
          restaurantFoodDiscountMinor: 1500,
          elesendFoodDiscountMinor: 500,
          rateBps: 1000,
          calculationBasis: 'gross_subtotal'
        });
        assert.equal(gross.commissionBaseMinor, 10000);
        assert.equal(gross.commissionMinor, 1000); // 10% of 100.00 = 10.00
        assert.equal(gross.netRestaurantSettlementMinor, 7500); // 100.00 - 15.00 (rest discount) - 10.00 (comm) = 75.00

        const netRest = computeRestaurantCommissionBreakdown({
          subtotalMinor: 10000,
          restaurantFoodDiscountMinor: 1500,
          elesendFoodDiscountMinor: 500,
          rateBps: 1000,
          calculationBasis: 'net_after_restaurant_discount'
        });
        assert.equal(netRest.commissionBaseMinor, 8500);
        assert.equal(netRest.commissionMinor, 850); // 10% of 85.00 = 8.50
        assert.equal(netRest.netRestaurantSettlementMinor, 7650); // 100.00 - 15.00 - 8.50 = 76.50

        const netAll = computeRestaurantCommissionBreakdown({
          subtotalMinor: 10000,
          restaurantFoodDiscountMinor: 1500,
          elesendFoodDiscountMinor: 500,
          rateBps: 1000,
          calculationBasis: 'net_after_all_discounts'
        });
        assert.equal(netAll.commissionBaseMinor, 8000);
        assert.equal(netAll.commissionMinor, 800); // 10% of 80.00 = 8.00
        assert.equal(netAll.netRestaurantSettlementMinor, 7700); // 100.00 - 15.00 - 8.00 = 77.00
      })
    );

    await t.test('3. ELESEND-funded 20% promotion: customer pays less, restaurant receives full 90% payout, platform absorbs subsidy', () =>
      fixture(async ({ c, admin, customer, restAId, itemA1, promo, food, payOrder }) => {
        await promo.createAdminCampaign(admin, {
          code: 'ELE20',
          name: 'ELESEND 20% Off Food',
          ownerType: 'elesend',
          fundingType: 'elesend_100',
          targetType: 'food_subtotal',
          discountType: 'percentage',
          discountBps: 2000 // 20%
        });

        const input = {
          restaurantId: restAId,
          items: [{ itemId: itemA1, quantity: 1, options: [] }],
          deliveryAddress: 'Cantonments',
          deliveryLatitude: 5.58,
          deliveryLongitude: -0.17,
          customerPhone: '0241234567',
          promoCode: 'ELE20'
        };

        const quote = await food.quoteFoodOrder(customer, input);
        assert.equal(quote.subtotalMinor, 10000); // GH₵ 100.00
        assert.equal(quote.foodDiscountMinor, 2000); // GH₵ 20.00 discount
        assert.equal(quote.elesendFoodDiscountMinor, 2000); // 100% funded by ELESEND
        assert.equal(quote.restaurantFoodDiscountMinor, 0);
        assert.equal(quote.foodCommissionMinor, 1000); // 10% of 100.00 = GH₵ 10.00
        assert.equal(quote.netRestaurantSettlementMinor, 9000); // Restaurant still gets full GH₵ 90.00!
        assert.equal(quote.totalMinor, 8000 + 1200); // Customer pays GH₵ 80.00 food + GH₵ 12.00 delivery = GH₵ 92.00

        const order = await food.createFoodOrder(customer, input, { paymentMethod: 'MOMO', idempotencyKey: randomUUID() });
        assert.equal(Number(order.total_minor), 9200);
        assert.equal(Number(order.net_restaurant_settlement_minor), 9000);

        await payOrder(order);
        const shipment = (await c.query('SELECT * FROM shipments WHERE id = $1', [order.shipment_id])).rows[0];
        await digitalDeliveryCompleted(c, shipment);

        const lines = (await c.query(
          `SELECT account,
                  sum(CASE WHEN side = 'credit' THEN amount_minor ELSE -amount_minor END)::bigint AS net
             FROM checkout_accounting_lines l
             JOIN checkout_accounting_journals j ON j.id = l.journal_id
            WHERE j.shipment_id = $1
            GROUP BY account`,
          [shipment.id]
        )).rows;
        const accounts = Object.fromEntries(lines.map(x => [x.account, Number(x.net)]));
        assert.equal(accounts.restaurant_payable, 9000); // Full GH₵ 90.00 credited to restaurant
        assert.equal(accounts.platform_food_commission_revenue, 1000); // GH₵ 10.00 commission
        assert.equal(accounts.platform_promotion_subsidy_expense, -2000); // GH₵ 20.00 platform marketing expense debit
      })
    );

    await t.test('4. Restaurant-funded self-service promotion & strict cross-restaurant ownership protection', () =>
      fixture(async ({ c, customer, kitchenA, kitchenB, restAId, itemA1, promo, food, payOrder }) => {
        // Restaurant A creates a 15% self-funded promotion
        const campA = await promo.createRestaurantCampaign(kitchenA, restAId, {
          code: 'OSUJ15',
          name: '15% Off Osu Jollof',
          targetType: 'food_subtotal',
          discountType: 'percentage',
          discountBps: 1500
        });
        assert.equal(campA.funding_type, 'restaurant_100');
        assert.equal(campA.restaurant_funding_bps, 10000);

        // Restaurant B cannot pause or modify Restaurant A's promotion
        await assert.rejects(
          promo.setCampaignStatus(kitchenB, campA.id, { status: 'paused', rationale: 'Sabotage attempt' }),
          /Only the restaurant owner|permission|access/i
        );

        // Preview financial impact for Restaurant A on GH₵ 100.00 basket
        const preview = await promo.previewCampaignFinancialImpact(kitchenA, restAId, {
          sampleFoodSubtotalMinor: 10000,
          sampleDeliveryFeeMinor: 1200,
          targetType: 'food_subtotal',
          discountType: 'percentage',
          discountBps: 1500,
          fundingType: 'restaurant_100'
        });
        assert.equal(preview.withPromotion.totalDiscountMinor, 1500);
        assert.equal(preview.withPromotion.restaurantFundedDiscountMinor, 1500);
        assert.equal(preview.withPromotion.commissionMinor, 1000); // 10% on gross_subtotal (10000)
        assert.equal(preview.withPromotion.netRestaurantSettlementMinor, 7500); // 10000 - 1500 - 1000 = 7500

        // Customer places order at Restaurant A using OSUJ15
        const input = {
          restaurantId: restAId,
          items: [{ itemId: itemA1, quantity: 1, options: [] }],
          deliveryAddress: 'Labone',
          deliveryLatitude: 5.57,
          deliveryLongitude: -0.17,
          customerPhone: '0241234567',
          promoCode: 'OSUJ15'
        };
        const order = await food.createFoodOrder(customer, input, { paymentMethod: 'MOMO', idempotencyKey: randomUUID() });
        assert.equal(Number(order.food_discount_minor), 1500);
        assert.equal(Number(order.restaurant_food_discount_minor), 1500);
        assert.equal(Number(order.elesend_food_discount_minor), 0);
        assert.equal(Number(order.net_restaurant_settlement_minor), 7500);
        assert.equal(Number(order.total_minor), 8500 + 1200);

        await payOrder(order);
        const shipment = (await c.query('SELECT * FROM shipments WHERE id = $1', [order.shipment_id])).rows[0];
        await digitalDeliveryCompleted(c, shipment);

        const lines = (await c.query(
          `SELECT account,
                  sum(CASE WHEN side = 'credit' THEN amount_minor ELSE -amount_minor END)::bigint AS net
             FROM checkout_accounting_lines l
             JOIN checkout_accounting_journals j ON j.id = l.journal_id
            WHERE j.shipment_id = $1
            GROUP BY account`,
          [shipment.id]
        )).rows;
        const accounts = Object.fromEntries(lines.map(x => [x.account, Number(x.net)]));
        assert.equal(accounts.restaurant_payable, 7500);
        assert.equal(accounts.platform_food_commission_revenue, 1000);
      })
    );

    await t.test('5. Joint co-funded campaign requires explicit restaurant consent before activation & splits discount + commission concession', () =>
      fixture(async ({ admin, customer, kitchenA, restAId, itemA1, promo, food }) => {
        // Admin creates a Joint Campaign (20% off: 50% ELESEND / 50% Restaurant + 8% commission concession rate = 800 bps)
        const joint = await promo.createAdminCampaign(admin, {
          code: 'JOINT20',
          name: 'Accra Food Week 20% Off',
          ownerType: 'joint',
          fundingType: 'shared_percentage',
          targetType: 'food_subtotal',
          discountType: 'percentage',
          discountBps: 2000,
          elesendFundingBps: 5000,
          restaurantFundingBps: 5000,
          commissionConcessionBps: 800, // 8.00% reduced commission rate during campaign (down from 10.00%)
          invitedRestaurantIds: [restAId]
        });

        const baseInput = {
          restaurantId: restAId,
          items: [{ itemId: itemA1, quantity: 1, options: [] }],
          deliveryAddress: 'Airport Residential',
          deliveryLatitude: 5.60,
          deliveryLongitude: -0.18,
          customerPhone: '0241234567',
          promoCode: 'JOINT20'
        };

        // BEFORE restaurant accepts invitation -> JOINT20 MUST NOT apply or deduct from restaurant!
        await assert.rejects(
          food.quoteFoodOrder(customer, baseInput),
          /consent|not applicable|Invalid|not participating/i
        );

        // Restaurant A explicitly ACCEPTS the joint campaign invitation
        const consent = await promo.respondToJointCampaignInvitation(kitchenA, restAId, joint.id, {
          decision: 'accepted',
          decisionNotes: 'Agreed to 50/50 split with 8% commission concession'
        });
        assert.equal(consent.consent_status, 'accepted');

        // Now JOINT20 applies:
        // Subtotal = 10000. Total discount = 2000 (1000 ELESEND, 1000 Restaurant).
        // Commission rate = 800 bps (8% of 10000 = 800 minor).
        // Restaurant Net = 10000 - 1000 (rest share) - 800 (8% comm) = 8200 minor.
        const quote = await food.quoteFoodOrder(customer, baseInput);
        assert.equal(quote.foodDiscountMinor, 2000);
        assert.equal(quote.elesendFoodDiscountMinor, 1000);
        assert.equal(quote.restaurantFoodDiscountMinor, 1000);
        assert.equal(quote.foodCommissionRateBps, 800);
        assert.equal(quote.foodCommissionMinor, 800);
        assert.equal(quote.netRestaurantSettlementMinor, 8200);

        // Restaurant A revokes participation -> JOINT20 immediately stops applying
        await promo.respondToJointCampaignInvitation(kitchenA, restAId, joint.id, {
          decision: 'revoked',
          decisionNotes: 'Ending participation'
        });
        await assert.rejects(
          food.quoteFoodOrder(customer, baseInput),
          /consent|not applicable|Invalid|not participating/i
        );
      })
    );

    await t.test('6. Delivery-fee promotion NEVER reduces courier rider earnings', () =>
      fixture(async ({ c, admin, customer, rider, restAId, itemA1, promo, food, payOrder }) => {
        await promo.createAdminCampaign(admin, {
          code: 'FREEDEL',
          name: 'Free Delivery Promo',
          ownerType: 'elesend',
          fundingType: 'elesend_100',
          targetType: 'delivery_fee',
          discountType: 'free_delivery'
        });

        const input = {
          restaurantId: restAId,
          items: [{ itemId: itemA1, quantity: 1, options: [] }],
          deliveryAddress: 'Dzorwulu',
          deliveryLatitude: 5.61,
          deliveryLongitude: -0.19,
          customerPhone: '0241234567',
          promoCode: 'FREEDEL'
        };

        const order = await food.createFoodOrder(customer, input, { paymentMethod: 'MOMO', idempotencyKey: randomUUID() });
        // Delivery fee is 1200 minor, discount is 1200 minor, customer pays 10000 food + 0 delivery = 10000 minor
        assert.equal(Number(order.delivery_fee_minor), 1200);
        assert.equal(Number(order.delivery_discount_minor), 1200);
        assert.equal(Number(order.customer_delivery_payable_minor), 0);
        assert.equal(Number(order.total_minor), 10000);

        await payOrder(order);
        await c.query('UPDATE shipments SET rider_id = $2 WHERE id = $1', [order.shipment_id, rider.id]);
        const shipment = (await c.query('SELECT * FROM shipments WHERE id = $1', [order.shipment_id])).rows[0];

        // Shipment contracted fare is still 1200 minor, commission 13% = 156 minor, rider net = 1044 minor
        assert.equal(Number(shipment.amount_minor), 1200);
        assert.equal(Number(shipment.commission_minor), 156);

        await digitalDeliveryCompleted(c, shipment);

        const lines = (await c.query(
          `SELECT account,
                  sum(CASE WHEN side = 'credit' THEN amount_minor ELSE -amount_minor END)::bigint AS net
             FROM checkout_accounting_lines l
             JOIN checkout_accounting_journals j ON j.id = l.journal_id
            WHERE j.shipment_id = $1
            GROUP BY account`,
          [shipment.id]
        )).rows;
        const accounts = Object.fromEntries(lines.map(x => [x.account, Number(x.net)]));
        // Rider gets full 1200 - 156 = 1044 minor!
        assert.equal(accounts.rider_payable, 1044);
        assert.equal(accounts.platform_commission_revenue, 156);
        assert.equal(accounts.platform_promotion_subsidy_expense, -1200);
      })
    );

    await t.test('7. Budget exhaustion, per-user limit, and automatic budget release on order cancellation', () =>
      fixture(async ({ admin, customer, customer2, restAId, itemA1, promo, food }) => {
        // Create promo with GH₵ 10.00 flat discount, total budget GH₵ 10.00 (1000 minor), max 1 redemption total
        await promo.createAdminCampaign(admin, {
          code: 'LIMITED10',
          name: 'Limited GH₵ 10 Off',
          ownerType: 'elesend',
          fundingType: 'elesend_100',
          targetType: 'food_subtotal',
          discountType: 'fixed',
          discountMinor: 1000,
          totalBudgetMinor: 1000,
          totalRedemptionLimit: 1,
          perCustomerLimit: 1
        });

        const makeInput = () => ({
          restaurantId: restAId,
          items: [{ itemId: itemA1, quantity: 1, options: [] }],
          deliveryAddress: 'Adabraka',
          deliveryLatitude: 5.56,
          deliveryLongitude: -0.20,
          customerPhone: '0241234567',
          promoCode: 'LIMITED10'
        });

        // Customer 1 creates order -> reserves the 1000 minor budget & 1 redemption
        const order1 = await food.createFoodOrder(customer, makeInput(), { paymentMethod: 'MOMO', idempotencyKey: randomUUID() });
        assert.equal(Number(order1.food_discount_minor), 1000);

        // Customer 2 tries to use LIMITED10 -> rejected because budget/redemption cap is reached!
        await assert.rejects(
          food.createFoodOrder(customer2, makeInput(), { paymentMethod: 'MOMO', idempotencyKey: randomUUID() }),
          /redemption|budget|not applicable|limit/i
        );

        // Customer 1 cancels unpaid order -> reservation is released!
        await food.cancelOrder(customer, order1.id);

        // Now Customer 2 can redeem LIMITED10!
        const order2 = await food.createFoodOrder(customer2, makeInput(), { paymentMethod: 'MOMO', idempotencyKey: randomUUID() });
        assert.equal(Number(order2.food_discount_minor), 1000);
      })
    );
  } finally {
    await root.close();
  }
});
