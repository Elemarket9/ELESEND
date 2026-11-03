-- Tracks which riders support a candidate road, so one rider cannot count as several.
ALTER TABLE candidate_roads
  ADD COLUMN IF NOT EXISTS contributor_rider_ids uuid[] NOT NULL DEFAULT '{}';
