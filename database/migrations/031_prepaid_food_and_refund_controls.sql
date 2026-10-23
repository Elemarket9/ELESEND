ALTER TABLE food_orders ALTER COLUMN payment_method SET DEFAULT 'MOMO';
CREATE UNIQUE INDEX food_orders_one_shipment ON food_orders(shipment_id);
ALTER TABLE food_orders ADD COLUMN request_key text;
ALTER TABLE food_orders ADD COLUMN request_hash text;
CREATE UNIQUE INDEX food_orders_request_key ON food_orders(customer_id,request_key) WHERE request_key IS NOT NULL;

ALTER TABLE checkout_accounting_journals DROP CONSTRAINT checkout_accounting_journals_kind_check;
ALTER TABLE checkout_accounting_journals ADD CHECK(kind IN ('psp_verified','delivery_completed','verified_unapplied','refund_requested'));
ALTER TABLE checkout_accounting_lines DROP CONSTRAINT checkout_accounting_lines_account_check;
ALTER TABLE checkout_accounting_lines ADD CHECK(account IN ('provider_receivable','customer_delivery_liability','rider_payable','platform_commission_revenue','customer_refund_liability','restaurant_payable','platform_food_commission_revenue'));
CREATE TABLE checkout_refund_requests(
 shipment_id uuid PRIMARY KEY REFERENCES shipments(id),
 intent_id uuid UNIQUE NOT NULL REFERENCES shipment_checkout_intents(id),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 reason text NOT NULL,
 status text NOT NULL DEFAULT 'pending_review' CHECK(status IN ('pending_review','submitted','refunded')),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION guard_prepaid_food() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.payment_method IS DISTINCT FROM OLD.payment_method THEN
  IF NEW.payment_method NOT IN ('MOMO','CARD','QR') THEN
   RAISE EXCEPTION 'Food orders require upfront digital payment' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.payment_status='PAID' OR NEW.state IN ('ACCEPTED','PREPARING','READY_FOR_PICKUP','IN_TRANSIT','DELIVERED') THEN
  IF NEW.payment_method='CASH' OR NOT EXISTS(
   SELECT 1 FROM shipments s JOIN shipment_checkout_intents i ON i.shipment_id=s.id
   WHERE s.id=NEW.shipment_id AND i.status='confirmed' AND i.amount_minor=NEW.total_minor
  ) THEN RAISE EXCEPTION 'Verified full food payment required' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prepaid_food_guard BEFORE INSERT OR UPDATE ON food_orders FOR EACH ROW EXECUTE FUNCTION guard_prepaid_food();

CREATE FUNCTION guard_food_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE food food_orders%ROWTYPE;
BEGIN
 SELECT * INTO food FROM food_orders WHERE shipment_id=NEW.id;
 IF FOUND AND (NEW.rider_id IS DISTINCT FROM OLD.rider_id OR NEW.state IS DISTINCT FROM OLD.state)
  AND NEW.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','COMPLETED') THEN
  IF NOT NEW.paid OR NEW.payment_method='CASH' OR food.payment_status<>'PAID'
   OR food.state NOT IN ('ACCEPTED','PREPARING','READY_FOR_PICKUP','IN_TRANSIT','DELIVERED')
   OR NOT EXISTS(SELECT 1 FROM shipment_checkout_intents WHERE shipment_id=NEW.id AND status='confirmed' AND amount_minor=food.total_minor)
  THEN RAISE EXCEPTION 'Food assignment requires verified payment and kitchen acceptance' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER food_assignment_guard BEFORE UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION guard_food_assignment();
