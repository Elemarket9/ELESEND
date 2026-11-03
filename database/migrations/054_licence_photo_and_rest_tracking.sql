-- Without an identity provider, staff review a licence photo instead.
ALTER TABLE rider_documents DROP CONSTRAINT rider_documents_kind_check;
ALTER TABLE rider_documents ADD CONSTRAINT rider_documents_kind_check
  CHECK (kind IN ('profile_photo','licence_photo','insurance','roadworthiness'));

-- The rest length is a setting, so the scheduled job decides when a shift ends.
CREATE OR REPLACE FUNCTION track_rider_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.online AND NOT OLD.online THEN
    NEW.shift_started_at := COALESCE(OLD.shift_started_at, now());
  ELSIF OLD.online AND NOT NEW.online THEN
    NEW.last_offline_at := now();
  END IF;
  RETURN NEW;
END $$;
