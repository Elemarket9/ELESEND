-- Migration 046: Comprehensive Restaurant Commission, Promotions, Campaign Partnerships & Settlement Engine

-- 1. Global Restaurant Commission Policy & Governance Settings
CREATE TABLE IF NOT EXISTS restaurant_commission_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  default_rate_bps integer NOT NULL DEFAULT 1000 CHECK (default_rate_bps BETWEEN 0 AND 10000),
  min_permitted_rate_bps integer NOT NULL DEFAULT 0 CHECK (min_permitted_rate_bps BETWEEN 0 AND 10000),
  max_permitted_rate_bps integer NOT NULL DEFAULT 3000 CHECK (max_permitted_rate_bps BETWEEN 0 AND 10000),
  approval_threshold_bps integer NOT NULL DEFAULT 2000 CHECK (approval_threshold_bps BETWEEN 0 AND 10000),
  default_calculation_basis text NOT NULL DEFAULT 'net_after_restaurant_discount'
    CHECK (default_calculation_basis IN ('gross_subtotal', 'net_after_restaurant_discount', 'net_after_all_discounts')),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (min_permitted_rate_bps <= max_permitted_rate_bps)
);

INSERT INTO restaurant_commission_settings (id, default_rate_bps, min_permitted_rate_bps, max_permitted_rate_bps, approval_threshold_bps, default_calculation_basis)
VALUES (true, 1000, 0, 3000, 2000, 'net_after_restaurant_discount')
ON CONFLICT (id) DO NOTHING;

-- 2. Extend restaurants with merchant tier and commission calculation basis
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS merchant_tier text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS cuisine_category text,
  ADD COLUMN IF NOT EXISTS commission_calculation_basis text
    CHECK (commission_calculation_basis IS NULL OR commission_calculation_basis IN ('gross_subtotal', 'net_after_restaurant_discount', 'net_after_all_discounts')),
  ADD COLUMN IF NOT EXISTS custom_commission_override boolean NOT NULL DEFAULT false;

-- 3. Extend commission_rules for hierarchical restaurant commission policies & contractual agreements
ALTER TABLE commission_rules DROP CONSTRAINT IF EXISTS commission_rules_category_check;
ALTER TABLE commission_rules ADD CONSTRAINT commission_rules_category_check CHECK (
  category IN (
    'delivery_default', 'delivery_vehicle', 'vehicle_tariff', 'rider_delivery',
    'merchant_delivery', 'corporate_delivery', 'founding_rider', 'rider_incentive', 'rider_tier',
    'restaurant_default', 'restaurant_food', 'restaurant_contract', 'restaurant_override',
    'restaurant_tier', 'restaurant_category', 'restaurant_introductory',
    'restaurant_time_limited', 'restaurant_campaign',
    'promotional_campaign', 'special_agreement'
  )
);

ALTER TABLE commission_rules DROP CONSTRAINT IF EXISTS commission_rules_scope_type_check;
ALTER TABLE commission_rules ADD CONSTRAINT commission_rules_scope_type_check CHECK (
  scope_type IN ('global', 'vehicle', 'rider', 'merchant', 'restaurant', 'tier', 'cuisine_category', 'campaign')
);

ALTER TABLE commission_rules DROP CONSTRAINT IF EXISTS commission_rules_status_check;
ALTER TABLE commission_rules ADD CONSTRAINT commission_rules_status_check CHECK (
  status IN ('pending_approval', 'scheduled', 'active', 'paused', 'expired', 'revoked')
);

