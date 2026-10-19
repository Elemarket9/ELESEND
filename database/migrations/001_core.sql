CREATE TABLE users(id uuid PRIMARY KEY, phone text UNIQUE NOT NULL CHECK(phone ~ '^\+233[25][0-9]{8}$'), password_hash text NOT NULL, kind text NOT NULL CHECK(kind IN ('customer','business','rider','company','admin')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sessions(token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE permissions(user_id uuid NOT NULL REFERENCES users(id), permission text NOT NULL, PRIMARY KEY(user_id,permission));
CREATE TABLE companies(id uuid PRIMARY KEY, owner_id uuid UNIQUE NOT NULL REFERENCES users(id), name text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','suspended','rejected')));
CREATE TABLE riders(id uuid PRIMARY KEY REFERENCES users(id), company_id uuid REFERENCES companies(id), status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','suspended','rejected')), online boolean NOT NULL DEFAULT false, max_weight_g integer NOT NULL CHECK(max_weight_g>0), vehicle text NOT NULL CHECK(vehicle IN ('bicycle','motorcycle','tricycle','car','pickup','van','truck')));
CREATE INDEX riders_eligibility ON riders(status,online,company_id);
CREATE TABLE pricing_policies(id uuid PRIMARY KEY, base_minor integer NOT NULL CHECK(base_minor>=0), per_km_minor integer NOT NULL CHECK(per_km_minor>=0), commission_bps integer NOT NULL CHECK(commission_bps BETWEEN 0 AND 10000), active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX one_active_price ON pricing_policies(active) WHERE active;
CREATE TABLE quotes(id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES users(id), policy_id uuid NOT NULL REFERENCES pricing_policies(id), request jsonb NOT NULL, amount_minor integer NOT NULL CHECK(amount_minor>0), commission_minor integer NOT NULL CHECK(commission_minor BETWEEN 0 AND amount_minor), expires_at timestamptz NOT NULL);
CREATE TABLE shipments(id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES users(id), quote_id uuid UNIQUE NOT NULL REFERENCES quotes(id), idempotency_key text NOT NULL, state text NOT NULL CHECK(state IN ('AWAITING_PAYMENT','AWAITING_ASSIGNMENT','RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','COMPLETED','FAILED','CANCELLED','RETURN_REQUESTED','RETURNED')), rider_id uuid REFERENCES riders(id), company_id uuid REFERENCES companies(id), recipient_phone text NOT NULL, amount_minor integer NOT NULL CHECK(amount_minor>0), commission_minor integer NOT NULL CHECK(commission_minor BETWEEN 0 AND amount_minor), paid boolean NOT NULL DEFAULT false, verification_authority text NOT NULL DEFAULT 'elesend' CHECK(verification_authority IN ('elesend','external')), completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(customer_id,idempotency_key), CHECK((state='COMPLETED')=(completed_at IS NOT NULL)), CHECK(state<>'COMPLETED' OR paid));
CREATE UNIQUE INDEX rider_one_active_assignment ON shipments(rider_id) WHERE state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','RETURN_REQUESTED');
CREATE INDEX shipment_customer ON shipments(customer_id,created_at DESC);
CREATE INDEX shipment_company ON shipments(company_id,created_at DESC);
CREATE INDEX shipment_dispatch ON shipments(state,created_at);
CREATE TABLE challenges(id uuid PRIMARY KEY, shipment_id uuid NOT NULL REFERENCES shipments(id), rider_id uuid NOT NULL REFERENCES riders(id), purpose text NOT NULL CHECK(purpose IN ('pickup','delivery')), phone text NOT NULL, digest text NOT NULL, expires_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5), consumed_at timestamptz, sent boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX challenge_shipment ON challenges(shipment_id,purpose,created_at DESC);
CREATE TABLE payment_events(provider text NOT NULL, event_id text NOT NULL, shipment_id uuid NOT NULL REFERENCES shipments(id), amount_minor integer NOT NULL, currency text NOT NULL CHECK(currency='GHS'), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider,event_id));
CREATE TABLE financial_entries(shipment_id uuid PRIMARY KEY REFERENCES shipments(id), beneficiary_id uuid NOT NULL, customer_charge_minor integer NOT NULL CHECK(customer_charge_minor>0), commission_minor integer NOT NULL CHECK(commission_minor>=0), entitlement_minor integer NOT NULL CHECK(entitlement_minor>=0), payout_status text NOT NULL DEFAULT 'held' CHECK(payout_status IN ('held','eligible')), created_at timestamptz NOT NULL DEFAULT now(), CHECK(customer_charge_minor=commission_minor+entitlement_minor));
CREATE TABLE disputes(id uuid PRIMARY KEY, shipment_id uuid NOT NULL REFERENCES shipments(id), reporter_id uuid NOT NULL REFERENCES users(id), category text NOT NULL, detail text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE locations(shipment_id uuid PRIMARY KEY REFERENCES shipments(id), rider_id uuid NOT NULL REFERENCES riders(id), latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90), longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE audit_logs(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL, entity_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE outbox(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, shipment_id uuid NOT NULL REFERENCES shipments(id), kind text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE rate_limits(subject text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE FUNCTION deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable evidence'; END $$;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER immutable_finance BEFORE UPDATE OR DELETE ON financial_entries FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER immutable_payments BEFORE UPDATE OR DELETE ON payment_events FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE FUNCTION guard_shipment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.customer_id<>NEW.customer_id OR OLD.quote_id<>NEW.quote_id OR OLD.recipient_phone<>NEW.recipient_phone OR OLD.amount_minor<>NEW.amount_minor OR OLD.commission_minor<>NEW.commission_minor OR OLD.verification_authority<>NEW.verification_authority THEN RAISE EXCEPTION 'Shipment terms immutable'; END IF;
 IF OLD.state<>NEW.state AND NOT (
 (OLD.state='AWAITING_PAYMENT' AND NEW.state IN ('AWAITING_ASSIGNMENT','CANCELLED')) OR
 (OLD.state='AWAITING_ASSIGNMENT' AND NEW.state IN ('RIDER_ASSIGNED','CANCELLED')) OR
 (OLD.state='RIDER_ASSIGNED' AND NEW.state IN ('PICKUP_VERIFIED','FAILED')) OR
 (OLD.state='PICKUP_VERIFIED' AND NEW.state IN ('IN_TRANSIT','FAILED')) OR
 (OLD.state='IN_TRANSIT' AND NEW.state IN ('AWAITING_DELIVERY_OTP','FAILED')) OR
 (OLD.state='AWAITING_DELIVERY_OTP' AND NEW.state IN ('COMPLETED','FAILED')) OR
 (OLD.state='FAILED' AND NEW.state='RETURN_REQUESTED') OR
 (OLD.state='RETURN_REQUESTED' AND NEW.state='RETURNED')) THEN RAISE EXCEPTION 'Invalid shipment transition'; END IF;
 IF NEW.state='PICKUP_VERIFIED' AND NOT EXISTS(SELECT 1 FROM challenges WHERE shipment_id=NEW.id AND rider_id=NEW.rider_id AND purpose='pickup' AND consumed_at IS NOT NULL AND sent) THEN RAISE EXCEPTION 'Pickup verification required'; END IF;
 IF NEW.state='COMPLETED' AND NOT EXISTS(SELECT 1 FROM challenges WHERE shipment_id=NEW.id AND rider_id=NEW.rider_id AND purpose='delivery' AND consumed_at IS NOT NULL AND sent) THEN RAISE EXCEPTION 'Delivery verification required'; END IF;
 IF NEW.state='COMPLETED' AND NEW.verification_authority<>'elesend' THEN RAISE EXCEPTION 'External authority integration not enabled'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shipment_guard BEFORE UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION guard_shipment();
