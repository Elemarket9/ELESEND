import React, { forwardRef, useId, useImperativeHandle, useMemo, useRef } from 'react';
import { View, Text, Platform, Linking, StyleSheet } from 'react-native';
import { MapView as NativeMap, Camera, MarkerView, PointAnnotation, ShapeSource, LineLayer, CircleLayer, SymbolLayer } from '@maplibre/maplibre-react-native';
import { privateTileUrl, privateMapStyle, OSM_ATTRIBUTION } from './private-map-style.mjs';
import { VECTOR_TILE_URL, GLYPHS_URL, isDevelopmentEnvironment } from '../config.js';

let tileUrl = null;
try {
  tileUrl = VECTOR_TILE_URL ? privateTileUrl(VECTOR_TILE_URL, { development: isDevelopmentEnvironment() }) : null;
} catch (e) {
  tileUrl = null;
}
const glyphsUrl = GLYPHS_URL || (tileUrl ? tileUrl.replace(/\/tiles\/.+$/, '/fonts/{fontstack}/{range}.pbf') : null);
const mapStyle = privateMapStyle(tileUrl, { glyphsUrl });

// Defensive coordinate helper: guarantees [lon, lat] array and prevents crashes on undefined/null
export const coordinate = p => {
  if (!p || typeof p !== 'object') return [-0.1870, 5.6037]; // Safe Ghana center (Accra)
  const lon = Number(p.longitude);
  const lat = Number(p.latitude);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [-0.1870, 5.6037];
  return [lon, lat];
};

// Safe offline fallback style in case vector tiles fail to connect or load
export const OFFLINE_MAP_STYLE = Object.freeze({
  version: 8,
  name: 'ELESEND Ghana Offline',
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#F8FAFC' }
    }
  ]
});

// Provider-neutral adapter boundaries
export const MAP_PROVIDERS = Object.freeze({
  PRIVATE_MAPLIBRE: 'elesend-private',
  GOOGLE_MAPS: 'google-maps' // Future adapter stub; requires no paid Google dependencies
});

export const MAP_RENDERER = MAP_PROVIDERS.PRIVATE_MAPLIBRE;
export const MAP_TRAFFIC_SUPPORTED = false;
export const MAX_STYLE_RETRIES = 3;

// Marker priority visual hierarchy
export const MARKER_PRIORITY = Object.freeze({
  CRITICAL: 1,         // Confirmed pickup, destination, assigned rider
  SEARCH_CANDIDATE: 2, // Active search results or candidate anchors
  BACKGROUND_POI: 3    // Background merchants or non-essential landmarks
});

