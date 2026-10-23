-- Migration 038: track VERIFIED terminal provider outcomes separately from local intent status.
-- Local expiry/failure frees the rider's active-attempt slot but is NOT proof that no money moved.
-- Any expired/failed intent without a verified terminal provider outcome stays eligible for scheduled
-- verification so a later provider success is recovered even when its webhook is missed.

ALTER TABLE settlement_intents
 ADD COLUMN IF NOT EXISTS provider_terminal_at timestamptz,
 ADD COLUMN IF NOT EXISTS provider_last_status text;

-- Backfill: rejected intents and failures recorded from definitive provider evidence are terminal.
-- Failures recorded from an 'abandoned' provider status were NOT terminal (abandoned checkouts can
-- still be completed), so they remain eligible for verification.
UPDATE settlement_intents
   SET provider_terminal_at = coalesce(failed_at, updated_at, now())
 WHERE provider_terminal_at IS NULL
   AND (
     status = 'rejected'
     OR (status = 'failed' AND coalesce(failure_reason, '') NOT ILIKE '%abandoned%'
                           AND coalesce(failure_reason, '') NOT ILIKE 'Initialization outcome uncertain%')
   );

CREATE INDEX IF NOT EXISTS settlement_intents_unresolved_verification
 ON settlement_intents(provider, last_reconciled_at)
 WHERE status IN ('initiating', 'pending', 'expired', 'failed') AND provider_terminal_at IS NULL;
