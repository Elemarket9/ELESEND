-- Migration 028: Enrich Spatial Landmarks Metadata with Street, Canonical Aliases & Verified Entrances
ALTER TABLE spatial_landmarks ADD COLUMN IF NOT EXISTS street text;

-- Update verified KAAF University campus entries
UPDATE spatial_landmarks
SET 
  aliases = '["KHAF University", "KAAF University College", "KAAF University Kasoa", "KAAF University Fetteh Kakraba", "KAAF Uni", "KUC", "KAAF", "KAAF Main Campus"]'::jsonb,
  street = 'KAAF Avenue Street',
  entrance = '{"latitude": 5.52735, "longitude": -0.47980, "description": "Main Gate on KAAF Avenue Street / Gomoa Fetteh Road"}'::jsonb,
  popularity = 95
WHERE id = 'GEO_000031' OR name = 'KAAF University (Main Campus - Fetteh Kakraba)';

UPDATE spatial_landmarks
SET 
  aliases = '["KAAF Darkuman", "KAAF City Campus", "KAAF University Accra", "KAAF Darkuman Junction", "KHAF Darkuman"]'::jsonb,
  street = 'Kaneshie-Odorkor Highway',
  entrance = '{"latitude": 5.5898, "longitude": -0.2524, "description": "BigLeg Plaza Entrance"}'::jsonb,
  popularity = 85
WHERE id = 'GEO_000423' OR name = 'KAAF University (City Campus - Darkuman)';

UPDATE spatial_landmarks
SET 
  aliases = '["KAAF East Legon", "KAAF Legon", "KHAF East Legon"]'::jsonb,
  street = '113A Mbabane Ave',
  entrance = '{"latitude": 5.6350, "longitude": -0.1580, "description": "113A Mbabane Ave Gate"}'::jsonb,
  popularity = 80
WHERE id = 'GEO_000428' OR name = 'KAAF University (East Legon Campus)';

-- Update raw duplicate Kaaf record to point clearly to Accra location
UPDATE spatial_landmarks
SET popularity = 70
WHERE id = 'GEO_000065';