export default forwardRef(function MapView({ initialRegion, children, onPress, onMapReady, onPanDrag, style, accessibilityLabel }, ref) {
  const camera = useRef(null);
  const [styleError, setStyleError] = React.useState(false);
  const styleRetries = useRef(0);

  const initial = useMemo(() => {
    const lat = Number(initialRegion?.latitude) || 5.6037;
    const lon = Number(initialRegion?.longitude) || -0.1870;
    const delta = (Number(initialRegion?.longitudeDelta) > 0 && Number.isFinite(initialRegion.longitudeDelta))
      ? initialRegion.longitudeDelta
      : 0.08;
    const zoomLevel = Math.max(1, Math.min(20, Math.round(Math.log2(360 / delta))));
    return {
      centerCoordinate: [lon, lat],
      zoomLevel
    };
  }, [initialRegion?.latitude, initialRegion?.longitude, initialRegion?.longitudeDelta]);

  useImperativeHandle(ref, () => ({
    animateCamera({ center, zoom }, { duration = 600 } = {}) {
      if (!center || !camera.current) return;
      try {
        camera.current.setCamera({
          centerCoordinate: coordinate(center),
          zoomLevel: Number.isFinite(zoom) ? zoom : 15,
          animationDuration: duration,
          animationMode: 'easeTo'
        });
      } catch (err) {
        console.warn('[MapAdapter] Camera animateCamera error:', err);
      }
    },
    animateToRegion(region, duration = 600) {
      if (!region || !camera.current) return;
      try {
        const delta = (Number(region?.longitudeDelta) > 0 && Number.isFinite(region.longitudeDelta)) ? region.longitudeDelta : 0.08;
        const zoom = Math.max(1, Math.min(20, Math.round(Math.log2(360 / delta))));
        camera.current.setCamera({
          centerCoordinate: coordinate(region),
          zoomLevel: zoom,
          animationDuration: duration,
          animationMode: 'easeTo'
        });
      } catch (err) {
        console.warn('[MapAdapter] Camera animateToRegion error:', err);
      }
    },
    fitToCoordinates(points, { edgePadding = {}, animated = true } = {}) {
      if (!Array.isArray(points) || points.length === 0 || !camera.current) return;
      try {
        const valid = points.filter(p => p && Number.isFinite(Number(p.longitude)) && Number.isFinite(Number(p.latitude)));
        if (valid.length === 0) return;
        const lons = valid.map(p => Number(p.longitude)), lats = valid.map(p => Number(p.latitude));
        camera.current.fitBounds(
          [Math.max(...lons), Math.max(...lats)],
          [Math.min(...lons), Math.min(...lats)],
          [edgePadding.top ?? 40, edgePadding.right ?? 40, edgePadding.bottom ?? 40, edgePadding.left ?? 40],
          animated ? 600 : 0
        );
      } catch (err) {
        console.warn('[MapAdapter] Camera fitBounds error:', err);
      }
    }
  }), []);

  const activeMapStyle = styleError ? OFFLINE_MAP_STYLE : mapStyle;

  // Bounded, user-initiated retry of the private style (no automatic retry loop).
  const retryPrivateStyle = () => {
    if (styleRetries.current >= MAX_STYLE_RETRIES) return;
    styleRetries.current += 1;
    setStyleError(false);
  };

  return (
    <View style={style} accessibilityLabel={accessibilityLabel}>
      <NativeMap
        style={{ flex: 1 }}
        mapStyle={activeMapStyle}
        attributionEnabled
        logoEnabled={false}
        compassEnabled
        onDidFinishLoadingMap={() => {
          // Do NOT clear styleError here: when the offline canvas finishes loading, clearing it
          // would reload the failing private style and oscillate indefinitely.
          onMapReady?.();
        }}
        onDidFailLoadingMap={() => {
          // MapLibre RN 10.4.2 invokes this without arguments. Fires on style load failure only;
          // individual tile failures leave the style loaded (blank tiles, map stays interactive).
          setStyleError(true);
        }}
        onRegionWillChange={event => { if (event?.properties?.isUserInteraction) onPanDrag?.(); }}
        onPress={event => {
          const c = event?.geometry?.coordinates;
          if (Array.isArray(c) && c.length >= 2) {
            onPress?.({ nativeEvent: { coordinate: { longitude: c[0], latitude: c[1] } } });
          }
        }}>
        <Camera ref={camera} defaultSettings={initial} />
        {children}
      </NativeMap>
      <Text style={styles.attribution}>{OSM_ATTRIBUTION}</Text>
      {(!tileUrl || styleError) && (
        <View pointerEvents={styleError ? 'auto' : 'none'} style={styles.noTileBanner}>
          <Text
            style={styles.noTileText}
            accessibilityRole={styleError ? 'button' : 'text'}
            onPress={styleError ? retryPrivateStyle : undefined}>
            {styleError
              ? (styleRetries.current < MAX_STYLE_RETRIES
                ? 'Map background unavailable. Pins, GPS and booking still work. Tap to retry.'
                : 'Map background unavailable. Pins, GPS and booking still work.')
              : 'Private Ghana map server is not configured. Map background is unavailable.'}
          </Text>
        </View>
      )}
    </View>
  );
});

