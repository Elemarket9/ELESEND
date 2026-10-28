import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check} from './security.mjs';

const id = () => randomUUID();
const uuid = z.string().uuid();

export const CommissionCategoryEnum = z.enum([
  'delivery_default',
  'delivery_vehicle',
  'vehicle_tariff',
  'rider_delivery',
  'merchant_delivery',
  'corporate_delivery',
  'founding_rider',
  'rider_incentive',
  'rider_tier',
  'restaurant_default',
  'restaurant_food',
  'restaurant_contract',
  'restaurant_override',
  'restaurant_tier',
  'restaurant_category',
  'restaurant_introductory',
  'restaurant_time_limited',
  'restaurant_campaign',
  'promotional_campaign',
  'special_agreement'
]);

export const CommissionScopeTypeEnum = z.enum([
  'global',
  'vehicle',
  'rider',
  'merchant',
  'restaurant',
  'tier',
  'cuisine_category',
  'campaign'
]);

export const CommissionCalculationBasisEnum = z.enum([
  'gross_subtotal',
  'net_after_restaurant_discount',
  'net_after_all_discounts'
]);

const createRuleSchema = z.object({
  name: z.string().min(2).max(120),
  category: CommissionCategoryEnum,
  scopeType: CommissionScopeTypeEnum,
  scopeId: z.string().max(100).nullable().optional(),
  rateBps: z.number().int().min(0).max(10000), // 0.00% to 100.00%
  calculationBasis: CommissionCalculationBasisEnum.optional(),
  priority: z.number().int().min(1).max(1000).optional(),
  contractReference: z.string().max(120).nullable().optional(),
  effectiveFrom: z.string().datetime().optional(),
  effectiveUntil: z.string().datetime().nullable().optional(),
  maxOrders: z.number().int().min(1).max(1000000).nullable().optional(),
  reason: z.string().min(5).max(500),
  confirmHighRate: z.boolean().optional(),
  highRateRationale: z.string().min(10).max(500).optional()
}).strict();

export function calculateCommissionBreakdown(amountMinor, rateBps) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error('Invalid amountMinor');
  }
  if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
    throw new Error('Invalid rateBps: must be between 0 and 10000');
  }

  const charge = BigInt(amountMinor);
  const bps = BigInt(rateBps);
  const commission = bps === 0n ? 0n : (charge * bps + 5000n) / 10000n;
  const cappedCommission = commission > charge ? charge : commission;
  const netEarnings = charge - cappedCommission;

  return {
    amountMinor: Number(charge),
    commissionMinor: Number(cappedCommission),
    netEarningsMinor: Number(netEarnings),
    rateBps
  };
}

/**
 * Computes restaurant food commission and net settlement with explicit calculation basis
 * and strict separation between restaurant-funded and ELESEND-funded discounts.
 *
 * Key Accounting Invariant:
 * - ELESEND-funded discounts NEVER reduce the restaurant's gross food revenue or payout.
 * - Restaurant-funded discounts reduce the restaurant's payout.
 * - Commission base depends on the agreed calculationBasis:
 *   - 'gross_subtotal': commission is calculated on original gross food subtotal.
 *   - 'net_after_restaurant_discount': commission is calculated on (subtotal - restaurantFoodDiscount).
 *   - 'net_after_all_discounts': commission is calculated on (subtotal - restaurantFoodDiscount - elesendFoodDiscount).
 */
export function computeRestaurantCommissionBreakdown({
  subtotalMinor,
  restaurantFoodDiscountMinor = 0,
  elesendFoodDiscountMinor = 0,
  restaurantDeliveryDiscountMinor = 0,
  rateBps = 1000,
  calculationBasis = 'net_after_restaurant_discount'
}) {
  if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor < 0) {
    throw new Error('Invalid subtotalMinor');
  }
  if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
    throw new Error('Invalid rateBps');
  }
  const restFoodDisc = Math.max(0, Math.min(subtotalMinor, Math.trunc(restaurantFoodDiscountMinor || 0)));
  const elesendFoodDisc = Math.max(0, Math.min(subtotalMinor - restFoodDisc, Math.trunc(elesendFoodDiscountMinor || 0)));
  const restDelivDisc = Math.max(0, Math.trunc(restaurantDeliveryDiscountMinor || 0));

  let commissionBaseMinor = subtotalMinor;
  if (calculationBasis === 'net_after_restaurant_discount') {
    commissionBaseMinor = Math.max(0, subtotalMinor - restFoodDisc);
  } else if (calculationBasis === 'net_after_all_discounts') {
    commissionBaseMinor = Math.max(0, subtotalMinor - restFoodDisc - elesendFoodDisc);
  }

  const baseBig = BigInt(commissionBaseMinor);
  const bpsBig = BigInt(rateBps);
  const rawComm = bpsBig === 0n ? 0n : (baseBig * bpsBig) / 10000n;
  const maxPossibleComm = BigInt(Math.max(0, subtotalMinor - restFoodDisc - restDelivDisc));
  const cappedComm = rawComm > maxPossibleComm ? maxPossibleComm : rawComm;
  const commissionMinor = Number(cappedComm);
  const totalRestaurantFundedDiscountMinor = restFoodDisc + restDelivDisc;
  const netRestaurantSettlementMinor = Math.max(0, subtotalMinor - totalRestaurantFundedDiscountMinor - commissionMinor);

  return {
    subtotalMinor,
    restaurantFoodDiscountMinor: restFoodDisc,
    elesendFoodDiscountMinor: elesendFoodDisc,
    restaurantDeliveryDiscountMinor: restDelivDisc,
    totalRestaurantFundedDiscountMinor,
    calculationBasis,
    commissionBaseMinor,
    rateBps,
    commissionMinor,
    netRestaurantSettlementMinor
  };
}

