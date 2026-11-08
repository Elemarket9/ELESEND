// Hand-added places must say where their position came from, and when, so nobody has to guess later.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PLACE_OVERLAY} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';
test('every hand-added place is sourced, dated and inside Ghana',()=>{
 assert.ok(PLACE_OVERLAY.length>0);
 for(const p of PLACE_OVERLAY){
  assert.ok(p.name&&p.category&&p.region,JSON.stringify(p));
  assert.ok(String(p.positionSource||'').length>=10,p.name+' needs positionSource');
  assert.match(String(p.checkedOn),/^\d{4}-\d{2}-\d{2}$/,p.name+' needs checkedOn');
  assert.ok(['entrance','building','street','area'].includes(p.precision),p.name+' needs precision');
  assert.ok(p.latitude>=4.5&&p.latitude<=11.4&&p.longitude>=-3.4&&p.longitude<=1.4,p.name);
 }
});
