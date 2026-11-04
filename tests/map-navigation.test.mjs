import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { osrmRouting, stepInstruction } from '../services/api/dispatch-routing.mjs';
import { formatDistance, locateOnRoute, metersBetween, rerouteCheck, upcomingStep } from '../apps/mobile/src/rider/navigation-logic.mjs';
import { privateMapStyle } from '../apps/mobile/src/maps/private-map-style.mjs';

const road = [{ latitude: 5.6, longitude: -0.2 }, { latitude: 5.61, longitude: -0.2 }, { latitude: 5.61, longitude: -0.19 }];

test('position on the route gives progress and distance off it', () => {
  const on = locateOnRoute({ latitude: 5.605, longitude: -0.2 }, road);
  assert.ok(on.offRouteMeters < 1);
  assert.ok(Math.abs(on.traveledMeters - metersBetween(road[0], road[1]) / 2) < 2);
  assert.ok(Math.abs(on.routeMeters - on.traveledMeters - on.remainingMeters) < 1);
  assert.ok(locateOnRoute({ latitude: 5.605, longitude: -0.195 }, road).offRouteMeters > 400);
  assert.equal(locateOnRoute(null, road), null);
});

test('the next manoeuvre is the one after the road being ridden', () => {
  const steps = [{ distanceMeters: 100, instruction: 'Head out' }, { distanceMeters: 200, instruction: 'Turn left' }, { distanceMeters: 0, instruction: 'You have arrived' }];
  assert.deepEqual([upcomingStep(steps, 40).step.instruction, upcomingStep(steps, 40).metersToStep], ['Turn left', 60]);
  assert.equal(upcomingStep(steps, 150).step.instruction, 'You have arrived');
  assert.equal(upcomingStep(steps, 999).last, true);
});

test('one bad GPS reading does not reroute, repeated ones do, with a cooldown', () => {
  let state = {};
  state = rerouteCheck(state, { offRouteMeters: 90, accuracy: 10, now: 100000 });
  assert.equal(state.reroute, false);
  state = rerouteCheck(state, { offRouteMeters: 90, accuracy: 200, now: 102000 });
  assert.equal(state.reroute, false, 'poor accuracy is ignored');
  state = rerouteCheck(state, { offRouteMeters: 90, accuracy: 10, now: 104000 });
  assert.equal(state.reroute, true);
  state = rerouteCheck(state, { offRouteMeters: 90, accuracy: 10, now: 106000 });
  state = rerouteCheck(state, { offRouteMeters: 90, accuracy: 10, now: 108000 });
  assert.equal(state.reroute, false, 'cooldown');
  state = rerouteCheck(state, { offRouteMeters: 5, accuracy: 10, now: 130000 });
  assert.equal(state.strikes, 0);
  assert.equal(formatDistance(1500), '1.5 km');
});

test('route steps become plain instructions and steps are off for other callers', async () => {
  assert.equal(stepInstruction({ maneuver: { type: 'turn', modifier: 'left' }, name: 'Oxford Street' }), 'Turn left onto Oxford Street');
  assert.equal(stepInstruction({ maneuver: { type: 'roundabout', exit: 2 }, name: '' }), 'At the roundabout, take exit 2');
  assert.equal(stepInstruction({ maneuver: { type: 'arrive' } }), 'You have arrived');
  const urls = [];
  const fetchImpl = async url => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ code: 'Ok', waypoints: [], routes: [{ distance: 1500, duration: 300, geometry: { type: 'LineString', coordinates: [[-0.2, 5.6], [-0.2, 5.61]] }, legs: [{ steps: [{ distance: 1500, duration: 300, name: 'Ring Road', maneuver: { type: 'depart', location: [-0.2, 5.6] } }, { distance: 0, duration: 0, name: '', maneuver: { type: 'arrive', location: [-0.2, 5.61] } }] }] }] }) };
  };
  const routing = osrmRouting({ endpoint: 'http://osrm.test', profiles: { motorcycle: 'driving' }, fetchImpl });
  const a = { latitude: 5.6, longitude: -0.2 }, b = { latitude: 5.61, longitude: -0.2 };
  assert.equal((await routing.route(a, b, { vehicle: 'motorcycle' })).steps, undefined);
  const nav = await routing.route(a, b, { vehicle: 'motorcycle', steps: true });
  assert.match(urls[1], /steps=true/);
  assert.deepEqual(nav.steps.map(s => s.instruction), ['Head out on Ring Road', 'You have arrived']);
});

test('the style has day and night looks, and the night one stays on our tiles', () => {
  const url = 'https://tiles.test/tiles/{z}/{x}/{y}.pbf', glyphsUrl = 'https://tiles.test/fonts/{fontstack}/{range}.pbf';
  const day = privateMapStyle(url, { glyphsUrl }), night = privateMapStyle(url, { glyphsUrl, night: true });
  assert.notEqual(day.layers[0].paint['background-color'], night.layers[0].paint['background-color']);
  assert.deepEqual(day.layers.map(l => l.id), night.layers.map(l => l.id));
  assert.deepEqual(night.sources.ghana.tiles, [url]);
  assert.equal(privateMapStyle(url).layers.some(l => l.type === 'symbol'), false, 'no text layers without a font server');
  assert.equal(privateMapStyle(null).layers.length, 1);
});

test('the motorcycle graph has its own rules and keeps one-way streets', () => {
  const lua = readFileSync(new URL('../deploy/maps/motorcycle.lua', import.meta.url), 'utf8');
  assert.match(lua, /'motorcycle', 'motor_vehicle'/);
  assert.doesNotMatch(lua, /oneway\s*=\s*false/);
  for (const file of ['prepare-ghana-osrm.sh', 'prepare-ghana-osrm.ps1']) assert.match(readFileSync(new URL('../scripts/' + file, import.meta.url), 'utf8'), /\/data\/motorcycle\.lua/);
});

test('a suspended rider finishing a parcel can still get directions', () => {
  assert.match(readFileSync(new URL('../services/api/http.mjs', import.meta.url), 'utf8'), /CUSTODY_ROUTES=new Set\([^)]*POST \/api\/v1\/rider\/navigation/);
});

test('voice says each turn once from afar and once when close', async () => {
  const { voicePrompt } = await import('../apps/mobile/src/rider/navigation-logic.mjs');
  const step = { instruction: 'Turn left onto Oxford Street' };
  let v = voicePrompt({}, { index: 0, metersToStep: 900, step });
  assert.equal(v.say, null);
  v = voicePrompt(v.state, { index: 0, metersToStep: 280, step });
  assert.equal(v.say, 'In 280 m, turn left onto Oxford Street');
  v = voicePrompt(v.state, { index: 0, metersToStep: 250, step });
  assert.equal(v.say, null);
  v = voicePrompt(v.state, { index: 0, metersToStep: 50, step });
  assert.equal(v.say, 'Turn left onto Oxford Street');
  v = voicePrompt(v.state, { index: 0, metersToStep: 20, step });
  assert.equal(v.say, null);
  assert.equal(voicePrompt(v.state, { index: 1, metersToStep: 50, step }).say, 'Turn left onto Oxford Street');
});
