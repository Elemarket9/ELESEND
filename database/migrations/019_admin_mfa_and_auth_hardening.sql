-- Existing administrator sessions are intentionally invalidated: prior sessions
-- did not meet MFA requirements. Provision each admin securely before login.
ALTER TABLE sessions ADD COLUMN admin_mfa_verified boolean NOT NULL DEFAULT false;
CREATE TABLE admin_mfa_credentials(
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 secret_encrypted text NOT NULL CHECK(length(secret_encrypted)>35),
 last_used_step bigint NOT NULL DEFAULT -1 CHECK(last_used_step>=-1),
 provisioned_at timestamptz NOT NULL DEFAULT now()
);
-- Existing users may never opt into an administrator login with an unverified
-- session simply because an administrator changed a users.kind field.
CREATE INDEX sessions_admin_mfa ON sessions(user_id,admin_mfa_verified);
