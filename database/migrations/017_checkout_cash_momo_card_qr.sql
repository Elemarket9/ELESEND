-- Additive, provider-neutral, shipment checkout. Existing 'DIGITAL' is retained solely
-- for historical shipments; new customer bookings use CASH/MOMO/CARD/QR.
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_payment_method_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_payment_method_check CHECK(payment_method IN ('CASH','DIGITAL','MOMO','CARD','QR'));
ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_payment_method_check;
ALTER TABLE shipments ADD CONSTRAINT shipments_payment_method_check CHECK(payment_method IN ('CASH','DIGITAL','MOMO','CARD','QR'));
-- Closed by default for all digital methods until a configured authorized PSP exists.
CREATE TABLE checkout_method_policies(
 method text PRIMARY KEY CHECK(method IN ('CASH','MOMO','CARD','QR')),
 enabled boolean NOT NULL DEFAULT false,
 updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO checkout_method_policies(method,enabled) VALUES('CASH',true),('MOMO',false),('CARD',false),('QR',false)
 ON CONFLICT(method) DO NOTHING;
CREATE TABLE shipment_checkout_intents(
 id uuid PRIMARY KEY,
 shipment_id uuid NOT NULL REFERENCES shipments(id),
 customer_id uuid NOT NULL REFERENCES users(id),
 method text NOT NULL CHECK(method IN ('MOMO','CARD','QR')),
 provider text NOT NULL,
 reference text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
 status text NOT NULL DEFAULT 'initiating' CHECK(status IN ('initiating','pending','confirmed','failed')),
 checkout_url text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 confirmed_at timestamptz,
 UNIQUE(customer_id,idempotency_key), UNIQUE(provider,reference)
);
-- Only one open payment attempt for a shipment. New attempt can be started after
-- provider-verified final failure. Unknown statuses must never silently clear the slot.
CREATE UNIQUE INDEX one_open_checkout_per_shipment ON shipment_checkout_intents(shipment_id)
 WHERE status IN ('initiating','pending');
CREATE INDEX checkout_reconcile_due ON shipment_checkout_intents(status,created_at);
CREATE TABLE checkout_confirmed_events(
 provider text NOT NULL,event_id text NOT NULL,
 intent_id uuid NOT NULL REFERENCES shipment_checkout_intents(id),
 shipment_id uuid NOT NULL REFERENCES shipments(id),
 reference text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),
 currency text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(provider,event_id),UNIQUE(provider,reference)
);
CREATE TRIGGER checkout_events_immutable BEFORE UPDATE OR DELETE ON checkout_confirmed_events
 FOR EACH ROW EXECUTE FUNCTION deny_mutation();
-- Lock down financial identifiers and evidence; only lifecycle status/checkout URL mutable.
CREATE FUNCTION guard_checkout_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.id,OLD.shipment_id,OLD.customer_id,OLD.method,OLD.provider,OLD.reference,
   OLD.amount_minor,OLD.currency,OLD.idempotency_key,OLD.created_at) IS DISTINCT FROM
    (NEW.id,NEW.shipment_id,NEW.customer_id,NEW.method,NEW.provider,NEW.reference,
   NEW.amount_minor,NEW.currency,NEW.idempotency_key,NEW.created_at)
 THEN RAISE EXCEPTION 'Checkout financial terms immutable'; END IF;
 IF OLD.status='confirmed' AND NEW.status<>'confirmed' THEN RAISE EXCEPTION 'Confirmed checkout immutable'; END IF;
 IF OLD.status='failed' AND NEW.status<>'failed' THEN RAISE EXCEPTION 'Failed checkout immutable'; END IF;
 IF OLD.status='pending' AND NEW.status='initiating' THEN RAISE EXCEPTION 'Invalid checkout rollback'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER checkout_intent_guard BEFORE UPDATE ON shipment_checkout_intents
 FOR EACH ROW EXECUTE FUNCTION guard_checkout_intent();
