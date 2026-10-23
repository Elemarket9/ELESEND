-- Fixed food dispatch start timestamp and separate payment submission/reconciliation timestamps.
ALTER TABLE refund_operations
 ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
 ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz;

ALTER TABLE payout_operations
 ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
 ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz;

ALTER TABLE food_orders
 ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz;
