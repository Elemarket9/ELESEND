-- Riders who opt in can carry more than one parcel when the parcels go the same way. Each parcel keeps its own commission.
UPDATE dispatch_policy SET multi_stop_enabled=true,max_detour_seconds=LEAST(max_detour_seconds,300);
UPDATE dispatch_algorithm_features SET enabled=true WHERE feature_key IN ('multi_parcel_vrp','dynamic_pickup_insertion');
