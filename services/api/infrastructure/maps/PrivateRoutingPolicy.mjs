import {check} from '../../security.mjs';
// No billable routing fallback, even if an old Google key remains in the host.
export function privateRoutingPriority(env=process.env){
 const priority=env.ROUTING_PROVIDER_PRIORITY??'osrm';
 check(priority.trim()==='osrm',500,'Private mapping permits only self-hosted OSRM routing');
 return 'osrm';
}
