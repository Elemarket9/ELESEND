import test from 'node:test';
import assert from 'node:assert/strict';
import {createOfflineCache,KEY,MAX_AGE_MS} from '../apps/mobile/src/offline.js';

test('corrupt offline cache and future-dated metadata cannot crash rider app or resurrect stale jobs',async()=>{
 const store=new Map();
 const storage={getItemAsync:async key=>store.get(key)??null,setItemAsync:async(key,val)=>store.set(key,String(val)),deleteItemAsync:async key=>store.delete(key)};
 const cache=createOfflineCache(storage);
 const rider='rider-a';
 store.set(KEY+'.meta','{truncated');
 assert.equal(await cache.readCachedJobs(rider),null,'damaged SecureStore metadata should produce unavailable cache');
 const now=Date.now();
 store.set(KEY+'.meta',JSON.stringify({actorId:rider,savedAt:now,count:1}));
 store.set(KEY+'.0','{unfinished');
 assert.equal(await cache.readCachedJobs(rider,now),null,'damaged cached shipment JSON should not crash a rider app');
 store.set(KEY+'.0',JSON.stringify({shipments:[],stops:[]}));
 store.set(KEY+'.meta',JSON.stringify({actorId:rider,savedAt:now+MAX_AGE_MS*2,count:1}));
 assert.equal(await cache.readCachedJobs(rider,now),null,'future-dated cache should not bypass retention');
});
