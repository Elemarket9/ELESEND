/**
 * Compares free Sentinel-2 images a year apart to find areas that became built up, such as new estates.
 * Only the results are kept. They point EGIA at likely change; they do not add roads to the map.
 */
const STAC_URL = 'https://earth-search.aws.element84.com/v1/search';
const DEFAULT_AREAS = [
  { name: 'Greater Accra', bbox: [-0.35, 5.52, -0.01, 5.78] },
  { name: 'Kumasi', bbox: [-1.72, 6.6, -1.5, 6.78] }
];
const RESOLUTION_METERS = 20;
const CELL_PIXELS = 15; // 300 m
const MIN_CLEAR_SHARE = 0.7;
const MIN_BUILT_UP_GAIN = 0.12;
const MIN_VEGETATION_LOSS = 0.12;
const MAX_CELLS = 500;
const CLEAR_SCENE_CLASSES = new Set([4, 5, 6]); // Vegetation, bare ground, water
const SCAN_EVERY_DAYS = 30;
const RETRY_AFTER_DAYS = 1;
const DAY_MS = 86400000;

export function changeAreas(env = process.env) {
  if (!env.MAP_CHANGE_AREAS) return DEFAULT_AREAS;
  try {
    const areas = JSON.parse(env.MAP_CHANGE_AREAS);
    return Array.isArray(areas) && areas.every(a => a?.name && a.bbox?.length === 4) ? areas : DEFAULT_AREAS;
  } catch {
    return DEFAULT_AREAS;
  }
}

/** Grid means from one image. Cells with too much cloud are null. */
export function cellIndexes({ nir, red, swir, scl }, width, height, offset = 0) {
  const columns = Math.floor(width / CELL_PIXELS), rows = Math.floor(height / CELL_PIXELS);
  const cells = new Array(columns * rows).fill(null);
  const pixels = CELL_PIXELS * CELL_PIXELS;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      let clear = 0, builtUp = 0, vegetation = 0;
      for (let y = row * CELL_PIXELS; y < (row + 1) * CELL_PIXELS; y++) {
        for (let x = column * CELL_PIXELS; x < (column + 1) * CELL_PIXELS; x++) {
          const i = y * width + x;
          if (!CLEAR_SCENE_CLASSES.has(scl[i])) continue;
          const n = Math.max(nir[i] - offset, 1), r = Math.max(red[i] - offset, 1), s = Math.max(swir[i] - offset, 1);
          builtUp += (s - n) / (s + n);
          vegetation += (n - r) / (n + r);
          clear++;
        }
      }
      if (clear / pixels >= MIN_CLEAR_SHARE) cells[row * columns + column] = { builtUp: builtUp / clear, vegetation: vegetation / clear };
    }
  }
  return { cells, columns, rows };
}

/** Cells that gained built-up surface and lost vegetation, strongest first. */
export function changedCells(baseline, latest, maxCells = MAX_CELLS) {
  const out = [];
  latest.cells.forEach((now, index) => {
    const before = baseline.cells[index];
    if (!now || !before) return;
    const builtUpChange = now.builtUp - before.builtUp, vegetationChange = now.vegetation - before.vegetation;
    if (builtUpChange >= MIN_BUILT_UP_GAIN && vegetationChange <= -MIN_VEGETATION_LOSS) {
      out.push({ row: Math.floor(index / latest.columns), column: index % latest.columns, builtUpChange, vegetationChange });
    }
  });
  return out.sort((a, b) => b.builtUpChange - a.builtUpChange).slice(0, maxCells);
}

async function clearestScene(bbox, from, to, grid, fetchImpl) {
  const body = {
    collections: ['sentinel-2-l2a'], bbox, datetime: `${from.toISOString()}/${to.toISOString()}`, limit: 20,
    query: { 'eo:cloud_cover': { lt: 40 } }, sortby: [{ field: 'properties.eo:cloud_cover', direction: 'asc' }]
  };
  const response = await fetchImpl(STAC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`Image search failed (${response.status})`);
  const centerLon = (bbox[0] + bbox[2]) / 2, centerLat = (bbox[1] + bbox[3]) / 2;
  const covers = item => item.bbox[0] <= centerLon && item.bbox[2] >= centerLon && item.bbox[1] <= centerLat && item.bbox[3] >= centerLat;
  const items = (await response.json()).features.filter(covers);
  return grid ? items.find(item => item.properties['grid:code'] === grid) : items[0];
}

