-- Each vehicle type has a heaviest parcel and a longest trip it is quoted for.
-- Before this, a 40 kg parcel or an Accra-Kumasi trip got a motorbike price, was paid for, and then no rider
-- could take it. NULL means no limit. Staff change these through the vehicle policy settings.
ALTER TABLE vehicle_capabilities
  ADD COLUMN max_weight_g integer CHECK (max_weight_g IS NULL OR max_weight_g > 0),
  ADD COLUMN max_trip_m integer CHECK (max_trip_m IS NULL OR max_trip_m > 0);

UPDATE vehicle_capabilities SET max_weight_g = l.weight, max_trip_m = l.trip
FROM (VALUES
  ('bicycle',       10000,  15000),
  ('motorcycle',    25000,  80000),
  ('tricycle',     200000,  40000),
  ('car',          100000, 200000),
  ('pickup',      1000000, 300000),
  ('van',         1000000, 400000),
  ('truck',       5000000, 600000)
) AS l(vehicle, weight, trip)
WHERE vehicle_capabilities.vehicle = l.vehicle;