ALTER TABLE commission_rules
  ADD COLUMN IF NOT EXISTS calculation_basis text NOT NULL DEFAULT 'net_after_restaurant_discount'
    CHECK (calculation_basis IN ('gross_subtotal', 'net_after_restaurant_discount', 'net_after_all_discounts')),
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS contract_reference text,
  ADD COLUMN IF NOT EXISTS min_rate_bps integer CHECK (min_rate_bps IS NULL OR min_rate_bps BETWEEN 0 AND 10000),
  ADD COLUMN IF NOT EXISTS max_rate_bps integer CHECK (max_rate_bps IS NULL OR max_rate_bps BETWEEN 0 AND 10000),
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 4. Promotional Campaigns Table (ELESEND-funded, Restaurant-funded, Joint Co-funded)
CREATE TABLE IF NOT EXISTS promotion_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE CHECK (code IS NULL OR (length(trim(code)) BETWEEN 3 AND 40 AND code = upper(trim(code)))),
  name text NOT NULL CHECK (length(trim(name)) >= 2),
  description text NOT NULL DEFAULT '',
  banner_text text,
  badge_text text,
  objective text NOT NULL DEFAULT 'general' CHECK (
    objective IN (
      'first_order', 'new_customer', 'returning_customer', 'weekend_special',
      'lunch_special', 'dinner_special', 'restaurant_launch', 'town_campaign',
      'loyalty', 'marketing_partnership', 'delivery_subsidy', 'bogo', 'free_item', 'general'
    )
  ),
  owner_type text NOT NULL CHECK (owner_type IN ('elesend', 'restaurant', 'joint')),
  creator_restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  funding_type text NOT NULL CHECK (funding_type IN ('elesend_100', 'restaurant_100', 'shared_percentage', 'shared_fixed')),
  elesend_funding_bps integer NOT NULL DEFAULT 0 CHECK (elesend_funding_bps BETWEEN 0 AND 10000),
  restaurant_funding_bps integer NOT NULL DEFAULT 0 CHECK (restaurant_funding_bps BETWEEN 0 AND 10000),
  elesend_fixed_share_minor integer NOT NULL DEFAULT 0 CHECK (elesend_fixed_share_minor >= 0),
  restaurant_fixed_share_minor integer NOT NULL DEFAULT 0 CHECK (restaurant_fixed_share_minor >= 0),
  per_order_elesend_cap_minor integer CHECK (per_order_elesend_cap_minor IS NULL OR per_order_elesend_cap_minor >= 0),
  per_order_restaurant_cap_minor integer CHECK (per_order_restaurant_cap_minor IS NULL OR per_order_restaurant_cap_minor >= 0),
  commission_basis_override text CHECK (
    commission_basis_override IS NULL OR commission_basis_override IN ('gross_subtotal', 'net_after_restaurant_discount', 'net_after_all_discounts')
  ),
  commission_concession_bps integer CHECK (commission_concession_bps IS NULL OR commission_concession_bps BETWEEN 0 AND 10000),
  target_type text NOT NULL DEFAULT 'food_subtotal' CHECK (
    target_type IN ('food_subtotal', 'menu_items', 'menu_categories', 'delivery_fee', 'bogo', 'free_item')
  ),
  discount_type text NOT NULL CHECK (discount_type IN ('percentage', 'fixed', 'free_delivery', 'bogo', 'free_item')),
  discount_bps integer NOT NULL DEFAULT 0 CHECK (discount_bps BETWEEN 0 AND 10000),
  discount_minor integer NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  max_discount_minor integer CHECK (max_discount_minor IS NULL OR max_discount_minor >= 0),
  min_order_minor integer NOT NULL DEFAULT 0 CHECK (min_order_minor >= 0),
  min_payable_minor integer NOT NULL DEFAULT 100 CHECK (min_payable_minor >= 0),
  eligible_restaurant_ids uuid[] DEFAULT NULL,
  eligible_category_ids uuid[] DEFAULT NULL,
  eligible_item_ids uuid[] DEFAULT NULL,
  excluded_item_ids uuid[] DEFAULT NULL,
  free_item_id uuid REFERENCES menu_items(id) ON DELETE SET NULL,
  eligible_towns text[] DEFAULT NULL,
  eligible_regions text[] DEFAULT NULL,
  eligible_customer_segment text NOT NULL DEFAULT 'all' CHECK (
    eligible_customer_segment IN ('all', 'first_order', 'new_customer', 'returning_customer', 'loyalty')
  ),
  eligible_payment_methods text[] DEFAULT NULL,
  schedule_days integer[] DEFAULT NULL,
  schedule_start_minute integer CHECK (schedule_start_minute IS NULL OR schedule_start_minute BETWEEN 0 AND 1439),
  schedule_end_minute integer CHECK (schedule_end_minute IS NULL OR schedule_end_minute BETWEEN 0 AND 1439),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  per_customer_limit integer NOT NULL DEFAULT 1 CHECK (per_customer_limit >= 1),
  total_redemption_limit integer CHECK (total_redemption_limit IS NULL OR total_redemption_limit >= 1),
  redeemed_count integer NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
  total_budget_minor bigint CHECK (total_budget_minor IS NULL OR total_budget_minor >= 0),
  spent_budget_minor bigint NOT NULL DEFAULT 0 CHECK (spent_budget_minor >= 0),
  elesend_budget_minor bigint CHECK (elesend_budget_minor IS NULL OR elesend_budget_minor >= 0),
  elesend_spent_minor bigint NOT NULL DEFAULT 0 CHECK (elesend_spent_minor >= 0),
  restaurant_budget_minor bigint CHECK (restaurant_budget_minor IS NULL OR restaurant_budget_minor >= 0),
  restaurant_spent_minor bigint NOT NULL DEFAULT 0 CHECK (restaurant_spent_minor >= 0),
  priority integer NOT NULL DEFAULT 100,
  stacking_policy text NOT NULL DEFAULT 'non_stackable' CHECK (
    stacking_policy IN ('non_stackable', 'stack_with_delivery', 'stack_cross_funder', 'stackable')
  ),
  exclusive_group text,
  requires_approval boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (
    status IN ('draft', 'pending_approval', 'awaiting_consent', 'scheduled', 'active', 'paused', 'expired', 'terminated', 'rejected')
  ),
  terms_disclosure text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  suspended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (total_redemption_limit IS NULL OR redeemed_count <= total_redemption_limit),
  CHECK (total_budget_minor IS NULL OR spent_budget_minor <= total_budget_minor),
  CHECK (elesend_budget_minor IS NULL OR elesend_spent_minor <= elesend_budget_minor),
  CHECK (restaurant_budget_minor IS NULL OR restaurant_spent_minor <= restaurant_budget_minor),
  CHECK (
    (funding_type = 'elesend_100' AND elesend_funding_bps = 10000 AND restaurant_funding_bps = 0) OR
    (funding_type = 'restaurant_100' AND restaurant_funding_bps = 10000 AND elesend_funding_bps = 0) OR
    (funding_type = 'shared_percentage' AND elesend_funding_bps + restaurant_funding_bps = 10000) OR
    (funding_type = 'shared_fixed' AND (elesend_fixed_share_minor + restaurant_fixed_share_minor > 0))
  )
);

