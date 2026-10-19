-- Additive, optional pricing terms. All prior quote and commission snapshots remain unchanged.
-- These terms remain zero unless explicitly configured by an authorized administrator.
ALTER TABLE pricing_policies
 ADD COLUMN per_minute_minor integer NOT NULL DEFAULT 0 CHECK (per_minute_minor BETWEEN 0 AND 100000),
 ADD COLUMN wait_per_minute_minor integer NOT NULL DEFAULT 0 CHECK (wait_per_minute_minor BETWEEN 0 AND 100000),
 ADD COLUMN per_extra_stop_minor integer NOT NULL DEFAULT 0 CHECK (per_extra_stop_minor BETWEEN 0 AND 1000000);
