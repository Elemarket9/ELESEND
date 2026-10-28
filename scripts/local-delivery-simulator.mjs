import {runLocalSimulation} from './prelaunch-simulation.mjs';
// CLI defaults to test, but never overrides an explicitly configured environment.
process.env.NODE_ENV ||= 'test';
runLocalSimulation().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
