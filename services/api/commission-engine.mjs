import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check} from './security.mjs';

const id = () => randomUUID();
const uuid = z.string().uuid();

export const CommissionCategoryEnum = z.enum([
  'delivery_default',
  'restaurant_default',
  'vehicle_tariff',
  'rider_delivery',
  'merchant_delivery',
  'restaurant_food',
  'corporate_delivery',
  'promotional_campaign',
  'founding_rider'
]);

export const CommissionScopeTypeEnum = z.enum([
  'global',
  'vehicle',
  'rider',
  'merchant',
  'restaurant',
  'campaign'
]);

const createRuleSchema = z.object({
  name: z.string().min(2).max(120),
  category: CommissionCategoryEnum,
  scopeType: CommissionScopeTypeEnum,
  scopeId: z.string().max(100).nullable().optional(),
  rateBps: z.number().int().min(0).max(10000), // 0.00% to 100.00%
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
  return {
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
    async resolveCommissionRate({ category, actorId, restaurantId, vehicle, isFood = false } = {}) {
      const now = new Date();

      // 1. Check rider-specific founding rider or promotional rule
      if (actorId) {
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

      // 2. Check restaurant-specific food commission rule
      if (isFood && restaurantId) {
        const restaurantRules = (await db.query(
          `SELECT * FROM commission_rules 
           WHERE status = 'active'
             AND (
               (scope_type = 'restaurant' AND scope_id = $1)
               OR (scope_type = 'campaign' AND category = 'promotional_campaign')
             )
             AND effective_from <= $2
             AND (effective_until IS NULL OR effective_until > $2)
             AND (max_orders IS NULL OR applied_orders < max_orders)
           ORDER BY scope_type = 'restaurant' DESC, created_at DESC
           LIMIT 1`,
          [restaurantId, now]
        )).rows;

        if (restaurantRules.length > 0) {
          const rule = restaurantRules[0];
          return {
            rateBps: rule.rate_bps,
            ruleId: rule.id,
            source: rule.category,
            reason: rule.reason
          };
        }

        // Check restaurant entity table configuration
        const restRow = (await db.query(
          'SELECT food_commission_bps FROM restaurants WHERE id = $1',
          [restaurantId]
        )).rows[0];

        if (restRow && Number.isInteger(restRow.food_commission_bps)) {
          return {
            rateBps: restRow.food_commission_bps,
            ruleId: null,
            source: 'restaurant_contract',
            reason: 'Restaurant contractual commission'
          };
        }
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

      // 5. Fallback defaults
      if (isFood) {
        return {
          rateBps: 1000, // 10.00% default food commission
          ruleId: null,
          source: 'system_default_food',
          reason: 'ELESEND default restaurant commerce commission'
        };
      }

      return {
        rateBps: 1300, // 13.00% default delivery commission
        ruleId: null,
        source: 'system_default_delivery',
        reason: 'ELESEND default delivery commission policy'
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

      // Guardrail check: if rate > 20% (delivery) or > 30% (restaurant), require explicit confirmation
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
        await c.query(
          `INSERT INTO commission_rules (
             id, name, category, scope_type, scope_id, rate_bps,
             effective_from, effective_until, max_orders, status, reason, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), $8, $9, 'active', $10, $11)`,
          [
            ruleId,
            v.name,
            v.category,
            v.scopeType,
            v.scopeId || null,
            v.rateBps,
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
              maxOrders: v.maxOrders
            })
          ]
        );

        return {
          id: ruleId,
          name: v.name,
          category: v.category,
          rateBps: v.rateBps,
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
        if (v.effectiveUntil !== undefined) {
          values.push(v.effectiveUntil);
          fields.push(`effective_until = $${values.length}`);
        }
        if (v.maxOrders !== undefined) {
          values.push(v.maxOrders);
          fields.push(`max_orders = $${values.length}`);
        }

        values.push(ruleId);
        await c.query(
          `UPDATE commission_rules 
           SET ${fields.join(', ')}, updated_at = now() 
           WHERE id = $${values.length}`,
          values
        );

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
