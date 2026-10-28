import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check, limit} from './security.mjs';
import {computeRestaurantCommissionBreakdown, commissionEngine} from './commission-engine.mjs';

const id = () => randomUUID();
const uuid = z.string().uuid();

export const CampaignObjectiveEnum = z.enum([
  'first_order',
  'new_customer',
  'returning_customer',
  'weekend_special',
  'lunch_special',
  'dinner_special',
  'restaurant_launch',
  'town_campaign',
  'loyalty',
  'marketing_partnership',
  'delivery_subsidy',
  'bogo',
  'free_item',
  'general'
]);

export const CampaignTargetTypeEnum = z.enum([
  'food_subtotal',
  'menu_items',
  'menu_categories',
  'delivery_fee',
  'bogo',
  'free_item'
]);

export const CampaignDiscountTypeEnum = z.enum([
  'percentage',
  'fixed',
  'free_delivery',
  'bogo',
  'free_item'
]);

export const CampaignStackingPolicyEnum = z.enum([
  'non_stackable',
  'stack_with_delivery',
  'stack_cross_funder',
  'stackable'
]);

export const CustomerSegmentEnum = z.enum([
  'all',
  'first_order',
  'new_customer',
  'returning_customer',
  'loyalty'
]);

function normalizeCode(code) {
  if (!code || typeof code !== 'string') return null;
  const trimmed = code.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

function isScheduleMatch(campaign, now = new Date()) {
  if (Array.isArray(campaign.schedule_days) && campaign.schedule_days.length > 0) {
    const day = now.getUTCDay();
    if (!campaign.schedule_days.includes(day)) return false;
  }
  if (Number.isInteger(campaign.schedule_start_minute) && Number.isInteger(campaign.schedule_end_minute)) {
    const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (campaign.schedule_start_minute <= campaign.schedule_end_minute) {
      if (minuteOfDay < campaign.schedule_start_minute || minuteOfDay > campaign.schedule_end_minute) {
        return false;
      }
    } else {
      // Overnight window (e.g., 22:00 to 02:00)
      if (minuteOfDay < campaign.schedule_start_minute && minuteOfDay > campaign.schedule_end_minute) {
        return false;
      }
    }
  }
  return true;
}

function isTownOrRegionMatch(campaign, { restaurant, deliveryAddress }) {
  if (Array.isArray(campaign.eligible_towns) && campaign.eligible_towns.length > 0) {
    const townsLower = campaign.eligible_towns.map(t => String(t).trim().toLowerCase()).filter(Boolean);
    if (townsLower.length > 0) {
      const candidates = [
        restaurant?.city,
        restaurant?.locality,
        restaurant?.address,
        deliveryAddress
      ]
        .filter(Boolean)
        .map(s => String(s).toLowerCase());
      const matched = townsLower.some(town => candidates.some(c => c.includes(town)));
      if (!matched) return false;
    }
  }
  if (Array.isArray(campaign.eligible_regions) && campaign.eligible_regions.length > 0) {
    const regionsLower = campaign.eligible_regions.map(r => String(r).trim().toLowerCase()).filter(Boolean);
    if (regionsLower.length > 0) {
      const candidates = [
        restaurant?.region,
        restaurant?.city,
        restaurant?.address,
        deliveryAddress
      ]
        .filter(Boolean)
        .map(s => String(s).toLowerCase());
      const matched = regionsLower.some(reg => candidates.some(c => c.includes(reg)));
      if (!matched) return false;
    }
  }
  return true;
}

/**
 * Computes raw discount and funding split for a single campaign against an order context.
 */
export function calculateSingleCampaignDiscount({
  campaign,
  consentRecord = null,
  orderItems = [],
  foodSubtotalMinor = 0,
  deliveryFeeMinor = 0,
  remainingFoodSubtotalMinor = foodSubtotalMinor,
  remainingDeliveryFeeMinor = deliveryFeeMinor
}) {
  const excludedSet = new Set((campaign.excluded_item_ids || []).map(String));
  const eligibleItemSet = Array.isArray(campaign.eligible_item_ids) && campaign.eligible_item_ids.length > 0
    ? new Set(campaign.eligible_item_ids.map(String))
    : null;
  const eligibleCatSet = Array.isArray(campaign.eligible_category_ids) && campaign.eligible_category_ids.length > 0
    ? new Set(campaign.eligible_category_ids.map(String))
    : null;

  // Filter eligible items
  const qualifyingItems = orderItems.filter(it => {
    const itemId = String(it.menuItemId || it.id || '');
    const catId = String(it.categoryId || it.category_id || '');
    if (excludedSet.has(itemId)) return false;
    if (eligibleItemSet && !eligibleItemSet.has(itemId)) return false;
    if (eligibleCatSet && !eligibleCatSet.has(catId)) return false;
    return true;
  });

  const qualifyingSubtotalMinor = qualifyingItems.reduce(
    (sum, it) => sum + Number(it.lineTotalMinor ?? (Number(it.unitPriceMinor || 0) * Number(it.quantity || 1))),
    0
  );

  let rawDiscountMinor = 0;
  let isDeliveryTarget = campaign.target_type === 'delivery_fee' || campaign.discount_type === 'free_delivery';

  if (isDeliveryTarget) {
    if (remainingDeliveryFeeMinor <= 0) return null;
    if (campaign.discount_type === 'free_delivery') {
      rawDiscountMinor = remainingDeliveryFeeMinor;
    } else if (campaign.discount_type === 'percentage') {
      rawDiscountMinor = Number((BigInt(remainingDeliveryFeeMinor) * BigInt(campaign.discount_bps)) / 10000n);
    } else if (campaign.discount_type === 'fixed') {
      rawDiscountMinor = Math.min(remainingDeliveryFeeMinor, Number(campaign.discount_minor || 0));
    }
    rawDiscountMinor = Math.min(rawDiscountMinor, remainingDeliveryFeeMinor);
  } else if (campaign.target_type === 'bogo' || campaign.discount_type === 'bogo') {
    // Buy-One-Get-One: for each qualifying item with quantity >= 2, 1 unit per pair is free
    let bogoSavings = 0;
    for (const it of qualifyingItems) {
      const qty = Number(it.quantity || 0);
      const unitPrice = Number(it.unitPriceMinor || 0);
      if (qty >= 2 && unitPrice > 0) {
        const freeUnits = Math.floor(qty / 2);
        bogoSavings += freeUnits * unitPrice;
      }
    }
    if (bogoSavings <= 0) return null;
    rawDiscountMinor = Math.min(bogoSavings, remainingFoodSubtotalMinor);
  } else if (campaign.target_type === 'free_item' || campaign.discount_type === 'free_item') {
    const freeItemId = campaign.free_item_id ? String(campaign.free_item_id) : null;
    const matchItem = freeItemId
      ? orderItems.find(it => String(it.menuItemId || it.id) === freeItemId)
      : qualifyingItems[0];
    if (!matchItem) {
      // If a fixed discount fallback is configured on free_item campaign, use it; otherwise not applicable
      if (Number(campaign.discount_minor || 0) > 0) {
        rawDiscountMinor = Math.min(Number(campaign.discount_minor), remainingFoodSubtotalMinor);
      } else {
        return null;
      }
    } else {
      rawDiscountMinor = Math.min(Number(matchItem.unitPriceMinor || 0), remainingFoodSubtotalMinor);
    }
  } else {
    // food_subtotal, menu_items, menu_categories
    const baseMinor = (campaign.target_type === 'menu_items' || campaign.target_type === 'menu_categories' || eligibleItemSet || eligibleCatSet || excludedSet.size > 0)
      ? Math.min(qualifyingSubtotalMinor, remainingFoodSubtotalMinor)
      : remainingFoodSubtotalMinor;
    if (baseMinor <= 0) return null;
    if (campaign.discount_type === 'percentage') {
      rawDiscountMinor = Number((BigInt(baseMinor) * BigInt(campaign.discount_bps)) / 10000n);
    } else if (campaign.discount_type === 'fixed') {
      rawDiscountMinor = Math.min(baseMinor, Number(campaign.discount_minor || 0));
    }
    rawDiscountMinor = Math.min(rawDiscountMinor, baseMinor);
  }

  if (Number.isInteger(campaign.max_discount_minor) && campaign.max_discount_minor >= 0) {
    rawDiscountMinor = Math.min(rawDiscountMinor, campaign.max_discount_minor);
  }

  if (rawDiscountMinor <= 0) return null;

  // Determine funding split between ELESEND and Restaurant
  let elesendShareMinor = 0;
  let restaurantShareMinor = 0;

  const fundingType = campaign.funding_type;
  if (fundingType === 'elesend_100') {
    elesendShareMinor = rawDiscountMinor;
    restaurantShareMinor = 0;
  } else if (fundingType === 'restaurant_100') {
    elesendShareMinor = 0;
    restaurantShareMinor = rawDiscountMinor;
  } else if (fundingType === 'shared_percentage') {
    const restBps = consentRecord && Number.isInteger(consentRecord.restaurant_funding_bps)
      ? consentRecord.restaurant_funding_bps
      : Number(campaign.restaurant_funding_bps || 0);
    restaurantShareMinor = Number((BigInt(rawDiscountMinor) * BigInt(restBps)) / 10000n);
    elesendShareMinor = rawDiscountMinor - restaurantShareMinor;
  } else if (fundingType === 'shared_fixed') {
    const eFixed = consentRecord && Number(consentRecord.elesend_fixed_share_minor) > 0
      ? Number(consentRecord.elesend_fixed_share_minor)
      : Number(campaign.elesend_fixed_share_minor || 0);
    const rFixed = consentRecord && Number(consentRecord.restaurant_fixed_share_minor) > 0
      ? Number(consentRecord.restaurant_fixed_share_minor)
      : Number(campaign.restaurant_fixed_share_minor || 0);
    const totalFixed = eFixed + rFixed;
    if (totalFixed <= 0) return null;
    const cappedTotal = Math.min(rawDiscountMinor, totalFixed);
    restaurantShareMinor = Number((BigInt(cappedTotal) * BigInt(rFixed)) / BigInt(totalFixed));
    elesendShareMinor = cappedTotal - restaurantShareMinor;
    rawDiscountMinor = cappedTotal;
  }

  // Enforce per-order contribution caps
  const perOrderElesendCap = Number.isInteger(campaign.per_order_elesend_cap_minor)
    ? campaign.per_order_elesend_cap_minor
    : null;
  const perOrderRestaurantCap = consentRecord && Number.isInteger(consentRecord.per_order_restaurant_cap_minor)
    ? consentRecord.per_order_restaurant_cap_minor
    : (Number.isInteger(campaign.per_order_restaurant_cap_minor) ? campaign.per_order_restaurant_cap_minor : null);

  if (perOrderElesendCap !== null && elesendShareMinor > perOrderElesendCap) {
    elesendShareMinor = perOrderElesendCap;
  }
  if (perOrderRestaurantCap !== null && restaurantShareMinor > perOrderRestaurantCap) {
    restaurantShareMinor = perOrderRestaurantCap;
  }

  const totalDiscountMinor = elesendShareMinor + restaurantShareMinor;
  if (totalDiscountMinor <= 0) return null;

  // Verify remaining campaign budgets
  if (campaign.total_budget_minor !== null && campaign.total_budget_minor !== undefined) {
    const remTotal = BigInt(campaign.total_budget_minor) - BigInt(campaign.spent_budget_minor || 0);
    if (BigInt(totalDiscountMinor) > remTotal) return { budgetExhausted: true };
  }
  if (campaign.elesend_budget_minor !== null && campaign.elesend_budget_minor !== undefined) {
    const remElesend = BigInt(campaign.elesend_budget_minor) - BigInt(campaign.elesend_spent_minor || 0);
    if (BigInt(elesendShareMinor) > remElesend) return { budgetExhausted: true };
  }
  if (campaign.restaurant_budget_minor !== null && campaign.restaurant_budget_minor !== undefined) {
    const remRest = BigInt(campaign.restaurant_budget_minor) - BigInt(campaign.restaurant_spent_minor || 0);
    if (BigInt(restaurantShareMinor) > remRest) return { budgetExhausted: true };
  }
  if (consentRecord && consentRecord.restaurant_budget_cap_minor !== null && consentRecord.restaurant_budget_cap_minor !== undefined) {
    const remMerchantCap = BigInt(consentRecord.restaurant_budget_cap_minor) - BigInt(consentRecord.restaurant_spent_minor || 0);
    if (BigInt(restaurantShareMinor) > remMerchantCap) return { budgetExhausted: true };
  }

  const concessionBps = consentRecord && Number.isInteger(consentRecord.commission_concession_bps)
    ? consentRecord.commission_concession_bps
    : (Number.isInteger(campaign.commission_concession_bps) ? campaign.commission_concession_bps : null);

  return {
    campaignId: campaign.id,
    code: campaign.code || null,
    name: campaign.name,
    ownerType: campaign.owner_type,
    fundingType: campaign.funding_type,
    targetType: isDeliveryTarget ? 'delivery_fee' : campaign.target_type,
    discountType: campaign.discount_type,
    stackingPolicy: campaign.stacking_policy,
    exclusiveGroup: campaign.exclusive_group || null,
    priority: Number(campaign.priority || 100),
    minPayableMinor: Number(campaign.min_payable_minor ?? 100),
    totalDiscountMinor,
    foodDiscountMinor: isDeliveryTarget ? 0 : totalDiscountMinor,
    deliveryDiscountMinor: isDeliveryTarget ? totalDiscountMinor : 0,
    elesendFundedMinor: elesendShareMinor,
    restaurantFundedMinor: restaurantShareMinor,
    commissionConcessionBps: concessionBps,
    commissionBasisOverride: campaign.commission_basis_override || null
  };
}

export function promotionEngine(db) {
  const commissions = commissionEngine(db);

  async function requireAdminPermission(c, actor, permissions = ['promotions:manage', 'finance:configure', 'pricing:write']) {
    check(actor?.kind === 'admin', 403, 'Administrator access required');
    const list = Array.isArray(permissions) ? permissions : [permissions];
    const has = (await c.query(
      'SELECT 1 FROM permissions WHERE user_id = $1 AND permission = ANY($2::text[])',
      [actor.id, list]
    )).rowCount;
    check(has, 403, 'Promotion management permission required');
  }

  async function verifyRestaurantOwnership(c, actor, restaurantId) {
    check(actor && ['customer', 'business', 'rider', 'admin'].includes(actor.kind), 401, 'Authentication required');
    check(uuid.safeParse(restaurantId).success, 400, 'Invalid restaurant ID');
    const rest = (await c.query('SELECT * FROM restaurants WHERE id = $1', [restaurantId])).rows[0];
    check(rest, 404, 'Restaurant not found');
    if (actor.kind !== 'admin') {
      check(rest.owner_id === actor.id, 403, 'Only the restaurant owner has permission to access or modify this restaurant');
    }
    return rest;
  }

  async function logPromoAudit(c, { campaignId = null, restaurantId = null, actor = null, action, rationale = '', metadata = {} }) {
    await c.query(
      `INSERT INTO promotion_audit_logs (
         id, campaign_id, restaurant_id, actor_id, actor_kind, action, rationale, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id(),
        campaignId,
        restaurantId,
        actor?.id || null,
        actor?.kind || 'system',
        action,
        rationale,
        JSON.stringify(metadata)
      ]
    );
  }

  async function getCustomerOrderStats(c, customerId) {
    if (!customerId) return { activeOrCompletedCount: 0, completedCount: 0 };
    const row = (await c.query(
      `SELECT
         COUNT(*) FILTER (WHERE state NOT IN ('CANCELLED', 'REJECTED'))::int AS active_or_completed,
         COUNT(*) FILTER (WHERE state = 'DELIVERED')::int AS completed
       FROM food_orders
       WHERE customer_id = $1`,
      [customerId]
    )).rows[0];
    return {
      activeOrCompletedCount: row?.active_or_completed || 0,
      completedCount: row?.completed || 0
    };
  }

  const campaignInputSchema = z.object({
    code: z.string().trim().min(3).max(40).nullable().optional(),
    name: z.string().trim().min(2).max(140),
    description: z.string().trim().max(1000).optional().default(''),
    bannerText: z.string().trim().max(240).nullable().optional(),
    badgeText: z.string().trim().max(60).nullable().optional(),
    objective: CampaignObjectiveEnum.default('general'),
    ownerType: z.enum(['elesend', 'restaurant', 'joint']),
    creatorRestaurantId: z.string().uuid().nullable().optional(),
    fundingType: z.enum(['elesend_100', 'restaurant_100', 'shared_percentage', 'shared_fixed']),
    elesendFundingBps: z.number().int().min(0).max(10000).optional(),
    restaurantFundingBps: z.number().int().min(0).max(10000).optional(),
    elesendFixedShareMinor: z.number().int().min(0).max(100000000).optional().default(0),
    restaurantFixedShareMinor: z.number().int().min(0).max(100000000).optional().default(0),
    perOrderElesendCapMinor: z.number().int().min(0).max(100000000).nullable().optional(),
    perOrderRestaurantCapMinor: z.number().int().min(0).max(100000000).nullable().optional(),
    commissionBasisOverride: z.enum(['gross_subtotal', 'net_after_restaurant_discount', 'net_after_all_discounts']).nullable().optional(),
    commissionConcessionBps: z.number().int().min(0).max(10000).nullable().optional(),
    targetType: CampaignTargetTypeEnum.default('food_subtotal'),
    discountType: CampaignDiscountTypeEnum,
    discountBps: z.number().int().min(0).max(10000).optional().default(0),
    discountMinor: z.number().int().min(0).max(100000000).optional().default(0),
    maxDiscountMinor: z.number().int().min(0).max(100000000).nullable().optional(),
    minOrderMinor: z.number().int().min(0).max(100000000).optional().default(0),
    minPayableMinor: z.number().int().min(0).max(100000000).optional().default(100),
    eligibleRestaurantIds: z.array(z.string().uuid()).nullable().optional(),
    eligibleCategoryIds: z.array(z.string().uuid()).nullable().optional(),
    eligibleItemIds: z.array(z.string().uuid()).nullable().optional(),
    excludedItemIds: z.array(z.string().uuid()).nullable().optional(),
    freeItemId: z.string().uuid().nullable().optional(),
    eligibleTowns: z.array(z.string().trim().min(1).max(80)).nullable().optional(),
    eligibleRegions: z.array(z.string().trim().min(1).max(80)).nullable().optional(),
    eligibleCustomerSegment: CustomerSegmentEnum.default('all'),
    eligiblePaymentMethods: z.array(z.enum(['MOMO', 'CARD', 'BANK_QR'])).nullable().optional(),
    scheduleDays: z.array(z.number().int().min(0).max(6)).nullable().optional(),
    scheduleStartMinute: z.number().int().min(0).max(1439).nullable().optional(),
    scheduleEndMinute: z.number().int().min(0).max(1439).nullable().optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    perCustomerLimit: z.number().int().min(1).max(10000).optional().default(1),
    totalRedemptionLimit: z.number().int().min(1).max(100000000).nullable().optional(),
    totalBudgetMinor: z.number().int().min(0).max(100000000000).nullable().optional(),
    elesendBudgetMinor: z.number().int().min(0).max(100000000000).nullable().optional(),
    restaurantBudgetMinor: z.number().int().min(0).max(100000000000).nullable().optional(),
    priority: z.number().int().min(1).max(1000).optional().default(100),
    stackingPolicy: CampaignStackingPolicyEnum.default('non_stackable'),
    exclusiveGroup: z.string().trim().max(80).nullable().optional(),
    termsDisclosure: z.string().trim().max(2000).optional().default(''),
    status: z.enum(['draft', 'pending_approval', 'awaiting_consent', 'scheduled', 'active', 'paused']).optional(),
    invitedRestaurantIds: z.array(z.string().uuid()).optional()
  }).strict();

  function normalizeAndValidateFunding(v) {
    let eBps = v.elesendFundingBps ?? 0;
    let rBps = v.restaurantFundingBps ?? 0;
    if (v.fundingType === 'elesend_100') {
      check(v.ownerType === 'elesend', 400, 'elesend_100 funding requires ownerType = elesend');
      eBps = 10000;
      rBps = 0;
    } else if (v.fundingType === 'restaurant_100') {
      check(v.ownerType === 'restaurant', 400, 'restaurant_100 funding requires ownerType = restaurant');
      eBps = 0;
      rBps = 10000;
    } else if (v.fundingType === 'shared_percentage') {
      check(v.ownerType === 'joint', 400, 'shared_percentage funding requires ownerType = joint');
      check(eBps > 0 && rBps > 0 && eBps + rBps === 10000, 400, 'Joint percentage funding shares must both be positive and sum to 10000 bps (100%)');
    } else if (v.fundingType === 'shared_fixed') {
      check(v.ownerType === 'joint', 400, 'shared_fixed funding requires ownerType = joint');
      check(
        (v.elesendFixedShareMinor || 0) > 0 && (v.restaurantFixedShareMinor || 0) > 0,
        400,
        'Joint fixed funding requires positive elesendFixedShareMinor and restaurantFixedShareMinor'
      );
      const totalFixed = v.elesendFixedShareMinor + v.restaurantFixedShareMinor;
      eBps = Math.round((v.elesendFixedShareMinor * 10000) / totalFixed);
      rBps = 10000 - eBps;
    }

    if (v.discountType === 'percentage') {
      check(v.discountBps >= 100 && v.discountBps <= 10000, 400, 'Percentage discountBps must be between 100 (1%) and 10000 (100%)');
    } else if (v.discountType === 'fixed') {
      check(v.discountMinor > 0, 400, 'Fixed discountMinor must be greater than 0');
    }

    if (v.startsAt && v.endsAt) {
      check(Date.parse(v.endsAt) > Date.parse(v.startsAt), 400, 'endsAt must be after startsAt');
    }

    return { eBps, rBps };
  }

  return {
    /**
     * Create an ELESEND-funded or Joint Co-funded promotional campaign (Admin).
     */
    async createAdminCampaign(actor, input) {
      await requireAdminPermission(db, actor);
      const v = campaignInputSchema.parse({
        ownerType: input.ownerType || 'elesend',
        fundingType: input.fundingType || (input.ownerType === 'joint' ? 'shared_percentage' : 'elesend_100'),
        ...input
      });
      const { eBps, rBps } = normalizeAndValidateFunding(v);
      const code = normalizeCode(v.code);

      return db.tx(async c => {
        if (code) {
          const dup = (await c.query('SELECT 1 FROM promotion_campaigns WHERE code = $1', [code])).rowCount;
          check(!dup, 409, `Promo code ${code} is already in use`);
        }

        const campaignId = id();
        const initialStatus = v.status || (v.ownerType === 'joint' ? 'active' : 'active');
        const badgeText = v.badgeText || (
          v.discountType === 'free_delivery'
            ? 'Free Delivery'
            : v.discountType === 'percentage'
            ? `${(v.discountBps / 100).toFixed(0)}% OFF`
            : v.discountType === 'fixed'
            ? `GH₵${(v.discountMinor / 100).toFixed(0)} OFF`
            : v.discountType === 'bogo'
            ? 'Buy 1 Get 1 Free'
            : 'Special Offer'
        );

        const row = (await c.query(
          `INSERT INTO promotion_campaigns (
             id, code, name, description, banner_text, badge_text, objective,
             owner_type, creator_restaurant_id, funding_type,
             elesend_funding_bps, restaurant_funding_bps,
             elesend_fixed_share_minor, restaurant_fixed_share_minor,
             per_order_elesend_cap_minor, per_order_restaurant_cap_minor,
             commission_basis_override, commission_concession_bps,
             target_type, discount_type, discount_bps, discount_minor,
             max_discount_minor, min_order_minor, min_payable_minor,
             eligible_restaurant_ids, eligible_category_ids, eligible_item_ids,
             excluded_item_ids, free_item_id, eligible_towns, eligible_regions,
             eligible_customer_segment, eligible_payment_methods,
             schedule_days, schedule_start_minute, schedule_end_minute,
             starts_at, ends_at, per_customer_limit, total_redemption_limit,
             total_budget_minor, elesend_budget_minor, restaurant_budget_minor,
             priority, stacking_policy, exclusive_group,
             requires_approval, status, terms_disclosure,
             created_by, approved_by, approved_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10,
             $11, $12,
             $13, $14,
             $15, $16,
             $17, $18,
             $19, $20, $21, $22,
             $23, $24, $25,
             $26, $27, $28,
             $29, $30, $31, $32,
             $33, $34,
             $35, $36, $37,
             COALESCE($38, now()), $39, $40, $41,
             $42, $43, $44,
             $45, $46, $47,
             false, $48, $49,
             $50, $50, now()
           ) RETURNING *`,
          [
            campaignId, code, v.name, v.description, v.bannerText || v.description || v.name, badgeText, v.objective,
            v.ownerType, v.creatorRestaurantId || null, v.fundingType,
            eBps, rBps,
            v.elesendFixedShareMinor, v.restaurantFixedShareMinor,
            v.perOrderElesendCapMinor ?? null, v.perOrderRestaurantCapMinor ?? null,
            v.commissionBasisOverride ?? null, v.commissionConcessionBps ?? null,
            v.targetType, v.discountType, v.discountBps, v.discountMinor,
            v.maxDiscountMinor ?? null, v.minOrderMinor, v.minPayableMinor,
            v.eligibleRestaurantIds ?? null, v.eligibleCategoryIds ?? null, v.eligibleItemIds ?? null,
            v.excludedItemIds ?? null, v.freeItemId ?? null, v.eligibleTowns ?? null, v.eligibleRegions ?? null,
            v.eligibleCustomerSegment, v.eligiblePaymentMethods ?? null,
            v.scheduleDays ?? null, v.scheduleStartMinute ?? null, v.scheduleEndMinute ?? null,
            v.startsAt || null, v.endsAt || null, v.perCustomerLimit, v.totalRedemptionLimit ?? null,
            v.totalBudgetMinor ?? null, v.elesendBudgetMinor ?? null, v.restaurantBudgetMinor ?? null,
            v.priority, v.stackingPolicy, v.exclusiveGroup ?? null,
            initialStatus, v.termsDisclosure || '',
            actor.id
          ]
        )).rows[0];

        // If joint campaign has invited restaurants, create invitation records (consent_status = 'invited')
        const inviteIds = [...new Set([...(v.invitedRestaurantIds || []), ...(v.eligibleRestaurantIds || [])])];
        if (v.ownerType === 'joint' && inviteIds.length > 0) {
          for (const restId of inviteIds) {
            await c.query(
              `INSERT INTO promotion_campaign_restaurants (
                 id, campaign_id, restaurant_id, consent_status,
                 restaurant_funding_bps, elesend_funding_bps,
                 restaurant_fixed_share_minor, elesend_fixed_share_minor,
                 per_order_restaurant_cap_minor, commission_concession_bps, invited_by
               ) VALUES ($1, $2, $3, 'invited', $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT (campaign_id, restaurant_id) DO NOTHING`,
              [
                id(),
                campaignId,
                restId,
                rBps,
                eBps,
                v.restaurantFixedShareMinor,
                v.elesendFixedShareMinor,
                v.perOrderRestaurantCapMinor ?? null,
                v.commissionConcessionBps ?? null,
                actor.id
              ]
            );
          }
        }

        await logPromoAudit(c, {
          campaignId,
          actor,
          action: 'campaign.created',
          rationale: `Created ${v.ownerType} campaign: ${v.name}`,
          metadata: { ownerType: v.ownerType, fundingType: v.fundingType, code }
        });

        return row;
      });
    },

    /**
     * Invite one or more restaurants into a Joint Campaign (Admin).
     * Never auto-consents; always starts as 'invited'.
     */
    async inviteRestaurantsToCampaign(actor, campaignId, input) {
      await requireAdminPermission(db, actor);
      check(uuid.safeParse(campaignId).success, 400, 'Invalid campaignId');
      const schema = z.object({
        restaurantIds: z.array(z.string().uuid()).min(1).max(200),
        perOrderRestaurantCapMinor: z.number().int().min(0).max(100000000).nullable().optional(),
        restaurantBudgetCapMinor: z.number().int().min(0).max(100000000000).nullable().optional(),
        commissionConcessionBps: z.number().int().min(0).max(10000).nullable().optional()
      }).strict();
      const v = schema.parse(input);

      return db.tx(async c => {
        const camp = (await c.query('SELECT * FROM promotion_campaigns WHERE id = $1 FOR UPDATE', [campaignId])).rows[0];
        check(camp, 404, 'Campaign not found');
        check(camp.owner_type === 'joint', 400, 'Only joint campaigns support restaurant partnership invitations');

        const invited = [];
        for (const restId of [...new Set(v.restaurantIds)]) {
          const row = (await c.query(
            `INSERT INTO promotion_campaign_restaurants (
               id, campaign_id, restaurant_id, consent_status,
               restaurant_funding_bps, elesend_funding_bps,
               restaurant_fixed_share_minor, elesend_fixed_share_minor,
               per_order_restaurant_cap_minor, restaurant_budget_cap_minor,
               commission_concession_bps, invited_by
             ) VALUES ($1, $2, $3, 'invited', $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (campaign_id, restaurant_id) DO UPDATE SET
               consent_status = CASE
                 WHEN promotion_campaign_restaurants.consent_status = 'accepted' THEN 'accepted'
                 ELSE 'invited'
               END,
               updated_at = now()
             RETURNING *`,
            [
              id(),
              campaignId,
              restId,
              camp.restaurant_funding_bps,
              camp.elesend_funding_bps,
              camp.restaurant_fixed_share_minor,
              camp.elesend_fixed_share_minor,
              v.perOrderRestaurantCapMinor ?? camp.per_order_restaurant_cap_minor ?? null,
              v.restaurantBudgetCapMinor ?? null,
              v.commissionConcessionBps ?? camp.commission_concession_bps ?? null,
              actor.id
            ]
          )).rows[0];
          invited.push(row);
        }

        await logPromoAudit(c, {
          campaignId,
          actor,
          action: 'campaign.restaurants_invited',
          rationale: `Invited ${invited.length} restaurant(s) to joint campaign`,
          metadata: { restaurantIds: v.restaurantIds }
        });

        return { campaignId, invitedCount: invited.length, invitations: invited };
      });
    },

    /**
     * Restaurant Self-Service: Create a Restaurant-Owned Promotion (100% merchant-funded).
     */
    async createRestaurantCampaign(actor, restaurantId, input) {
      return db.tx(async c => {
        const rest = await verifyRestaurantOwnership(c, actor, restaurantId);
        check(rest.status === 'approved', 403, 'Restaurant must be approved before launching promotions');

        const v = campaignInputSchema.parse({
          ...input,
          ownerType: 'restaurant',
          creatorRestaurantId: restaurantId,
          fundingType: 'restaurant_100',
          elesendFundingBps: 0,
          restaurantFundingBps: 10000,
          eligibleRestaurantIds: [restaurantId]
        });
        normalizeAndValidateFunding(v);

        // Ensure any item/category IDs belong to this restaurant
        if (Array.isArray(v.eligibleItemIds) && v.eligibleItemIds.length > 0) {
          const validCount = (await c.query(
            'SELECT COUNT(*)::int AS cnt FROM menu_items WHERE id = ANY($1::uuid[]) AND restaurant_id = $2',
            [v.eligibleItemIds, restaurantId]
          )).rows[0].cnt;
          check(validCount === v.eligibleItemIds.length, 403, 'All eligible menu items must belong to your restaurant');
        }
        if (Array.isArray(v.eligibleCategoryIds) && v.eligibleCategoryIds.length > 0) {
          const validCatCount = (await c.query(
            'SELECT COUNT(*)::int AS cnt FROM menu_categories WHERE id = ANY($1::uuid[]) AND restaurant_id = $2',
            [v.eligibleCategoryIds, restaurantId]
          )).rows[0].cnt;
          check(validCatCount === v.eligibleCategoryIds.length, 403, 'All eligible menu categories must belong to your restaurant');
        }
        if (v.freeItemId) {
          const ownsFreeItem = (await c.query(
            'SELECT 1 FROM menu_items WHERE id = $1 AND restaurant_id = $2',
            [v.freeItemId, restaurantId]
          )).rowCount;
          check(ownsFreeItem, 403, 'Free item must belong to your restaurant');
        }

        const code = normalizeCode(v.code);
        if (code) {
          const dup = (await c.query('SELECT 1 FROM promotion_campaigns WHERE code = $1', [code])).rowCount;
          check(!dup, 409, `Promo code ${code} is already in use`);
        }

        // High discount threshold check (>60% or >GH₵200 fixed requires admin approval unless created by admin)
        const requiresApproval = actor.kind !== 'admin' && (
          (v.discountType === 'percentage' && v.discountBps > 6000) ||
          (v.discountType === 'fixed' && v.discountMinor > 20000)
        );
        const status = requiresApproval ? 'pending_approval' : (v.status || 'active');
        const badgeText = v.badgeText || (
          v.discountType === 'free_delivery'
            ? 'Free Delivery'
            : v.discountType === 'percentage'
            ? `${(v.discountBps / 100).toFixed(0)}% OFF`
            : v.discountType === 'fixed'
            ? `GH₵${(v.discountMinor / 100).toFixed(0)} OFF`
            : v.discountType === 'bogo'
            ? 'BOGO'
            : 'Merchant Offer'
        );

        const campaignId = id();
        const row = (await c.query(
          `INSERT INTO promotion_campaigns (
             id, code, name, description, banner_text, badge_text, objective,
             owner_type, creator_restaurant_id, funding_type,
             elesend_funding_bps, restaurant_funding_bps,
             per_order_restaurant_cap_minor,
             target_type, discount_type, discount_bps, discount_minor,
             max_discount_minor, min_order_minor, min_payable_minor,
             eligible_restaurant_ids, eligible_category_ids, eligible_item_ids,
             excluded_item_ids, free_item_id,
             eligible_customer_segment, eligible_payment_methods,
             schedule_days, schedule_start_minute, schedule_end_minute,
             starts_at, ends_at, per_customer_limit, total_redemption_limit,
             total_budget_minor, restaurant_budget_minor,
             priority, stacking_policy, exclusive_group,
             requires_approval, status, terms_disclosure, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             'restaurant', $8, 'restaurant_100',
             0, 10000,
             $9,
             $10, $11, $12, $13,
             $14, $15, $16,
             $17, $18, $19,
             $20, $21,
             $22, $23,
             $24, $25, $26,
             COALESCE($27, now()), $28, $29, $30,
             $31, $32,
             $33, $34, $35,
             $36, $37, $38, $39
           ) RETURNING *`,
          [
            campaignId, code, v.name, v.description, v.bannerText || v.description || v.name, badgeText, v.objective,
            restaurantId,
            v.perOrderRestaurantCapMinor ?? null,
            v.targetType, v.discountType, v.discountBps, v.discountMinor,
            v.maxDiscountMinor ?? null, v.minOrderMinor, v.minPayableMinor,
            [restaurantId], v.eligibleCategoryIds ?? null, v.eligibleItemIds ?? null,
            v.excludedItemIds ?? null, v.freeItemId ?? null,
            v.eligibleCustomerSegment, v.eligiblePaymentMethods ?? null,
            v.scheduleDays ?? null, v.scheduleStartMinute ?? null, v.scheduleEndMinute ?? null,
            v.startsAt || null, v.endsAt || null, v.perCustomerLimit, v.totalRedemptionLimit ?? null,
            v.totalBudgetMinor ?? v.restaurantBudgetMinor ?? null,
            v.restaurantBudgetMinor ?? v.totalBudgetMinor ?? null,
            v.priority, v.stackingPolicy, v.exclusiveGroup ?? null,
            requiresApproval, status, v.termsDisclosure || '', actor.id
          ]
        )).rows[0];

        await logPromoAudit(c, {
          campaignId,
          restaurantId,
          actor,
          action: 'restaurant_campaign.created',
          rationale: `Merchant created promotion: ${v.name}`,
          metadata: { status, requiresApproval, discountType: v.discountType }
        });

        return row;
      });
    },

    /**
     * Explicit Restaurant Consent Workflow for Joint ELESEND + Restaurant Campaigns.
     * Silence is NEVER treated as consent; only explicit decision === 'accepted' activates merchant participation.
     */
    async respondToJointCampaignInvitation(actor, restaurantId, campaignId, input) {
      check(uuid.safeParse(campaignId).success, 400, 'Invalid campaignId');
      const schema = z.object({
        decision: z.enum(['accepted', 'rejected', 'revoked']),
        restaurantBudgetCapMinor: z.number().int().min(0).max(100000000000).nullable().optional(),
        perOrderRestaurantCapMinor: z.number().int().min(0).max(100000000).nullable().optional(),
        decisionNotes: z.string().trim().max(500).optional().default('')
      }).strict();
      const v = schema.parse(input);

      return db.tx(async c => {
        const rest = await verifyRestaurantOwnership(c, actor, restaurantId);
        const camp = (await c.query('SELECT * FROM promotion_campaigns WHERE id = $1 FOR UPDATE', [campaignId])).rows[0];
        check(camp, 404, 'Campaign not found');
        check(camp.owner_type === 'joint', 400, 'Campaign is not a joint partnership campaign');

        const existing = (await c.query(
          'SELECT * FROM promotion_campaign_restaurants WHERE campaign_id = $1 AND restaurant_id = $2 FOR UPDATE',
          [campaignId, restaurantId]
        )).rows[0];

        // Check if restaurant is invited or in eligible_restaurant_ids (or open to all restaurants if eligible_restaurant_ids is null)
        const isEligibleToJoin = existing ||
          !camp.eligible_restaurant_ids ||
          camp.eligible_restaurant_ids.length === 0 ||
          camp.eligible_restaurant_ids.includes(restaurantId);
        check(isEligibleToJoin, 403, 'This restaurant was not invited to participate in this joint campaign');

        const agreementSnapshot = {
          campaignId: camp.id,
          campaignName: camp.name,
          fundingType: camp.funding_type,
          elesendFundingBps: camp.elesend_funding_bps,
          restaurantFundingBps: camp.restaurant_funding_bps,
          elesendFixedShareMinor: camp.elesend_fixed_share_minor,
          restaurantFixedShareMinor: camp.restaurant_fixed_share_minor,
          discountType: camp.discount_type,
          discountBps: camp.discount_bps,
          discountMinor: camp.discount_minor,
          commissionConcessionBps: camp.commission_concession_bps,
          commissionBasisOverride: camp.commission_basis_override,
          startsAt: camp.starts_at,
          endsAt: camp.ends_at,
          decision: v.decision,
          consentedByUserId: actor.id,
          consentedAt: new Date().toISOString()
        };

        const row = (await c.query(
          `INSERT INTO promotion_campaign_restaurants (
             id, campaign_id, restaurant_id, consent_status,
             restaurant_funding_bps, elesend_funding_bps,
             restaurant_fixed_share_minor, elesend_fixed_share_minor,
             per_order_restaurant_cap_minor, restaurant_budget_cap_minor,
             commission_concession_bps, consented_by, consented_at,
             decision_notes, agreement_snapshot, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13, $14, now())
           ON CONFLICT (campaign_id, restaurant_id) DO UPDATE SET
             consent_status = EXCLUDED.consent_status,
             per_order_restaurant_cap_minor = COALESCE(EXCLUDED.per_order_restaurant_cap_minor, promotion_campaign_restaurants.per_order_restaurant_cap_minor),
             restaurant_budget_cap_minor = COALESCE(EXCLUDED.restaurant_budget_cap_minor, promotion_campaign_restaurants.restaurant_budget_cap_minor),
             consented_by = EXCLUDED.consented_by,
             consented_at = now(),
             decision_notes = EXCLUDED.decision_notes,
             agreement_snapshot = EXCLUDED.agreement_snapshot,
             updated_at = now()
           RETURNING *`,
          [
            id(),
            campaignId,
            restaurantId,
            v.decision,
            camp.restaurant_funding_bps,
            camp.elesend_funding_bps,
            camp.restaurant_fixed_share_minor,
            camp.elesend_fixed_share_minor,
            v.perOrderRestaurantCapMinor ?? camp.per_order_restaurant_cap_minor ?? null,
            v.restaurantBudgetCapMinor ?? null,
            camp.commission_concession_bps ?? null,
            actor.id,
            v.decisionNotes,
            JSON.stringify(agreementSnapshot)
          ]
        )).rows[0];

        await logPromoAudit(c, {
          campaignId,
          restaurantId,
          actor,
          action: `joint_campaign.consent_${v.decision}`,
          rationale: v.decisionNotes || `Merchant ${rest.name} ${v.decision} joint campaign ${camp.name}`,
          metadata: agreementSnapshot
        });

        return row;
      });
    },

    /**
     * Lifecycle state changes (activate, pause, resume, expire, terminate, approve, reject).
     */
    async setCampaignStatus(actor, campaignId, input) {
      check(uuid.safeParse(campaignId).success, 400, 'Invalid campaignId');
      const schema = z.object({
        status: z.enum(['active', 'paused', 'expired', 'terminated', 'rejected']),
        rationale: z.string().trim().min(3).max(500)
      }).strict();
      const v = schema.parse(input);

      return db.tx(async c => {
        const camp = (await c.query('SELECT * FROM promotion_campaigns WHERE id = $1 FOR UPDATE', [campaignId])).rows[0];
        check(camp, 404, 'Campaign not found');

        if (actor.kind === 'admin') {
          await requireAdminPermission(c, actor);
        } else {
          check(camp.owner_type === 'restaurant' && camp.creator_restaurant_id, 403, 'Only administrators can modify platform or joint campaigns');
          await verifyRestaurantOwnership(c, actor, camp.creator_restaurant_id);
          check(
            !(camp.status === 'pending_approval' && v.status === 'active'),
            403,
            'Campaigns awaiting administrator approval cannot be self-approved by the merchant'
          );
          check(
            !(camp.suspended_reason && v.status === 'active'),
            403,
            'Campaign suspended by administrator cannot be resumed without admin review'
          );
        }

        const isAdminApproval = actor.kind === 'admin' && camp.status === 'pending_approval' && v.status === 'active';
        const suspendedReason = actor.kind === 'admin' && ['paused', 'terminated', 'rejected'].includes(v.status)
          ? v.rationale
          : (v.status === 'active' ? null : camp.suspended_reason);

        const updated = (await c.query(
          `UPDATE promotion_campaigns
           SET status = $2,
               approved_by = CASE WHEN $3::boolean THEN $4 ELSE approved_by END,
               approved_at = CASE WHEN $3::boolean THEN now() ELSE approved_at END,
               suspended_reason = $5,
               updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [campaignId, v.status, isAdminApproval, actor.id, suspendedReason]
        )).rows[0];

        await logPromoAudit(c, {
          campaignId,
          restaurantId: camp.creator_restaurant_id,
          actor,
          action: `campaign.status_${v.status}`,
          rationale: v.rationale,
          metadata: { previousStatus: camp.status, newStatus: v.status }
        });

        return updated;
      });
    },

    /**
     * Financial Impact Preview for Restaurant Self-Service or Joint Campaign Inspection.
     */
    async previewCampaignFinancialImpact(actor, restaurantId, input) {
      await verifyRestaurantOwnership(db, actor, restaurantId);
      const schema = z.object({
        sampleFoodSubtotalMinor: z.number().int().min(100).max(100000000).default(10000),
        sampleDeliveryFeeMinor: z.number().int().min(0).max(100000000).default(2000),
        discountType: CampaignDiscountTypeEnum.default('percentage'),
        targetType: CampaignTargetTypeEnum.default('food_subtotal'),
        discountBps: z.number().int().min(0).max(10000).default(1000),
        discountMinor: z.number().int().min(0).max(100000000).default(0),
        maxDiscountMinor: z.number().int().min(0).max(100000000).nullable().optional(),
        fundingType: z.enum(['elesend_100', 'restaurant_100', 'shared_percentage', 'shared_fixed']).default('restaurant_100'),
        elesendFundingBps: z.number().int().min(0).max(10000).default(0),
        restaurantFundingBps: z.number().int().min(0).max(10000).default(10000),
        elesendFixedShareMinor: z.number().int().min(0).max(100000000).default(0),
        restaurantFixedShareMinor: z.number().int().min(0).max(100000000).default(0),
        perOrderRestaurantCapMinor: z.number().int().min(0).max(100000000).nullable().optional(),
        commissionConcessionBps: z.number().int().min(0).max(10000).nullable().optional(),
        commissionBasisOverride: z.enum(['gross_subtotal', 'net_after_restaurant_discount', 'net_after_all_discounts']).nullable().optional()
      }).strict();
      const v = schema.parse(input);

      const syntheticCampaign = {
        id: '00000000-0000-0000-0000-000000000000',
        name: 'Preview Offer',
        owner_type: v.fundingType === 'restaurant_100' ? 'restaurant' : v.fundingType === 'elesend_100' ? 'elesend' : 'joint',
        funding_type: v.fundingType,
        elesend_funding_bps: v.fundingType === 'elesend_100' ? 10000 : v.fundingType === 'restaurant_100' ? 0 : v.elesendFundingBps,
        restaurant_funding_bps: v.fundingType === 'restaurant_100' ? 10000 : v.fundingType === 'elesend_100' ? 0 : v.restaurantFundingBps,
        elesend_fixed_share_minor: v.elesendFixedShareMinor,
        restaurant_fixed_share_minor: v.restaurantFixedShareMinor,
        per_order_restaurant_cap_minor: v.perOrderRestaurantCapMinor ?? null,
        commission_concession_bps: v.commissionConcessionBps ?? null,
        commission_basis_override: v.commissionBasisOverride ?? null,
        target_type: v.targetType,
        discount_type: v.discountType,
        discount_bps: v.discountBps,
        discount_minor: v.discountMinor,
        max_discount_minor: v.maxDiscountMinor ?? null,
        stacking_policy: 'non_stackable',
        priority: 100,
        min_payable_minor: 100
      };

      const discountEval = calculateSingleCampaignDiscount({
        campaign: syntheticCampaign,
        orderItems: [{ menuItemId: 'sample', unitPriceMinor: v.sampleFoodSubtotalMinor, quantity: 1, lineTotalMinor: v.sampleFoodSubtotalMinor }],
        foodSubtotalMinor: v.sampleFoodSubtotalMinor,
        deliveryFeeMinor: v.sampleDeliveryFeeMinor
      }) || {
        totalDiscountMinor: 0,
        foodDiscountMinor: 0,
        deliveryDiscountMinor: 0,
        elesendFundedMinor: 0,
        restaurantFundedMinor: 0
      };

      const commPolicy = await commissions.resolveRestaurantCommission({
        restaurantId,
        campaignConcessionBps: v.commissionConcessionBps ?? null,
        campaignBasisOverride: v.commissionBasisOverride ?? null
      });

      const isDeliv = syntheticCampaign.target_type === 'delivery_fee' || syntheticCampaign.discount_type === 'free_delivery';
      const restFoodDisc = isDeliv ? 0 : discountEval.restaurantFundedMinor;
      const elesendFoodDisc = isDeliv ? 0 : discountEval.elesendFundedMinor;
      const restDelivDisc = isDeliv ? discountEval.restaurantFundedMinor : 0;

      const settlement = computeRestaurantCommissionBreakdown({
        subtotalMinor: v.sampleFoodSubtotalMinor,
        restaurantFoodDiscountMinor: restFoodDisc,
        elesendFoodDiscountMinor: elesendFoodDisc,
        restaurantDeliveryDiscountMinor: restDelivDisc,
        rateBps: commPolicy.rateBps,
        calculationBasis: commPolicy.calculationBasis
      });

      const baselinePolicy = await commissions.resolveRestaurantCommission({
        restaurantId
      });
      const baselineSettlement = computeRestaurantCommissionBreakdown({
        subtotalMinor: v.sampleFoodSubtotalMinor,
        restaurantFoodDiscountMinor: 0,
        elesendFoodDiscountMinor: 0,
        restaurantDeliveryDiscountMinor: 0,
        rateBps: baselinePolicy.rateBps,
        calculationBasis: baselinePolicy.calculationBasis
      });

      const withPromotion = {
        sampleFoodSubtotalMinor: v.sampleFoodSubtotalMinor,
        sampleDeliveryFeeMinor: v.sampleDeliveryFeeMinor,
        customerFoodPayableMinor: v.sampleFoodSubtotalMinor - discountEval.foodDiscountMinor,
        customerDeliveryPayableMinor: v.sampleDeliveryFeeMinor - discountEval.deliveryDiscountMinor,
        customerTotalPayableMinor: (v.sampleFoodSubtotalMinor - discountEval.foodDiscountMinor) + (v.sampleDeliveryFeeMinor - discountEval.deliveryDiscountMinor),
        totalDiscountMinor: discountEval.totalDiscountMinor,
        elesendSubsidyMinor: discountEval.elesendFundedMinor,
        elesendFundedDiscountMinor: discountEval.elesendFundedMinor,
        restaurantFundedDiscountMinor: discountEval.restaurantFundedMinor,
        commissionRateBps: commPolicy.rateBps,
        commissionCalculationBasis: settlement.calculationBasis,
        commissionBaseMinor: settlement.commissionBaseMinor,
        commissionMinor: settlement.commissionMinor,
        netRestaurantSettlementMinor: settlement.netRestaurantSettlementMinor,
        estimatedNetRestaurantSettlementMinor: settlement.netRestaurantSettlementMinor
      };

      return {
        ...withPromotion,
        withoutPromotion: {
          subtotalMinor: v.sampleFoodSubtotalMinor,
          commissionRateBps: baselinePolicy.rateBps,
          commissionMinor: baselineSettlement.commissionMinor,
          netRestaurantSettlementMinor: baselineSettlement.netRestaurantSettlementMinor
        },
        withPromotion
      };
    },

    /**
     * Fetch active public promotions for restaurant discovery & menu rendering.
     * Never returns expired, paused, budget-exhausted, redemption-exhausted, or unconsented joint offers.
     */
    async getPublicPromotionsForRestaurant(restaurantId, { town = null, region = null } = {}) {
      const now = new Date();
      const rows = (await db.query(
        `SELECT c.*, pcr.consent_status, pcr.restaurant_budget_cap_minor, pcr.restaurant_spent_minor AS pcr_spent_minor
         FROM promotion_campaigns c
         LEFT JOIN promotion_campaign_restaurants pcr
           ON pcr.campaign_id = c.id AND pcr.restaurant_id = $1
         WHERE c.status = 'active'
           AND c.starts_at <= $2
           AND (c.ends_at IS NULL OR c.ends_at > $2)
           AND (c.total_redemption_limit IS NULL OR c.redeemed_count < c.total_redemption_limit)
           AND (c.total_budget_minor IS NULL OR c.spent_budget_minor < c.total_budget_minor)
           AND (c.elesend_budget_minor IS NULL OR c.elesend_spent_minor < c.elesend_budget_minor)
           AND (c.restaurant_budget_minor IS NULL OR c.restaurant_spent_minor < c.restaurant_budget_minor)
           AND (
             c.eligible_restaurant_ids IS NULL
             OR cardinality(c.eligible_restaurant_ids) = 0
             OR $1 = ANY(c.eligible_restaurant_ids)
           )
           AND (
             c.owner_type <> 'joint'
             OR (
               pcr.consent_status = 'accepted'
               AND (pcr.restaurant_budget_cap_minor IS NULL OR pcr.restaurant_spent_minor < pcr.restaurant_budget_cap_minor)
             )
           )
         ORDER BY c.priority ASC, c.created_at DESC`,
        [restaurantId, now]
      )).rows;

      return rows
        .filter(c => isScheduleMatch(c, now))
        .map(c => ({
          id: c.id,
          code: c.code,
          name: c.name,
          description: c.description,
          bannerText: c.banner_text || c.description || c.name,
          badgeText: c.badge_text || c.name,
          objective: c.objective,
          ownerType: c.owner_type,
          targetType: c.target_type,
          discountType: c.discount_type,
          discountBps: c.discount_bps,
          discountMinor: c.discount_minor,
          maxDiscountMinor: c.max_discount_minor,
          minOrderMinor: c.min_order_minor,
          eligibleCategoryIds: c.eligible_category_ids,
          eligibleItemIds: c.eligible_item_ids,
          excludedItemIds: c.excluded_item_ids,
          freeItemId: c.free_item_id,
          eligibleCustomerSegment: c.eligible_customer_segment,
          endsAt: c.ends_at,
          termsDisclosure: c.terms_disclosure
        }));
    },

    /**
     * Authoritative Evaluation of Checkout Promotions & Commission in quoteFoodOrder / createFoodOrder.
     */
    async evaluateCheckoutPromotions(c, {
      actor,
      restaurant,
      orderItems,
      foodSubtotalMinor,
      deliveryFeeMinor,
      promoCodes = [],
      campaignIds = [],
      paymentMethod = 'MOMO',
      deliveryAddress = '',
      now = new Date()
    }) {
      const normalizedCodes = [...new Set(
        (Array.isArray(promoCodes) ? promoCodes : [promoCodes])
          .map(normalizeCode)
          .filter(Boolean)
      )];
      const requestedIds = [...new Set(
        (Array.isArray(campaignIds) ? campaignIds : [campaignIds])
          .filter(x => typeof x === 'string' && uuid.safeParse(x).success)
      )];

      // Rate-limit coupon code attempts per user to prevent brute-force guessing
      if (normalizedCodes.length > 0 && actor?.id) {
        await limit(c, `promo-code-eval:${actor.id}`, 25, 60);
      }

      const customerStats = await getCustomerOrderStats(c, actor?.id);

      // Load all candidate campaigns:
      // 1) Automatic active campaigns (code IS NULL)
      // 2) Explicitly requested promo codes or campaign IDs (even if inactive/expired so we can return accurate rejection reasons!)
      const candidates = (await c.query(
        `SELECT c.*,
                pcr.consent_status,
                pcr.restaurant_funding_bps AS pcr_restaurant_funding_bps,
                pcr.elesend_funding_bps AS pcr_elesend_funding_bps,
                pcr.restaurant_fixed_share_minor AS pcr_restaurant_fixed_share_minor,
                pcr.elesend_fixed_share_minor AS pcr_elesend_fixed_share_minor,
                pcr.per_order_restaurant_cap_minor AS pcr_per_order_restaurant_cap_minor,
                pcr.restaurant_budget_cap_minor,
                pcr.restaurant_spent_minor AS pcr_spent_minor,
                pcr.commission_concession_bps AS pcr_commission_concession_bps
         FROM promotion_campaigns c
         LEFT JOIN promotion_campaign_restaurants pcr
           ON pcr.campaign_id = c.id AND pcr.restaurant_id = $1
         WHERE (c.code IS NULL AND c.status = 'active')
            OR (c.code = ANY($2::text[]))
            OR (c.id = ANY($3::uuid[]))
         ORDER BY c.priority ASC, c.created_at DESC`,
        [restaurant.id, normalizedCodes, requestedIds]
      )).rows;

      const rejectedPromotions = [];
      const foundCodes = new Set(candidates.map(x => x.code).filter(Boolean));
      for (const reqCode of normalizedCodes) {
        if (!foundCodes.has(reqCode)) {
          rejectedPromotions.push({
            code: reqCode,
            reasonCode: 'INVALID_CODE',
            message: `Promo code "${reqCode}" is invalid or does not exist.`
          });
        }
      }

      // If repeated invalid code attempts occur, record an operational risk signal
      if (rejectedPromotions.some(r => r.reasonCode === 'INVALID_CODE') && actor?.id) {
        await c.query(
          `INSERT INTO promotion_audit_logs (id, actor_id, actor_kind, action, rationale, metadata)
           VALUES ($1, $2, $3, 'promo.invalid_code_attempt', 'Invalid promo code submitted at checkout', $4)`,
          [id(), actor.id, actor.kind, JSON.stringify({ codes: normalizedCodes, restaurantId: restaurant.id })]
        );
      }

      const validEvaluations = [];

      for (const camp of candidates) {
        const isExplicit = (camp.code && normalizedCodes.includes(camp.code)) || requestedIds.includes(camp.id);
        const reject = (reasonCode, message) => {
          if (isExplicit) {
            rejectedPromotions.push({
              campaignId: camp.id,
              code: camp.code || null,
              name: camp.name,
              reasonCode,
              message
            });
          }
        };

        // 1. Status & time window check
        if (camp.status !== 'active') {
          reject('CAMPAIGN_INACTIVE', `Promotion "${camp.name}" is currently ${camp.status}.`);
          continue;
        }
        if (camp.starts_at && new Date(camp.starts_at) > now) {
          reject('CAMPAIGN_NOT_STARTED', `Promotion "${camp.name}" has not started yet.`);
          continue;
        }
        if (camp.ends_at && new Date(camp.ends_at) <= now) {
          reject('CAMPAIGN_EXPIRED', `Promotion "${camp.name}" has expired.`);
          continue;
        }
        if (!isScheduleMatch(camp, now)) {
          reject('OUTSIDE_SCHEDULE', `Promotion "${camp.name}" is only valid during its scheduled hours/days.`);
          continue;
        }

        // 2. Restaurant scope check
        if (Array.isArray(camp.eligible_restaurant_ids) && camp.eligible_restaurant_ids.length > 0) {
          if (!camp.eligible_restaurant_ids.includes(restaurant.id)) {
            reject('INELIGIBLE_RESTAURANT', `Promotion "${camp.name}" is not valid at this restaurant.`);
            continue;
          }
        }
        if (camp.owner_type === 'restaurant' && camp.creator_restaurant_id && camp.creator_restaurant_id !== restaurant.id) {
          reject('INELIGIBLE_RESTAURANT', `Merchant promotion "${camp.name}" belongs to another restaurant.`);
          continue;
        }

        // 3. Mandatory Joint Campaign Consent check
        if (camp.owner_type === 'joint') {
          if (camp.consent_status !== 'accepted') {
            reject('MERCHANT_CONSENT_MISSING', `This restaurant has not given consent (not participating) in joint campaign "${camp.name}".`);
            continue;
          }
        }

        // 4. Geographic town/region check
        if (!isTownOrRegionMatch(camp, { restaurant, deliveryAddress })) {
          reject('INELIGIBLE_GEOGRAPHY', `Promotion "${camp.name}" is not available in this town/region.`);
          continue;
        }

        // 5. Payment method check
        if (Array.isArray(camp.eligible_payment_methods) && camp.eligible_payment_methods.length > 0) {
          if (!camp.eligible_payment_methods.includes(paymentMethod)) {
            reject('INELIGIBLE_PAYMENT_METHOD', `Promotion "${camp.name}" requires payment via ${camp.eligible_payment_methods.join(' or ')}.`);
            continue;
          }
        }

        // 6. Customer segment check
        if (camp.eligible_customer_segment === 'first_order' || camp.eligible_customer_segment === 'new_customer') {
          if (customerStats.activeOrCompletedCount > 0) {
            reject('FIRST_ORDER_ONLY', `Promotion "${camp.name}" is exclusively for first-time food orders.`);
            continue;
          }
        } else if (camp.eligible_customer_segment === 'returning_customer') {
          if (customerStats.completedCount < 1) {
            reject('RETURNING_CUSTOMER_ONLY', `Promotion "${camp.name}" is for returning customers.`);
            continue;
          }
        } else if (camp.eligible_customer_segment === 'loyalty') {
          if (customerStats.completedCount < 3) {
            reject('LOYALTY_SEGMENT_ONLY', `Promotion "${camp.name}" requires at least 3 completed orders.`);
            continue;
          }
        }

        // 7. Minimum order subtotal check
        if (foodSubtotalMinor < Number(camp.min_order_minor || 0)) {
          const shortfall = Number(camp.min_order_minor) - foodSubtotalMinor;
          reject(
            'MIN_ORDER_NOT_MET',
            `Add GH₵${(shortfall / 100).toFixed(2)} more to qualify for "${camp.name}" (min order GH₵${(Number(camp.min_order_minor) / 100).toFixed(2)}).`
          );
          continue;
        }

        // 8. Total redemption limit check
        if (camp.total_redemption_limit !== null && Number(camp.redeemed_count || 0) >= Number(camp.total_redemption_limit)) {
          reject('REDEMPTION_LIMIT_REACHED', `Promotion "${camp.name}" has reached its maximum total redemptions.`);
          continue;
        }

        // 9. Per-customer redemption limit check
        if (actor?.id && Number(camp.per_customer_limit || 0) > 0) {
          const userUsed = (await c.query(
            `SELECT COUNT(*)::int AS cnt
             FROM promotion_redemptions
             WHERE campaign_id = $1 AND customer_id = $2 AND status IN ('reserved', 'applied')`,
            [camp.id, actor.id]
          )).rows[0].cnt;
          if (userUsed >= Number(camp.per_customer_limit)) {
            reject('CUSTOMER_LIMIT_REACHED', `You have already used promotion "${camp.name}" the maximum number of times (${camp.per_customer_limit}).`);
            continue;
          }
        }

        const consentRecord = camp.owner_type === 'joint' ? {
          restaurant_funding_bps: camp.pcr_restaurant_funding_bps,
          elesend_funding_bps: camp.pcr_elesend_funding_bps,
          restaurant_fixed_share_minor: camp.pcr_restaurant_fixed_share_minor,
          elesend_fixed_share_minor: camp.pcr_elesend_fixed_share_minor,
          per_order_restaurant_cap_minor: camp.pcr_per_order_restaurant_cap_minor,
          restaurant_budget_cap_minor: camp.restaurant_budget_cap_minor,
          restaurant_spent_minor: camp.pcr_spent_minor,
          commission_concession_bps: camp.pcr_commission_concession_bps
        } : null;

        const previewCalc = calculateSingleCampaignDiscount({
          campaign: camp,
          consentRecord,
          orderItems,
          foodSubtotalMinor,
          deliveryFeeMinor
        });

        if (!previewCalc) {
          reject('NO_QUALIFYING_ITEMS', `No items in your basket qualify for "${camp.name}".`);
          continue;
        }
        if (previewCalc.budgetExhausted) {
          reject('BUDGET_EXHAUSTED', `Promotional budget for "${camp.name}" has been exhausted.`);
          continue;
        }

        validEvaluations.push({
          campaign: camp,
          consentRecord,
          previewCalc,
          isExplicit
        });
      }

      // Deterministic Selection & Stacking Resolution:
      // Sort candidates so explicit promo codes & higher savings / higher priority (lower number) win
      validEvaluations.sort((a, b) => {
        if (a.isExplicit !== b.isExplicit) return a.isExplicit ? -1 : 1;
        if (b.previewCalc.totalDiscountMinor !== a.previewCalc.totalDiscountMinor) {
          return b.previewCalc.totalDiscountMinor - a.previewCalc.totalDiscountMinor;
        }
        return (a.campaign.priority || 100) - (b.campaign.priority || 100);
      });

      const selected = [];
      let remFoodMinor = foodSubtotalMinor;
      let remDeliveryMinor = deliveryFeeMinor;

      for (const candidate of validEvaluations) {
        if (selected.length === 0) {
          selected.push(candidate);
          remFoodMinor = Math.max(0, remFoodMinor - candidate.previewCalc.foodDiscountMinor);
          remDeliveryMinor = Math.max(0, remDeliveryMinor - candidate.previewCalc.deliveryDiscountMinor);
          continue;
        }

        // Check if candidate can stack with all already-selected campaigns
        const canStack = selected.every(already => {
          const p1 = already.campaign.stacking_policy;
          const p2 = candidate.campaign.stacking_policy;
          if (p1 === 'non_stackable' || p2 === 'non_stackable') return false;
          if (
            already.campaign.exclusive_group &&
            candidate.campaign.exclusive_group &&
            already.campaign.exclusive_group === candidate.campaign.exclusive_group
          ) {
            return false;
          }
          const isDeliv1 = already.previewCalc.targetType === 'delivery_fee';
          const isDeliv2 = candidate.previewCalc.targetType === 'delivery_fee';

          if (p1 === 'stack_with_delivery' || p2 === 'stack_with_delivery') {
            return isDeliv1 !== isDeliv2;
          }
          if (p1 === 'stack_cross_funder' || p2 === 'stack_cross_funder') {
            return already.campaign.owner_type !== candidate.campaign.owner_type;
          }
          return p1 === 'stackable' && p2 === 'stackable';
        });

        if (!canStack) {
          if (candidate.isExplicit) {
            rejectedPromotions.push({
              campaignId: candidate.campaign.id,
              code: candidate.campaign.code || null,
              name: candidate.campaign.name,
              reasonCode: 'NON_STACKABLE',
              message: `Promotion "${candidate.campaign.name}" cannot be combined with "${selected[0].campaign.name}".`
            });
          }
          continue;
        }

        // Recompute candidate against remaining food/delivery amounts
        const stackedCalc = calculateSingleCampaignDiscount({
          campaign: candidate.campaign,
          consentRecord: candidate.consentRecord,
          orderItems,
          foodSubtotalMinor,
          deliveryFeeMinor,
          remainingFoodSubtotalMinor: remFoodMinor,
          remainingDeliveryFeeMinor: remDeliveryMinor
        });
        if (!stackedCalc || stackedCalc.budgetExhausted || stackedCalc.totalDiscountMinor <= 0) {
          continue;
        }
        candidate.previewCalc = stackedCalc;
        selected.push(candidate);
        remFoodMinor = Math.max(0, remFoodMinor - stackedCalc.foodDiscountMinor);
        remDeliveryMinor = Math.max(0, remDeliveryMinor - stackedCalc.deliveryDiscountMinor);
      }

      // Enforce minimum payable amount (prevent negative or zero PSP checkout intent)
      const grossTotalMinor = foodSubtotalMinor + deliveryFeeMinor;
      const requiredMinPayableMinor = selected.reduce(
        (maxMin, s) => Math.max(maxMin, Number(s.previewCalc.minPayableMinor ?? 100)),
        selected.length > 0 ? 100 : 0
      );
      const maxAllowedTotalDiscountMinor = Math.max(0, grossTotalMinor - requiredMinPayableMinor);

      const appliedPromotions = [];
      let runningTotalDiscount = 0;
      let totalFoodDiscountMinor = 0;
      let totalDeliveryDiscountMinor = 0;
      let totalElesendFundedMinor = 0;
      let totalRestaurantFundedMinor = 0;
      let restaurantFoodDiscountMinor = 0;
      let elesendFoodDiscountMinor = 0;
      let restaurantDeliveryDiscountMinor = 0;
      let elesendDeliveryDiscountMinor = 0;
      let bestCommissionConcessionBps = null;
      let campaignBasisOverride = null;

      for (const s of selected) {
        const calc = { ...s.previewCalc };
        const allowedRemaining = Math.max(0, maxAllowedTotalDiscountMinor - runningTotalDiscount);
        if (allowedRemaining <= 0) break;

        if (calc.totalDiscountMinor > allowedRemaining) {
          // Scale down proportionally to preserve minPayableMinor
          const ratioRest = calc.restaurantFundedMinor / calc.totalDiscountMinor;
          calc.totalDiscountMinor = allowedRemaining;
          calc.restaurantFundedMinor = Math.floor(allowedRemaining * ratioRest);
          calc.elesendFundedMinor = allowedRemaining - calc.restaurantFundedMinor;
          if (calc.deliveryDiscountMinor > 0) {
            calc.deliveryDiscountMinor = allowedRemaining;
            calc.foodDiscountMinor = 0;
          } else {
            calc.foodDiscountMinor = allowedRemaining;
            calc.deliveryDiscountMinor = 0;
          }
        }

        runningTotalDiscount += calc.totalDiscountMinor;
        totalFoodDiscountMinor += calc.foodDiscountMinor;
        totalDeliveryDiscountMinor += calc.deliveryDiscountMinor;
        totalElesendFundedMinor += calc.elesendFundedMinor;
        totalRestaurantFundedMinor += calc.restaurantFundedMinor;

        if (calc.deliveryDiscountMinor > 0) {
          restaurantDeliveryDiscountMinor += calc.restaurantFundedMinor;
          elesendDeliveryDiscountMinor += calc.elesendFundedMinor;
        } else {
          restaurantFoodDiscountMinor += calc.restaurantFundedMinor;
          elesendFoodDiscountMinor += calc.elesendFundedMinor;
        }

        if (Number.isInteger(calc.commissionConcessionBps)) {
          bestCommissionConcessionBps = bestCommissionConcessionBps === null
            ? calc.commissionConcessionBps
            : Math.min(bestCommissionConcessionBps, calc.commissionConcessionBps);
        }
        if (calc.commissionBasisOverride) {
          campaignBasisOverride = calc.commissionBasisOverride;
        }

        appliedPromotions.push(calc);
      }

      // Resolve restaurant commission using the commission engine
      const commPolicy = await commissions.resolveRestaurantCommission({
        restaurantId: restaurant.id,
        campaignConcessionBps: bestCommissionConcessionBps,
        campaignBasisOverride,
        at: now
      }, c);

      const commBreakdown = computeRestaurantCommissionBreakdown({
        subtotalMinor: foodSubtotalMinor,
        restaurantFoodDiscountMinor,
        elesendFoodDiscountMinor,
        restaurantDeliveryDiscountMinor,
        rateBps: commPolicy.rateBps,
        calculationBasis: commPolicy.calculationBasis
      });

      const customerFoodPayableMinor = foodSubtotalMinor - totalFoodDiscountMinor;
      const customerDeliveryPayableMinor = deliveryFeeMinor - totalDeliveryDiscountMinor;
      const totalCustomerPayableMinor = customerFoodPayableMinor + customerDeliveryPayableMinor;

      return {
        originalFoodSubtotalMinor: foodSubtotalMinor,
        originalDeliveryFeeMinor: deliveryFeeMinor,
        foodDiscountMinor: totalFoodDiscountMinor,
        deliveryDiscountMinor: totalDeliveryDiscountMinor,
        totalDiscountMinor: runningTotalDiscount,
        elesendFundedDiscountMinor: totalElesendFundedMinor,
        restaurantFundedDiscountMinor: totalRestaurantFundedMinor,
        restaurantFoodDiscountMinor,
        elesendFoodDiscountMinor,
        restaurantDeliveryDiscountMinor,
        elesendDeliveryDiscountMinor,
        customerFoodPayableMinor,
        customerDeliveryPayableMinor,
        totalCustomerPayableMinor,
        foodCommissionBps: commPolicy.rateBps,
        foodCommissionMinor: commBreakdown.commissionMinor,
        commissionCalculationBasis: commBreakdown.calculationBasis,
        commissionBaseMinor: commBreakdown.commissionBaseMinor,
        commissionRuleId: commPolicy.ruleId || null,
        commissionPolicy: commPolicy,
        restaurantNetSettlementMinor: commBreakdown.netRestaurantSettlementMinor,
        appliedPromotions,
        rejectedPromotions,
        appliedPromoCodes: appliedPromotions.map(p => p.code).filter(Boolean)
      };
    },

    /**
     * Concurrency-Safe Atomic Reservation of Promotional Redemptions & Budgets inside createFoodOrder transaction.
     */
    async reservePromotionsForOrder(c, { orderId, actor, restaurant, evaluation }) {
      const applied = evaluation?.appliedPromotions || [];
      if (applied.length === 0) return [];

      // Lock all applied campaigns in deterministic UUID order to prevent deadlocks
      const sortedIds = [...new Set(applied.map(p => p.campaignId))].sort();
      const lockedCampaigns = (await c.query(
        'SELECT * FROM promotion_campaigns WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [sortedIds]
      )).rows;
      const campMap = new Map(lockedCampaigns.map(r => [r.id, r]));

      const redemptions = [];
      for (const promo of applied) {
        const camp = campMap.get(promo.campaignId);
        check(camp && camp.status === 'active', 409, `Promotion "${promo.name}" is no longer active`);

        // Re-verify total redemption limit under row lock
        if (camp.total_redemption_limit !== null) {
          check(
            Number(camp.redeemed_count) + 1 <= Number(camp.total_redemption_limit),
            409,
            `Promotion "${camp.name}" has just reached its maximum redemption limit`
          );
        }

        // Re-verify per-customer redemption limit under lock
        if (actor?.id && Number(camp.per_customer_limit || 0) > 0) {
          const userUsed = (await c.query(
            `SELECT COUNT(*)::int AS cnt
             FROM promotion_redemptions
             WHERE campaign_id = $1 AND customer_id = $2 AND status IN ('reserved', 'applied')`,
            [camp.id, actor.id]
          )).rows[0].cnt;
          check(
            userUsed < Number(camp.per_customer_limit),
            409,
            `Per-customer redemption limit reached for promotion "${camp.name}"`
          );
        }

        // Re-verify campaign budgets under lock
        if (camp.total_budget_minor !== null) {
          check(
            BigInt(camp.spent_budget_minor) + BigInt(promo.totalDiscountMinor) <= BigInt(camp.total_budget_minor),
            409,
            `Promotional budget exhausted for "${camp.name}"`
          );
        }
        if (camp.elesend_budget_minor !== null) {
          check(
            BigInt(camp.elesend_spent_minor) + BigInt(promo.elesendFundedMinor) <= BigInt(camp.elesend_budget_minor),
            409,
            `Platform promotional budget exhausted for "${camp.name}"`
          );
        }
        if (camp.restaurant_budget_minor !== null) {
          check(
            BigInt(camp.restaurant_spent_minor) + BigInt(promo.restaurantFundedMinor) <= BigInt(camp.restaurant_budget_minor),
            409,
            `Merchant promotional budget exhausted for "${camp.name}"`
          );
        }

        // If Joint campaign, lock & verify merchant consent and merchant budget cap
        if (camp.owner_type === 'joint') {
          const pcr = (await c.query(
            'SELECT * FROM promotion_campaign_restaurants WHERE campaign_id = $1 AND restaurant_id = $2 FOR UPDATE',
            [camp.id, restaurant.id]
          )).rows[0];
          check(pcr && pcr.consent_status === 'accepted', 409, `Restaurant consent is not active for joint campaign "${camp.name}"`);
          if (pcr.restaurant_budget_cap_minor !== null) {
            check(
              BigInt(pcr.restaurant_spent_minor) + BigInt(promo.restaurantFundedMinor) <= BigInt(pcr.restaurant_budget_cap_minor),
              409,
              `Restaurant budget cap reached for joint campaign "${camp.name}"`
            );
          }
          await c.query(
            `UPDATE promotion_campaign_restaurants
             SET restaurant_spent_minor = restaurant_spent_minor + $3,
                 updated_at = now()
             WHERE campaign_id = $1 AND restaurant_id = $2`,
            [camp.id, restaurant.id, promo.restaurantFundedMinor]
          );
        }

        // Atomically increment counters on promotion_campaigns
        await c.query(
          `UPDATE promotion_campaigns
           SET redeemed_count = redeemed_count + 1,
               spent_budget_minor = spent_budget_minor + $2,
               elesend_spent_minor = elesend_spent_minor + $3,
               restaurant_spent_minor = restaurant_spent_minor + $4,
               updated_at = now()
           WHERE id = $1`,
          [camp.id, promo.totalDiscountMinor, promo.elesendFundedMinor, promo.restaurantFundedMinor]
        );

        const redemptionId = id();
        const redRow = (await c.query(
          `INSERT INTO promotion_redemptions (
             id, campaign_id, order_id, customer_id, restaurant_id,
             status, target_type, total_discount_minor,
             food_discount_minor, delivery_discount_minor,
             elesend_funded_minor, restaurant_funded_minor,
             code_used, calculation_snapshot
           ) VALUES ($1, $2, $3, $4, $5, 'reserved', $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          [
            redemptionId,
            camp.id,
            orderId,
            actor.id,
            restaurant.id,
            promo.targetType,
            promo.totalDiscountMinor,
            promo.foodDiscountMinor,
            promo.deliveryDiscountMinor,
            promo.elesendFundedMinor,
            promo.restaurantFundedMinor,
            promo.code || null,
            JSON.stringify(promo)
          ]
        )).rows[0];
        redemptions.push(redRow);
      }

      return redemptions;
    },

    /**
     * Mark reserved promotions as applied upon order delivery completion.
     */
    async finalizeOrderPromotions(c, orderId) {
      await c.query(
        `UPDATE promotion_redemptions
         SET status = 'applied', updated_at = now()
         WHERE order_id = $1 AND status = 'reserved'`,
        [orderId]
      );
    },

    /**
     * Release or refund promotion redemptions on order rejection, cancellation, timeout expiry, or return.
     * Restores redemption count and promotional budgets idempotently.
     */
    async releaseOrderPromotions(c, orderId, { reason = 'order_cancelled', isRefund = false } = {}) {
      const activeRedemptions = (await c.query(
        `SELECT * FROM promotion_redemptions
         WHERE order_id = $1 AND status IN ('reserved', 'applied')
         ORDER BY campaign_id
         FOR UPDATE`,
        [orderId]
      )).rows;

      if (activeRedemptions.length === 0) return { releasedCount: 0 };

      const targetStatus = isRefund ? 'refunded' : 'released';
      for (const red of activeRedemptions) {
        await c.query(
          `UPDATE promotion_campaigns
           SET redeemed_count = GREATEST(0, redeemed_count - 1),
               spent_budget_minor = GREATEST(0, spent_budget_minor - $2),
               elesend_spent_minor = GREATEST(0, elesend_spent_minor - $3),
               restaurant_spent_minor = GREATEST(0, restaurant_spent_minor - $4),
               updated_at = now()
           WHERE id = $1`,
          [red.campaign_id, red.total_discount_minor, red.elesend_funded_minor, red.restaurant_funded_minor]
        );

        await c.query(
          `UPDATE promotion_campaign_restaurants
           SET restaurant_spent_minor = GREATEST(0, restaurant_spent_minor - $3),
               updated_at = now()
           WHERE campaign_id = $1 AND restaurant_id = $2`,
          [red.campaign_id, red.restaurant_id, red.restaurant_funded_minor]
        );

        await c.query(
          `UPDATE promotion_redemptions
           SET status = $2, updated_at = now()
           WHERE id = $1`,
          [red.id, targetStatus]
        );

        await logPromoAudit(c, {
          campaignId: red.campaign_id,
          restaurantId: red.restaurant_id,
          action: `redemption.${targetStatus}`,
          rationale: reason,
          metadata: {
            orderId,
            redemptionId: red.id,
            restoredDiscountMinor: red.total_discount_minor,
            restoredElesendMinor: red.elesend_funded_minor,
            restoredRestaurantMinor: red.restaurant_funded_minor
          }
        });
      }

      return { releasedCount: activeRedemptions.length, status: targetStatus };
    },

    /**
     * List campaigns & joint invitations for a specific restaurant dashboard.
     */
    async listRestaurantCampaigns(actor, restaurantId) {
      await verifyRestaurantOwnership(db, actor, restaurantId);
      const ownCampaigns = (await db.query(
        `SELECT * FROM promotion_campaigns
         WHERE creator_restaurant_id = $1
            OR (owner_type = 'elesend' AND ($1 = ANY(eligible_restaurant_ids) OR eligible_restaurant_ids IS NULL))
         ORDER BY created_at DESC
         LIMIT 100`,
        [restaurantId]
      )).rows;

      const jointInvitations = (await db.query(
        `SELECT pcr.*,
                c.name AS campaign_name,
                c.code AS campaign_code,
                c.description AS campaign_description,
                c.objective,
                c.funding_type,
                c.target_type,
                c.discount_type,
                c.discount_bps,
                c.discount_minor,
                c.max_discount_minor,
                c.min_order_minor,
                c.starts_at,
                c.ends_at,
                c.status AS campaign_status,
                c.terms_disclosure
         FROM promotion_campaign_restaurants pcr
         JOIN promotion_campaigns c ON c.id = pcr.campaign_id
         WHERE pcr.restaurant_id = $1
         ORDER BY pcr.created_at DESC`,
        [restaurantId]
      )).rows;

      return {
        campaigns: ownCampaigns,
        jointInvitations
      };
    },

    /**
     * Restaurant Promotion & Settlement Analytics.
     */
    async getRestaurantPromotionAnalytics(actor, restaurantId) {
      await verifyRestaurantOwnership(db, actor, restaurantId);
      const summary = (await db.query(
        `SELECT
           COUNT(DISTINCT r.order_id) FILTER (WHERE r.status IN ('reserved', 'applied'))::int AS promotional_orders_count,
           COUNT(r.id) FILTER (WHERE r.status IN ('reserved', 'applied'))::int AS total_redemptions_count,
           COALESCE(SUM(r.total_discount_minor) FILTER (WHERE r.status IN ('reserved', 'applied')), 0)::bigint AS total_discount_minor,
           COALESCE(SUM(r.restaurant_funded_minor) FILTER (WHERE r.status IN ('reserved', 'applied')), 0)::bigint AS restaurant_funded_minor,
           COALESCE(SUM(r.elesend_funded_minor) FILTER (WHERE r.status IN ('reserved', 'applied')), 0)::bigint AS elesend_funded_minor
         FROM promotion_redemptions r
         WHERE r.restaurant_id = $1`,
        [restaurantId]
      )).rows[0];

      const orderStats = (await db.query(
        `SELECT
           COUNT(*)::int AS promo_orders,
           COALESCE(SUM(subtotal_minor), 0)::bigint AS gross_campaign_sales_minor,
           COALESCE(AVG(subtotal_minor), 0)::numeric(12,2) AS average_order_value_minor,
           COALESCE(SUM(food_commission_minor), 0)::bigint AS commission_charged_minor,
           COALESCE(SUM(COALESCE(restaurant_net_settlement_minor, subtotal_minor - restaurant_funded_discount_minor - food_commission_minor)), 0)::bigint AS net_settlement_minor
         FROM food_orders
         WHERE restaurant_id = $1
           AND state NOT IN ('CANCELLED', 'REJECTED')
           AND (food_discount_minor > 0 OR delivery_discount_minor > 0)`,
        [restaurantId]
      )).rows[0];

      const perCampaign = (await db.query(
        `SELECT
           c.id,
           c.name,
           c.code,
           c.owner_type,
           c.status,
           c.redeemed_count,
           c.total_redemption_limit,
           c.total_budget_minor,
           c.spent_budget_minor,
           c.restaurant_budget_minor,
           c.restaurant_spent_minor,
           COALESCE(SUM(r.total_discount_minor) FILTER (WHERE r.status IN ('reserved', 'applied')), 0)::bigint AS restaurant_order_discount_minor,
           COALESCE(SUM(r.restaurant_funded_minor) FILTER (WHERE r.status IN ('reserved', 'applied')), 0)::bigint AS restaurant_share_minor,
           COALESCE(SUM(r.elesend_funded_minor) FILTER (WHERE r.status IN ('reserved', 'applied')), 0)::bigint AS elesend_share_minor
         FROM promotion_campaigns c
         LEFT JOIN promotion_redemptions r ON r.campaign_id = c.id AND r.restaurant_id = $1
         WHERE c.creator_restaurant_id = $1
            OR EXISTS (SELECT 1 FROM promotion_campaign_restaurants pcr WHERE pcr.campaign_id = c.id AND pcr.restaurant_id = $1)
            OR r.restaurant_id = $1
         GROUP BY c.id
         ORDER BY c.created_at DESC
         LIMIT 50`,
        [restaurantId]
      )).rows;

      return {
        restaurantId,
        promotionalOrdersCount: Number(summary.promotional_orders_count || 0),
        totalRedemptionsCount: Number(summary.total_redemptions_count || 0),
        totalDiscountMinor: Number(summary.total_discount_minor || 0),
        restaurantFundedMinor: Number(summary.restaurant_funded_minor || 0),
        elesendFundedMinor: Number(summary.elesend_funded_minor || 0),
        grossCampaignSalesMinor: Number(orderStats.gross_campaign_sales_minor || 0),
        averageOrderValueMinor: Math.round(Number(orderStats.average_order_value_minor || 0)),
        commissionChargedMinor: Number(orderStats.commission_charged_minor || 0),
        netSettlementMinor: Number(orderStats.net_settlement_minor || 0),
        campaigns: perCampaign.map(c => ({
          ...c,
          remainingBudgetMinor: c.total_budget_minor !== null
            ? Math.max(0, Number(c.total_budget_minor) - Number(c.spent_budget_minor || 0))
            : null
        }))
      };
    },

    /**
     * Admin Campaign Listing, Analytics, Fraud Signals & Reconciliation Export.
     */
    async listAdminCampaigns(actor, { ownerType, status } = {}) {
      await requireAdminPermission(db, actor, ['promotions:manage', 'finance:read', 'finance:approve', 'finance:configure', 'pricing:write']);
      const conds = [];
      const vals = [];
      if (ownerType) {
        vals.push(ownerType);
        conds.push(`c.owner_type = $${vals.length}`);
      }
      if (status) {
        vals.push(status);
        conds.push(`c.status = $${vals.length}`);
      }
      const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const campaigns = (await db.query(
        `SELECT c.*, r.name AS creator_restaurant_name,
                (SELECT COUNT(*)::int FROM promotion_campaign_restaurants pcr WHERE pcr.campaign_id = c.id AND pcr.consent_status = 'accepted') AS accepted_restaurants_count,
                (SELECT COUNT(*)::int FROM promotion_campaign_restaurants pcr WHERE pcr.campaign_id = c.id) AS invited_restaurants_count
         FROM promotion_campaigns c
         LEFT JOIN restaurants r ON r.id = c.creator_restaurant_id
         ${whereSql}
         ORDER BY c.created_at DESC
         LIMIT 200`,
        vals
      )).rows;

      const totals = (await db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('reserved', 'applied'))::int AS active_redemptions,
           COALESCE(SUM(total_discount_minor) FILTER (WHERE status IN ('reserved', 'applied')), 0)::bigint AS total_discount_minor,
           COALESCE(SUM(elesend_funded_minor) FILTER (WHERE status IN ('reserved', 'applied')), 0)::bigint AS total_elesend_subsidy_minor,
           COALESCE(SUM(restaurant_funded_minor) FILTER (WHERE status IN ('reserved', 'applied')), 0)::bigint AS total_restaurant_discount_minor
         FROM promotion_redemptions`
      )).rows[0];

      const suspiciousLogs = (await db.query(
        `SELECT * FROM promotion_audit_logs
         WHERE action IN ('promo.invalid_code_attempt', 'campaign.status_terminated', 'campaign.status_rejected')
         ORDER BY created_at DESC
         LIMIT 50`
      )).rows;

      return {
        campaigns,
        summary: {
          activeRedemptions: Number(totals.active_redemptions || 0),
          totalDiscountMinor: Number(totals.total_discount_minor || 0),
          totalElesendSubsidyMinor: Number(totals.total_elesend_subsidy_minor || 0),
          totalRestaurantDiscountMinor: Number(totals.total_restaurant_discount_minor || 0)
        },
        suspiciousActivity: suspiciousLogs
      };
    }
  };
}
