-- FAILED may still mean parcel is in rider custody pending documented return.
DROP INDEX rider_one_active_assignment;
CREATE UNIQUE INDEX rider_one_active_assignment ON shipments(rider_id) WHERE state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED');
ALTER TABLE dispatch_policy ADD COLUMN moving_upload_seconds integer NOT NULL DEFAULT 15 CHECK(moving_upload_seconds BETWEEN 5 AND 120),
 ADD COLUMN idle_upload_seconds integer NOT NULL DEFAULT 60 CHECK(idle_upload_seconds BETWEEN 15 AND 600);
