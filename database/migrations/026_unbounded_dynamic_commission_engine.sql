-- 026_unbounded_dynamic_commission_engine.sql
-- Removes hardcoded 20% (delivery) and 30% (restaurant) ceilings.
-- Establishes fully dynamic 0.00% to 100.00% (0 - 10000 bps) range.
-- Establishes commission_rules and commission_audit_logs tables for rule precedence and campaigns.

ALTER TABLE pricing_policies DROP CONSTRAINT IF EXISTS pricing_policies_commission_bps_check;
ALTER TABLE pricing_policies ADD CONSTRAINT pricing_policies_commission_bps_check CHECK (commission_bps BETWEEN 0 AND 10000);

ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_food_commission_bps_check;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_food_commission_bps_check CHECK (food_commission_bps BETWEEN 0 AND 10000);

ALTER TABLE food_orders DROP CONSTRAINT IF EXISTS food_orders_food_commission_bps_check;
ALTER TABLE food_orders ADD CONSTRAINT food_orders_food_commission_bps_check CHECK (food_commission_bps BETWEEN 0 AND 10000);

ALTER TABLE restaurant_settlements DROP CONSTRAINT IF EXISTS restaurant_settlements_commission_bps_check;
ALTER TABLE restaurant_settlements ADD CONSTRAINT restaurant_settlements_commission_bps_check CHECK (commission_bps BETWEEN 0 AND 10000);

CREATE TABLE IF NOT EXISTS commission_rules (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL CHECK(category IN ('delivery_default', 'restaurant_default', 'vehicle_tariff', 'rider_delivery', 'merchant_delivery', 'restaurant_food', 'corporate_delivery', 'promotional_campaign', 'founding_rider')),
  scope_type text NOT NULL CHECK(scope_type IN ('global', 'vehicle', 'rider', 'merchant', 'restaurant', 'campaign')),
  scope_id text,
  rate_bps integer NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  max_orders integer,
  applied_orders integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'expired', 'revoked')),
  reason text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commission_rules_scope ON commission_rules(scope_type, scope_id, status);
CREATE INDEX IF NOT EXISTS idx_commission_rules_category ON commission_rules(category, status);

CREATE TABLE IF NOT EXISTS commission_audit_logs (
  id uuid PRIMARY KEY,
  rule_id uuid REFERENCES commission_rules(id),
  action text NOT NULL CHECK(action IN ('created', 'updated', 'paused', 'resumed', 'revoked', 'applied')),
  actor_id uuid REFERENCES users(id),
  previous_rate_bps integer,
  new_rate_bps integer,
  rationale text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commission_audit_logs_rule ON commission_audit_logs(rule_id);
