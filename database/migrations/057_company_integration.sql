-- A company can send its own deliveries, supply riders, or both.
ALTER TABLE companies ADD COLUMN services text[] NOT NULL DEFAULT '{riders}';
ALTER TABLE companies ADD CONSTRAINT companies_services_valid CHECK (cardinality(services) >= 1 AND services <@ ARRAY['delivery','riders']::text[]);

ALTER TABLE rider_invitations ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX rider_invitations_open_for_rider ON rider_invitations(rider_id) WHERE status='pending';
CREATE INDEX rider_invitations_for_company ON rider_invitations(company_id, created_at DESC);

-- Delivery status updates sent to a client's own system.
CREATE TABLE api_webhooks(
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL UNIQUE REFERENCES users(id),
 url text NOT NULL,
 secret_sealed text NOT NULL,
 after_outbox_id bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE api_webhook_deliveries(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 webhook_id uuid NOT NULL REFERENCES api_webhooks(id) ON DELETE CASCADE,
 outbox_id bigint NOT NULL REFERENCES outbox(id),
 shipment_id uuid NOT NULL REFERENCES shipments(id),
 event text NOT NULL,
 occurred_at timestamptz NOT NULL,
 attempts int NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 delivered_at timestamptz,
 abandoned_at timestamptz,
 last_status int,
 UNIQUE(webhook_id,outbox_id)
);
CREATE INDEX api_webhook_deliveries_due ON api_webhook_deliveries(next_attempt_at) WHERE delivered_at IS NULL AND abandoned_at IS NULL;
