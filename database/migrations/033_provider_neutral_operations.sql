ALTER TABLE restaurants ALTER COLUMN status SET DEFAULT 'pending';
CREATE TABLE refund_operations(
 id uuid PRIMARY KEY,
 source_key text UNIQUE NOT NULL,
 shipment_id uuid NOT NULL REFERENCES shipments(id),
 provider text NOT NULL,
 reference text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 currency text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','initiating','pending','refunded','failed')),
 provider_id text,
 submitted_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payment_operation_events(
 provider text NOT NULL,event_id text NOT NULL,operation_id uuid NOT NULL,kind text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(provider,event_id)
);
CREATE TRIGGER immutable_operation_events BEFORE UPDATE OR DELETE ON payment_operation_events FOR EACH ROW EXECUTE FUNCTION deny_mutation();
ALTER TABLE checkout_accounting_journals DROP CONSTRAINT checkout_accounting_journals_kind_check;
ALTER TABLE checkout_accounting_journals ADD CHECK(kind IN ('psp_verified','delivery_completed','verified_unapplied','refund_requested','refund_completed','payout_completed'));
CREATE TABLE payout_beneficiaries(
 user_id uuid NOT NULL REFERENCES users(id),provider text NOT NULL,recipient_reference text NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,provider)
);
CREATE TABLE payout_operations(
 id uuid PRIMARY KEY,shipment_id uuid NOT NULL REFERENCES shipments(id),
 kind text NOT NULL CHECK(kind IN ('restaurant','rider')),beneficiary_id uuid NOT NULL REFERENCES users(id),
 provider text NOT NULL,recipient_reference text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),
 currency text NOT NULL DEFAULT 'GHS',
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','initiating','pending','paid','failed')),
 proposed_by uuid NOT NULL REFERENCES users(id),approved_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(shipment_id,kind),CHECK(approved_by IS NULL OR approved_by<>proposed_by)
);
