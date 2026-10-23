ALTER TABLE settlement_notifications ALTER COLUMN sent_at DROP NOT NULL;
ALTER TABLE settlement_notifications ALTER COLUMN sent_at DROP DEFAULT;
CREATE TABLE notification_jobs(
 id text PRIMARY KEY,
 recipient_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL,
 payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','expired','failed')),
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz,
 provider_message_id text,
 sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_jobs_due ON notification_jobs(available_at) WHERE state IN ('pending','sending');
