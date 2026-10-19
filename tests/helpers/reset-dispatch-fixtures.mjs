export async function resetDispatchFixtures(db){
 await db.query(`UPDATE dispatch_policy SET
  search_radii_m=ARRAY[2000,5000,10000],candidate_limit=10,fresh_seconds=75,
  max_sample_age_seconds=120,max_accuracy_m=100,max_speed_mps=55,
  offer_seconds=30,retry_seconds=30,max_attempts=15,sample_retention_hours=24,
  moving_upload_seconds=15,idle_upload_seconds=60,multi_stop_enabled=false,
  max_active_parcels=2,max_detour_seconds=480,delivery_slack_seconds=1200,
  max_pickup_eta_seconds=1800,max_offer_movement_m=300,updated_at=now() WHERE id=1`);
 await db.query(`INSERT INTO dispatch_algorithm_features(feature_key,enabled) VALUES
  ('geospatial_discovery',true),('road_network_routing',true),('direction_matching',true),
  ('eta_dispatch_ranking',true),('multi_parcel_vrp',false),('dynamic_pickup_insertion',false),
  ('cost_based_pricing',true),('commission_exposure',true),('financial_reconciliation',true),
  ('gps_filtering',false),('eta_calibration',false),('fraud_signals',false),
  ('road_corridor_discovery',false),('multi_rider_broadcast',false),('fleet_batch_optimization',false)
  ON CONFLICT(feature_key) DO UPDATE SET enabled=excluded.enabled,updated_by=NULL,updated_at=now()`);
}
