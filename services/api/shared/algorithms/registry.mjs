/** All twelve algorithms have explicit global operational flags. Controls live in PostgreSQL. */
export const ALGORITHM_KEYS=Object.freeze([
 'geospatial_discovery','road_network_routing','direction_matching','eta_dispatch_ranking','multi_parcel_vrp','dynamic_pickup_insertion','cost_based_pricing','commission_exposure','financial_reconciliation','gps_filtering','eta_calibration','fraud_signals',
 'road_corridor_discovery','multi_rider_broadcast','fleet_batch_optimization'
]);
export const EXPERIMENTAL_ALGORITHMS=new Set(['road_corridor_discovery','multi_rider_broadcast','fleet_batch_optimization','eta_calibration','fraud_signals','gps_filtering']);
export function validateFeatureKey(key){if(!ALGORITHM_KEYS.includes(key))throw Error('Unknown dispatch feature');return key;}