export function Marker({
  coordinate: point,
  children,
  title,
  pinColor = '#18C6A5',
  anchor = { x: 0.5, y: 1 },
  draggable = false,
  onDragEnd,
  priority = MARKER_PRIORITY.CRITICAL
}) {
  const id = useId().replace(/:/g, '');
  if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) {
    return null;
  }

  if (draggable) {
    return (
      <PointAnnotation
        id={'marker-' + id}
        coordinate={coordinate(point)}
        draggable={true}
        anchor={anchor}
        title={title}
        onDragEnd={payload => {
          const coords = payload?.geometry?.coordinates;
          if (Array.isArray(coords) && coords.length >= 2) {
            onDragEnd?.({ nativeEvent: { coordinate: { longitude: coords[0], latitude: coords[1] } } });
          }
        }}>
        <View collapsable={false} accessibilityLabel={title}>
          {children ?? (
            <View style={[styles.defaultPin, { backgroundColor: pinColor }]}>
              <View style={styles.pinInnerDot} />
            </View>
          )}
        </View>
      </PointAnnotation>
    );
  }

  return (
    <MarkerView id={id} coordinate={coordinate(point)} anchor={anchor}>
      <View collapsable={false} accessibilityLabel={title}>
        {children ?? (
          <View style={[styles.defaultPin, { backgroundColor: pinColor }]}>
            <View style={styles.pinInnerDot} />
          </View>
        )}
      </View>
    </MarkerView>
  );
}

export function RiderMarker({ coordinate: point, heading = 0, vehicle = 'motorcycle', title = 'Courier' }) {
  const id = useId();
  if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) {
    return null;
  }
  return (
    <MarkerView id={id} coordinate={coordinate(point)} anchor={{ x: 0.5, y: 0.5 }}>
      <View style={styles.riderContainer} collapsable={false} accessibilityLabel={title}>
        <View style={[styles.riderDisc, { transform: [{ rotate: `${heading}deg` }] }]}>
          <Text style={{ fontSize: 16 }}>{vehicle === 'car' ? '🚗' : '🛵'}</Text>
        </View>
        <View style={styles.riderHeadingIndicator} />
      </View>
    </MarkerView>
  );
}

export function CurrentLocationMarker({ coordinate: point, accuracy = 12, title = 'My Current Location' }) {
  const id = useId();
  if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) {
    return null;
  }
  const haloSize = Math.min(90, Math.max(32, Math.round(accuracy * 1.4)));
  return (
    <MarkerView id={id} coordinate={coordinate(point)} anchor={{ x: 0.5, y: 0.5 }}>
      <View style={styles.currentLocWrapper} collapsable={false} accessibilityLabel={title}>
        <View style={[styles.currentLocHalo, { width: haloSize, height: haloSize, borderRadius: haloSize / 2 }]}>
          <View style={styles.currentLocCenterDot} />
        </View>
      </View>
    </MarkerView>
  );
}

export function Polyline({ coordinates, strokeColor = '#18C6A5', strokeWidth = 5 }) {
  const id = useId().replace(/:/g, '');
  const valid = (coordinates || []).filter(p => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
  if (valid.length < 2) return null;
  return (
    <ShapeSource id={'route-' + id} shape={{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: valid.map(coordinate) } }}>
      <LineLayer id={'line-' + id} style={{ lineColor: strokeColor, lineWidth: strokeWidth, lineCap: 'round', lineJoin: 'round' }} />
    </ShapeSource>
  );
}

