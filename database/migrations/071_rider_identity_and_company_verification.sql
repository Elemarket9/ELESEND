-- Name customers see for their rider (first name only is shown).
ALTER TABLE riders ADD COLUMN IF NOT EXISTS display_name text CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 2 AND 60);
-- Set when a rider supply company, not ELESEND, checked this rider. Cleared when the rider leaves the company.
ALTER TABLE riders ADD COLUMN IF NOT EXISTS verified_by_company_id uuid REFERENCES companies(id);

-- Independent riders give their Ghana Card. The number is encrypted; the keyed hash stops one card backing two accounts.
ALTER TABLE rider_licences ADD COLUMN IF NOT EXISTS ghana_card_encrypted text;
ALTER TABLE rider_licences ADD COLUMN IF NOT EXISTS ghana_card_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS rider_licences_ghana_card_once ON rider_licences(ghana_card_hash) WHERE ghana_card_hash IS NOT NULL;

ALTER TABLE rider_documents DROP CONSTRAINT IF EXISTS rider_documents_kind_check;
ALTER TABLE rider_documents ADD CONSTRAINT rider_documents_kind_check
  CHECK (kind IN ('profile_photo','licence_photo','ghana_card_photo','insurance','roadworthiness'));

-- A rider their company checked goes back to ELESEND review the moment they stop working for that company,
-- however that happens (they leave, are removed, or the company closes). They then need their Ghana Card.
CREATE OR REPLACE FUNCTION guard_company_verified_rider() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.verified_by_company_id IS NOT NULL AND NEW.company_id IS DISTINCT FROM OLD.verified_by_company_id
    AND NEW.verified_by_company_id IS NOT DISTINCT FROM OLD.verified_by_company_id THEN
  NEW.verified_by_company_id := NULL;
  IF NEW.status='approved' THEN NEW.status := 'pending'; END IF;
  NEW.online := false;
 END IF;
 IF NEW.verified_by_company_id IS NOT NULL AND NEW.company_id IS DISTINCT FROM NEW.verified_by_company_id THEN
  RAISE EXCEPTION 'A company can only verify its own riders';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS riders_company_verification ON riders;
CREATE TRIGGER riders_company_verification BEFORE UPDATE ON riders FOR EACH ROW EXECUTE FUNCTION guard_company_verified_rider();
