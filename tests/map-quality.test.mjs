// Every search in config/map-quality.json must keep finding the right place first.
import test from 'node:test';
import assert from 'node:assert/strict';
import {searchFailures,MAP_QUALITY} from '../scripts/map-quality.mjs';
test('map quality searches all find the expected place first',()=>assert.deepEqual(searchFailures(),[]));
test('every map quality route has valid Ghana coordinates and a vehicle',()=>{
 for(const r of MAP_QUALITY.routes){for(const [la,lo] of [r.from,r.to])assert.ok(la>=4.5&&la<=11.4&&lo>=-3.4&&lo<=1.4,r.name);assert.ok(r.vehicles.length,r.name);}
});
