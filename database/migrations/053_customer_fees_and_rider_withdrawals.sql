-- Customer-paid payment processing fees, and rider-requested withdrawals covering several deliveries.
ALTER TABLE shipment_checkout_intents
  ADD COLUMN IF NOT EXISTS processing_fee_minor bigint NOT NULL DEFAULT 0 CHECK (processing_fee_minor >= 0);

CREATE OR REPLACE FUNCTION guard_checkout_processing_fee() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.processing_fee_minor IS DISTINCT FROM OLD.processing_fee_minor THEN RAISE EXCEPTION 'Checkout financial terms immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER checkout_processing_fee_guard BEFORE UPDATE ON shipment_checkout_intents
  FOR EACH ROW EXECUTE FUNCTION guard_checkout_processing_fee();

-- Food totals exclude the customer's processing fee, which the payment intent adds on top.
CREATE OR REPLACE FUNCTION guard_prepaid_food() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.payment_method IS DISTINCT FROM OLD.payment_method THEN
  IF NEW.payment_method NOT IN ('MOMO','CARD','QR') THEN
   RAISE EXCEPTION 'Food orders require upfront digital payment' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.payment_status='PAID' OR NEW.state IN ('ACCEPTED','PREPARING','READY_FOR_PICKUP','IN_TRANSIT','DELIVERED') THEN
  IF NEW.payment_method='CASH' OR NOT EXISTS(
   SELECT 1 FROM shipments s JOIN shipment_checkout_intents i ON i.shipment_id=s.id
   WHERE s.id=NEW.shipment_id AND i.status='confirmed' AND i.amount_minor-i.processing_fee_minor=NEW.total_minor
  ) THEN RAISE EXCEPTION 'Verified full food payment required' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_food_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE food food_orders%ROWTYPE;
BEGIN
 SELECT * INTO food FROM food_orders WHERE shipment_id=NEW.id;
 IF FOUND AND (NEW.rider_id IS DISTINCT FROM OLD.rider_id OR NEW.state IS DISTINCT FROM OLD.state)
  AND NEW.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','COMPLETED') THEN
  IF NOT NEW.paid OR NEW.payment_method='CASH' OR food.payment_status<>'PAID'
   OR food.state NOT IN ('ACCEPTED','PREPARING','READY_FOR_PICKUP','IN_TRANSIT','DELIVERED')
   OR NOT EXISTS(SELECT 1 FROM shipment_checkout_intents WHERE shipment_id=NEW.id AND status='confirmed' AND amount_minor-processing_fee_minor=food.total_minor)
  THEN RAISE EXCEPTION 'Food assignment requires verified payment and kitchen acceptance' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;

DO $$
DECLARE constraint_name text; definition text;
BEGIN
  SELECT conname, pg_get_constraintdef(oid) INTO constraint_name, definition FROM pg_constraint
   WHERE conrelid='checkout_accounting_lines'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%provider_receivable%';
  EXECUTE format('ALTER TABLE checkout_accounting_lines DROP CONSTRAINT %I', constraint_name);
  EXECUTE 'ALTER TABLE checkout_accounting_lines ADD CONSTRAINT checkout_accounting_lines_account_check ' ||
    replace(definition, '''provider_receivable''::text', '''provider_receivable''::text, ''customer_processing_fee_liability''::text');
END $$;

CREATE TABLE IF NOT EXISTS rider_withdrawals (
  id uuid PRIMARY KEY,
  rider_id uuid NOT NULL REFERENCES riders(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  provider text NOT NULL,
  recipient_reference text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL DEFAULT 'GHS',
  status text NOT NULL DEFAULT 'initiating' CHECK (status IN ('awaiting_approval','initiating','pending','needs_review','paid','failed','rejected')),
  approved_by uuid REFERENCES users(id),
  provider_id text,
  failure_reason text,
  submitted_at timestamptz,
  last_reconciled_at timestamptz,
  reconcile_lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rider_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS rider_withdrawals_open ON rider_withdrawals(status, updated_at);
-- A rider can only have one withdrawal moving at a time.
CREATE UNIQUE INDEX IF NOT EXISTS rider_withdrawals_one_open ON rider_withdrawals(rider_id)
  WHERE status IN ('awaiting_approval','initiating','pending','needs_review');

-- Each delivery keeps its own ledger row, linked to the single transfer that pays it.
ALTER TABLE payout_operations ADD COLUMN IF NOT EXISTS withdrawal_id uuid REFERENCES rider_withdrawals(id);
CREATE INDEX IF NOT EXISTS payout_operations_withdrawal ON payout_operations(withdrawal_id) WHERE withdrawal_id IS NOT NULL;
