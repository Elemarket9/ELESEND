-- When dispatch first ran out of riders for an order. Cleared when a rider accepts.
ALTER TABLE shipments ADD COLUMN no_rider_since timestamptz;
-- Staff now see orders with no rider and handover codes that could not be sent.
ALTER TABLE dispatch_exceptions DROP CONSTRAINT dispatch_exceptions_kind_check;
ALTER TABLE dispatch_exceptions ADD CONSTRAINT dispatch_exceptions_kind_check CHECK(kind IN ('pre_pickup_rider_release','reassignment_review','no_rider_found','handover_sms_failed'));
