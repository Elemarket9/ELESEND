ALTER TABLE shipments
  ADD COLUMN scheduled_pickup_start timestamptz,
  ADD COLUMN scheduled_pickup_end timestamptz;

ALTER TABLE shipments
  ADD CONSTRAINT shipments_scheduled_pickup_window_check
  CHECK ((scheduled_pickup_start IS NULL) = (scheduled_pickup_end IS NULL)
    AND (scheduled_pickup_start IS NULL OR scheduled_pickup_start < scheduled_pickup_end));

ALTER TABLE vehicle_capabilities
  ADD COLUMN scheduled_dispatch_lead_minutes integer NOT NULL DEFAULT 1440
  CHECK (scheduled_dispatch_lead_minutes BETWEEN 30 AND 10080);

CREATE INDEX shipments_scheduled_pickup_idx
  ON shipments(scheduled_pickup_start, rider_id)
  WHERE scheduled_pickup_start IS NOT NULL AND rider_id IS NOT NULL
    AND state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT');

CREATE OR REPLACE FUNCTION guard_shipment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.customer_id<>NEW.customer_id OR OLD.quote_id<>NEW.quote_id
   OR (OLD.recipient_phone<>NEW.recipient_phone AND current_setting('elesend.recipient_correction',true) IS DISTINCT FROM NEW.id::text)
   OR OLD.amount_minor<>NEW.amount_minor OR OLD.commission_minor<>NEW.commission_minor OR OLD.verification_authority<>NEW.verification_authority
   OR OLD.scheduled_pickup_start IS DISTINCT FROM NEW.scheduled_pickup_start
   OR OLD.scheduled_pickup_end IS DISTINCT FROM NEW.scheduled_pickup_end
 THEN RAISE EXCEPTION 'Shipment terms immutable'; END IF;
 IF OLD.state<>NEW.state AND NOT (
   (OLD.state='AWAITING_PAYMENT' AND NEW.state IN ('AWAITING_ASSIGNMENT','CANCELLED')) OR
   (OLD.state='AWAITING_ASSIGNMENT' AND NEW.state IN ('RIDER_ASSIGNED','CANCELLED')) OR
   (OLD.state IN ('RIDER_ASSIGNED','FAILED') AND NEW.state IN ('AWAITING_ASSIGNMENT','CANCELLED') AND NEW.rider_id IS NULL AND NEW.company_id IS NULL AND NOT EXISTS(SELECT 1 FROM challenges WHERE shipment_id=NEW.id AND purpose='pickup' AND consumed_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM shipment_handover_events WHERE shipment_id=NEW.id AND kind='pickup')) OR
   (OLD.state='RIDER_ASSIGNED' AND NEW.state='CANCELLED' AND NEW.cancellation_fee_minor>0 AND NOT EXISTS(SELECT 1 FROM challenges WHERE shipment_id=NEW.id AND purpose='pickup' AND consumed_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM shipment_handover_events WHERE shipment_id=NEW.id AND kind='pickup')) OR
   (OLD.state='RIDER_ASSIGNED' AND NEW.state IN ('PICKUP_VERIFIED','FAILED')) OR
   (OLD.state='PICKUP_VERIFIED' AND NEW.state IN ('IN_TRANSIT','FAILED')) OR
   (OLD.state='IN_TRANSIT' AND NEW.state IN ('AWAITING_DELIVERY_OTP','COMPLETED','FAILED')) OR
   (OLD.state='AWAITING_DELIVERY_OTP' AND NEW.state IN ('COMPLETED','FAILED')) OR
   (OLD.state='FAILED' AND NEW.state='RETURN_REQUESTED') OR
   (OLD.state='RETURN_REQUESTED' AND NEW.state='RETURNED')
 ) THEN RAISE EXCEPTION 'Invalid shipment transition'; END IF;
 IF NEW.state='PICKUP_VERIFIED' AND NOT EXISTS(SELECT 1 FROM challenges WHERE shipment_id=NEW.id AND rider_id=NEW.rider_id AND purpose='pickup' AND consumed_at IS NOT NULL AND sent) AND NOT EXISTS(SELECT 1 FROM shipment_handover_events WHERE shipment_id=NEW.id AND rider_id=NEW.rider_id AND kind='pickup') THEN RAISE EXCEPTION 'Pickup verification required'; END IF;
 IF NEW.state='COMPLETED' AND NOT EXISTS(SELECT 1 FROM challenges WHERE shipment_id=NEW.id AND rider_id=NEW.rider_id AND purpose='delivery' AND consumed_at IS NOT NULL AND sent) AND NOT EXISTS(SELECT 1 FROM shipment_handover_events WHERE shipment_id=NEW.id AND rider_id=NEW.rider_id AND kind='delivery') THEN RAISE EXCEPTION 'Delivery verification required'; END IF;
 IF NEW.state='COMPLETED' AND NEW.verification_authority<>'elesend' THEN RAISE EXCEPTION 'External authority integration not enabled'; END IF;
 RETURN NEW;
END $$;
