import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analyzeBoundaries,readBaseline} from '../scripts/module-boundaries.mjs';

const found=analyzeBoundaries(),baseline=readBaseline();
const added=(now,old)=>now.filter(x=>!old.includes(x));

test('every API file belongs to a module',()=>assert.deepEqual(found.unassigned,[]));
test('other modules reach payments only through its public entry',()=>assert.deepEqual(found.entryViolations,[]));
test('payments depends on nothing but shared code',()=>{
 assert.deepEqual(found.imports.filter(x=>x.startsWith('payments ->')),[]);
});
test('no new imports cross a module boundary',()=>assert.deepEqual(added(found.imports,baseline.imports),[]));
test('no new SQL reaches another module\'s tables',()=>assert.deepEqual(added(found.tables,baseline.tables),[]));
test('finished migrations are removed from the baseline, so it only shrinks',()=>{
 assert.deepEqual(added(baseline.imports,found.imports),[]);
 assert.deepEqual(added(baseline.tables,found.tables),[]);
});
test('every table has one owner',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../config/modules.json',import.meta.url),'utf8'));
 const owned=[...Object.values(manifest.modules),manifest.shared].flatMap(m=>m.tables);
 assert.equal(new Set(owned).size,owned.length);
});
