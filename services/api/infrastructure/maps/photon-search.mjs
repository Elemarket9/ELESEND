// Optional self-hosted Photon (Apache-2.0). No public Nominatim or Photon host is used.
// A house number is returned only when Photon itself sent one. If Photon is down, the caller continues.

const GHANA = {minLatitude: 4.5, maxLatitude: 11.4, minLongitude: -3.4, maxLongitude: 1.4};

export function looksLikeStreetQuery(query) {
  return /\b(road|street|avenue|lane|highway|close|crescent)\b/i.test(String(query || ''));
}

export function photonResult(feature) {
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const longitude = Number(coordinates[0]), latitude = Number(coordinates[1]);
  if (!(latitude >= GHANA.minLatitude && latitude <= GHANA.maxLatitude && longitude >= GHANA.minLongitude && longitude <= GHANA.maxLongitude)) return null;
  const props = feature.properties || {};
  const name = String(props.name || props.street || '').trim();
  if (!name) return null;
  const housenumber = typeof props.housenumber === 'string' && props.housenumber.trim() ? props.housenumber.trim() : null;
  const street = typeof props.street === 'string' ? props.street.trim() : '';
  const road = !housenumber && (props.osm_key === 'highway' || props.type === 'street' || looksLikeStreetQuery(name));
  return {
    name: housenumber && street ? `${housenumber} ${street}` : name,
    label: road ? `Road · ${name}` : [props.city || props.locality, props.state].filter(Boolean).join(', ') || name,
    type: road ? 'road' : 'place',
    category: road ? 'road' : (props.osm_value || 'place'),
    latitude,
    longitude,
    housenumber,
    source: 'Photon',
    license: 'ODbL 1.0',
    coordinate_kind: road ? 'road_midpoint' : 'mapped_point'
  };
}

export async function photonSearch(query, {baseUrl, fetchImpl = fetch, timeoutMs = 1500} = {}) {
  if (!baseUrl || typeof fetchImpl !== 'function') return [];
  const url = new URL('/api', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '5');
  url.searchParams.set('lang', 'en');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {signal: controller.signal});
    if (!response?.ok) return [];
    const body = await response.json();
    return (body?.features || []).map(photonResult).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
