-- Additive search index for OpenStreetMap places, named roads and Overture places.
-- New rows are unverified. The loader will not replace a curated row.
-- Existing trigram indexes on spatial_landmarks (migration 027) cover the new rows.

ALTER TABLE spatial_landmarks
  ADD COLUMN IF NOT EXISTS source_date date,
  ADD COLUMN IF NOT EXISTS confidence double precision;

CREATE TABLE IF NOT EXISTS road_gap_flags (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'REVIEW_REQUIRED' CHECK (status IN ('REVIEW_REQUIRED', 'approved', 'rejected')),
  area text NOT NULL,
  length_m integer NOT NULL CHECK (length_m > 0),
  latitude double precision NOT NULL CHECK (latitude BETWEEN 4.5 AND 11.5),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -3.5 AND 1.5),
  reason text NOT NULL,
  observed_on date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profile_speed_proposals (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  area text NOT NULL CHECK (area IN ('greater_accra', 'kumasi')),
  vehicle text NOT NULL CHECK (vehicle IN ('car', 'motorcycle')),
  proposed_kmh real NOT NULL CHECK (proposed_kmh > 0 AND proposed_kmh < 120),
  samples integer NOT NULL CHECK (samples > 0),
  source text NOT NULL DEFAULT 'rider_gps',
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

-- Proposals are a review record. Quote, commission, settlement and rider earnings do not read these tables.
