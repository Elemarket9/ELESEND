-- Optional acknowledgement by the customer who booked a completed delivery.
-- This is not proof that the named recipient received it; it is never a payment or custody prerequisite.
CREATE TABLE shipment_receipt_confirmations (
 shipment_id uuid PRIMARY KEY REFERENCES shipments(id),
 customer_id uuid NOT NULL REFERENCES users(id),
 confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipment_receipt_customer ON shipment_receipt_confirmations(customer_id,confirmed_at DESC);
CREATE TRIGGER immutable_shipment_receipt BEFORE UPDATE OR DELETE ON shipment_receipt_confirmations FOR EACH ROW EXECUTE FUNCTION deny_mutation();
