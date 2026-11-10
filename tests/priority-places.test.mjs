import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {classifyOsmTags, geometryCentre, INSERT_LANDMARKS_SQL, landmarkRecord, overturePlace, placeGrid, priorityArea} from '../scripts/place-import.mjs';
import {photonResult, photonSearch} from '../services/api/infrastructure/maps/photon-search.mjs';
import {ghanaSearch, GHANA_GAZETTEER, searchPlaces} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';
import {missingLinkFlags, speedProposals} from '../services/api/infrastructure/maps/trace-review.mjs';

const run = promisify(execFile);

test('OpenStreetMap tags keep delivery places and name the reason for every drop', () => {
  assert.equal(classifyOsmTags({amenity: 'toilets', name: 'Public Toilet'}).drop, 'not_a_destination');
  assert.equal(classifyOsmTags({amenity: 'pharmacy', name: 'Adepa Pharmacy'}).category, 'health');
  assert.equal(classifyOsmTags({shop: 'supermarket', name: 'Melcom'}).category, 'commerce');
  assert.equal(classifyOsmTags({amenity: 'place_of_worship', name: 'Action Chapel'}).category, 'religion');
  assert.equal(classifyOsmTags({highway: 'residential', name: 'Spintex Road'}).kind, 'road');
  assert.equal(classifyOsmTags({highway: 'footway', name: 'Foot Path'}).drop, 'not_a_destination');
  assert.equal(classifyOsmTags({amenity: 'clinic', name: 'Clinic', disused: 'yes'}).drop, 'disused');
  assert.equal(classifyOsmTags({amenity: 'bank'}).drop, 'unnamed');
  const station = classifyOsmTags({amenity: 'fuel', name: 'Zzprobe Goil'});
  assert.equal(station.category, 'commerce');
  assert.equal(station.subcategory, 'fuel');
  assert.equal(classifyOsmTags({amenity: 'bus_station', name: 'Zzprobe Bus Station'}).category, 'transport');
});

test('a named road uses its own midpoint and never gains a house number', () => {
  const feature = {id: 'way1', properties: {highway: 'residential', name: 'Spintex Road', 'addr:housenumber': '12'}, geometry: {type: 'LineString', coordinates: [[-0.12, 5.63], [-0.10, 5.64]]}};
  const built = geometryCentre(feature.geometry);
  assert.ok(Math.abs(built.latitude - 5.635) < 0.001);
  const place = landmarkRecord({id: 'ROAD_way1', name: 'Spintex Road', category: 'road', subcategory: 'residential', latitude: built.latitude, longitude: built.longitude, coordinate_kind: 'road_midpoint', source: 'OpenStreetMap', license: 'ODbL 1.0', area: 'greater_accra'});
  assert.equal(place.verification_status, 'unverified');
  assert.equal(place.street, null);
  assert.equal(place.housenumber, undefined);
  assert.equal(priorityArea(5.63, -0.11), 'greater_accra');
  assert.equal(priorityArea(6.69, -1.62), 'kumasi');
  assert.equal(priorityArea(5.10, -1.25), 'central');
});

test('the place builder reports kept and dropped counts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'places-'));
  const input = join(dir, 'in.geojsonseq');
  const output = join(dir, 'out.json');
  const lines = [
    {type: 'Feature', id: 'shop1', properties: {shop: 'convenience', name: 'Corner Shop'}, geometry: {type: 'Point', coordinates: [-0.18, 5.60]}},
    {type: 'Feature', id: 'toilet', properties: {amenity: 'toilets', name: 'Public Toilet'}, geometry: {type: 'Point', coordinates: [-0.18, 5.61]}},
    {type: 'Feature', id: 'mall', properties: {shop: 'mall', name: 'Accra Mall'}, geometry: {type: 'Point', coordinates: [-0.1748, 5.6212]}},
    {type: 'Feature', id: 'road', properties: {highway: 'residential', name: 'Some Road'}, geometry: {type: 'LineString', coordinates: [[-0.2, 5.6], [-0.19, 5.6]]}}
  ].map(feature => JSON.stringify(feature)).join('\n');
  writeFileSync(input, lines);
  const {stdout} = await run(process.execPath, ['scripts/build-ghana-places.mjs', input, output]);
  const summary = JSON.parse(stdout);
  assert.equal(summary.droppedByReason.not_a_destination, 1);
  assert.equal(summary.droppedByReason.duplicate_curated, 1);
  assert.equal(summary.droppedByReason.road_indexed_separately, 1);
  assert.equal(summary.added, 1);
  assert.equal(summary.byArea.greater_accra, 1);
});

