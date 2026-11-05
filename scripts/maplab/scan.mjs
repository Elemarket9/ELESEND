import {scanArea,changeAreas} from '../../services/api/infrastructure/maps/egia/imagery-change-scan.mjs';
import {createRequire} from 'node:module';
for(const area of changeAreas({})){const t=Date.now();try{const r=await scanArea(area);console.log(area.name,r.outcome,'cells',r.cells.length,r.baselineDate,r.latestDate,Date.now()-t,'ms','mem',Math.round(process.memoryUsage().rss/1e6),'MB');console.log(JSON.stringify(r.cells.slice(0,5).map(c=>({at:c.ring[0],built:+c.builtUpChange.toFixed(2),veg:+c.vegetationChange.toFixed(2)}))));}catch(e){console.log(area.name,'FAILED',e.stack.slice(0,500));}}
