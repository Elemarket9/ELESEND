-- Customer checkout lifecycle hardening:
-- 1. Add 'expired' status for checkout window expiry without treating non-terminal PSP states ('abandoned', 'pending') as definitive failure.
-- 2. Add database-backed submission ownership (submission_token, submission_lease_until) and reconciliation leases (reconcile_lease_until).
-- 3. Track verified terminal provider outcomes (provider_terminal_at, provider_last_status) so expired/uncertain attempts keep polling until resolved.
-- 4. Guard state transitions so failed/expired attempts cannot be resurrected to pending/initiating, while allowing late verified payments to confirm.

ALTER TABLE shipment_checkout_intents DROP CONSTRAINT IF EXISTS shipment_checkout_intents_status_check;
ALTER TABLE shipment_checkout_intents ADD CONSTRAINT shipment_checkout_intents_status_check
 CHECK(status IN ('initiating','pending','confirmed','failed','expired'));

ALTER TABLE shipment_checkout_intents
 ADD COLUMN IF NOT EXISTS payer_email text,
 ADD COLUMN IF NOT EXISTS failure_reason text,
 ADD COLUMN IF NOT EXISTS failed_at timestamptz,
 ADD COLUMN IF NOT EXISTS submission_token uuid,
 ADD COLUMN IF NOT EXISTS submission_lease_until timestamptz,
 ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
 ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz,
 ADD COLUMN IF NOT EXISTS reconcile_lease_until timestamptz,
 ADD COLUMN IF NOT EXISTS provider_terminal_at timestamptz,
 ADD COLUMN IF NOT EXISTS provider_last_status text;

CREATE OR REPLACE FUNCTION guard_checkout_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.id,OLD.shipment_id,OLD.customer_id,OLD.method,OLD.provider,OLD.reference,
   OLD.amount_minor,OLD.currency,OLD.idempotency_key,OLD.created_at) IS DISTINCT FROM
    (NEW.id,NEW.shipment_id,NEW.customer_id,NEW.method,NEW.provider,NEW.reference,
   NEW.amount_minor,NEW.currency,NEW.idempotency_key,NEW.created_at)
 THEN RAISE EXCEPTION 'Checkout financial terms immutable'; END IF;
 IF OLD.status='confirmed' AND NEW.status<>'confirmed' THEN RAISE EXCEPTION 'Confirmed checkout immutable'; END IF;
 IF OLD.status IN ('failed','expired') AND NEW.status NOT IN (OLD.status,'confirmed') THEN
  RAISE EXCEPTION 'Inactive checkout intent (%) cannot be resurrected to %', OLD.status, NEW.status USING ERRCODE='23514';
 END IF;
 IF OLD.status='pending' AND NEW.status='initiating' THEN RAISE EXCEPTION 'Invalid checkout rollback'; END IF;
 IF OLD.status='initiating' AND NEW.status='pending' AND EXISTS (
  SELECT 1 FROM shipment_checkout_intents
   WHERE shipment_id=NEW.shipment_id
     AND status IN ('initiating','pending')
     AND id<>NEW.id
 ) THEN
  RAISE EXCEPTION 'Another active checkout attempt already exists for this shipment' USING ERRCODE='23505';
 END IF;
 RETURN NEW;
END $$;

UPDATE shipment_checkout_intents
   SET submitted_at = coalesce(submitted_at, created_at)
 WHERE submitted_at IS NULL;

UPDATE shipment_checkout_intents
   SET provider_terminal_at = coalesce(confirmed_at, updated_at, now()),
       provider_last_status = coalesce(provider_last_status, 'success')
 WHERE status = 'confirmed'
   AND provider_terminal_at IS NULL;

DROP INDEX IF EXISTS checkout_reconcile_due;
CREATE INDEX IF NOT EXISTS checkout_reconcile_due
 ON shipment_checkout_intents(provider, status, coalesce(last_reconciled_at, submitted_at, updated_at, created_at))
 WHERE provider_terminal_at IS NULL;
