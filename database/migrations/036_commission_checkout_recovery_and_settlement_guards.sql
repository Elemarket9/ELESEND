-- Commission checkout recovery, idempotent retry metadata, reconciliation leases, and active-attempt guard.
ALTER TABLE settlement_intents DROP CONSTRAINT IF EXISTS settlement_intents_status_check;
ALTER TABLE settlement_intents ADD CONSTRAINT settlement_intents_status_check
 CHECK(status IN ('initiating','pending','confirmed','failed','rejected','expired','reversed'));

ALTER TABLE settlement_intents
 ADD COLUMN IF NOT EXISTS checkout_url text,
 ADD COLUMN IF NOT EXISTS payment_instructions jsonb,
 ADD COLUMN IF NOT EXISTS payer_email text,
 ADD COLUMN IF NOT EXISTS failure_reason text,
 ADD COLUMN IF NOT EXISTS failed_at timestamptz,
 ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
 ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz,
 ADD COLUMN IF NOT EXISTS reconcile_lease_until timestamptz,
 ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

WITH ranked AS (
 SELECT id, row_number() OVER (PARTITION BY rider_id, kind ORDER BY created_at DESC, id DESC) AS rn
 FROM settlement_intents
 WHERE status IN ('initiating', 'pending')
)
UPDATE settlement_intents
   SET status = 'expired',
       failure_reason = coalesce(failure_reason, 'Superseded by newer pending settlement intent before migration 036'),
       updated_at = now()
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS settlement_intents_one_active
 ON settlement_intents(rider_id, kind)
 WHERE status IN ('initiating', 'pending');

CREATE INDEX IF NOT EXISTS settlement_intents_reconcile_due
 ON settlement_intents(provider, status, updated_at)
 WHERE status IN ('initiating', 'pending');
