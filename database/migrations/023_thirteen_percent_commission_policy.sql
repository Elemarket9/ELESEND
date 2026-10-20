-- Migration 023: Approved delivery platform commission policy
-- Standard delivery commission default: 13% (1,300 basis points).
-- Maximum administrator-configurable delivery commission: 20% (2,000 basis points).
-- Preserves immutable historical quotes and pricing policies by versioning, never modifying past rows in place.

-- Ensure pricing policies table enforces upper bound of 20% (2,000 basis points) on active policies.
ALTER TABLE pricing_policies DROP CONSTRAINT IF EXISTS pricing_policies_commission_bps_check;
ALTER TABLE pricing_policies ADD CONSTRAINT pricing_policies_commission_bps_check CHECK (commission_bps BETWEEN 0 AND 2000);

-- Transition all active delivery policies to 1,300 basis points (13%)
DO $$
DECLARE
 cur RECORD;
 pid uuid;
BEGIN
 FOR cur IN SELECT * FROM pricing_policies WHERE active FOR UPDATE LOOP
  IF cur.commission_bps <> 1300 THEN
   UPDATE pricing_policies SET active = false WHERE id = cur.id;
   pid := gen_random_uuid();
   INSERT INTO pricing_policies(
     id, vehicle, base_minor, per_km_minor, per_minute_minor, minimum_minor,
     rush_hour_enabled, supply_demand_enabled, commission_bps, active,
     commission_mode, commission_fixed_minor, commission_cap_minor,
     wait_per_minute_minor, per_extra_stop_minor
   ) VALUES (
     pid, cur.vehicle, cur.base_minor, cur.per_km_minor, cur.per_minute_minor, cur.minimum_minor,
     cur.rush_hour_enabled, cur.supply_demand_enabled, 1300, true,
     cur.commission_mode, cur.commission_fixed_minor, cur.commission_cap_minor,
     cur.wait_per_minute_minor, cur.per_extra_stop_minor
   );
  END IF;
 END LOOP;

 -- If no active vehicle tariffs exist, establish default 13% policies
 IF NOT EXISTS (SELECT 1 FROM pricing_policies WHERE active AND vehicle = 'motorcycle') THEN
  INSERT INTO pricing_policies(id, vehicle, base_minor, per_km_minor, per_minute_minor, minimum_minor, commission_bps, rush_hour_enabled, active)
   VALUES (gen_random_uuid(), 'motorcycle', 1200, 320, 25, 2000, 1300, true, true);
 END IF;

 IF NOT EXISTS (SELECT 1 FROM pricing_policies WHERE active AND vehicle = 'car') THEN
  INSERT INTO pricing_policies(id, vehicle, base_minor, per_km_minor, per_minute_minor, minimum_minor, commission_bps, rush_hour_enabled, active)
   VALUES (gen_random_uuid(), 'car', 2200, 500, 60, 3500, 1300, true, true);
 END IF;

 IF NOT EXISTS (SELECT 1 FROM pricing_policies WHERE active AND vehicle = 'van') THEN
  INSERT INTO pricing_policies(id, vehicle, base_minor, per_km_minor, per_minute_minor, minimum_minor, commission_bps, rush_hour_enabled, active)
   VALUES (gen_random_uuid(), 'van', 5500, 850, 110, 7500, 1300, true, true);
 END IF;

 IF NOT EXISTS (SELECT 1 FROM pricing_policies WHERE active AND vehicle IS NULL) THEN
  INSERT INTO pricing_policies(id, base_minor, per_km_minor, commission_bps, active)
   VALUES (gen_random_uuid(), 2000, 150, 1300, true);
 END IF;
END $$;
