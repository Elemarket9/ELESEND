-- Voice notes in order chat. Removed with their message, leaving no record.
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_message_type_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_message_type_check
  CHECK (message_type IN ('text', 'quick_reply', 'location_pin', 'system_notice', 'voice_note'));
CREATE TABLE chat_voice_notes (
  message_id uuid PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  audio_encrypted text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_voice_notes_conversation ON chat_voice_notes(conversation_id);
CREATE INDEX chat_messages_age ON chat_messages(created_at);
-- Chat records are removed with their chat after 24 hours, including chat audit entries.
-- Entries still cannot be edited while they exist.
DROP TRIGGER IF EXISTS immutable_chat_audit ON chat_audit_logs;
CREATE TRIGGER immutable_chat_audit BEFORE UPDATE ON chat_audit_logs FOR EACH ROW EXECUTE FUNCTION deny_mutation();
ALTER TABLE chat_audit_logs DROP CONSTRAINT IF EXISTS chat_audit_logs_conversation_id_fkey;
ALTER TABLE chat_audit_logs ADD CONSTRAINT chat_audit_logs_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE;
