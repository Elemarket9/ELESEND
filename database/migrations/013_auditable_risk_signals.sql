-- Explainable review signals; never automatically penalize a rider or alter financial truth.
CREATE TABLE operational_risk_signals(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 rider_id uuid REFERENCES riders(id),
 shipment_id uuid REFERENCES shipments(id),
 signal_code text NOT NULL CHECK(signal_code ~ '^[A-Z_]{3,60}$'),
 severity text NOT NULL CHECK(severity IN ('low','medium','high')),
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','reviewed','dismissed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operational_risk_pending ON operational_risk_signals(created_at DESC) WHERE review_status='pending';
-- Evidence is immutable; only review status may change. Every review is audited by the API.
CREATE FUNCTION protect_risk_signal_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.rider_id IS DISTINCT FROM NEW.rider_id
 OR OLD.shipment_id IS DISTINCT FROM NEW.shipment_id
 OR OLD.signal_code IS DISTINCT FROM NEW.signal_code
 OR OLD.severity IS DISTINCT FROM NEW.severity
 OR OLD.evidence IS DISTINCT FROM NEW.evidence
 OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
  RAISE EXCEPTION 'Risk evidence is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER risk_evidence_guard BEFORE UPDATE ON operational_risk_signals
 FOR EACH ROW EXECUTE FUNCTION protect_risk_signal_evidence();
