import {osrmRouting} from './osrm-routing.mjs';
import {privateRoutingPriority} from './PrivateRoutingPolicy.mjs';
import {googleMapsConfig, googleRouting} from './google-maps.mjs';

/** Builds the one routing adapter the API and worker share. Returns null when no routing is configured. */
export function createRouting(config, env = process.env) {
  const provider = privateRoutingPriority(env);
  const billingSnapMeters = env.ROUTING_BILLING_SNAP_METERS ? Number(env.ROUTING_BILLING_SNAP_METERS) : undefined;
  if (provider === 'google') {
    const google = googleMapsConfig(env);
    return googleRouting({apiKey: google.apiKey, trafficAware: google.trafficAware, twoWheeler: google.twoWheeler, limits: google.limits, billingSnapMeters});
  }
  return (config.routing.vehicleRoutes || config.routing.osrmUrl)
    ? osrmRouting({endpoint: config.routing.osrmUrl, profiles: config.routing.profiles, vehicleRoutes: config.routing.vehicleRoutes, billingSnapMeters})
    : null;
}