export function commissionEngine(db) {
  async function requireAdminPermission(c, actor, permissions) {
    check(actor?.kind === 'admin', 403, 'Administrator access required');
    const list = Array.isArray(permissions) ? permissions : [permissions];
    const has = (await c.query(
      'SELECT 1 FROM permissions WHERE user_id = $1 AND permission = ANY($2::text[])',
      [actor.id, list]
    )).rowCount;
    check(has, 403, 'Commission configuration permission required');
  }

  async function loadGlobalRestaurantSettings(c = db) {
    const row = (await c.query('SELECT * FROM restaurant_commission_settings WHERE id = true')).rows[0];
    return row || {
      default_rate_bps: 1000,
      min_permitted_rate_bps: 0,
      max_permitted_rate_bps: 3000,
      approval_threshold_bps: 2000,
      default_calculation_basis: 'net_after_restaurant_discount'
    };
  }

  return {
    async getRestaurantCommissionSettings(actor) {
      await requireAdminPermission(db, actor, ['finance:read', 'finance:approve', 'finance:configure', 'pricing:write']);
      const row = await loadGlobalRestaurantSettings(db);
      return {
        defaultRateBps: row.default_rate_bps,
        defaultRatePercent: (row.default_rate_bps / 100).toFixed(2) + '%',
        minPermittedRateBps: row.min_permitted_rate_bps,
        maxPermittedRateBps: row.max_permitted_rate_bps,
        approvalThresholdBps: row.approval_threshold_bps,
        defaultCalculationBasis: row.default_calculation_basis,
        updatedBy: row.updated_by || null,
        updatedAt: row.updated_at || null
      };
    },

    async updateRestaurantCommissionSettings(actor, input) {
      await requireAdminPermission(db, actor, ['finance:configure', 'pricing:write']);
      const schema = z.object({
        defaultRateBps: z.number().int().min(0).max(10000).optional(),
        minPermittedRateBps: z.number().int().min(0).max(10000).optional(),
        maxPermittedRateBps: z.number().int().min(0).max(10000).optional(),
        approvalThresholdBps: z.number().int().min(0).max(10000).optional(),
        defaultCalculationBasis: CommissionCalculationBasisEnum.optional(),
        rationale: z.string().min(5).max(500)
      }).strict();
      const v = schema.parse(input);

      return db.tx(async c => {
        const current = await loadGlobalRestaurantSettings(c);
        const nextDefault = v.defaultRateBps ?? current.default_rate_bps;
        const nextMin = v.minPermittedRateBps ?? current.min_permitted_rate_bps;
        const nextMax = v.maxPermittedRateBps ?? current.max_permitted_rate_bps;
        const nextThreshold = v.approvalThresholdBps ?? current.approval_threshold_bps;
        const nextBasis = v.defaultCalculationBasis ?? current.default_calculation_basis;

        check(nextMin <= nextMax, 400, 'Minimum permitted rate cannot exceed maximum permitted rate');
        check(
          nextDefault >= nextMin && nextDefault <= nextMax,
          400,
          `Default restaurant commission rate (${nextDefault} bps) must be within permitted bounds [${nextMin}, ${nextMax}] bps`
        );

        await c.query(
          `INSERT INTO restaurant_commission_settings (
             id, default_rate_bps, min_permitted_rate_bps, max_permitted_rate_bps,
             approval_threshold_bps, default_calculation_basis, updated_by, updated_at
           ) VALUES (true, $1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (id) DO UPDATE SET
             default_rate_bps = EXCLUDED.default_rate_bps,
             min_permitted_rate_bps = EXCLUDED.min_permitted_rate_bps,
             max_permitted_rate_bps = EXCLUDED.max_permitted_rate_bps,
             approval_threshold_bps = EXCLUDED.approval_threshold_bps,
             default_calculation_basis = EXCLUDED.default_calculation_basis,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
          [nextDefault, nextMin, nextMax, nextThreshold, nextBasis, actor.id]
        );

        await c.query(
          `INSERT INTO commission_audit_logs (
             id, rule_id, action, actor_id, previous_rate_bps, new_rate_bps, rationale, metadata
           ) VALUES ($1, NULL, 'updated', $2, $3, $4, $5, $6)`,
          [
            id(),
            actor.id,
            current.default_rate_bps,
            nextDefault,
            v.rationale,
            JSON.stringify({
              type: 'restaurant_commission_settings',
              minPermittedRateBps: nextMin,
              maxPermittedRateBps: nextMax,
              approvalThresholdBps: nextThreshold,
              defaultCalculationBasis: nextBasis
            })
          ]
        );

        return {
          defaultRateBps: nextDefault,
          minPermittedRateBps: nextMin,
          maxPermittedRateBps: nextMax,
          approvalThresholdBps: nextThreshold,
          defaultCalculationBasis: nextBasis
        };
      });
    },

    /**
     * Deterministically resolves the effective restaurant commission policy:
     * Precedence hierarchy:
     * 1. Active signed restaurant-specific commercial agreement ('restaurant_contract')
     * 2. Explicit active restaurant-specific override / introductory / time-limited rule
     *    ('restaurant_override', 'restaurant_introductory', 'restaurant_time_limited', 'restaurant_food')
     * 3. Explicit custom rate on the restaurant record (when custom_commission_override = true or food_commission_bps != 1000)
     * 4. Eligible negotiated merchant group or tier ('restaurant_tier')
     * 5. Eligible category/cuisine rule ('restaurant_category')
     * 6. Active global restaurant commission rule ('restaurant_default') or global restaurant_commission_settings
     *
     * Plus campaign-specific commission concessions:
     * - If an approved campaign concession is present (campaignConcessionBps), it applies ONLY if it is lower than or equal to
     *   the resolved rate (protecting the merchant from any campaign silently raising their contractual commission).
     */
    async resolveRestaurantCommission({
      restaurantId,
      cuisineCategory = null,
      campaignConcessionBps = null,
      campaignBasisOverride = null,
      at = new Date()
    } = {}, clientOrDb = db) {
      const c = clientOrDb || db;
      const settings = await loadGlobalRestaurantSettings(c);
      const now = at instanceof Date ? at : new Date(at);

      let restRow = null;
      if (restaurantId) {
        restRow = (await c.query(
          'SELECT id, name, food_commission_bps, merchant_tier, cuisine_category, commission_calculation_basis, custom_commission_override FROM restaurants WHERE id = $1',
          [restaurantId]
        )).rows[0] || null;
      }

      const tier = restRow?.merchant_tier || 'standard';
      const categoryKey = cuisineCategory || restRow?.cuisine_category || null;

      let resolved = null;

      // 1 & 2. Restaurant-scoped active rules (contract > override > introductory > time_limited > food)
      if (restaurantId) {
        const restRules = (await c.query(
          `SELECT * FROM commission_rules
           WHERE status = 'active'
             AND scope_type = 'restaurant'
             AND scope_id = $1
             AND effective_from <= $2
             AND (effective_until IS NULL OR effective_until > $2)
             AND (max_orders IS NULL OR applied_orders < max_orders)
           ORDER BY
             CASE category
               WHEN 'restaurant_contract' THEN 1
               WHEN 'special_agreement' THEN 2
               WHEN 'restaurant_override' THEN 3
               WHEN 'restaurant_introductory' THEN 4
               WHEN 'restaurant_time_limited' THEN 5
               WHEN 'restaurant_food' THEN 6
               ELSE 7
             END ASC,
             priority ASC,
             created_at DESC
           LIMIT 1`,
          [restaurantId, now]
        )).rows;

        if (restRules.length > 0) {
          const rule = restRules[0];
          resolved = {
            rateBps: rule.rate_bps,
            ruleId: rule.id,
            source: rule.category,
            reason: rule.reason,
            contractReference: rule.contract_reference || null,
            calculationBasis: rule.calculation_basis || restRow?.commission_calculation_basis || settings.default_calculation_basis
          };
        }
      }

      // 3. Explicit custom rate configured directly on the restaurant record
      if (!resolved && restRow && restRow.custom_commission_override) {
        resolved = {
          rateBps: restRow.food_commission_bps,
          ruleId: null,
          source: 'restaurant_contract',
          reason: 'Restaurant contractual commission',
          contractReference: null,
          calculationBasis: restRow.commission_calculation_basis || settings.default_calculation_basis
        };
      }

      // 4. Merchant tier/group rule
      if (!resolved && tier) {
        const tierRules = (await c.query(
          `SELECT * FROM commission_rules
           WHERE status = 'active'
             AND scope_type = 'tier'
             AND lower(scope_id) = lower($1)
             AND category = 'restaurant_tier'
             AND effective_from <= $2
             AND (effective_until IS NULL OR effective_until > $2)
             AND (max_orders IS NULL OR applied_orders < max_orders)
           ORDER BY priority ASC, created_at DESC
           LIMIT 1`,
          [tier, now]
        )).rows;
        if (tierRules.length > 0) {
          const rule = tierRules[0];
          resolved = {
            rateBps: rule.rate_bps,
            ruleId: rule.id,
            source: 'restaurant_tier',
            reason: rule.reason,
            contractReference: rule.contract_reference || null,
            calculationBasis: rule.calculation_basis || restRow?.commission_calculation_basis || settings.default_calculation_basis
          };
        }
      }

      // 5. Cuisine / menu category commission rule
      if (!resolved && categoryKey) {
        const catRules = (await c.query(
          `SELECT * FROM commission_rules
           WHERE status = 'active'
             AND scope_type = 'cuisine_category'
             AND lower(scope_id) = lower($1)
             AND category = 'restaurant_category'
             AND effective_from <= $2
             AND (effective_until IS NULL OR effective_until > $2)
             AND (max_orders IS NULL OR applied_orders < max_orders)
           ORDER BY priority ASC, created_at DESC
           LIMIT 1`,
          [categoryKey, now]
        )).rows;
        if (catRules.length > 0) {
          const rule = catRules[0];
          resolved = {
            rateBps: rule.rate_bps,
            ruleId: rule.id,
            source: 'restaurant_category',
            reason: rule.reason,
            contractReference: rule.contract_reference || null,
            calculationBasis: rule.calculation_basis || restRow?.commission_calculation_basis || settings.default_calculation_basis
          };
        }
      }

      // 6. Active global restaurant commission rule or global settings default
      if (!resolved) {
        const globalRules = (await c.query(
          `SELECT * FROM commission_rules
           WHERE status = 'active'
             AND (
               (scope_type = 'global' AND category = 'restaurant_default')
               OR (scope_type = 'campaign' AND category = 'promotional_campaign')
             )
             AND effective_from <= $1
             AND (effective_until IS NULL OR effective_until > $1)
             AND (max_orders IS NULL OR applied_orders < max_orders)
           ORDER BY
             CASE category WHEN 'promotional_campaign' THEN 1 ELSE 2 END ASC,
             priority ASC,
             created_at DESC
           LIMIT 1`,
          [now]
        )).rows;

        if (globalRules.length > 0) {
          const rule = globalRules[0];
          resolved = {
            rateBps: rule.rate_bps,
            ruleId: rule.id,
            source: rule.category,
            reason: rule.reason,
            contractReference: rule.contract_reference || null,
            calculationBasis: rule.calculation_basis || restRow?.commission_calculation_basis || settings.default_calculation_basis
          };
        } else {
          const fallbackRate = Number.isInteger(settings.default_rate_bps)
            ? settings.default_rate_bps
            : (restRow && Number.isInteger(restRow.food_commission_bps) ? restRow.food_commission_bps : 1000);
          resolved = {
            rateBps: fallbackRate,
            ruleId: null,
            source: 'restaurant_default',
            reason: 'ELESEND default restaurant commerce commission',
            contractReference: null,
            calculationBasis: restRow?.commission_calculation_basis || settings.default_calculation_basis
          };
        }
      }

      // Apply campaign commission concession if advantageous (never increases contractual rate)
      const standardRateBps = resolved.rateBps;
      let concessionApplied = false;
      if (Number.isInteger(campaignConcessionBps) && campaignConcessionBps >= 0 && campaignConcessionBps < resolved.rateBps) {
        resolved = {
          ...resolved,
          standardRateBps,
          rateBps: campaignConcessionBps,
          source: 'campaign_concession',
          reason: `Campaign commission concession (${(campaignConcessionBps / 100).toFixed(2)}% vs standard ${(standardRateBps / 100).toFixed(2)}%)`,
          concessionApplied: true
        };
        concessionApplied = true;
      }

      if (campaignBasisOverride && ['gross_subtotal', 'net_after_restaurant_discount', 'net_after_all_discounts'].includes(campaignBasisOverride)) {
        resolved.calculationBasis = campaignBasisOverride;
      }

      return {
        ...resolved,
        standardRateBps,
        concessionApplied,
        evaluatedAt: now.toISOString()
      };
    },

    /**
     * Resolves commission rate adhering to the deterministic hierarchy:
     * 1. Active Founding Rider / Promotional Campaign
     * 2. Partner Agreement (Rider, Merchant, Restaurant specific)
     * 3. Vehicle Tariff (Motorcycle, Car, Van)
     * 4. Active Pricing Policy / Default Rule
     * 5. Built-in defaults: Delivery = 1300 bps (13%), Restaurant = 1000 bps (10%)
     *
     * Crucial: Zero (0 bps) is an explicit valid rate and is NEVER overridden by defaults.
     */
    async resolveCommissionRate({ category, actorId, restaurantId, vehicle, isFood = false, cuisineCategory = null, campaignConcessionBps = null, campaignBasisOverride = null } = {}) {
      const now = new Date();

      // 1. Check rider-specific founding rider or promotional rule (only for non-food delivery or when actorId is rider/merchant)
      if (actorId && !isFood) {
        const userRules = (await db.query(
          `SELECT * FROM commission_rules 
           WHERE status = 'active'
             AND (
               (scope_type IN ('rider', 'merchant') AND scope_id = $1)
               OR (scope_type = 'campaign' AND category = 'promotional_campaign')
             )
             AND effective_from <= $2
             AND (effective_until IS NULL OR effective_until > $2)
             AND (max_orders IS NULL OR applied_orders < max_orders)
           ORDER BY 
             CASE category 
               WHEN 'founding_rider' THEN 1 
               WHEN 'promotional_campaign' THEN 2 
               WHEN 'rider_delivery' THEN 3 
               WHEN 'merchant_delivery' THEN 4 
               ELSE 5 
             END ASC,
             created_at DESC
           LIMIT 1`,
          [actorId, now]
        )).rows;

        if (userRules.length > 0) {
          const rule = userRules[0];
          return {
            rateBps: rule.rate_bps,
            ruleId: rule.id,
            source: rule.category,
            reason: rule.reason
          };
        }
      }

      // 2. Check restaurant-specific food commission hierarchy
      if (isFood) {
        return this.resolveRestaurantCommission({
          restaurantId,
          cuisineCategory,
          campaignConcessionBps,
          campaignBasisOverride,
          at: now
        });
      }

      // 3. Check vehicle tariff policy (for delivery)
      if (!isFood && vehicle) {
        const vehiclePolicy = (await db.query(
          'SELECT id, commission_bps FROM pricing_policies WHERE active = true AND vehicle = $1 LIMIT 1',
          [vehicle]
        )).rows[0];

        if (vehiclePolicy && Number.isInteger(vehiclePolicy.commission_bps)) {
          return {
            rateBps: vehiclePolicy.commission_bps,
            ruleId: vehiclePolicy.id,
            source: 'vehicle_tariff',
            reason: `Active pricing policy for ${vehicle}`
          };
        }
      }

      // 4. Check active global pricing policy
      if (!isFood) {
        const globalPolicy = (await db.query(
          'SELECT id, commission_bps FROM pricing_policies WHERE active = true AND vehicle IS NULL LIMIT 1'
        )).rows[0];

        if (globalPolicy && Number.isInteger(globalPolicy.commission_bps)) {
          return {
            rateBps: globalPolicy.commission_bps,
            ruleId: globalPolicy.id,
            source: 'global_pricing_policy',
            reason: 'Active global delivery pricing policy'
          };
        }
      }

      return {
        rateBps: 1300, // 13.00% default delivery commission
        ruleId: null,
        source: 'system_default_delivery',
        reason: 'ELESEND default delivery commission policy'
      };
    },

    /**
     * Configure or update a restaurant's commercial agreement & commission profile.
     */
    async setRestaurantAgreement(actor, restaurantId, input) {
      await requireAdminPermission(db, actor, ['finance:configure', 'pricing:write']);
      check(uuid.safeParse(restaurantId).success, 400, 'Valid restaurantId required');
      const schema = z.object({
        rateBps: z.number().int().min(0).max(10000),
        merchantTier: z.string().trim().min(2).max(50).optional(),
        cuisineCategory: z.string().trim().min(2).max(60).nullable().optional(),
        calculationBasis: CommissionCalculationBasisEnum.optional(),
        category: z.enum([
          'restaurant_contract',
          'restaurant_override',
          'restaurant_introductory',
          'restaurant_time_limited'
        ]).default('restaurant_contract'),
        contractReference: z.string().trim().max(120).nullable().optional(),
        effectiveFrom: z.string().datetime().optional(),
        effectiveUntil: z.string().datetime().nullable().optional(),
        maxOrders: z.number().int().min(1).max(1000000).nullable().optional(),
        reason: z.string().trim().min(5).max(500),
        confirmHighRate: z.boolean().optional(),
        highRateRationale: z.string().min(10).max(500).optional()
      }).strict();
      const v = schema.parse(input);

      return db.tx(async c => {
        const settings = await loadGlobalRestaurantSettings(c);
        check(
          v.rateBps >= settings.min_permitted_rate_bps && (v.rateBps <= settings.max_permitted_rate_bps || v.confirmHighRate),
          400,
          `Rate ${v.rateBps} bps is outside permitted bounds [${settings.min_permitted_rate_bps}, ${settings.max_permitted_rate_bps}] bps`
        );
        if (v.rateBps > settings.approval_threshold_bps && !v.confirmHighRate) {
          check(false, 400, `Commission rate above threshold (${settings.approval_threshold_bps} bps) requires confirmHighRate and highRateRationale`);
        }

        const rest = (await c.query('SELECT * FROM restaurants WHERE id = $1 FOR UPDATE', [restaurantId])).rows[0];
        check(rest, 404, 'Restaurant not found');

        const nextBasis = v.calculationBasis || rest.commission_calculation_basis || settings.default_calculation_basis;
        const nextTier = v.merchantTier || rest.merchant_tier || 'standard';
        const nextCuisine = v.cuisineCategory !== undefined ? v.cuisineCategory : rest.cuisine_category;

        await c.query(
          `UPDATE restaurants
           SET food_commission_bps = $2,
               merchant_tier = $3,
               cuisine_category = $4,
               commission_calculation_basis = $5,
               custom_commission_override = true
           WHERE id = $1`,
          [restaurantId, v.rateBps, nextTier, nextCuisine, nextBasis]
        );

        // Supersede older active rules of the same category for this restaurant
        await c.query(
          `UPDATE commission_rules
           SET status = 'revoked', updated_at = now()
           WHERE scope_type = 'restaurant' AND scope_id = $1 AND category = $2 AND status = 'active'`,
          [restaurantId, v.category]
        );

        const ruleId = id();
        await c.query(
          `INSERT INTO commission_rules (
             id, name, category, scope_type, scope_id, rate_bps, calculation_basis,
             contract_reference, effective_from, effective_until, max_orders,
             status, reason, created_by, approved_by, approved_at
           ) VALUES ($1, $2, $3, 'restaurant', $4, $5, $6, $7, COALESCE($8, now()), $9, $10, 'active', $11, $12, $12, now())`,
          [
            ruleId,
            `${rest.name} — ${v.category} (${(v.rateBps / 100).toFixed(2)}%)`,
            v.category,
            restaurantId,
            v.rateBps,
            nextBasis,
            v.contractReference || null,
            v.effectiveFrom || null,
            v.effectiveUntil || null,
            v.maxOrders || null,
            v.reason,
            actor.id
          ]
        );

        await c.query(
          `INSERT INTO commission_audit_logs (
             id, rule_id, action, actor_id, previous_rate_bps, new_rate_bps, rationale, metadata
           ) VALUES ($1, $2, 'created', $3, $4, $5, $6, $7)`,
          [
            id(),
            ruleId,
            actor.id,
            rest.food_commission_bps,
            v.rateBps,
            v.reason,
            JSON.stringify({
              restaurantId,
              restaurantName: rest.name,
              category: v.category,
              calculationBasis: nextBasis,
              merchantTier: nextTier,
              contractReference: v.contractReference || null
            })
          ]
        );

        return {
          ruleId,
          restaurantId,
          restaurantName: rest.name,
          previousRateBps: rest.food_commission_bps,
          rateBps: v.rateBps,
          ratePercent: (v.rateBps / 100).toFixed(2) + '%',
          calculationBasis: nextBasis,
          merchantTier: nextTier,
          category: v.category
        };
      });
    },

    /**
     * Preview effective commission rate and settlement math before applying changes or placing an order.
     */
    async previewRestaurantCommission(actor, input) {
      check(actor && ['admin', 'customer', 'business', 'rider'].includes(actor.kind), 401, 'Authentication required');
      const schema = z.object({
        restaurantId: z.string().uuid(),
        subtotalMinor: z.number().int().min(0).max(100000000).default(10000),
        restaurantFoodDiscountMinor: z.number().int().min(0).max(100000000).default(0),
        elesendFoodDiscountMinor: z.number().int().min(0).max(100000000).default(0),
        restaurantDeliveryDiscountMinor: z.number().int().min(0).max(100000000).default(0),
        hypotheticalRateBps: z.number().int().min(0).max(10000).optional(),
        hypotheticalBasis: CommissionCalculationBasisEnum.optional(),
        campaignConcessionBps: z.number().int().min(0).max(10000).optional()
      }).strict();
      const v = schema.parse(input);

      if (actor.kind !== 'admin') {
        const owns = (await db.query('SELECT 1 FROM restaurants WHERE id = $1 AND owner_id = $2', [v.restaurantId, actor.id])).rowCount;
        check(owns, 403, 'Restaurant owner or administrator access required');
      }

      const resolved = await this.resolveRestaurantCommission({
        restaurantId: v.restaurantId,
        campaignConcessionBps: v.campaignConcessionBps ?? null,
        campaignBasisOverride: v.hypotheticalBasis ?? null
      });

      const effectiveRateBps = v.hypotheticalRateBps ?? resolved.rateBps;
      const effectiveBasis = v.hypotheticalBasis ?? resolved.calculationBasis;

      const breakdown = computeRestaurantCommissionBreakdown({
        subtotalMinor: v.subtotalMinor,
        restaurantFoodDiscountMinor: v.restaurantFoodDiscountMinor,
        elesendFoodDiscountMinor: v.elesendFoodDiscountMinor,
        restaurantDeliveryDiscountMinor: v.restaurantDeliveryDiscountMinor,
        rateBps: effectiveRateBps,
        calculationBasis: effectiveBasis
      });

      return {
        resolvedPolicy: resolved,
        preview: {
          ...breakdown,
          ratePercent: (effectiveRateBps / 100).toFixed(2) + '%',
          customerFoodPayableMinor: Math.max(0, v.subtotalMinor - breakdown.restaurantFoodDiscountMinor - breakdown.elesendFoodDiscountMinor)
        }
      };
    },

    /**
     * Increment applied orders count for promotional or bounded rules,
     * and track forgone commission revenue in audit trail.
     */
    async recordOrderCommissionApplied(clientOrDb, ruleId, { orderAmountMinor = 0, standardRateBps = 1300, appliedRateBps = 0 } = {}) {
      if (!ruleId) return;
      const c = clientOrDb || db;
      await c.query(
        `UPDATE commission_rules 
         SET applied_orders = applied_orders + 1,
             status = CASE 
               WHEN max_orders IS NOT NULL AND applied_orders + 1 >= max_orders THEN 'expired'
               ELSE status 
             END,
             updated_at = now()
         WHERE id = $1`,
        [ruleId]
      );

      if (orderAmountMinor > 0 && standardRateBps > appliedRateBps) {
        const standardFee = (BigInt(orderAmountMinor) * BigInt(standardRateBps) + 5000n) / 10000n;
        const appliedFee = appliedRateBps === 0 ? 0n : (BigInt(orderAmountMinor) * BigInt(appliedRateBps) + 5000n) / 10000n;
        const forgoneMinor = Number(standardFee - appliedFee);
        if (forgoneMinor > 0) {
          await c.query(
            `INSERT INTO commission_audit_logs (
               id, rule_id, action, actor_id, previous_rate_bps, new_rate_bps, rationale, metadata
             ) VALUES ($1, $2, 'applied', NULL, $3, $3, $4, $5)`,
            [
              id(),
              ruleId,
              appliedRateBps,
              `Campaign discount applied: forgone commission revenue GH₵ ${(forgoneMinor / 100).toFixed(2)}`,
              JSON.stringify({ orderAmountMinor, forgoneMinor, standardRateBps, appliedRateBps })
            ]
          );
        }
      }
    },

    /**
     * Create a commission rule with guardrails against accidental extreme rates.
     */
    async createRule(actor, input) {
      await requireAdminPermission(db, actor, ['finance:configure', 'pricing:write']);
      const v = createRuleSchema.parse(input);

      const isHighRate = v.rateBps > 2000;
      if (isHighRate && !v.confirmHighRate) {
        check(
          false,
          400,
          `High commission rate (${(v.rateBps / 100).toFixed(2)}%) requires explicit confirmHighRate flag and highRateRationale`
        );
      }
      if (isHighRate && (!v.highRateRationale || v.highRateRationale.trim().length < 10)) {
        check(
          false,
          400,
          'High commission rate requires highRateRationale with at least 10 characters'
        );
      }

      const ruleId = id();
      const rationale = v.highRateRationale ? `${v.reason} | High-rate confirmation: ${v.highRateRationale}` : v.reason;

      return db.tx(async c => {
        const settings = await loadGlobalRestaurantSettings(c);
        const basis = v.calculationBasis || settings.default_calculation_basis || 'net_after_restaurant_discount';

        await c.query(
          `INSERT INTO commission_rules (
             id, name, category, scope_type, scope_id, rate_bps,
             calculation_basis, priority, contract_reference,
             effective_from, effective_until, max_orders, status, reason, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now()), $11, $12, 'active', $13, $14)`,
          [
            ruleId,
            v.name,
            v.category,
            v.scopeType,
            v.scopeId || null,
            v.rateBps,
            basis,
            v.priority ?? 100,
            v.contractReference || null,
            v.effectiveFrom || null,
            v.effectiveUntil || null,
            v.maxOrders || null,
            rationale,
            actor.id
          ]
        );

        await c.query(
          `INSERT INTO commission_audit_logs (
             id, rule_id, action, actor_id, previous_rate_bps, new_rate_bps, rationale, metadata
           ) VALUES ($1, $2, 'created', $3, NULL, $4, $5, $6)`,
          [
            id(),
            ruleId,
            actor.id,
            v.rateBps,
            rationale,
            JSON.stringify({
              category: v.category,
              scopeType: v.scopeType,
              scopeId: v.scopeId,
              calculationBasis: basis,
              maxOrders: v.maxOrders
            })
          ]
        );

        return {
          id: ruleId,
          name: v.name,
          category: v.category,
          rateBps: v.rateBps,
          calculationBasis: basis,
          ratePercent: (v.rateBps / 100).toFixed(2) + '%',
          status: 'active'
        };
      });
    },

    /**
     * Enroll a rider in the 0% Founding Rider Campaign.
     */
    async enrollFoundingRider(actor, { riderId, days = 90, maxOrders = null, rationale } = {}) {
      await requireAdminPermission(db, actor, ['finance:configure', 'pricing:write']);
      check(riderId && typeof riderId === 'string', 400, 'Rider ID required');

      const now = new Date();
      const effectiveUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const ruleName = `Founding Rider 0% — ${riderId.substring(0, 8)}`;
      const reason = rationale || (maxOrders ? `Founding Rider campaign: 0% commission for ${days} days or first ${maxOrders} orders` : `Founding Rider campaign: 0% commission for ${days} days`);

      return this.createRule(actor, {
        name: ruleName,
        category: 'founding_rider',
        scopeType: 'rider',
        scopeId: riderId,
        rateBps: 0, // 0.00%
        effectiveFrom: now.toISOString(),
        effectiveUntil: effectiveUntil.toISOString(),
        maxOrders,
        reason
      });
    },

    /**
     * Pause an active commission rule.
     */
    async pauseRule(actor, ruleId, rationale) {
      await requireAdminPermission(db, actor, ['finance:configure', 'pricing:write']);
      check(rationale && rationale.trim().length >= 5, 400, 'Rationale required (min 5 chars)');

      return db.tx(async c => {
        const rule = (await c.query(
          'SELECT * FROM commission_rules WHERE id = $1 FOR UPDATE',
          [ruleId]
        )).rows[0];
        check(rule, 404, 'Commission rule not found');
        check(rule.status === 'active', 409, `Cannot pause rule in ${rule.status} state`);

        await c.query(
          "UPDATE commission_rules SET status = 'paused', updated_at = now() WHERE id = $1",
          [ruleId]
        );

        await c.query(
          `INSERT INTO commission_audit_logs (
             id, rule_id, action, actor_id, previous_rate_bps, new_rate_bps, rationale
           ) VALUES ($1, $2, 'paused', $3, $4, $4, $5)`,
          [id(), ruleId, actor.id, rule.rate_bps, rationale]
        );

        return { id: ruleId, status: 'paused' };
      });
    },

    /**
     * Resume a paused commission rule.
     */
    async resumeRule(actor, ruleId, rationale) {
      await requireAdminPermission(db, actor, ['finance:configure', 'pricing:write']);
      check(rationale && rationale.trim().length >= 5, 400, 'Rationale required (min 5 chars)');

      return db.tx(async c => {
        const rule = (await c.query(
          'SELECT * FROM commission_rules WHERE id = $1 FOR UPDATE',
          [ruleId]
        )).rows[0];
        check(rule, 404, 'Commission rule not found');
        check(rule.status === 'paused', 409, `Cannot resume rule in ${rule.status} state`);

        await c.query(
          "UPDATE commission_rules SET status = 'active', updated_at = now() WHERE id = $1",
          [ruleId]
        );

        await c.query(
          `INSERT INTO commission_audit_logs (
             id, rule_id, action, actor_id, previous_rate_bps, new_rate_bps, rationale
           ) VALUES ($1, $2, 'resumed', $3, $4, $4, $5)`,
          [id(), ruleId, actor.id, rule.rate_bps, rationale]
        );

        return { id: ruleId, status: 'active' };
      });
    },

    /**
     * Revoke a commission rule permanently.
     */
    async revokeRule(actor, ruleId, rationale) {
      await requireAdminPermission(db, actor, ['finance:configure', 'pricing:write']);
      check(rationale && rationale.trim().length >= 5, 400, 'Rationale required (min 5 chars)');

      return db.tx(async c => {
        const rule = (await c.query(
          'SELECT * FROM commission_rules WHERE id = $1 FOR UPDATE',
          [ruleId]
        )).rows[0];
        check(rule, 404, 'Commission rule not found');
        check(rule.status !== 'revoked', 409, 'Rule is already revoked');

        await c.query(
          "UPDATE commission_rules SET status = 'revoked', updated_at = now() WHERE id = $1",
          [ruleId]
        );

        await c.query(
          `INSERT INTO commission_audit_logs (
             id, rule_id, action, actor_id, previous_rate_bps, new_rate_bps, rationale
           ) VALUES ($1, $2, 'revoked', $3, $4, $4, $5)`,
          [id(), ruleId, actor.id, rule.rate_bps, rationale]
        );

        return { id: ruleId, status: 'revoked' };
      });
    },

    /**
     * Update an existing commission rule.
     */
    async updateRule(actor, ruleId, updates) {
      await requireAdminPermission(db, actor, ['finance:configure', 'pricing:write']);
      const updateSchema = z.object({
        name: z.string().min(2).max(120).optional(),
        rateBps: z.number().int().min(0).max(10000).optional(),
        calculationBasis: CommissionCalculationBasisEnum.optional(),
        effectiveUntil: z.string().datetime().nullable().optional(),
        maxOrders: z.number().int().min(1).max(1000000).nullable().optional(),
        rationale: z.string().min(5).max(500),
        confirmHighRate: z.boolean().optional(),
        highRateRationale: z.string().min(10).max(500).optional()
      }).strict();

      const v = updateSchema.parse(updates);

      return db.tx(async c => {
        const rule = (await c.query(
          'SELECT * FROM commission_rules WHERE id = $1 FOR UPDATE',
          [ruleId]
        )).rows[0];
        check(rule, 404, 'Commission rule not found');
        check(rule.status !== 'revoked', 409, 'Cannot update a revoked rule');

        const newRate = v.rateBps !== undefined ? v.rateBps : rule.rate_bps;
        const isHighRate = newRate > 2000;
        if (isHighRate && v.rateBps !== undefined && !v.confirmHighRate) {
          check(
            false,
            400,
            `High commission rate (${(newRate / 100).toFixed(2)}%) requires explicit confirmHighRate flag and highRateRationale`
          );
        }

        const fields = [];
        const values = [];

        if (v.name !== undefined) {
          values.push(v.name);
          fields.push(`name = $${values.length}`);
        }
        if (v.rateBps !== undefined) {
          values.push(v.rateBps);
          fields.push(`rate_bps = $${values.length}`);
        }
        if (v.calculationBasis !== undefined) {
          values.push(v.calculationBasis);
          fields.push(`calculation_basis = $${values.length}`);
        }
        if (v.effectiveUntil !== undefined) {
          values.push(v.effectiveUntil);
          fields.push(`effective_until = $${values.length}`);
        }
        if (v.maxOrders !== undefined) {
          values.push(v.maxOrders);
          fields.push(`max_orders = $${values.length}`);
        }

        if (fields.length > 0) {
          values.push(ruleId);
          await c.query(
            `UPDATE commission_rules 
             SET ${fields.join(', ')}, updated_at = now() 
             WHERE id = $${values.length}`,
            values
          );
        }

        await c.query(
          `INSERT INTO commission_audit_logs (
             id, rule_id, action, actor_id, previous_rate_bps, new_rate_bps, rationale, metadata
           ) VALUES ($1, $2, 'updated', $3, $4, $5, $6, $7)`,
          [
            id(),
            ruleId,
            actor.id,
            rule.rate_bps,
            newRate,
            v.rationale,
            JSON.stringify(v)
          ]
        );

        return { id: ruleId, ...v, previousRateBps: rule.rate_bps, newRateBps: newRate };
      });
    },

    /**
     * List commission rules with optional filtering.
     */
    async listRules(actor, { category, scopeType, status } = {}) {
      await requireAdminPermission(db, actor, ['finance:read', 'finance:approve', 'finance:configure', 'pricing:write']);
      const conditions = [];
      const values = [];

      if (category) {
        values.push(category);
        conditions.push(`category = $${values.length}`);
      }
      if (scopeType) {
        values.push(scopeType);
        conditions.push(`scope_type = $${values.length}`);
      }
      if (status) {
        values.push(status);
        conditions.push(`status = $${values.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const query = `
        SELECT r.*, u.phone AS created_by_phone
        FROM commission_rules r
        LEFT JOIN users u ON u.id = r.created_by
        ${whereClause}
        ORDER BY r.created_at DESC
        LIMIT 200
      `;

      return (await db.query(query, values)).rows.map(r => ({
        ...r,
        ratePercent: (r.rate_bps / 100).toFixed(2) + '%'
      }));
    },

    /**
     * Fetch audit trail for a rule or system-wide.
     */
    async getAuditLogs(actor, ruleId) {
      await requireAdminPermission(db, actor, ['finance:read', 'finance:approve', 'finance:configure', 'pricing:write']);
      if (ruleId) {
        return (await db.query(
          `SELECT l.*, u.phone AS actor_phone 
           FROM commission_audit_logs l 
           LEFT JOIN users u ON u.id = l.actor_id 
           WHERE l.rule_id = $1 
           ORDER BY l.created_at DESC`,
          [ruleId]
        )).rows;
      }
      return (await db.query(
        `SELECT l.*, u.phone AS actor_phone 
         FROM commission_audit_logs l 
         LEFT JOIN users u ON u.id = l.actor_id 
         ORDER BY l.created_at DESC 
         LIMIT 100`
      )).rows;
    }
  };
}
