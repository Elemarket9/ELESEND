-- Owner decision, 5 Nov 2026: motorbike fares follow trip time, so a rider stuck in traffic is paid
-- for it, and rush hour adds only the extra minutes rather than multiplying the fare.
-- Start GH₵7, GH₵1.70/km, GH₵0.90/min. The GH₵20 minimum and commission stay as they are.
-- Only the motorbike tariff gets a new version. Issued quotes and cars do not change.
DO $$
DECLARE current_id uuid;
BEGIN
 SELECT id INTO current_id FROM pricing_policies WHERE active AND vehicle='motorcycle';
 IF current_id IS NOT NULL THEN
  UPDATE pricing_policies SET active=false WHERE id=current_id;
  INSERT INTO pricing_policies
   SELECT (jsonb_populate_record(NULL::pricing_policies,to_jsonb(p)||jsonb_build_object('id',gen_random_uuid()::text,'base_minor',700,'per_km_minor',170,'per_minute_minor',90,'traffic_time_pricing',true,'active',true))).*
   FROM pricing_policies p WHERE p.id=current_id;
 END IF;
END $$;
