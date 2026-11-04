-- Staff are told when a restaurant does not confirm a failed food order coming back.
ALTER TABLE dispatch_exceptions DROP CONSTRAINT dispatch_exceptions_kind_check;
ALTER TABLE dispatch_exceptions ADD CONSTRAINT dispatch_exceptions_kind_check CHECK(kind IN ('pre_pickup_rider_release','reassignment_review','no_rider_found','handover_sms_failed','return_unconfirmed'));
