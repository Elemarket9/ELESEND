-- Migration 042: Enhanced Candidate Road Routing Graph, Topology & Provenance
-- Adds topology connectivity, one-way enforcement, vehicle restrictions, 
-- and multi-factor GPS corroboration provenance.

ALTER TABLE candidate_roads 
  ADD COLUMN IF NOT EXISTS is_one_way boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS one_way_bearing double precision,
  ADD COLUMN IF NOT EXISTS max_speed_kmh integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS is_pedestrian_only boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_private_access boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connected_road_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  ADD COLUMN IF NOT EXISTS snapped_to_network boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS network_snap_distance_m double precision,
  ADD COLUMN IF NOT EXISTS temporal_span_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bidirectional boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mean_accuracy_m double precision DEFAULT 10.0;

-- Index for spatial network routing queries
CREATE INDEX IF NOT EXISTS idx_candidate_roads_routing 
  ON candidate_roads(status, is_private_access) 
  WHERE status = 'PUBLISHED' AND is_private_access = false;
