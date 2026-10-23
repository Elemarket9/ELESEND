/**
 * ELESEND Runtime Security Engine
 * Enforces patched Node.js LTS versions against October 2026 security advisories:
 * - CVE-2026-111497 (Brotli RCE / out-of-bounds write in decompressor)
 * - CVE-2026-106069, CVE-2026-106072, CVE-2026-105483 (TLS & IP normalization verification bypass)
 * - CVE-2026-105482 (DNS resolution null-byte truncation)
 * - CVE-2026-106073 (realpathSync permission bypass)
 *
 * Supported Patched Release Lines:
 * - Node.js 24 LTS (Standardized): >= 24.22.1 < 25.0.0
 * - Node.js 22 LTS (Container Compatibility): >= 22.23.4 < 23.0.0
 * - Node.js 26 Current: >= 26.12.1
 */

export function parseSemver(versionStr) {
  const clean = String(versionStr || '').replace(/^v/, '').trim();
  const [majorStr, minorStr, patchStr] = clean.split('.');
  const major = parseInt(majorStr, 10);
  const minor = parseInt(minorStr, 10);
  const patch = parseInt(patchStr, 10);
  return { major, minor, patch, raw: clean };
}

export function isPatchedNodeVersion(versionStr = process.version) {
  const v = parseSemver(versionStr);
  if (Number.isNaN(v.major) || Number.isNaN(v.minor) || Number.isNaN(v.patch)) return false;

  // Node 24 LTS (Standardized)
  if (v.major === 24) {
    if (v.minor > 22) return true;
    if (v.minor === 22 && v.patch >= 1) return true;
    return false; // e.g. 24.21.0 or 24.22.0 is UNPATCHED
  }

  // Node 22 LTS (Compatibility line for Docker node:22-bookworm-slim)
  if (v.major === 22) {
    if (v.minor > 23) return true;
    if (v.minor === 23 && v.patch >= 4) return true;
    return false; // e.g. 22.23.3 is UNPATCHED
  }

  // Node 26 Current
  if (v.major >= 26) {
    if (v.major > 26) return true;
    if (v.minor > 12) return true;
    if (v.minor === 12 && v.patch >= 1) return true;
    return false;
  }

  // Any other older release line (Node 18, 20, 21, 23, 25) is unpatched / EOL
  return false;
}

export function enforcePatchedNodeRuntime({
  strict = process.env.NODE_ENV === 'production' || process.env.ELESEND_STRICT_RUNTIME === 'true',
  version = process.version
} = {}) {
  const patched = isPatchedNodeVersion(version);
  if (!patched) {
    const msg = `CRITICAL NODE.JS SECURITY HAZARD: Runtime version ${version} is unpatched against October 2026 security vulnerabilities (including CVE-2026-111497 Brotli RCE and CVE-2026-106069 TLS bypass). Minimum required: Node 24.22.1 LTS (or Node 22.23.4 LTS).`;
    if (strict) {
      console.error(`[FATAL SECURITY ENFORCEMENT] ${msg}`);
      throw new Error(msg);
    } else {
      console.warn(`[SECURITY ADVISORY WARNING] ${msg}`);
      return { patched: false, warning: msg, current: version, target: '24.22.1' };
    }
  }
  return { patched: true, current: version };
}
