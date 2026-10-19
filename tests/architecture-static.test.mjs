import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=async path=>readFile(new URL(path,import.meta.url),'utf8');
test('database retains one accepted offer per shipment, but supports multi-rider offered states',async()=>{
 const old=await source('../database/migrations/003_intelligent_dispatch.sql');
 const migration=await source('../database/migrations/011_dispatch_broadcast_corridors_features.sql');
 const dispatch=await source('../services/api/dispatch.mjs');
 assert.match(old,/one_accepted_shipment_offer/);assert.match(migration,/DROP INDEX IF EXISTS one_open_shipment_offer/);
 assert.match(migration,/one_open_offer_per_rider_shipment/);assert.match(dispatch,/SET status='invalidated' WHERE shipment_id=\$1 AND id<>\$2 AND status='offered'/);
});
test('3 percent commission policy uses new policy version, never rewrites old quote records',async()=>{
 const m=await source('../database/migrations/014_three_percent_policy_version.sql');
 assert.match(m,/previous\.commission_bps<>300/);assert.match(m,/VALUES \(gen_random_uuid\(\),previous\.base_minor/);
 assert.doesNotMatch(m,/UPDATE quotes SET/);
});
test('provider neutral backend: no hoster-specific imports, no paid cash fabricated',async()=>{
 for(const file of ['../services/api/server.mjs','../services/api/dispatch.mjs','../services/api/finance.mjs']){
  const body=await source(file);assert.doesNotMatch(body,/hostinger|hetzner|digitalocean/i);
 }
 assert.match(await source('../services/api/finance.mjs'),/cash_commission:/);
});
test('native mobile admin feature switches use permissioned API, not a web portal',async()=>{
 assert.match(await source('../apps/mobile/App.js'),/admin\/algorithm-features/);
 assert.match(await source('../services/api/http.mjs'),/dispatcher\.setAlgorithmFeature\(actor,body\)/);
});