export function RestaurantClusterLayer({
  restaurants = [],
  onSelectRestaurant,
  clusterRadius = 45,
  clusterMaxZoomLevel = 13,
  /** Optional viewport filter: { minLat, maxLat, minLon, maxLon }. Without it, callers must pre-bound the payload. */
  viewportBounds = null,
  /** Hard cap to prevent nationwide dumps from saturating the renderer on low-end devices. */
  maxFeatures = 500
}) {
  const id = useId().replace(/:/g, '');
  const validRestaurants = useMemo(() => {
    let rows = restaurants.filter(r => Number.isFinite(Number(r.latitude)) && Number.isFinite(Number(r.longitude)));
    if (viewportBounds) {
      const { minLat, maxLat, minLon, maxLon } = viewportBounds;
      rows = rows.filter(r => {
        const lat = Number(r.latitude), lon = Number(r.longitude);
        return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
      });
    }
    const cap = Math.max(1, Math.min(2500, Number(maxFeatures) || 500));
    return rows.length > cap ? rows.slice(0, cap) : rows;
  }, [restaurants, viewportBounds, maxFeatures]);

  const shape = useMemo(() => ({
    type: 'FeatureCollection',
    features: validRestaurants.map(r => ({
      type: 'Feature',
      id: r.restaurant_id || r.id,
      geometry: { type: 'Point', coordinates: [Number(r.longitude), Number(r.latitude)] },
      properties: {
        restaurant_id: r.restaurant_id || r.id,
        name: r.name,
        category: r.category || 'restaurant',
        category_group: r.category_group || 'restaurants_and_chop_bars',
        is_registered_merchant: Boolean(r.is_registered_merchant),
        can_order_menu: Boolean(r.is_registered_merchant && r.registered_merchant_id),
        selectable_as_destination: true,
        latitude: Number(r.latitude),
        longitude: Number(r.longitude)
      }
    }))
  }), [validRestaurants]);

  return (
    <ShapeSource
      id={'rest-cluster-' + id}
      shape={shape}
      cluster={true}
      clusterRadius={clusterRadius}
      clusterMaxZoomLevel={clusterMaxZoomLevel}
      onPress={event => {
        const feat = event?.features?.[0];
        if (!feat) return;
        if (!feat.properties?.cluster && onSelectRestaurant) {
          onSelectRestaurant({
            ...feat.properties,
            coordinate: { latitude: Number(feat.properties.latitude), longitude: Number(feat.properties.longitude) }
          });
        }
      }}>
      <CircleLayer
        id={'rest-clusters-' + id}
        filter={['has', 'point_count']}
        style={{
          circleColor: '#0f766e',
          circleRadius: ['step', ['get', 'point_count'], 18, 20, 24, 100, 30],
          circleStrokeWidth: 2,
          circleStrokeColor: '#ffffff'
        }}
      />
      <SymbolLayer
        id={'rest-cluster-count-' + id}
        filter={['has', 'point_count']}
        style={{
          textField: ['get', 'point_count_abbreviated'],
          textSize: 12,
          textColor: '#ffffff'
        }}
      />
      <CircleLayer
        id={'rest-unclustered-partner-' + id}
        filter={['all', ['!', ['has', 'point_count']], ['==', ['get', 'is_registered_merchant'], true]]}
        style={{
          circleColor: '#f59e0b',
          circleRadius: 9,
          circleStrokeWidth: 2.5,
          circleStrokeColor: '#ffffff'
        }}
      />
      <CircleLayer
        id={'rest-unclustered-poi-' + id}
        filter={['all', ['!', ['has', 'point_count']], ['==', ['get', 'is_registered_merchant'], false]]}
        style={{
          circleColor: '#14695b',
          circleRadius: 7,
          circleStrokeWidth: 2,
          circleStrokeColor: '#ffffff'
        }}
      />
    </ShapeSource>
  );
}

export function openTurnByTurnNavigation({ latitude, longitude, label = 'Delivery Point' }) {
  const lat = Number(latitude), lon = Number(longitude);
  const uri = Platform.OS === 'android' ? `geo:${lat},${lon}?q=${lat},${lon}(${encodeURIComponent(label)})` : `https://maps.google.com/?daddr=${lat},${lon}`;
  return Linking.openURL(uri).catch(() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`));
}

const styles = StyleSheet.create({
  attribution: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    fontSize: 10,
    color: '#203e36',
    backgroundColor: '#ffffffdd',
    paddingHorizontal: 4,
    borderRadius: 2
  },
  noTileBanner: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: 8,
    backgroundColor: '#fff8e5',
    padding: 8,
    borderRadius: 4
  },
  noTileText: {
    fontSize: 12,
    color: '#854d0e'
  },
  defaultPin: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 3,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 3,
    elevation: 5
  },
  pinInnerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF'
  },
  riderContainer: {
    alignItems: 'center',
    justifyContent: 'center'
  },
  riderDisc: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#172239',
    borderWidth: 2,
    borderColor: '#3fd6b3',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 5
  },
  riderHeadingIndicator: {
    position: 'absolute',
    top: -3,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#3fd6b3'
  },
  currentLocWrapper: {
    alignItems: 'center',
    justifyContent: 'center'
  },
  currentLocHalo: {
    backgroundColor: 'rgba(56,189,248,0.22)',
    borderWidth: 1.5,
    borderColor: 'rgba(56,189,248,0.5)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  currentLocCenterDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#0284C7',
    borderWidth: 3,
    borderColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 5
  }
});
