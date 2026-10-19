CREATE TABLE dispatch_exceptions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 shipment_id uuid NOT NULL REFERENCES shipments(id),
 actor_id uuid REFERENCES users(id),
 reason text NOT NULL CHECK(length(reason) BETWEEN 5 AND 500),
 kind text NOT NULL CHECK(kind IN ('pre_pickup_rider_release','reassignment_review')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispatch_exceptions_ship ON dispatch_exceptions(shipment_id,created_at DESC);
CREATE TRIGGER immutable_dispatch_exceptions BEFORE UPDATE OR DELETE ON dispatch_exceptions FOR EACH ROW EXECUTE FUNCTION deny_mutation();
