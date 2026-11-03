-- Account deletion removes personal contact details while keeping required financial and custody records.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_check;
ALTER TABLE users ADD CONSTRAINT users_phone_check
  CHECK ((deleted_at IS NULL AND phone ~ '^\+233[25][0-9]{8}$') OR (deleted_at IS NOT NULL AND phone LIKE 'deleted:%'));
