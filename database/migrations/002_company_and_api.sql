CREATE TABLE rider_invitations(id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), rider_id uuid NOT NULL REFERENCES riders(id), token_hash text UNIQUE NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked')), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX one_pending_rider_invitation ON rider_invitations(company_id,rider_id) WHERE status='pending';
CREATE TABLE api_clients(id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), name text NOT NULL, token_hash text UNIQUE NOT NULL, scopes text[] NOT NULL, revoked_at timestamptz, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX api_clients_owner ON api_clients(owner_id);