test('Overture rows stay unverified, in the priority areas, and do not copy over a curated place', () => {
  const grid = placeGrid([{name: 'Accra Mall', latitude: 5.6212, longitude: -0.1748}]);
  const release = '2026-11-01.0';
  const kept = overturePlace({properties: {id: 'ov1', names: {primary: 'New Clinic'}, categories: {primary: 'clinic'}, confidence: 0.8}, geometry: {type: 'Point', coordinates: [-0.2, 5.60]}}, {release, grid});
  assert.equal(kept.place.verification_status, 'unverified');
  assert.equal(kept.place.license, 'CDLA-Permissive-2.0');
  assert.equal(kept.place.source_date, '2026-11-01');
  assert.equal(kept.place.latitude, 5.6);
  assert.equal(overturePlace({properties: {id: 'low', names: {primary: 'Low'}, confidence: 0.2}, geometry: {type: 'Point', coordinates: [-0.2, 5.6]}}, {release, grid}).drop, 'low_confidence');
  assert.equal(overturePlace({properties: {id: 'north', names: {primary: 'Tamale Shop'}, confidence: 0.9}, geometry: {type: 'Point', coordinates: [-0.84, 9.40]}}, {release, grid}).drop, 'outside_priority');
  assert.equal(overturePlace({properties: {id: 'dup', names: {primary: 'Accra Mall'}, confidence: 0.95}, geometry: {type: 'Point', coordinates: [-0.1748, 5.6212]}}, {release, grid}).drop, 'duplicate_curated');
});

