import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {analyzeBoundaries,readBaseline} from '../scripts/module-boundaries.mjs';

const found=analyzeBoundaries(),baseline=readBaseline();
const added=(now,old)=>now.filter(x=>!old.includes(x));

test('every API file belongs to a module, shared code or composition',()=>assert.deepEqual(found.unassigned,[]));
test('every module has a public entry',()=>assert.deepEqual(found.missingEntries,[]));
test('code reaches another module only through its public entry',()=>assert.deepEqual(found.entryViolations,[]));
test('shared code depends on no module',()=>assert.deepEqual(found.sharedViolations,[]));
test('module dependencies are exactly the ones declared in config/modules.json',()=>{
 assert.deepEqual(found.undeclaredEdges,[],'Declare the new dependency in config/modules.json, or go through an existing one');
 assert.deepEqual(found.unusedDeclarations,[],'Remove the dependency from config/modules.json');
});
test('payments and maps depend on nothing but shared code',()=>{
 assert.deepEqual(found.edges.filter(x=>x.startsWith('payments ->')||x.startsWith('maps ->')),[]);
});
test('no new SQL reaches another module\'s tables',()=>assert.deepEqual(added(found.tables,baseline.tables),[]));
test('finished migrations are removed from the baseline, so it only shrinks',()=>assert.deepEqual(added(baseline.tables,found.tables),[]));
test('every module file loads on its own, without load-order cycles',async()=>{
 // Modules depend on each other through their entries, so a value used while a file loads must not come
 // round a cycle. Loading each file first, in a fresh process, catches that before a test or server does.
 const api=new URL('../services/api/',import.meta.url);
 const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(new URL(e.name+'/',dir)):e.name.endsWith('.mjs')?[new URL(e.name,dir).href]:[]);
 const files=[...walk(new URL('modules/',api)),...walk(new URL('shared/',api))];
 const load=url=>new Promise(resolve=>{
  const child=spawn(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(url)})`],{stdio:['ignore','ignore','pipe']});
  let err='';child.stderr.on('data',d=>err+=d);
  child.on('close',code=>resolve(code===0?null:`${url.slice(api.href.length)}: ${err.split('\n').find(l=>/Error/.test(l))}`));
 });
 const failures=[];
 for(let i=0;i<files.length;i+=8)failures.push(...(await Promise.all(files.slice(i,i+8).map(load))).filter(Boolean));
 assert.deepEqual(failures,[]);
});
test('every table has one owner',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../config/modules.json',import.meta.url),'utf8'));
 const owned=[...Object.values(manifest.modules),manifest.shared].flatMap(m=>m.tables);
 assert.equal(new Set(owned).size,owned.length);
});

test('repeated code does not grow',async()=>{
 const {findDuplicates}=await import('../scripts/find-duplicates.mjs');
 assert.equal(findDuplicates(['services','apps','scripts'],8).length,0,'Remove the new repeated code with a shared helper');
 // The few 6-line matches left are design scales and short shared control flow; this stops new ones.
 assert.ok(findDuplicates(['services','apps','scripts'],6).length<=5,'Remove the new repeated code with a shared helper');
});
