-- Customer-paid payment processing fees, and automatic withdrawals sent through the payment provider.
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
    replace(definition, '''provider_receivable''::text', '''provider_receivable''::text, ''customer_processing_fee_liability''::text, ''company_commission_receivable''::text');
END $$;

-- Sign-in or destination changes start a security hold on withdrawals.
ALTER TABLE users ADD COLUMN IF NOT EXISTS credentials_changed_at timestamptz;
CREATE OR REPLACE FUNCTION mark_credentials_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.phone IS DISTINCT FROM OLD.phone THEN
    NEW.credentials_changed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_mark_credentials_changed BEFORE UPDATE OF password_hash, phone ON users
  FOR EACH ROW EXECUTE FUNCTION mark_credentials_changed();
ALTER TABLE payout_beneficiaries ADD COLUMN IF NOT EXISTS destination_changed_at timestamptz;

DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
   WHERE conrelid='checkout_accounting_journals'::regclass AND conname='checkout_accounting_journals_kind_check';
  ALTER TABLE checkout_accounting_journals DROP CONSTRAINT checkout_accounting_journals_kind_check;
  EXECUTE 'ALTER TABLE checkout_accounting_journals ADD CONSTRAINT checkout_accounting_journals_kind_check ' ||
    replace(definition, '''payout_completed''::text', '''payout_completed''::text, ''payout_reversed''::text, ''company_commission_assessed''::text, ''company_commission_recovered''::text');
END $$;

CREATE TABLE IF NOT EXISTS payout_withdrawals (
  id uuid PRIMARY KEY,
  beneficiary_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  provider text NOT NULL,
  recipient_reference text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0), -- what the transfer sends, after the fee
  fee_minor bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  currency text NOT NULL DEFAULT 'GHS',
  status text NOT NULL DEFAULT 'initiating' CHECK (status IN ('initiating','pending','needs_review','paid','failed','reversed')),
  provider_id text,
  failure_reason text,
  submitted_at timestamptz,
  last_reconciled_at timestamptz,
  reconcile_lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (beneficiary_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS payout_withdrawals_open ON payout_withdrawals(status, updated_at);
CREATE INDEX IF NOT EXISTS payout_withdrawals_recent ON payout_withdrawals(created_at) WHERE status NOT IN ('failed','reversed');
-- Only one withdrawal per person can be moving at a time.
CREATE UNIQUE INDEX IF NOT EXISTS payout_withdrawals_one_open ON payout_withdrawals(beneficiary_id)
  WHERE status IN ('initiating','pending','needs_review');

-- One withdrawal per person per day (UTC, which is Ghana time). Failed or reversed ones do not count.
CREATE UNIQUE INDEX IF NOT EXISTS payout_withdrawals_once_a_day ON payout_withdrawals(beneficiary_id, ((created_at AT TIME ZONE 'UTC')::date))
  WHERE status NOT IN ('failed','reversed');

-- Who is paid, and how much, can never change. Finished withdrawals cannot restart.
CREATE OR REPLACE FUNCTION guard_payout_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Withdrawal records are permanent'; END IF;
  IF (NEW.id, NEW.beneficiary_id, NEW.provider, NEW.recipient_reference, NEW.amount_minor, NEW.fee_minor, NEW.currency)
     IS DISTINCT FROM (OLD.id, OLD.beneficiary_id, OLD.provider, OLD.recipient_reference, OLD.amount_minor, OLD.fee_minor, OLD.currency) THEN
    RAISE EXCEPTION 'Withdrawal terms immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (
       OLD.status IN ('failed','reversed') OR (OLD.status = 'paid' AND NEW.status <> 'reversed')
     ) THEN
    RAISE EXCEPTION 'Withdrawal already finished';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payout_withdrawal_guard BEFORE UPDATE OR DELETE ON payout_withdrawals
  FOR EACH ROW EXECUTE FUNCTION guard_payout_withdrawal();

-- Each delivery keeps its own ledger row, linked to the single transfer that pays it.
ALTER TABLE payout_operations ADD COLUMN IF NOT EXISTS withdrawal_id uuid REFERENCES payout_withdrawals(id);
CREATE INDEX IF NOT EXISTS payout_operations_withdrawal ON payout_operations(withdrawal_id) WHERE withdrawal_id IS NOT NULL;

-- Cash commission is due at the weekly Monday cutoff, with 24 hours of grace.
ALTER TABLE weekly_settlement_settings ALTER COLUMN grace_hours SET DEFAULT 24;
UPDATE weekly_settlement_settings SET grace_hours=24 WHERE grace_hours=0;

-- The sender's SMS code proves that a failed parcel came back.
ALTER TABLE challenges DROP CONSTRAINT challenges_purpose_check;
ALTER TABLE challenges ADD CONSTRAINT challenges_purpose_check CHECK (purpose IN ('pickup','delivery','return'));

-- Parcels held too long after pickup: the rider is suspended and the evidence is frozen for any police report.
CREATE TABLE IF NOT EXISTS parcel_custody_incidents (
  id uuid PRIMARY KEY,
  shipment_id uuid NOT NULL UNIQUE REFERENCES shipments(id),
  rider_id uuid NOT NULL REFERENCES riders(id),
  evidence jsonb NOT NULL,
  outcome text CHECK (outcome IN ('police_reported','recovered','false_alarm')),
  outcome_reason text,
  police_reference text,
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  opened_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION guard_custody_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.evidence IS DISTINCT FROM OLD.evidence OR NEW.rider_id IS DISTINCT FROM OLD.rider_id
     OR NEW.shipment_id IS DISTINCT FROM OLD.shipment_id OR NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
    RAISE EXCEPTION 'Custody evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custody_evidence_guard BEFORE UPDATE OR DELETE ON parcel_custody_incidents
  FOR EACH ROW EXECUTE FUNCTION guard_custody_evidence();

-- Identity is required before a rider can be approved.
CREATE TABLE IF NOT EXISTS rider_licences (
  rider_id uuid PRIMARY KEY REFERENCES riders(id),
  document_type text NOT NULL CHECK (document_type IN ('drivers_licence','ghana_card')),
  legal_name text NOT NULL,
  number_encrypted text NOT NULL,
  number_hash text NOT NULL UNIQUE,
  licence_class text,
  expires_on date NOT NULL,
  vehicle_plate text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  rejection_reason text,
  valid_until date,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  submitted_at timestamptz NOT NULL DEFAULT now()
);
-- Riders approved before this check must submit a licence and be reviewed again.
UPDATE riders SET status='pending',online=false WHERE status='approved';

-- Result of the hosted photo, selfie and liveness check. The images stay with the provider.
ALTER TABLE rider_licences
  ADD COLUMN IF NOT EXISTS identity_session_id uuid UNIQUE,
  ADD COLUMN IF NOT EXISTS identity_status text NOT NULL DEFAULT 'not_started'
    CHECK (identity_status IN ('not_started','in_progress','approved','failed')),
  ADD COLUMN IF NOT EXISTS identity_reason text,
  ADD COLUMN IF NOT EXISTS identity_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS rider_licences_identity_open ON rider_licences(identity_checked_at) WHERE identity_status='in_progress';

-- Documents Bolt asks of drivers in Ghana. Images are encrypted by the application.
CREATE TABLE IF NOT EXISTS rider_documents (
  rider_id uuid NOT NULL REFERENCES riders(id),
  kind text NOT NULL CHECK (kind IN ('profile_photo','insurance','roadworthiness')),
  data_encrypted text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  expires_on date,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  rejection_reason text,
  valid_until date,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rider_id, kind)
);
CREATE TABLE IF NOT EXISTS rider_document_links (
  token_hash text PRIMARY KEY,
  rider_id uuid NOT NULL REFERENCES riders(id),
  expires_at timestamptz NOT NULL
);
