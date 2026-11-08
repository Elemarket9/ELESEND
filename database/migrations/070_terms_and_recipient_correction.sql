-- Customers accept the published privacy notice and terms at sign-up; the version they saw is kept.
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version text, ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;

-- A mistyped recipient number can be corrected by the customer before delivery.
-- The change is only allowed inside the correction transaction, which sets elesend.recipient_correction to the shipment id.
CREATE OR REPLACE FUNCTION guard_shipment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.customer_id<>NEW.customer_id OR OLD.quote_id<>NEW.quote_id OR (OLD.recipient_phone<>NEW.recipient_phone AND current_setting('elesend.recipient_correction',true) IS DISTINCT FROM NEW.id::text) OR OLD.amount_minor<>NEW.amount_minor OR OLD.commission_minor<>NEW.commission_minor OR OLD.verification_authority<>NEW.verification_authority THEN RAISE EXCEPTION 'Shipment terms immutable'; END IF;
 IF OLD.state<>NEW.state AND NOT (
 (OLD.state='AWAITING_PAYMENT' AND NEW.state IN ('AWAITING_ASSIGNMENT','CANCELLED')) OR
 (OLD.state='AWAITING_ASSIGNMENT' AND NEW.state IN ('RIDER_ASSIGNED','CANCELLED')) OR
 (OLD.state IN ('RIDER_ASSIGNED','FAILED') AND NEW.state IN ('AWAITING_ASSIGNMENT','CANCELLED') AND NEW.rider_id IS NULL AND NEW.company_id IS NULL AND NOT EXISTS(SELECT 1 FROM challenges WHERE shipment_id=NEW.id AND purpose='pickup' AND consumed_at IS NOT NULL)) OR
 (OLD.state='RIDER_ASSIGNED' AND NEW.state='CANCELLED' AND NEW.cancellation_fee_minor>0 AND NOT EXISTS(SELECT 1 FROM challenges WHERE shipment_id=NEW.id AND purpose='pickup' AND consumed_at IS NOT NULL)) OR
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