async function readBands(item, bbox, { GeoTIFF, proj4 }) {
  const epsg = item.properties['proj:code'] || `EPSG:${item.properties['proj:epsg']}`;
  const zone = Number(epsg.split(':')[1]) - 32600;
  if (!(zone >= 1 && zone <= 60)) throw Error(`Unexpected image projection ${epsg}`);
  const utm = `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`;
  const toUtm = point => proj4('WGS84', utm, point);
  const read = async (asset, level) => {
    const file = await GeoTIFF.fromUrl(item.assets[asset].href);
    const full = await file.getImage(0);
    const image = level ? await file.getImage(level) : full;
    const [originX, , , originY] = full.getBoundingBox();
    const [minX, minY] = toUtm([bbox[0], bbox[1]]), [maxX, maxY] = toUtm([bbox[2], bbox[3]]);
    const pixelMeters = full.getResolution()[0] * (full.getWidth() / image.getWidth());
    if (Math.abs(pixelMeters - RESOLUTION_METERS) > 0.5) throw Error(`${asset} is not at ${RESOLUTION_METERS} m`);
    const clamp = (value, top) => Math.max(0, Math.min(top, value));
    const left = clamp(Math.floor((minX - full.getBoundingBox()[0]) / pixelMeters), image.getWidth());
    const right = clamp(Math.ceil((maxX - originX) / pixelMeters), image.getWidth());
    const topPixel = clamp(Math.floor((full.getBoundingBox()[3] - maxY) / pixelMeters), image.getHeight());
    const bottom = clamp(Math.ceil((full.getBoundingBox()[3] - minY) / pixelMeters), image.getHeight());
    const raster = (await image.readRasters({ window: [left, topPixel, right, bottom], samples: [0] }))[0];
    return { data: raster, width: right - left, height: bottom - topPixel, originX: full.getBoundingBox()[0] + left * pixelMeters, originY: full.getBoundingBox()[3] - topPixel * pixelMeters };
  };
  // 10 m bands use their first overview, which is 20 m like the others.
  const [nir, red, swir, scl] = await Promise.all([read('nir', 1), read('red', 1), read('swir16', 0), read('scl', 0)]);
  if ([red, swir, scl].some(band => band.width !== nir.width || band.height !== nir.height)) throw Error('Image bands do not line up');
  const baselineNumber = Number(item.properties['s2:processing_baseline']);
  const offset = item.properties['earthsearch:boa_offset_applied'] === true || !(baselineNumber >= 4) ? 0 : 1000;
  return { bands: { nir: nir.data, red: red.data, swir: swir.data, scl: scl.data }, width: nir.width, height: nir.height, originX: nir.originX, originY: nir.originY, offset, zone };
}

export async function scanArea(area, { now = Date.now(), fetchImpl = fetch, libraries } = {}) {
  const { GeoTIFF, proj4 } = libraries || { GeoTIFF: await import('geotiff'), proj4: (await import('proj4')).default };
  const latestScene = await clearestScene(area.bbox, new Date(now - 90 * DAY_MS), new Date(now), null, fetchImpl);
  if (!latestScene) return { outcome: 'No clear recent image', cells: [] };
  const seen = Date.parse(latestScene.properties.datetime);
  const baselineScene = await clearestScene(area.bbox, new Date(seen - 410 * DAY_MS), new Date(seen - 320 * DAY_MS), latestScene.properties['grid:code'], fetchImpl);
  if (!baselineScene) return { outcome: 'No clear image from a year ago', cells: [] };
  const libs = { GeoTIFF, proj4 };
  const latest = await readBands(latestScene, area.bbox, libs), baseline = await readBands(baselineScene, area.bbox, libs);
  if (latest.width !== baseline.width || latest.height !== baseline.height) throw Error('Images do not line up');
  const changed = changedCells(cellIndexes(baseline.bands, baseline.width, baseline.height, baseline.offset), cellIndexes(latest.bands, latest.width, latest.height, latest.offset));
  const utm = `+proj=utm +zone=${latest.zone} +datum=WGS84 +units=m +no_defs`;
  const size = CELL_PIXELS * RESOLUTION_METERS;
  const cells = changed.map(cell => {
    const west = latest.originX + cell.column * size, north = latest.originY - cell.row * size;
    const corner = (x, y) => proj4(utm, 'WGS84', [x, y]).map(value => Number(value.toFixed(6)));
    const ring = [corner(west, north), corner(west + size, north), corner(west + size, north - size), corner(west, north - size)];
    return { key: `${latestScene.properties['grid:code']}:${cell.row}:${cell.column}`, ring: [...ring, ring[0]], builtUpChange: cell.builtUpChange, vegetationChange: cell.vegetationChange };
  });
  return { outcome: 'Scan complete', cells, baselineDate: baselineScene.properties.datetime.slice(0, 10), latestDate: latestScene.properties.datetime.slice(0, 10) };
}

/** Scans each area about monthly. A failure is recorded and tried again the next day. */
export async function scanMapChangesIfDue(db, { areas = changeAreas(), now = Date.now(), scan = scanArea } = {}) {
  if (process.env.MAP_CHANGE_SCAN === 'off') return [];
  const results = [];
  for (const area of areas) {
    const last = (await db.query('SELECT scanned_at, outcome FROM map_change_scans WHERE area_name = $1', [area.name])).rows[0];
    const waitDays = last?.outcome === 'Scan complete' ? SCAN_EVERY_DAYS : RETRY_AFTER_DAYS;
    if (last && now - new Date(last.scanned_at).getTime() < waitDays * DAY_MS) continue;
    let found;
    try {
      found = await scan(area, { now });
    } catch (error) {
      found = { outcome: `Scan failed: ${String(error.message).slice(0, 120)}`, cells: [] };
    }
    if (found.outcome === 'Scan complete') {
      await db.query('DELETE FROM map_change_areas WHERE area_name = $1', [area.name]);
      for (const cell of found.cells) {
        await db.query(
          `INSERT INTO map_change_areas (cell_key, area_name, cell, built_up_change, vegetation_change, baseline_date, latest_date)
           VALUES ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)::geography, $4, $5, $6, $7)
           ON CONFLICT (cell_key) DO NOTHING`,
          [cell.key, area.name, JSON.stringify({ type: 'Polygon', coordinates: [cell.ring] }), cell.builtUpChange, cell.vegetationChange, found.baselineDate, found.latestDate]
        );
      }
    }
    await db.query(
      `INSERT INTO map_change_scans (area_name, scanned_at, outcome, changed_cells) VALUES ($1, $2, $3, $4)
       ON CONFLICT (area_name) DO UPDATE SET scanned_at = EXCLUDED.scanned_at, outcome = EXCLUDED.outcome, changed_cells = EXCLUDED.changed_cells`,
      [area.name, new Date(now), found.outcome, found.cells.length]
    );
    results.push({ area: area.name, outcome: found.outcome, cells: found.cells.length });
  }
  return results;
}
