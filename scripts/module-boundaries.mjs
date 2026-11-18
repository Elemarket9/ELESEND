// Checks the API's module boundaries. Run with --write only to record a smaller table baseline.
//
// Layout (config/modules.json):
//   modules/<name>/   one folder per module; other code may import only its index.mjs
//   shared/           code with no business owner; it may not import any module
//   the rest          composition: http.mjs, server.mjs, worker.mjs and config.mjs wire the modules together
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join,normalize,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const api=join(root,'services/api');
const baselinePath=join(root,'config/module-boundary-baseline.json');
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):e.name.endsWith('.mjs')?[join(dir,e.name)]:[]);

export const readManifest=()=>JSON.parse(readFileSync(join(root,'config/modules.json'),'utf8'));

export function analyzeBoundaries(){
 const manifest=readManifest();
 const groups={...manifest.modules,shared:manifest.shared,composition:manifest.composition};
 const moduleOf=file=>Object.keys(groups).find(name=>groups[name].paths.some(p=>p.endsWith('/')?file.startsWith(p):file===p))??null;
 const owner=new Map(Object.entries(groups).flatMap(([name,g])=>(g.tables??[]).map(t=>[t,name])));
 const tablePattern=new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(${[...owner.keys()].join('|')})\\b`,'g');
 const files=walk(api).map(f=>relative(api,f).replaceAll('\\','/'));
 const unassigned=files.filter(f=>!moduleOf(f));
 const missingEntries=Object.entries(manifest.modules).filter(([,m])=>!m.entry||!files.includes(m.entry)).map(([name])=>name);
 const edges=new Set(),tables=new Set(),entryViolations=[],sharedViolations=[];
 for(const file of files){
  const from=moduleOf(file),text=readFileSync(join(api,file),'utf8');
  for(const m of text.matchAll(/(?:from\s+|import\s*\()['"](\.[^'"]+\.mjs)['"]/g)){
   const target=normalize(join(dirname(file),m[1])).replaceAll('\\','/'),to=moduleOf(target);
   if(!to||to===from||to==='shared'||to==='composition')continue;
   if(from==='shared'){sharedViolations.push(`${file} -> ${target}`);continue;}
   if(target!==groups[to].entry)entryViolations.push(`${file} -> ${target}`);
   if(from!=='composition')edges.add(`${from} -> ${to}`);
  }
  if(from==='shared')continue;
  for(const m of text.matchAll(tablePattern)){
   if(owner.get(m[1])!==from&&owner.get(m[1])!=='shared')tables.add(`${file}: ${m[1]}`);
  }
 }
 const declared=new Set(Object.entries(manifest.modules).flatMap(([name,m])=>(m.dependsOn??[]).map(to=>`${name} -> ${to}`)));
 return {
  unassigned,missingEntries,entryViolations,sharedViolations,
  edges:[...edges].sort(),
  undeclaredEdges:[...edges].filter(e=>!declared.has(e)).sort(),
  unusedDeclarations:[...declared].filter(e=>!edges.has(e)).sort(),
  tables:[...tables].sort()
 };
}
export const readBaseline=()=>JSON.parse(readFileSync(baselinePath,'utf8'));
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const found=analyzeBoundaries();
 if(process.argv.includes('--write'))writeFileSync(baselinePath,JSON.stringify({tables:found.tables},null,1)+'\n');
 else console.log(JSON.stringify({...found,tables:found.tables.length},null,1));
}