test('an Overture release id is stored as a date the landmark insert can cast', () => {
  const release = '2026-11-01.0';
  const kept = overturePlace({properties: {id: 'ov-date', names: {primary: 'Date Clinic'}, categories: {primary: 'clinic'}, confidence: 0.8}, geometry: {type: 'Point', coordinates: [-0.2, 5.60]}}, {release});
  assert.equal(kept.place.source_date, '2026-11-01');
  const row = landmarkRecord({...kept.place, source_date: release});
  assert.equal(row.source_date, '2026-11-01');
  assert.match(row.source_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(landmarkRecord({...kept.place, source_date: '2026-02-31.0'}).source_date, null);
  assert.equal(landmarkRecord({...kept.place, source_date: 'not-a-release'}).source_date, null);
  assert.match(INSERT_LANDMARKS_SQL, /source_date date/);
});

test('fuel and filling-station searches keep imported stations and skip bus stops', () => {
  const imported = classifyOsmTags({amenity: 'fuel', name: 'Zzprobe Goil'});
  const stop = classifyOsmTags({amenity: 'bus_station', name: 'Zzprobe Bus Station'});
  const added = [
    {id: 'OSMIMP_zzfuel', name: 'Zzprobe Goil', category: imported.category, subcategory: imported.subcategory, locality: 'Spintex', city: 'Accra', region: 'Greater Accra', latitude: 5.6301, longitude: -0.1201, popularity: 90, _nameLower: 'zzprobe goil'},
    {id: 'OSMIMP_zzfuel_old', name: 'Zzprobe Filling Station', category: 'transport', subcategory: 'fuel', locality: 'Spintex', city: 'Accra', region: 'Greater Accra', latitude: 5.6302, longitude: -0.1202, popularity: 90, _nameLower: 'zzprobe filling station'},
    {id: 'OSMIMP_zzbus', name: 'Zzprobe Bus Station', category: stop.category, subcategory: stop.subcategory, locality: 'Circle', city: 'Accra', region: 'Greater Accra', latitude: 5.6303, longitude: -0.1203, popularity: 90, _nameLower: 'zzprobe bus station'}
  ];
  GHANA_GAZETTEER.push(...added);
  try {
    const near = {latitude: 5.6301, longitude: -0.1201};
    for (const query of ['fuel', 'filling station', 'filling station near me']) {
      const rows = ghanaSearch(query, {limit: 30, near});
      assert.ok(rows.some(row => row.id === 'OSMIMP_zzfuel'), query);
      assert.ok(rows.some(row => row.id === 'OSMIMP_zzfuel_old'), query);
      assert.equal(rows.some(row => row.id === 'OSMIMP_zzbus'), false, query);
    }
  } finally {
    for (const place of added) {
      const index = GHANA_GAZETTEER.indexOf(place);
      if (index >= 0) GHANA_GAZETTEER.splice(index, 1);
    }
  }
});

test('unverified imports cannot replace a curated landmark', () => {
  assert.match(INSERT_LANDMARKS_SQL, /verification_status = 'unverified'/);
  assert.match(INSERT_LANDMARKS_SQL, /IS DISTINCT FROM 'unverified'/);
  assert.match(INSERT_LANDMARKS_SQL, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(INSERT_LANDMARKS_SQL, /ST_DWithin/);
});

test('the photon service can write its temp files and index lock while the container stays read-only', () => {
  const compose = readFileSync(new URL('../deploy/runtime/compose.yaml', import.meta.url), 'utf8');
  const photon = compose.slice(compose.indexOf('\n  photon:'), compose.indexOf('\n  maps:'));
  assert.match(photon, /read_only:\s*true/);
  assert.match(photon, /tmpfs:/);
  assert.match(photon, /\/tmp:rw,exec,/);
  assert.match(photon, /target: \/data, read_only: true/);
  assert.match(photon, /target: \/data\/photon\/data, read_only: false/);
});

test('Photon is optional and does not invent a house number', async () => {
  assert.deepEqual(await photonSearch('12 Spintex Road', {baseUrl: ''}), []);
  assert.deepEqual(await photonSearch('12 Spintex Road', {baseUrl: 'http://photon:2322', fetchImpl: async () => { throw Error('down'); }}), []);
  const withNumber = photonResult({geometry: {coordinates: [-0.11, 5.63]}, properties: {name: 'Spintex Road', street: 'Spintex Road', housenumber: '12'}});
  assert.equal(withNumber.housenumber, '12');
  const roadOnly = photonResult({geometry: {coordinates: [-0.11, 5.63]}, properties: {name: 'Spintex Road', osm_key: 'highway'}});
  assert.equal(roadOnly.housenumber, null);
  assert.match(roadOnly.label, /^Road · /);
  assert.equal(photonResult({geometry: {coordinates: [10, 50]}, properties: {name: 'Somewhere'}}), null);
});

test('a stored road is labelled as a road when Photon is not running', async () => {
  const road = {id: 'ROAD_1', name: 'Quarry Test Road', category: 'road', subcategory: 'residential', locality: 'Accra', city: 'Accra', region: 'Greater Accra', latitude: '5.70', longitude: '-0.05', aliases: [], entrance: null, popularity: 20, street: null, coordinate_kind: 'road_midpoint', name_sim: 0.8, sim: 0.8, verification_status: 'unverified', source: 'OpenStreetMap', license: 'ODbL 1.0'};
  const rows = await searchPlaces({query: async () => ({rows: [road]})}, 'Quarry Test Road');
  const found = rows.find(row => row.id === 'ROAD_1');
  assert.ok(found);
  assert.equal(found.type, 'road');
  assert.equal(found.housenumber, null);
  assert.match(found.label, /^Road · Quarry Test Road/);
});

test('rider traces only propose reviews for missing links and speeds', () => {
  const flags = missingLinkFlags([
    {latitude: 5.60, longitude: -0.20, accuracyMeters: 10, matched: false},
    {latitude: 5.603, longitude: -0.20, accuracyMeters: 10, matched: false}
  ]);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].status, 'REVIEW_REQUIRED');
  assert.equal(flags[0].area, 'greater_accra');
  assert.equal('riderId' in flags[0], false);
  const samples = Array.from({length: 20}, (_, index) => ({vehicle: 'motorcycle', latitude: 5.60, longitude: -0.19, speedKmh: 20 + (index % 3)}));
  const proposals = speedProposals(samples);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].status, 'pending');
  assert.equal(proposals[0].area, 'greater_accra');
  assert.equal(proposals[0].vehicle, 'motorcycle');
  assert.equal('riderId' in proposals[0], false);
  assert.equal(speedProposals([{vehicle: 'motorcycle', latitude: 9.4, longitude: -0.84, speedKmh: 30}]).length, 0);
});
