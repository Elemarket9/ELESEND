-- Corrective migration 037:
-- 1. Restore any commission settlement intents that migration 036 marked 'expired' without provider evidence.
-- 2. Add database-backed submission ownership columns (submission_token, submission_lease_until).
-- 3. Enforce guarded state transitions and prevent overlapping active attempts without discarding historical pending intents.

ALTER TABLE settlement_intents
 ADD COLUMN IF NOT EXISTS submission_token uuid,
 ADD COLUMN IF NOT EXISTS submission_lease_until timestamptz;

DROP INDEX IF EXISTS settlement_intents_one_active;

UPDATE settlement_intents
   SET status = 'pending',
       failure_reason = NULL,
       failed_at = NULL,
       updated_at = now()
 WHERE status = 'expired'
   AND (
     failure_reason LIKE 'Superseded by newer pending settlement intent%'
     OR last_reconciled_at IS NULL
   );

DROP INDEX IF EXISTS settlement_intents_reconcile_due;
CREATE INDEX IF NOT EXISTS settlement_intents_reconcile_due
 ON settlement_intents(provider, status, updated_at)
 WHERE status IN ('initiating', 'pending', 'expired');

CREATE OR REPLACE FUNCTION guard_settlement_intent_transitions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  PERFORM 1 FROM commission_accounts WHERE rider_id = NEW.rider_id FOR UPDATE;
  IF NEW.status IN ('initiating', 'pending') AND EXISTS (
   SELECT 1 FROM settlement_intents
    WHERE rider_id = NEW.rider_id
      AND kind = NEW.kind
      AND status IN ('initiating', 'pending')
      AND id <> NEW.id
  ) THEN
   RAISE EXCEPTION 'An existing commission payment attempt is pending; verify or complete it before starting another'
    USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
 END IF;

 IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
  IF OLD.status = 'confirmed' AND NEW.status NOT IN ('confirmed', 'reversed') THEN
   RAISE EXCEPTION 'Confirmed commission payment intent cannot transition to %', NEW.status
    USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'reversed' AND NEW.status <> 'reversed' THEN
   RAISE EXCEPTION 'Reversed commission payment intent cannot transition to %', NEW.status
    USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('failed', 'rejected', 'expired') AND NEW.status <> 'confirmed' THEN
   RAISE EXCEPTION 'Inactive commission payment intent (%) cannot be resurrected to %', OLD.status, NEW.status
    USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'initiating' AND NEW.status = 'pending' AND EXISTS (
   SELECT 1 FROM settlement_intents
    WHERE rider_id = NEW.rider_id
      AND kind = NEW.kind
      AND status IN ('initiating', 'pending')
      AND id <> NEW.id
  ) THEN
   RAISE EXCEPTION 'Another active commission payment attempt already exists for this rider'
    USING ERRCODE = '23505';
  END IF;
 END IF;

 RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_settlement_intent_transitions ON settlement_intents;
CREATE TRIGGER trg_guard_settlement_intent_transitions
 BEFORE INSERT OR UPDATE ON settlement_intents
 FOR EACH ROW
 EXECUTE FUNCTION guard_settlement_intent_transitions();
