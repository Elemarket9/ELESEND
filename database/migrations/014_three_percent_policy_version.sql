-- Per successful order: standard 300 basis points. Preserve immutable historical quotes
-- by activating a NEW pricing policy instead of editing policy terms used by past orders.
DO $$
DECLARE previous RECORD;
BEGIN
 SELECT * INTO previous FROM pricing_policies WHERE active FOR UPDATE;
 IF FOUND AND (previous.commission_bps<>300 OR previous.commission_mode<>'percentage'
    OR previous.commission_fixed_minor<>0 OR previous.commission_cap_minor IS NOT NULL) THEN
  UPDATE pricing_policies SET active=false WHERE id=previous.id;
  INSERT INTO pricing_policies(id,base_minor,per_km_minor,commission_bps,active,
    commission_mode,commission_fixed_minor,commission_cap_minor)
   VALUES (gen_random_uuid(),previous.base_minor,previous.per_km_minor,300,true,'percentage',0,NULL);
 END IF;
END $$;
