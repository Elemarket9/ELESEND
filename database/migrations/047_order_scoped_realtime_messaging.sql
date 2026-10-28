-- Migration 047: Order-Scoped Real-Time Chat, Customer Communication, and Order Messaging Engine

-- 1. Administrator-Configurable Messaging & Retention Policy
CREATE TABLE IF NOT EXISTS chat_messaging_policy (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  post_delivery_resolution_minutes integer NOT NULL DEFAULT 15 CHECK (post_delivery_resolution_minutes BETWEEN 0 AND 1440),
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 7 AND 3650),
  max_message_length integer NOT NULL DEFAULT 1000 CHECK (max_message_length BETWEEN 50 AND 4000),
  rate_limit_per_minute integer NOT NULL DEFAULT 25 CHECK (rate_limit_per_minute BETWEEN 3 AND 200),
  allow_location_pins boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO chat_messaging_policy (id, post_delivery_resolution_minutes, retention_days, max_message_length, rate_limit_per_minute, allow_location_pins)
VALUES (true, 15, 90, 1000, 25, true)
ON CONFLICT (id) DO NOTHING;

-- 2. Order-Scoped Conversations
CREATE TABLE IF NOT EXISTS chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_type text NOT NULL CHECK (
    conversation_type IN ('CUSTOMER_RIDER', 'CUSTOMER_RESTAURANT', 'RIDER_RESTAURANT', 'CUSTOMER_SUPPORT')
  ),
  shipment_id uuid REFERENCES shipments(id) ON DELETE CASCADE,
  food_order_id uuid REFERENCES food_orders(id) ON DELETE CASCADE,
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES users(id),
  active_rider_id uuid REFERENCES riders(id),
  assignment_epoch integer NOT NULL DEFAULT 1 CHECK (assignment_epoch >= 1),
  support_category text CHECK (
    support_category IS NULL OR support_category IN (
      'order_issue', 'rider_issue', 'restaurant_issue', 'address_change_request',
      'payment_dispute', 'safety_report', 'general'
    )
  ),
  escalated_from_conversation_id uuid REFERENCES chat_conversations(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (
    state IN ('CREATED', 'ACTIVE', 'RESTRICTED', 'CLOSED', 'ARCHIVED')
  ),
  restricted_after timestamptz,
  closed_at timestamptz,
  archived_at timestamptz,
  retention_expires_at timestamptz,
  last_message_seq bigint NOT NULL DEFAULT 0 CHECK (last_message_seq >= 0),
  last_message_at timestamptz,
  last_message_preview text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (shipment_id IS NOT NULL OR food_order_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_shipment
  ON chat_conversations(shipment_id, conversation_type, state);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_food_order
  ON chat_conversations(food_order_id, conversation_type, state);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_restaurant
  ON chat_conversations(restaurant_id, state, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_customer
  ON chat_conversations(customer_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_rider
  ON chat_conversations(active_rider_id, state, updated_at DESC);

-- 3. Conversation Participant Membership & Read/Delivery Watermarks
CREATE TABLE IF NOT EXISTS chat_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('customer', 'rider', 'restaurant', 'support', 'admin')),
  membership_status text NOT NULL DEFAULT 'active' CHECK (membership_status IN ('active', 'revoked', 'left')),
  muted boolean NOT NULL DEFAULT false,
  last_read_seq bigint NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  last_read_at timestamptz,
  last_delivered_seq bigint NOT NULL DEFAULT 0 CHECK (last_delivered_seq >= 0),
  last_delivered_at timestamptz,
  joined_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_reason text,
  UNIQUE (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_participants_user_active
  ON chat_participants(user_id, membership_status, conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_participants_conv_active
  ON chat_participants(conversation_id, membership_status);

-- 4. Durable Ordered Messages with Idempotency & Verifiable Delivery/Read States
CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  seq bigint NOT NULL CHECK (seq >= 1),
  sender_id uuid NOT NULL REFERENCES users(id),
  sender_role text NOT NULL CHECK (sender_role IN ('customer', 'rider', 'restaurant', 'support', 'admin', 'system')),
  client_message_id text NOT NULL CHECK (length(trim(client_message_id)) BETWEEN 4 AND 120),
  message_type text NOT NULL DEFAULT 'text' CHECK (
    message_type IN ('text', 'quick_reply', 'location_pin', 'system_notice')
  ),
  body text NOT NULL CHECK (length(trim(body)) >= 1 AND length(body) <= 4000),
  quick_reply_key text,
  location_pin jsonb,
  delivery_status text NOT NULL DEFAULT 'SENT' CHECK (delivery_status IN ('SENT', 'DELIVERED', 'READ')),
  delivered_at timestamptz,
  read_at timestamptz,
  moderation_status text NOT NULL DEFAULT 'clean' CHECK (moderation_status IN ('clean', 'flagged', 'redacted')),
  otp_warning boolean NOT NULL DEFAULT false,
  address_change_warning boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, sender_id, client_message_id),
  UNIQUE (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conv_seq
  ON chat_messages(conversation_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conv_unread
  ON chat_messages(conversation_id, sender_id, seq) WHERE delivery_status <> 'READ';

-- 5. Abuse Reporting & Support Escalation Records
CREATE TABLE IF NOT EXISTS chat_abuse_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  message_id uuid REFERENCES chat_messages(id) ON DELETE SET NULL,
  reporter_id uuid NOT NULL REFERENCES users(id),
  reporter_role text NOT NULL CHECK (reporter_role IN ('customer', 'rider', 'restaurant', 'support', 'admin')),
  category text NOT NULL CHECK (
    category IN (
      'harassment', 'threats', 'fraudulent_payment_request',
      'unsafe_delivery_instructions', 'inappropriate_messages',
      'spam', 'disputed_order_info'
    )
  ),
  details text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'dismissed')),
  assigned_support_id uuid REFERENCES users(id),
  resolution_notes text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_abuse_reports_status
  ON chat_abuse_reports(status, created_at DESC);

-- 6. Immutable Messaging Security & Support Access Audit Logs
CREATE TABLE IF NOT EXISTS chat_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES chat_conversations(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id),
  actor_role text,
  action text NOT NULL,
  justification text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_audit_logs_conv
  ON chat_audit_logs(conversation_id, created_at DESC);

-- 7. Trigger: Automatic Rider Revocation & Lifecycle Sync on Shipment Reassignment or Completion
CREATE OR REPLACE FUNCTION sync_chat_on_shipment_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  res_mins integer := 15;
  ret_days integer := 90;
BEGIN
  SELECT post_delivery_resolution_minutes, retention_days
    INTO res_mins, ret_days
    FROM chat_messaging_policy WHERE id = true;
  res_mins := COALESCE(res_mins, 15);
  ret_days := COALESCE(ret_days, 90);

  -- A) Rider unassigned or changed: immediately revoke previous rider's chat membership and close rider-scoped threads
  IF OLD.rider_id IS DISTINCT FROM NEW.rider_id AND OLD.rider_id IS NOT NULL THEN
    UPDATE chat_participants p
       SET membership_status = 'revoked',
           revoked_at = now(),
           revoked_reason = 'shipment_rider_reassigned'
      FROM chat_conversations c
     WHERE p.conversation_id = c.id
       AND c.shipment_id = NEW.id
       AND p.user_id = OLD.rider_id
       AND p.membership_status = 'active';

    UPDATE chat_conversations
       SET state = 'CLOSED',
           closed_at = COALESCE(closed_at, now()),
           retention_expires_at = COALESCE(retention_expires_at, now() + (ret_days || ' days')::interval),
           updated_at = now()
     WHERE shipment_id = NEW.id
       AND active_rider_id = OLD.rider_id
       AND conversation_type IN ('CUSTOMER_RIDER', 'RIDER_RESTAURANT')
       AND state NOT IN ('CLOSED', 'ARCHIVED');

    -- Expire any pending push notifications for the unassigned rider on this shipment's chats
    UPDATE notification_jobs
       SET state = 'expired',
           lease_until = NULL
     WHERE recipient_id = OLD.rider_id
       AND kind = 'chat_message'
       AND state IN ('pending', 'sending')
       AND (payload->>'shipmentId') = NEW.id::text;

    INSERT INTO chat_audit_logs(conversation_id, actor_id, actor_role, action, justification, metadata)
    SELECT id, NULL, 'system', 'chat.rider_revoked_on_reassignment', 'Shipment rider changed or unassigned',
           jsonb_build_object('shipmentId', NEW.id, 'previousRiderId', OLD.rider_id, 'newRiderId', NEW.rider_id)
      FROM chat_conversations
     WHERE shipment_id = NEW.id AND active_rider_id = OLD.rider_id;
  END IF;

  -- B) Delivery completed: set post-delivery resolution window on non-support threads
  IF OLD.state IS DISTINCT FROM NEW.state AND NEW.state = 'COMPLETED' THEN
    UPDATE chat_conversations
       SET restricted_after = now() + (res_mins || ' minutes')::interval,
           retention_expires_at = now() + (ret_days || ' days')::interval,
           state = CASE WHEN res_mins = 0 THEN 'RESTRICTED' ELSE state END,
           updated_at = now()
     WHERE shipment_id = NEW.id
       AND conversation_type IN ('CUSTOMER_RIDER', 'CUSTOMER_RESTAURANT', 'RIDER_RESTAURANT')
       AND state IN ('CREATED', 'ACTIVE');
  END IF;

  -- C) Shipment cancelled or returned: restrict/close operational threads immediately
  IF OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('CANCELLED', 'RETURNED') THEN
    UPDATE chat_conversations
       SET state = 'CLOSED',
           closed_at = COALESCE(closed_at, now()),
           restricted_after = COALESCE(restricted_after, now()),
           retention_expires_at = COALESCE(retention_expires_at, now() + (ret_days || ' days')::interval),
           updated_at = now()
     WHERE shipment_id = NEW.id
       AND conversation_type IN ('CUSTOMER_RIDER', 'CUSTOMER_RESTAURANT', 'RIDER_RESTAURANT')
       AND state NOT IN ('CLOSED', 'ARCHIVED');
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS chat_shipment_lifecycle_sync ON shipments;
CREATE TRIGGER chat_shipment_lifecycle_sync
  AFTER UPDATE OF rider_id, state ON shipments
  FOR EACH ROW
  EXECUTE FUNCTION sync_chat_on_shipment_change();

-- 8. Grant support & moderation permissions to existing admins
INSERT INTO permissions(user_id, permission)
SELECT id, 'support:chat' FROM users WHERE kind = 'admin'
ON CONFLICT DO NOTHING;

INSERT INTO permissions(user_id, permission)
SELECT id, 'support:moderate' FROM users WHERE kind = 'admin'
ON CONFLICT DO NOTHING;
