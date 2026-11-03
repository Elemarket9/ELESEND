// Finds imports and SQL that cross module boundaries. Run with --write only to record a smaller baseline.
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join,normalize,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const api=join(root,'services/api');
const baselinePath=join(root,'config/module-boundary-baseline.json');
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):e.name.endsWith('.mjs')?[join(dir,e.name)]:[]);

export function analyzeBoundaries(){
 const manifest=JSON.parse(readFileSync(join(root,'config/modules.json'),'utf8'));
 const groups={...manifest.modules,shared:manifest.shared,composition:manifest.composition};
 const moduleOf=file=>Object.keys(groups).find(name=>groups[name].paths.some(p=>p.endsWith('/')?file.startsWith(p):file===p))??null;
 const owner=new Map(Object.entries(groups).flatMap(([name,g])=>(g.tables??[]).map(t=>[t,name])));
 const tablePattern=new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(${[...owner.keys()].join('|')})\\b`,'g');
 const files=walk(api).map(f=>relative(api,f).replaceAll('\\','/'));
 const unassigned=files.filter(f=>f!=='modules.json'&&!moduleOf(f));
 const imports=new Set(),tables=new Set(),entryViolations=[];
 for(const file of files){
  const from=moduleOf(file),text=readFileSync(join(api,file),'utf8');
  for(const m of text.matchAll(/(?:from\s+|import\s*\()['"](\.[^'"]+\.mjs)['"]/g)){
   const target=normalize(join(dirname(file),m[1])).replaceAll('\\','/'),to=moduleOf(target);
   if(!to||to===from||to==='shared')continue;
   const entry=groups[to].entry;
   if(entry&&target!==entry)entryViolations.push(`${file} -> ${target}`);
   if(from!=='composition'&&!entry)imports.add(`${from} -> ${to}`);
   if(from!=='composition'&&entry&&from!=='shared')imports.add(`${from} -> ${to}`);
  }
  if(from==='shared')continue;
  for(const m of text.matchAll(tablePattern)){
   if(owner.get(m[1])!==from&&owner.get(m[1])!=='shared')tables.add(`${file}: ${m[1]}`);
  }
 }
 return {unassigned,entryViolations,imports:[...imports].sort(),tables:[...tables].sort()};
}
export const readBaseline=()=>JSON.parse(readFileSync(baselinePath,'utf8'));
if(process.argv[1]===fileURLToPath(import.meta.url)&&process.argv.includes('--write')){
 const {imports,tables}=analyzeBoundaries();
 writeFileSync(baselinePath,JSON.stringify({imports,tables},null,1)+'\n');
}