CREATE INDEX IF NOT EXISTS idx_promotion_campaigns_status_dates
  ON promotion_campaigns(status, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_promotion_campaigns_creator_rest
  ON promotion_campaigns(creator_restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_promotion_campaigns_code
  ON promotion_campaigns(code) WHERE code IS NOT NULL;

-- 5. Joint Campaign Restaurant Participation & Explicit Consent Ledger
CREATE TABLE IF NOT EXISTS promotion_campaign_restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  consent_status text NOT NULL DEFAULT 'invited' CHECK (
    consent_status IN ('invited', 'accepted', 'rejected', 'revoked')
  ),
  restaurant_funding_bps integer NOT NULL DEFAULT 0 CHECK (restaurant_funding_bps BETWEEN 0 AND 10000),
  elesend_funding_bps integer NOT NULL DEFAULT 0 CHECK (elesend_funding_bps BETWEEN 0 AND 10000),
  restaurant_fixed_share_minor integer NOT NULL DEFAULT 0 CHECK (restaurant_fixed_share_minor >= 0),
  elesend_fixed_share_minor integer NOT NULL DEFAULT 0 CHECK (elesend_fixed_share_minor >= 0),
  per_order_restaurant_cap_minor integer CHECK (per_order_restaurant_cap_minor IS NULL OR per_order_restaurant_cap_minor >= 0),
  restaurant_budget_cap_minor bigint CHECK (restaurant_budget_cap_minor IS NULL OR restaurant_budget_cap_minor >= 0),
  restaurant_spent_minor bigint NOT NULL DEFAULT 0 CHECK (restaurant_spent_minor >= 0),
  commission_concession_bps integer CHECK (commission_concession_bps IS NULL OR commission_concession_bps BETWEEN 0 AND 10000),
  invited_by uuid REFERENCES users(id),
  consented_by uuid REFERENCES users(id),
  consented_at timestamptz,
  decision_notes text,
  agreement_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, restaurant_id),
  CHECK (restaurant_budget_cap_minor IS NULL OR restaurant_spent_minor <= restaurant_budget_cap_minor)
);

CREATE INDEX IF NOT EXISTS idx_promo_campaign_restaurants_lookup
  ON promotion_campaign_restaurants(restaurant_id, consent_status);

-- 6. Promotion Redemptions & Order Reservation Ledger
CREATE TABLE IF NOT EXISTS promotion_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES promotion_campaigns(id),
  order_id uuid NOT NULL REFERENCES food_orders(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES users(id),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'applied', 'released', 'refunded')),
  target_type text NOT NULL,
  total_discount_minor integer NOT NULL CHECK (total_discount_minor >= 0),
  food_discount_minor integer NOT NULL DEFAULT 0 CHECK (food_discount_minor >= 0),
  delivery_discount_minor integer NOT NULL DEFAULT 0 CHECK (delivery_discount_minor >= 0),
  elesend_funded_minor integer NOT NULL DEFAULT 0 CHECK (elesend_funded_minor >= 0),
  restaurant_funded_minor integer NOT NULL DEFAULT 0 CHECK (restaurant_funded_minor >= 0),
  code_used text,
  calculation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, order_id),
  CHECK (total_discount_minor = food_discount_minor + delivery_discount_minor),
  CHECK (total_discount_minor = elesend_funded_minor + restaurant_funded_minor)
);

