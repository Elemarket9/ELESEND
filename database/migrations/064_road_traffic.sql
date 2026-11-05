-- Road speeds measured from riders' trips. Stores road segments and speeds, never who rode them.
CREATE TABLE traffic_observations (
 vehicle text NOT NULL,
 from_node bigint NOT NULL,
 to_node bigint NOT NULL,
 speed_kmh real NOT NULL CHECK(speed_kmh>0 AND speed_kmh<=130),
 observed_at timestamptz NOT NULL
);
CREATE INDEX traffic_observations_segment ON traffic_observations(vehicle,from_node,to_node,observed_at DESC);
CREATE INDEX traffic_observations_age ON traffic_observations(observed_at);
-- Usual speed for a segment at one hour of the week (0 = Sunday midnight), Ghana time.
CREATE TABLE traffic_typical_speeds (
 vehicle text NOT NULL,
 from_node bigint NOT NULL,
 to_node bigint NOT NULL,
 hour_of_week smallint NOT NULL CHECK(hour_of_week BETWEEN 0 AND 167),
 speed_kmh real NOT NULL,
 samples integer NOT NULL,
 PRIMARY KEY(vehicle,from_node,to_node,hour_of_week)
);
CREATE TABLE traffic_cursor (
 id integer PRIMARY KEY DEFAULT 1 CHECK(id=1),
 processed_until timestamptz NOT NULL
);
