-- Owner decision, 5 Nov 2026: motorbikes pay for the extra rush-hour time they really lose, not a
-- multiplier on the whole fare. Only the motorbike tariff gets a new version. Its rates, and issued
-- quotes, do not change, and cars keep their multiplier.
DO $$
DECLARE current_id uuid;
BEGIN
 SELECT id INTO current_id FROM pricing_policies WHERE active AND vehicle='motorcycle';
 IF current_id IS NOT NULL THEN
  UPDATE pricing_policies SET active=false WHERE id=current_id;
  INSERT INTO pricing_policies
   SELECT (jsonb_populate_record(NULL::pricing_policies,to_jsonb(p)||jsonb_build_object('id',gen_random_uuid()::text,'traffic_time_pricing',true,'active',true))).*
   FROM pricing_policies p WHERE p.id=current_id;
 END IF;
END $$;
