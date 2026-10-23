-- Accurate failure/uncertain states, immutable receipt evidence, safe retries,
-- reconciliation leases, company payout ownership and pre-custody food reassignment.
ALTER TABLE refund_operations DROP CONSTRAINT refund_operations_status_check;
ALTER TABLE refund_operations ADD CONSTRAINT refund_operations_status_check CHECK(status IN ('queued','initiating','pending','needs_review','refunded','failed'));
ALTER TABLE refund_operations
 ADD COLUMN failure_reason text,
 ADD COLUMN failed_at timestamptz,
 ADD COLUMN retry_of uuid REFERENCES refund_operations(id),
 ADD COLUMN reconcile_lease_until timestamptz;
CREATE UNIQUE INDEX refund_operations_one_retry ON refund_operations(retry_of) WHERE retry_of IS NOT NULL;

ALTER TABLE payout_operations DROP CONSTRAINT payout_operations_status_check;
ALTER TABLE payout_operations ADD CONSTRAINT payout_operations_status_check CHECK(status IN ('proposed','initiating','pending','needs_review','paid','failed'));
ALTER TABLE payout_operations
 ADD COLUMN provider_id text,
 ADD COLUMN failure_reason text,
 ADD COLUMN failed_at timestamptz,
 ADD COLUMN retry_of uuid REFERENCES payout_operations(id),
 ADD COLUMN company_id uuid REFERENCES companies(id),
 ADD COLUMN reconcile_lease_until timestamptz;
ALTER TABLE payout_operations DROP CONSTRAINT payout_operations_shipment_id_kind_key;
-- Exactly one live payout per shipment/kind; definitively failed attempts stay as history.
CREATE UNIQUE INDEX payout_operations_one_live ON payout_operations(shipment_id,kind) WHERE status<>'failed';
CREATE UNIQUE INDEX payout_operations_one_retry ON payout_operations(retry_of) WHERE retry_of IS NOT NULL;

-- Receipt evidence is appended, never overwritten (table is already immutable).
ALTER TABLE payment_operation_events
 ADD COLUMN request_id text,
 ADD COLUMN provider_reference text,
 ADD COLUMN status text,
 ADD COLUMN receipt jsonb;
ALTER TABLE payment_operation_events DROP CONSTRAINT IF EXISTS payment_operation_events_amount_minor_check;
ALTER TABLE payment_operation_events ADD CONSTRAINT payment_operation_events_amount_minor_check CHECK(amount_minor>0);

-- Pre-custody failure may return to dispatch (no consumed pickup challenge).
CREATE OR REPLACE FUNCTION guard_shipment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.customer_id<>NEW.customer_id OR OLD.quote_id<>NEW.quote_id OR OLD.recipient_phone<>NEW.recipient_phone OR OLD.amount_minor<>NEW.amount_minor OR OLD.commission_minor<>NEW.commission_minor OR OLD.verification_authority<>NEW.verification_authority THEN RAISE EXCEPTION 'Shipment terms immutable'; END IF;
 IF OLD.state<>NEW.state AND NOT (
 (OLD.state='AWAITING_PAYMENT' AND NEW.state IN ('AWAITING_ASSIGNMENT','CANCELLED')) OR
 (OLD.state='AWAITING_ASSIGNMENT' AND NEW.state IN ('RIDER_ASSIGNED','CANCELLED')) OR
 (OLD.state IN ('RIDER_ASSIGNED','FAILED') AND NEW.state IN ('AWAITING_ASSIGNMENT','CANCELLED') AND NEW.rider_id IS NULL AND NEW.company_id IS NULL AND NOT EXISTS(SELECT 1 FROM challenges WHERE shipment_id=NEW.id AND purpose='pickup' AND consumed_at IS NOT NULL)) OR
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
