-- EGIA: read every rider trip once, publish roads that pass verification, and record imagery changes.
ALTER TABLE candidate_roads
  ADD COLUMN IF NOT EXISTS published_automatically boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS imagery_supported boolean NOT NULL DEFAULT false;
ALTER TABLE candidate_landmarks
  ADD COLUMN IF NOT EXISTS published_automatically boolean NOT NULL DEFAULT false;
CREATE TABLE geo_learning_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  processed_until timestamptz NOT NULL
);
-- Results of comparing satellite images. The images themselves are never stored.
CREATE TABLE map_change_areas (
  cell_key text PRIMARY KEY,
  area_name text NOT NULL,
  cell geography(Polygon, 4326) NOT NULL,
  built_up_change real NOT NULL,
  vegetation_change real NOT NULL,
  baseline_date date NOT NULL,
  latest_date date NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX map_change_areas_cell ON map_change_areas USING gist(cell);
CREATE TABLE map_change_scans (
  area_name text PRIMARY KEY,
  scanned_at timestamptz NOT NULL,
  outcome text NOT NULL,
  changed_cells integer NOT NULL DEFAULT 0
);
