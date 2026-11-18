-- Cargo prices start as visible placeholders. Staff must publish a real tariff before quoting.
ALTER TABLE pricing_policies
 ADD COLUMN is_placeholder boolean NOT NULL DEFAULT false,
 ADD COLUMN per_helper_minor integer NOT NULL DEFAULT 0 CHECK(per_helper_minor BETWEEN 0 AND 10000000),
 ADD COLUMN per_floor_minor integer NOT NULL DEFAULT 0 CHECK(per_floor_minor BETWEEN 0 AND 10000000),
 ADD COLUMN free_loading_minutes integer NOT NULL DEFAULT 5 CHECK(free_loading_minutes BETWEEN 0 AND 240);

-- Keep the previous van policy for already-issued quotes, and version in its 15-minute loading allowance.
UPDATE pricing_policies SET active=false WHERE active AND vehicle='van';
INSERT INTO pricing_policies(id,vehicle,base_minor,per_km_minor,per_minute_minor,minimum_minor,rush_hour_enabled,
 supply_demand_enabled,commission_bps,commission_mode,commission_fixed_minor,commission_cap_minor,wait_per_minute_minor,
 per_extra_stop_minor,rush_hour_bps,traffic_time_pricing,booking_fee_bps,is_placeholder,per_helper_minor,per_floor_minor,free_loading_minutes)
SELECT gen_random_uuid(),vehicle,base_minor,per_km_minor,per_minute_minor,minimum_minor,rush_hour_enabled,
 supply_demand_enabled,commission_bps,commission_mode,commission_fixed_minor,commission_cap_minor,wait_per_minute_minor,
 per_extra_stop_minor,rush_hour_bps,traffic_time_pricing,booking_fee_bps,is_placeholder,per_helper_minor,per_floor_minor,15
FROM pricing_policies WHERE vehicle='van' AND NOT active ORDER BY created_at DESC LIMIT 1;

INSERT INTO pricing_policies(id,vehicle,base_minor,per_km_minor,per_minute_minor,minimum_minor,commission_bps,active,is_placeholder,free_loading_minutes)
VALUES
 (gen_random_uuid(),'tricycle',0,0,0,0,1300,true,true,10),
 (gen_random_uuid(),'pickup',0,0,0,0,1300,true,true,15),
 (gen_random_uuid(),'box_truck',0,0,0,0,1300,true,true,30),
 (gen_random_uuid(),'long_vehicle',0,0,0,0,1300,true,true,30);

CREATE TABLE cargo_policy_settings(
 id smallint PRIMARY KEY DEFAULT 1 CHECK(id=1),
 liability_limit_minor integer CHECK(liability_limit_minor IS NULL OR liability_limit_minor BETWEEN 1 AND 2147483647),
 liability_terms text NOT NULL DEFAULT '',
 updated_by uuid REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cargo_policy_settings(id) VALUES(1);
