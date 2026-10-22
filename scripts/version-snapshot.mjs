import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve('.');
const SNAPSHOT_DIR = resolve('.snapshots');

if (!existsSync(SNAPSHOT_DIR)) {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

const action = process.argv[2] || 'create';
const label = process.argv[3] || 'manual';

if (action === 'create') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `snapshot-${timestamp}-${label}.tar.gz`;
  const archivePath = join(SNAPSHOT_DIR, filename);

  console.log(`Creating source snapshot: ${filename}...`);
  execSync(`tar --exclude="*node_modules*" --exclude="*.snapshots*" --exclude="*.tar.gz" --exclude="*.log" --exclude="*.git*" -czf "${archivePath}" services apps/mobile/App.js apps/mobile/src apps/mobile/package.json database tests scripts config integrations package.json`, {
    cwd: ROOT,
    stdio: 'inherit'
  });

  const manifest = {
    timestamp,
    label,
    archive: filename,
    created_at: new Date().toISOString()
  };
  writeFileSync(join(SNAPSHOT_DIR, 'latest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Snapshot saved to ${archivePath}`);
} else if (action === 'list') {
  console.log(`Available snapshots in ${SNAPSHOT_DIR}:`);
  execSync(`dir "${SNAPSHOT_DIR}"`, { stdio: 'inherit', shell: 'cmd.exe' });
} else {
  console.log('Usage: node scripts/version-snapshot.mjs [create <label> | list]');
}
