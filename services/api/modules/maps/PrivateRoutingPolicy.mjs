import {check} from '../../shared/security.mjs';
// Routing is self-hosted OSRM unless Google is chosen on purpose with ROUTING_PROVIDER_PRIORITY=google.
// There is never a silent fallback between them: a leftover Google key does nothing while OSRM is selected.
export const ROUTING_PROVIDERS = Object.freeze(['osrm', 'google']);
export function privateRoutingPriority(env=process.env){
 const priority=(env.ROUTING_PROVIDER_PRIORITY??'osrm').trim().toLowerCase();
 check(ROUTING_PROVIDERS.includes(priority),500,'ROUTING_PROVIDER_PRIORITY must be osrm or google');
 return priority;
}
