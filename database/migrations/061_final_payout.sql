-- A rider closing their account can take out a balance under the withdrawal minimum, once.
ALTER TABLE users ADD COLUMN final_payout_at timestamptz;
