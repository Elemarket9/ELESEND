import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveFile(relativePath, fallbackPath) {
  const candidates = [
    join(__dirname, relativePath),
    join(process.cwd(), fallbackPath),
    join(__dirname, '..', fallbackPath)
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

const htmlPath = resolveFile('../../../apps/restaurant-web/index.html', 'apps/restaurant-web/index.html');
const manifestPath = resolveFile('../../../apps/restaurant-web/manifest.json', 'apps/restaurant-web/manifest.json');

let cachedHtml = null;
let cachedManifest = null;

export function renderRestaurantPortalHtml() {
  if (!cachedHtml) {
    cachedHtml = readFileSync(htmlPath, 'utf8');
  }
  return cachedHtml;
}

export function renderRestaurantManifestJson() {
  if (!cachedManifest) {
    cachedManifest = readFileSync(manifestPath, 'utf8');
  }
  return cachedManifest;
}
