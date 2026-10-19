ALTER TABLE riders ADD COLUMN service_radius_m integer NOT NULL DEFAULT 10000 CHECK(service_radius_m BETWEEN 250 AND 100000);
CREATE TABLE vehicle_capabilities (
 vehicle text PRIMARY KEY CHECK(vehicle IN ('bicycle','motorcycle','tricycle','car','pickup','van','truck')),
 max_parcel_size text NOT NULL CHECK(max_parcel_size IN ('small','medium','large')),
 allowed_categories text[] NOT NULL CHECK(cardinality(allowed_categories)>0),
 enabled boolean NOT NULL DEFAULT true
);
INSERT INTO vehicle_capabilities(vehicle,max_parcel_size,allowed_categories) VALUES
 ('bicycle','small',ARRAY['general','documents']),
 ('motorcycle','medium',ARRAY['general','documents']),
 ('tricycle','large',ARRAY['general','documents','fragile']),
 ('car','large',ARRAY['general','documents','fragile']),
 ('pickup','large',ARRAY['general','documents','fragile']),
 ('van','large',ARRAY['general','documents','fragile']),
 ('truck','large',ARRAY['general','documents']);
-- Food requires a separately approved carrying policy and is disabled by default.