CREATE INDEX IF NOT EXISTS idx_promotion_redemptions_customer
  ON promotion_redemptions(campaign_id, customer_id, status);
CREATE INDEX IF NOT EXISTS idx_promotion_redemptions_order
  ON promotion_redemptions(order_id, status);
CREATE INDEX IF NOT EXISTS idx_promotion_redemptions_restaurant
  ON promotion_redemptions(restaurant_id, status, created_at DESC);

-- 7. Promotion & Partnership Immutable Audit Logs
CREATE TABLE IF NOT EXISTS promotion_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES promotion_campaigns(id) ON DELETE SET NULL,
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id),
  actor_kind text,
  action text NOT NULL,
  rationale text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_promotion_audit_logs_campaign
  ON promotion_audit_logs(campaign_id, created_at DESC);

-- 8. Extend food_orders with immutable commission & promotion snapshots
ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS food_discount_minor integer NOT NULL DEFAULT 0 CHECK (food_discount_minor >= 0),
  ADD COLUMN IF NOT EXISTS delivery_discount_minor integer NOT NULL DEFAULT 0 CHECK (delivery_discount_minor >= 0),
  ADD COLUMN IF NOT EXISTS restaurant_funded_discount_minor integer NOT NULL DEFAULT 0 CHECK (restaurant_funded_discount_minor >= 0),
  ADD COLUMN IF NOT EXISTS elesend_funded_discount_minor integer NOT NULL DEFAULT 0 CHECK (elesend_funded_discount_minor >= 0),
  ADD COLUMN IF NOT EXISTS customer_food_payable_minor integer,
  ADD COLUMN IF NOT EXISTS customer_delivery_payable_minor integer,
  ADD COLUMN IF NOT EXISTS restaurant_net_settlement_minor integer,
  ADD COLUMN IF NOT EXISTS commission_calculation_basis text NOT NULL DEFAULT 'gross_subtotal',
  ADD COLUMN IF NOT EXISTS commission_base_minor integer,
  ADD COLUMN IF NOT EXISTS commission_rule_id uuid REFERENCES commission_rules(id),
  ADD COLUMN IF NOT EXISTS commission_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS promotion_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS applied_promo_codes text[] NOT NULL DEFAULT '{}';

-- 9. Extend restaurant_settlements to support restaurant-funded discounts and ELESEND subsidies
ALTER TABLE restaurant_settlements
  ADD COLUMN IF NOT EXISTS restaurant_discount_minor integer NOT NULL DEFAULT 0 CHECK (restaurant_discount_minor >= 0),
  ADD COLUMN IF NOT EXISTS elesend_subsidy_minor integer NOT NULL DEFAULT 0 CHECK (elesend_subsidy_minor >= 0),
  ADD COLUMN IF NOT EXISTS commission_basis text NOT NULL DEFAULT 'gross_subtotal',
  ADD COLUMN IF NOT EXISTS commission_base_minor integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS promotion_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE restaurant_settlements DROP CONSTRAINT IF EXISTS restaurant_settlements_check;
ALTER TABLE restaurant_settlements DROP CONSTRAINT IF EXISTS restaurant_settlements_balance_check;
ALTER TABLE restaurant_settlements ADD CONSTRAINT restaurant_settlements_balance_check
  CHECK (gross_sales_minor - restaurant_discount_minor = commission_minor + net_payable_minor);

-- 10. Extend checkout_accounting_lines for platform promotional subsidy expense & multi-line journals
ALTER TABLE checkout_accounting_lines DROP CONSTRAINT IF EXISTS checkout_accounting_lines_line_no_check;
ALTER TABLE checkout_accounting_lines ADD CONSTRAINT checkout_accounting_lines_line_no_check
  CHECK (line_no BETWEEN 1 AND 20);

ALTER TABLE checkout_accounting_lines DROP CONSTRAINT IF EXISTS checkout_accounting_lines_account_check;
ALTER TABLE checkout_accounting_lines ADD CONSTRAINT checkout_accounting_lines_account_check
  CHECK (account IN (
    'provider_receivable',
    'customer_delivery_liability',
    'rider_payable',
    'platform_commission_revenue',
    'customer_refund_liability',
    'restaurant_payable',
    'platform_food_commission_revenue',
    'rider_debt_recovery_clearing',
    'platform_promotion_subsidy_expense'
  ));

-- 11. Grant promotions & commissions permissions to existing admins
INSERT INTO permissions(user_id, permission)
SELECT id, 'promotions:manage' FROM users WHERE kind = 'admin'
ON CONFLICT DO NOTHING;
