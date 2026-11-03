-- A transfer that succeeds after its money was released blocks further withdrawals for that person.
CREATE TABLE IF NOT EXISTS payout_holds (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  withdrawal_id uuid NOT NULL REFERENCES payout_withdrawals(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Once set, the provider may have received this transfer, so it can never be released automatically.
ALTER TABLE payout_withdrawals
  ADD COLUMN IF NOT EXISTS provider_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS stuck_flagged_at timestamptz;
UPDATE payout_withdrawals SET provider_attempted_at=coalesce(submitted_at,created_at) WHERE provider_attempted_at IS NULL AND status IN ('pending','needs_review','paid','failed','reversed');
