/**
 * ELESEND Mobile Application Configuration Interface
 * 
 * Provides unified, validated access to client-side runtime settings.
 * All public client settings MUST be prefixed with EXPO_PUBLIC_*.
 * Secrets (DB credentials, API keys, MFA master seeds) MUST NEVER be placed here.
 * 
 * NOTE: Expo environment variables (EXPO_PUBLIC_*) are statically embedded into
 * the JavaScript bundle at build time. Changing these values requires rebuilding
 * the mobile application bundle or native APK/AAB (`npx expo export` / `npx expo run:android`).
 */

export function isDevelopmentEnvironment() {
  if (typeof __DEV__ !== 'undefined' && __DEV__) return true;
  const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
  return nodeEnv === 'development' || nodeEnv === 'test';
}

export function isLocalOrPrivateHost(urlStr) {
  if (!urlStr) return false;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '10.0.2.2' || // Android emulator loopback alias
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)
    );
  } catch {
    return false;
  }
}

export function validateApiBaseUrl(rawUrl, isDev = isDevelopmentEnvironment()) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const clean = rawUrl.trim().replace(/\/$/, '');
  if (!clean) return '';

  const isHttps = /^https:\/\//i.test(clean);
  const isAllowedDevHttp = isDev && isLocalOrPrivateHost(clean);

  if (!isHttps && !isAllowedDevHttp) {
    throw new Error('ELESEND app requires HTTPS for real devices and production builds.');
  }

  return clean;
}

export function resolveVectorTileUrl(rawUrl, isDev = isDevelopmentEnvironment()) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const clean = rawUrl.trim();
  if (!clean) return null;

  const isHttps = /^https:\/\//i.test(clean);
  const isAllowedDevHttp = isDev && isLocalOrPrivateHost(clean);

  if (!isHttps && !isAllowedDevHttp) {
    return null;
  }

  return clean;
}

export function resolveGlyphsUrl(rawGlyphsUrl, tileUrl) {
  if (rawGlyphsUrl && typeof rawGlyphsUrl === 'string' && rawGlyphsUrl.trim()) {
    return rawGlyphsUrl.trim();
  }
  if (tileUrl) {
    return tileUrl.replace(/\/tiles\/.+$/, '/fonts/{fontstack}/{range}.pbf');
  }
  return null;
}

// Statically read and validated from embedded Expo environment
const rawApiBase = process.env.EXPO_PUBLIC_ELESEND_API_BASE_URL || '';
const rawTileUrl = process.env.EXPO_PUBLIC_ELESEND_VECTOR_TILE_URL || '';
const rawGlyphs = process.env.EXPO_PUBLIC_ELESEND_GLYPHS_URL || '';

export const API_BASE_URL = validateApiBaseUrl(rawApiBase);
export const VECTOR_TILE_URL = resolveVectorTileUrl(rawTileUrl);
export const GLYPHS_URL = resolveGlyphsUrl(rawGlyphs, VECTOR_TILE_URL);

/**
 * Returns a sanitized configuration summary suitable for display or diagnostics.
 * Absolutely guarantees no secrets are leaked.
 */
export function getPublicConfigSummary() {
  return {
    isDev: isDevelopmentEnvironment(),
    hasApiUrl: Boolean(API_BASE_URL),
    apiOrigin: API_BASE_URL ? new URL(API_BASE_URL).origin : 'not_configured',
    hasVectorTiles: Boolean(VECTOR_TILE_URL),
    hasGlyphs: Boolean(GLYPHS_URL)
  };
}
