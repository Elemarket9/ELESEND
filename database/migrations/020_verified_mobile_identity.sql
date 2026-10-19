-- Existing identities are deliberately not assumed to own their registered phone.
-- Phone ownership must be demonstrated through an authenticated, short-lived SMS challenge.
ALTER TABLE users ADD COLUMN phone_verified_at timestamptz;
CREATE TABLE account_phone_challenges(
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),phone text NOT NULL,
 digest text NOT NULL,expires_at timestamptz NOT NULL,
 sent boolean NOT NULL DEFAULT false,attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_phone_challenges_active ON account_phone_challenges(user_id,expires_at DESC);
CREATE TRIGGER immutable_account_phone_challenge_identity BEFORE UPDATE OF user_id,phone,digest ON account_phone_challenges
 FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- Force unverified riders offline for NEW offers. Do not erase existing parcel
-- custody or break current assigned delivery verification/recovery workflows.
UPDATE riders SET online=false WHERE id IN (SELECT id FROM users WHERE phone_verified_at IS NULL) AND online=true;
UPDATE dispatch_offers SET status='invalidated' WHERE status='offered'
 AND rider_id IN (SELECT id FROM users WHERE phone_verified_at IS NULL);
