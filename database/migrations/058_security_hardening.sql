-- Administrator sessions end after inactivity, and API key use can be reviewed.
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE api_clients ADD COLUMN last_used_at timestamptz;

-- These records must not be changed after they are written, the same as the main audit log.
CREATE TRIGGER immutable_chat_audit BEFORE UPDATE OR DELETE ON chat_audit_logs FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER immutable_commission_audit BEFORE UPDATE OR DELETE ON commission_audit_logs FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER immutable_promotion_audit BEFORE UPDATE OR DELETE ON promotion_audit_logs FOR EACH ROW EXECUTE FUNCTION deny_mutation();
