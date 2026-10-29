-- Migration 048: Operational Reliability, Live Tracking, Watchdog Escalation,
-- Background Offer Alerts, Item/Partial Dispute Refunds, Account Recovery, and Multi-Instance Realtime

-- 1. Account Recovery Challenges (Rate-limited, Expiring SMS/OTP Password Reset)
CREATE TABLE IF NOT EXISTS account_recovery_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone text NOT NULL,
  digest text NOT NULL,
  sent boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_account_recovery_user_created
  ON account_recovery_challenges(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_recovery_phone_created
  ON account_recovery_challenges(phone, created_at DESC);

-- 2. Mobile Push & Background Alert Tokens (Rider & Customer Device Channels)
CREATE TABLE IF NOT EXISTS user_push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform text NOT NULL DEFAULT 'expo' CHECK (platform IN ('expo', 'fcm', 'apns', 'android', 'ios', 'web')),
  app_scope text NOT NULL DEFAULT 'rider' CHECK (app_scope IN ('rider', 'customer', 'restaurant')),
  push_token text NOT NULL CHECK (length(trim(push_token)) BETWEEN 8 AND 512),
  channel_id text NOT NULL DEFAULT 'elesend-rider-offers',
  device_id text,
  session_token_hash text,
  app_state text NOT NULL DEFAULT 'active' CHECK (app_state IN ('active', 'background', 'inactive')),
  battery_saver_enabled boolean NOT NULL DEFAULT false,
  background_location_enabled boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (push_token)
);

ALTER TABLE user_push_tokens
  ADD COLUMN IF NOT EXISTS session_token_hash text;

DELETE FROM user_push_tokens a
USING user_push_tokens b
WHERE a.push_token = b.push_token
  AND (a.updated_at < b.updated_at OR (a.updated_at = b.updated_at AND a.id < b.id));

DELETE FROM user_push_tokens a
USING user_push_tokens b
WHERE a.device_id IS NOT NULL
  AND b.device_id IS NOT NULL
  AND a.app_scope = b.app_scope
  AND a.device_id = b.device_id
  AND (a.updated_at < b.updated_at OR (a.updated_at = b.updated_at AND a.id < b.id));

ALTER TABLE user_push_tokens
  DROP CONSTRAINT IF EXISTS user_push_tokens_user_id_push_token_key;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_push_tokens_push_token_key'
  ) THEN
    ALTER TABLE user_push_tokens
      ADD CONSTRAINT user_push_tokens_push_token_key UNIQUE (push_token);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_push_tokens_scope_device
  ON user_push_tokens(app_scope, device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_push_tokens_user_active
  ON user_push_tokens(user_id, active, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_push_tokens_session_hash
  ON user_push_tokens(session_token_hash) WHERE session_token_hash IS NOT NULL;

-- 3. Missing-Item & Partial-Refund Dispute Resolution
ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_status_check;
ALTER TABLE disputes ADD CONSTRAINT disputes_status_check
  CHECK (status IN ('open', 'resolved', 'dismissed'));

ALTER TABLE disputes
  ADD COLUMN IF NOT EXISTS items_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS requested_refund_minor bigint CHECK (requested_refund_minor IS NULL OR requested_refund_minor > 0),
  ADD COLUMN IF NOT EXISTS approved_refund_minor bigint CHECK (approved_refund_minor IS NULL OR approved_refund_minor >= 0),
  ADD COLUMN IF NOT EXISTS resolution_notes text,
  ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

ALTER TABLE food_order_items
  ADD COLUMN IF NOT EXISTS refunded_quantity integer NOT NULL DEFAULT 0
  CHECK (refunded_quantity >= 0 AND refunded_quantity <= quantity);

CREATE TABLE IF NOT EXISTS dispute_refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid UNIQUE NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  shipment_id uuid NOT NULL REFERENCES shipments(id),
  food_order_id uuid REFERENCES food_orders(id),
  intent_id uuid NOT NULL REFERENCES shipment_checkout_intents(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  items_subtotal_refund_minor bigint NOT NULL DEFAULT 0 CHECK (items_subtotal_refund_minor >= 0),
  commission_refund_minor bigint NOT NULL DEFAULT 0 CHECK (commission_refund_minor >= 0),
  merchant_net_deduction_minor bigint NOT NULL DEFAULT 0 CHECK (merchant_net_deduction_minor >= 0),
  delivery_fee_refund_minor bigint NOT NULL DEFAULT 0 CHECK (delivery_fee_refund_minor >= 0),
  items_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'submitted', 'refunded')),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dispute_refund_requests_shipment
  ON dispute_refund_requests(shipment_id, status);

ALTER TABLE restaurant_settlements
  ADD COLUMN IF NOT EXISTS refunded_gross_minor integer NOT NULL DEFAULT 0
  CHECK (refunded_gross_minor >= 0);

ALTER TABLE restaurant_settlements DROP CONSTRAINT IF EXISTS restaurant_settlements_balance_check;
ALTER TABLE restaurant_settlements ADD CONSTRAINT restaurant_settlements_balance_check
  CHECK (gross_sales_minor - restaurant_discount_minor - refunded_gross_minor = commission_minor + net_payable_minor);

ALTER TABLE food_orders DROP CONSTRAINT IF EXISTS food_orders_payment_status_check;
ALTER TABLE food_orders ADD CONSTRAINT food_orders_payment_status_check
  CHECK (payment_status IN ('PENDING', 'PAID', 'PARTIALLY_REFUNDED', 'FAILED', 'REFUNDED'));

ALTER TABLE checkout_accounting_journals DROP CONSTRAINT IF EXISTS checkout_accounting_journals_kind_check;
ALTER TABLE checkout_accounting_journals ADD CONSTRAINT checkout_accounting_journals_kind_check
  CHECK (kind IN ('psp_verified', 'delivery_completed', 'verified_unapplied', 'refund_requested', 'refund_completed', 'payout_completed', 'rider_debt_recovered', 'dispute_refund_requested'));

-- 4. Watchdog Fair Inspection Scheduling & Anti-Starvation Tracking
ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS watchdog_last_inspected_at timestamptz,
  ADD COLUMN IF NOT EXISTS watchdog_next_review_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_shipments_watchdog_review
  ON shipments(watchdog_next_review_at ASC NULLS FIRST, watchdog_last_inspected_at ASC NULLS FIRST, created_at ASC)
  WHERE rider_id IS NOT NULL AND state IN ('RIDER_ASSIGNED', 'PICKUP_VERIFIED', 'IN_TRANSIT', 'AWAITING_DELIVERY_OTP');

ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS watchdog_last_inspected_at timestamptz,
  ADD COLUMN IF NOT EXISTS watchdog_next_review_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_food_orders_watchdog_review
  ON food_orders(watchdog_next_review_at ASC NULLS FIRST, watchdog_last_inspected_at ASC NULLS FIRST, created_at ASC)
  WHERE state IN ('ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'IN_TRANSIT');

-- 5. Transactional Chat Realtime Outbox (Publish Only After Commit with Expiring Lease)
CREATE TABLE IF NOT EXISTS chat_realtime_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  recipient_user_ids uuid[] NOT NULL,
  payload jsonb NOT NULL,
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE chat_realtime_outbox
  ADD COLUMN IF NOT EXISTS claimed_by text,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text;

DROP INDEX IF EXISTS idx_chat_realtime_outbox_unpublished;
CREATE INDEX IF NOT EXISTS idx_chat_realtime_outbox_unpublished
  ON chat_realtime_outbox(lease_expires_at ASC NULLS FIRST, created_at ASC)
  WHERE published_at IS NULL;
