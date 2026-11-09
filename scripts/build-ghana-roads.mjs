// Named roads from an OpenStreetMap GeoJSONSeq export. The coordinate is the midpoint of the
// road's own geometry. No house number is stored.
import {writeFileSync} from 'node:fs';
import {classifyOsmTags, emptyAreaCounts, placeFromFeature, readGeoJsonSeq} from './place-import.mjs';

const [,, input, output] = process.argv;
if (!input || !output) { console.error('Usage: node scripts/build-ghana-roads.mjs <named-highways.geojsonseq> <out.json>'); process.exit(2); }
const kept = [];
const seen = new Set();
const byArea = emptyAreaCounts();
const {read, droppedByReason} = await readGeoJsonSeq(input, (feature, drop) => {
  const classified = classifyOsmTags(feature.properties || {});
  if (classified.kind !== 'road') { drop(classified.drop || 'not_a_road'); return; }
  const built = placeFromFeature(feature, classified);
  if (built.drop) { drop(built.drop); return; }
  delete built.place.street;
  delete built.place.housenumber;
  const key = `${built.place.name.toLowerCase().replace(/[^a-z0-9]/g, '')}:${built.place.area}`;
  if (seen.has(key)) { drop('duplicate_segment'); return; }
  seen.add(key);
  kept.push(built.place);
  byArea[built.place.area] = (byArea[built.place.area] || 0) + 1;
});
writeFileSync(output, JSON.stringify(kept));
console.log(JSON.stringify({read, added: kept.length, skipped: read - kept.length, droppedByReason, byArea, bytes: Buffer.byteLength(JSON.stringify(kept))}));
