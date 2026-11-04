-- The vehicle record is the only place a plate is stored.
UPDATE rider_vehicle_registrations v SET registration_plate=l.vehicle_plate
  FROM rider_licences l WHERE l.rider_id=v.rider_id AND v.registration_plate IS NULL AND l.vehicle_plate IS NOT NULL;
INSERT INTO rider_vehicle_registrations(rider_id,vehicle,registration_plate)
  SELECT l.rider_id,r.vehicle,l.vehicle_plate FROM rider_licences l JOIN riders r ON r.id=l.rider_id
  WHERE l.vehicle_plate IS NOT NULL AND r.vehicle<>'car' ON CONFLICT(rider_id) DO NOTHING;
ALTER TABLE rider_licences DROP COLUMN vehicle_plate;
