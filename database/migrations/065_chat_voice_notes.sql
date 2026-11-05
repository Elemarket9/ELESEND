-- Voice notes in order chat. The audio is removed on a schedule; the record of the note stays.
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_message_type_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_message_type_check
  CHECK (message_type IN ('text', 'quick_reply', 'location_pin', 'system_notice', 'voice_note'));
CREATE TABLE chat_voice_notes (
  message_id uuid PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  audio_encrypted text,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 1 AND 60),
  expires_at timestamptz NOT NULL,
  held_until timestamptz,
  audio_deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_voice_notes_conversation ON chat_voice_notes(conversation_id);
CREATE INDEX chat_voice_notes_due ON chat_voice_notes(expires_at) WHERE audio_encrypted IS NOT NULL;
