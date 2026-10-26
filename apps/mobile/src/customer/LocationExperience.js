import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator, Animated, KeyboardAvoidingView, PanResponder, Platform,
  Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View
} from 'react-native';
import * as Location from 'expo-location';
import MapView, {LandmarkLayer, Marker} from '../maps/map-adapter';
import {detectCustomerLocation} from '../customer-location';
import {
  assessManualAddress, boundsFromRegion, buildViewportQuery, composeManualAddress,
  createDebouncer, isQuotableLocation, locationFromGps, locationFromMapPress,
  locationFromResolve, locationFromSearchResult, positionStatus, readManualFields
} from '../customer-location';
import {colors, radii} from '../theme';

const EMPTY_MANUAL = {region: '', city: '', community: '', street: '', house: '', landmark: '', instructions: ''};
const ACCRA = {latitude: 5.6037, longitude: -0.187, latitudeDelta: 0.02, longitudeDelta: 0.02};

function samePoint(point) {
  if (!point || !Number.isFinite(Number(point.latitude)) || !Number.isFinite(Number(point.longitude))) return null;
  return {latitude: Number(point.latitude), longitude: Number(point.longitude)};
}

export default function LocationExperience({
  mode = 'parcel',
  pickup = null,
  destination = null,
  target = 'pickup',
  onTarget,
  onCommit,
  onContinue,
  onCancel,
  onConfirmSingle,
  callApi,
  pickupLabel = 'Set Pickup',
  destinationLabel = 'Set Destination',
  title = 'Where should we go?'
}) {
  const {height, width} = useWindowDimensions();
  const compact = width < 360;
  const [sheet, setSheet] = useState('home');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [banner, setBanner] = useState('');
  const [manual, setManual] = useState(EMPTY_MANUAL);
  const [resolving, setResolving] = useState(false);
  const [pending, setPending] = useState(null);
  const [resolved, setResolved] = useState(null);
  const [landmarks, setLandmarks] = useState([]);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const mapRef = useRef(null);
  const regionRef = useRef(ACCRA);
  const searchEpoch = useRef(0);
  const viewportKey = useRef('');
  const searchDebounce = useRef(createDebouncer(320)).current;
  const viewportDebounce = useRef(createDebouncer(450)).current;
  const sheetHeight = useRef(new Animated.Value(Math.min(340, height * 0.42))).current;
  const snaps = useMemo(() => ({
    peek: Math.min(210, height * 0.28),
    mid: Math.min(430, height * 0.52),
    full: Math.min(height * 0.78, height - 96)
  }), [height]);

  useEffect(() => {
    Animated.timing(sheetHeight, {toValue: sheet === 'home' ? snaps.mid : snaps.full, duration: 180, useNativeDriver: false}).start();
  }, [sheet, snaps.mid, snaps.full, sheetHeight]);

  useEffect(() => {
    const bounds = boundsFromRegion(ACCRA);
    if (bounds) loadViewport(bounds);
  }, []);

  const snapsRef = useRef(snaps);
  snapsRef.current = snaps;
  const drag = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 8,
    onPanResponderRelease: (_, gesture) => {
      const current = snapsRef.current;
      const next = gesture.dy > 40 ? current.peek : gesture.dy < -40 ? current.full : current.mid;
      Animated.spring(sheetHeight, {toValue: next, useNativeDriver: false, bounciness: 0}).start();
    }
  })).current;

  const pickupPoint = samePoint(target === 'pickup' && pending?.latitude != null ? pending : pickup);
  const destinationPoint = samePoint(target === 'destination' && pending?.latitude != null ? pending : destination);
  const singlePoint = samePoint(pending);

  function focusMap(point) {
    if (!point) return;
    mapRef.current?.animateToRegion({
      latitude: point.latitude,
      longitude: point.longitude,
      latitudeDelta: 0.012,
      longitudeDelta: 0.012
    }, 450);
  }

  function stage(location, meta = null) {
    setPending(location);
    setResolved(meta);
    setBanner('');
    setSheet('confirm');
    if (location?.latitude != null) focusMap(location);
  }

  async function loadViewport(bounds) {
    const q = buildViewportQuery(bounds, bounds.zoom);
    if (!q || q === viewportKey.current) return;
    viewportKey.current = q;
    try {
      const payload = await callApi('GET', `/api/v1/maps/viewport?${q}`);
      setLandmarks(Array.isArray(payload?.features) ? payload.features : []);
    } catch {
      setLandmarks([]);
    }
  }

  function onRegion(event) {
    let bounds = null;
    const zoom = Number(event?.zoom);
    if (Array.isArray(event?.bounds) && event.bounds.length >= 2 && Array.isArray(event.bounds[0]) && Array.isArray(event.bounds[1])) {
      const longs = [event.bounds[0][0], event.bounds[1][0]];
      const lats = [event.bounds[0][1], event.bounds[1][1]];
      bounds = {west: Math.min(...longs), east: Math.max(...longs), south: Math.min(...lats), north: Math.max(...lats), zoom};
    } else if (Array.isArray(event?.center) && Number.isFinite(zoom)) {
      const [longitude, latitude] = event.center;
      const longitudeDelta = 360 / (2 ** zoom);
      bounds = boundsFromRegion({latitude, longitude, latitudeDelta: longitudeDelta, longitudeDelta});
    }
    if (!bounds) return;
    regionRef.current = {
      latitude: (bounds.north + bounds.south) / 2,
      longitude: (bounds.east + bounds.west) / 2,
      latitudeDelta: bounds.north - bounds.south,
      longitudeDelta: bounds.east - bounds.west
    };
    viewportDebounce(() => loadViewport(bounds));
  }

  async function runSearch(text) {
    const clean = text.trim();
    if (clean.length < 2) {
      setResults([]);
      return;
    }
    const epoch = ++searchEpoch.current;
    setSearching(true);
    try {
      const center = regionRef.current;
      const res = await callApi('GET', `/api/v1/maps/search?q=${encodeURIComponent(clean)}&lat=${center.latitude}&lon=${center.longitude}`);
      if (epoch !== searchEpoch.current) return;
      setResults(Array.isArray(res) ? res : []);
      setBanner(Array.isArray(res) && res.length === 0 ? 'No matching places in EGIE. You can enter the address manually.' : '');
    } catch (error) {
      if (epoch !== searchEpoch.current) return;
      setResults([]);
      setBanner(error.message || 'Search is unavailable. You can still enter an address or drop a pin.');
    } finally {
      if (epoch === searchEpoch.current) setSearching(false);
    }
  }

  function chooseResult(place) {
    if (place?.needsConfirmation && place.coordinateOrder === 'ambiguous') {
      setBanner(place.uncertainty || 'Those coordinates conflict. Nothing was placed on the map.');
      return;
    }
    if (place?.needsConfirmation && Number.isFinite(Number(place.latitude))) {
      stage({
        latitude: Number(place.latitude),
        longitude: Number(place.longitude),
        address: place.label || place.name,
        positionKind: 'customer_pin',
        confidence: 'low',
        uncertaintyNote: place.uncertainty || 'Confirm this coordinate order before it is used.',
        needsConfirmation: true
      });
      return;
    }
    const location = locationFromSearchResult(place);
    if (!location) {
      setBanner(place?.uncertainty || 'That result cannot be used as a delivery point.');
      return;
    }
    stage(location);
  }

  async function useGps() {
    setLocating(true);
    setBanner('');
    try {
      const detected = await detectCustomerLocation({
        locationApi: Location,
        reverseGeocodeApi: async (lat, lon) => callApi('GET', `/api/v1/maps/reverse?lat=${lat}&lon=${lon}`),
        timeoutMs: 12000
      });
      if (!detected.ok) {
        setBanner(detected.message);
        return;
      }
      const location = locationFromGps(detected);
      if (!location) {
        setBanner(detected.message || 'GPS did not return a point inside Ghana.');
        return;
      }
      stage(location);
    } finally {
      setLocating(false);
    }
  }

  async function submitManual() {
    const fields = readManualFields(manual);
    const assessment = assessManualAddress(fields);
    if (!assessment.ok) {
      setBanner(assessment.reason);
      return;
    }
    setResolving(true);
    setBanner('');
    try {
      const center = regionRef.current;
      const payload = await callApi('POST', '/api/v1/maps/resolve-address', {
        original: fields,
        near: {latitude: center.latitude, longitude: center.longitude}
      });
      stage(locationFromResolve(fields, payload), payload);
    } catch (error) {
      setBanner(error.message || 'Address check failed. Your text was not discarded — drop a pin or try again.');
    } finally {
      setResolving(false);
    }
  }

  async function confirmPending() {
    if (!pending) return;
    if (pending.positionKind === 'none' || pending.latitude == null) {
      setBanner('This address is not located yet. Drop a pin or choose a suggested place. No fare is calculated from a written address alone.');
      return;
    }
    if (!isQuotableLocation(pending)) {
      setBanner('This point is outside the delivery area, or the address is incomplete. Adjust it before confirming.');
      return;
    }
    setSaving(true);
    try {
      if (pending.originalManual) {
        const center = regionRef.current;
        await callApi('POST', '/api/v1/maps/address-submissions', {
          role: mode === 'single' ? 'food_delivery' : target,
          original: pending.originalManual,
          positionKind: pending.positionKind,
          latitude: pending.latitude,
          longitude: pending.longitude,
          near: {latitude: center.latitude, longitude: center.longitude}
        });
      }
      if (mode === 'single') {
        onConfirmSingle?.(pending);
        return;
      }
      onCommit?.(target, pending);
      setPending(null);
      setResolved(null);
      setManual(EMPTY_MANUAL);
      setQuery('');
      setResults([]);
      setSheet('home');
      if (target === 'pickup' && !destination) onTarget?.('destination');
    } catch (error) {
      setBanner(error.message || 'The address could not be saved. It was not confirmed.');
    } finally {
      setSaving(false);
    }
  }

  async function handleMapPress(event) {
    const coordinate = event?.nativeEvent?.coordinate;
    if (!coordinate) return;
    let reverse = null;
    try {
      reverse = await callApi('GET', `/api/v1/maps/reverse?lat=${coordinate.latitude}&lon=${coordinate.longitude}`);
    } catch {
      reverse = null;
    }
    try {
      if (pending?.originalManual || sheet === 'manual') {
        const fields = pending?.originalManual || manual;
        stage(locationFromResolve(fields, resolved, coordinate), resolved);
        return;
      }
      stage(locationFromMapPress(coordinate, reverse));
    } catch (error) {
      setBanner(error.message || 'That point cannot be used.');
    }
  }

  function handleLandmarkPress(feature) {
    if (feature?.kind === 'cluster') {
      mapRef.current?.animateToRegion({
        latitude: feature.latitude,
        longitude: feature.longitude,
        latitudeDelta: 0.02,
        longitudeDelta: 0.02
      }, 400);
      return;
    }
    chooseResult({
      id: feature.id,
      name: feature.name,
      label: feature.city || '',
      latitude: feature.latitude,
      longitude: feature.longitude,
      city: feature.city
    });
  }

  const status = positionStatus(pending?.positionKind);
  const manualReady = assessManualAddress(manual).ok;
  const bothReady = isQuotableLocation(pickup) && isQuotableLocation(destination);

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.fill}>
        <MapView
          ref={mapRef}
          style={styles.map}
          accessibilityLabel="Delivery map"
          initialRegion={ACCRA}
          onPress={handleMapPress}
          onRegionDidChange={onRegion}>
          <LandmarkLayer features={landmarks} onPress={handleLandmarkPress} />
          {mode === 'parcel' && pickupPoint && <Marker coordinate={pickupPoint} pinColor={colors.primary} title="Pickup" />}
          {mode === 'parcel' && destinationPoint && <Marker coordinate={destinationPoint} pinColor={colors.danger} title="Dropoff" />}
          {mode === 'single' && singlePoint && <Marker coordinate={singlePoint} pinColor={colors.primary} title="Delivery" />}
        </MapView>

        <View style={[styles.topBar, compact && {left: 8, right: 8}]}>
          <Text style={styles.topTitle}>{title}</Text>
          <TextInput
            value={query}
            onChangeText={text => {
              setQuery(text);
              setSheet('search');
              searchDebounce(() => runSearch(text));
            }}
            onFocus={() => setSheet('search')}
            onSubmitEditing={() => runSearch(query)}
            placeholder="Search a place, community, or landmark"
            placeholderTextColor="#64748B"
            style={styles.searchInput}
            accessibilityLabel="Search places"
            returnKeyType="search"
          />
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Use current GPS location"
          onPress={useGps}
          disabled={locating}
          style={styles.gpsFab}>
          {locating ? <ActivityIndicator color={colors.primaryDark} /> : <Text style={styles.gpsFabText}>◎</Text>}
        </Pressable>

        {mode === 'single' && (
          <Pressable accessibilityRole="button" accessibilityLabel="Close location picker" onPress={onCancel} style={styles.closeFab}>
            <Text style={styles.closeFabText}>Close</Text>
          </Pressable>
        )}

        <Animated.View style={[styles.sheet, {height: sheetHeight}]}>
          <View {...drag.panHandlers} style={styles.handleWrap} accessibilityLabel="Drag booking sheet">
            <View style={styles.handle} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
            {!!banner && (
              <Pressable onPress={() => setBanner('')} style={styles.banner} accessibilityRole="alert">
                <Text style={styles.bannerText}>{banner}</Text>
              </Pressable>
            )}

            {mode === 'parcel' && sheet === 'home' && (
              <View>
                <View style={styles.targetRow}>
                  <Pressable accessibilityRole="button" accessibilityLabel="Select Pickup Point" onPress={() => onTarget?.('pickup')} style={[styles.targetBtn, target === 'pickup' && styles.targetBtnOn]}>
                    <Text style={styles.targetText}>{pickupLabel}</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel="Select Destination Point" onPress={() => onTarget?.('destination')} style={[styles.targetBtn, target === 'destination' && styles.targetBtnOn]}>
                    <Text style={styles.targetText}>{destinationLabel}</Text>
                  </Pressable>
                </View>
                <LocationRow label="Pickup" value={pickup?.address} active={target === 'pickup'} onPress={() => { onTarget?.('pickup'); setSheet('search'); }} />
                <LocationRow label="Destination" value={destination?.address} active={target === 'destination'} onPress={() => { onTarget?.('destination'); setSheet('search'); }} />
                <View style={styles.methodRow}>
                  <MethodButton label="GPS" onPress={useGps} />
                  <MethodButton label="Search EGIE" onPress={() => setSheet('search')} />
                  <MethodButton label="Enter address" onPress={() => { setSheet('manual'); setBanner(''); }} />
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="Continue to package details" onPress={onContinue} style={[styles.primary, !bothReady && styles.primaryOff]}>
                  <Text style={styles.primaryText}>{bothReady ? 'Continue to package details' : 'Confirm pickup and destination first'}</Text>
                </Pressable>
              </View>
            )}

            {sheet === 'search' && (
              <View>
                <View style={styles.methodRow}>
                  <MethodButton label="GPS" onPress={useGps} />
                  <MethodButton label="Enter address" onPress={() => setSheet('manual')} />
                  <MethodButton label="Back" onPress={() => setSheet('home')} />
                </View>
                {searching && <ActivityIndicator color={colors.primary} style={{marginVertical: 8}} />}
                {results[0]?.ambiguous && <Text style={styles.hint}>Several areas match. Check the city before you choose. Nothing is selected automatically.</Text>}
                {results.map(place => (
                  <Pressable key={`${place.id || place.name}-${place.latitude}-${place.longitude}`} onPress={() => chooseResult(place)} style={styles.result} accessibilityRole="button">
                    <Text style={styles.resultTitle}>{place.name}</Text>
                    <Text style={styles.resultMeta}>{place.label}{place.distanceMeters != null ? ` · ${place.distanceMeters < 1000 ? `${place.distanceMeters} m` : `${(place.distanceMeters / 1000).toFixed(1)} km`}` : ''}</Text>
                    {!!place.nameConflict && <Text style={styles.warnTiny}>Same name exists elsewhere — confirm the city.</Text>}
                  </Pressable>
                ))}
                {!searching && query.trim().length >= 2 && results.length === 0 && (
                  <Text style={styles.hint}>No EGIE match. Enter the address manually or drop a pin.</Text>
                )}
              </View>
            )}

            {sheet === 'manual' && (
              <View>
                <Text style={styles.sheetTitle}>Enter address</Text>
                <Text style={styles.hint}>Use what you know. A community, landmark, or street in a city is enough. Coordinates are never guessed.</Text>
                {[
                  ['region', 'Region'],
                  ['city', 'City or town'],
                  ['community', 'Community or neighbourhood'],
                  ['street', 'Street name, where available'],
                  ['house', 'House number or building description'],
                  ['landmark', 'Nearby landmark'],
                  ['instructions', 'Additional delivery instructions']
                ].map(([key, label]) => (
                  <View key={key} style={styles.field}>
                    <Text style={styles.fieldLabel}>{label}</Text>
                    <TextInput
                      value={manual[key]}
                      onChangeText={value => setManual(current => ({...current, [key]: value}))}
                      style={styles.fieldInput}
                      placeholderTextColor="#94A3B8"
                      accessibilityLabel={label}
                    />
                  </View>
                ))}
                <View style={styles.methodRow}>
                  <Pressable onPress={submitManual} disabled={!manualReady || resolving} style={[styles.primary, {flex: 1}, !manualReady && styles.primaryOff]}>
                    {resolving ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.primaryText}>Check address</Text>}
                  </Pressable>
                  <MethodButton label="Back" onPress={() => setSheet(mode === 'single' ? 'search' : 'home')} />
                </View>
              </View>
            )}

            {sheet === 'confirm' && pending && (
              <View>
                <Text style={styles.sheetTitle}>Confirm address</Text>
                <View style={[styles.status, styles[`status_${status.tone}`] || styles.status_unresolved]}>
                  <Text style={styles.statusText}>{status.label}</Text>
                </View>
                <Text style={styles.addressFull}>{pending.address || 'No address text'}</Text>
                <Text style={styles.resultMeta}>Nearby landmark: {pending.landmark || pending.nearestPlace || 'Not identified'}</Text>
                {pending.latitude == null ? (
                  <Text style={styles.hint}>No map point yet. Pan the map and tap the entrance, or pick a suggestion below. Riders are not dispatched on a written address alone.</Text>
                ) : (
                  <Text style={styles.resultMeta}>Map point: {Number(pending.latitude).toFixed(5)}, {Number(pending.longitude).toFixed(5)}</Text>
                )}
                {!!pending.accuracyLabel && <Text style={styles.resultMeta}>{pending.accuracyLabel}</Text>}
                {!!pending.uncertaintyNote && <Text style={styles.hint}>{pending.uncertaintyNote}</Text>}
                {!!resolved?.conflicts?.length && <Text style={styles.warnTiny}>Conflicting records were flagged and left unchanged.</Text>}
                {(resolved?.candidates || []).slice(0, 4).map(candidate => (
                  <Pressable key={candidate.id || candidate.name} style={styles.result} onPress={() => stage(locationFromResolve(pending.originalManual || manual, {...resolved, suggestion: {...candidate, positionKind: candidate.score >= 560 ? 'verified_record' : 'approximate', confidence: candidate.score >= 560 ? 'high' : 'medium', uncertainty: `You chose ${candidate.name}.`}}), resolved)}>
                    <Text style={styles.resultTitle}>{candidate.name}</Text>
                    <Text style={styles.resultMeta}>{candidate.label}</Text>
                  </Pressable>
                ))}
                <View style={styles.methodRow}>
                  <Pressable accessibilityRole="button" accessibilityLabel="Edit address" onPress={() => setSheet(pending.originalManual ? 'manual' : 'search')} style={styles.secondary}>
                    <Text style={styles.secondaryText}>Edit address</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel="Confirm address" onPress={confirmPending} disabled={saving || pending.latitude == null} style={[styles.primary, {flex: 1}, (saving || pending.latitude == null) && styles.primaryOff]}>
                    {saving ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.primaryText}>Confirm address</Text>}
                  </Pressable>
                </View>
              </View>
            )}
          </ScrollView>
        </Animated.View>
      </View>
    </KeyboardAvoidingView>
  );
}

function LocationRow({label, value, active, onPress}) {
  return (
    <Pressable onPress={onPress} style={[styles.row, active && styles.rowOn]} accessibilityRole="button">
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={2}>{value || 'Search, use GPS, or enter an address'}</Text>
    </Pressable>
  );
}

function MethodButton({label, onPress}) {
  return (
    <Pressable onPress={onPress} style={styles.method} accessibilityRole="button">
      <Text style={styles.methodText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: {flex: 1, backgroundColor: '#E7E2D6'},
  map: {flex: 1},
  topBar: {position: 'absolute', top: 10, left: 12, right: 68},
  topTitle: {color: colors.bg, fontWeight: '800', fontSize: 16, marginBottom: 6, textShadowColor: '#ffffff', textShadowRadius: 6},
  searchInput: {backgroundColor: '#FFFFFF', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: '#0F172A', elevation: 3},
  gpsFab: {position: 'absolute', top: 12, right: 12, width: 48, height: 48, borderRadius: 24, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', elevation: 4},
  gpsFabText: {fontSize: 22, color: colors.primaryDark, fontWeight: '700'},
  closeFab: {position: 'absolute', top: 68, right: 12, backgroundColor: '#FFFFFF', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8, elevation: 3},
  closeFabText: {color: colors.primaryDark, fontWeight: '700', fontSize: 12},
  sheet: {position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, elevation: 8},
  handleWrap: {alignItems: 'center', paddingVertical: 8},
  handle: {width: 46, height: 5, borderRadius: 3, backgroundColor: colors.cardBorder},
  sheetBody: {paddingHorizontal: 16, paddingBottom: 28},
  sheetTitle: {color: colors.text, fontSize: 18, fontWeight: '800', marginBottom: 6},
  targetRow: {flexDirection: 'row', gap: 8, marginBottom: 10},
  targetBtn: {flex: 1, borderRadius: radii.full, borderWidth: 1, borderColor: colors.cardBorder, paddingVertical: 10, alignItems: 'center', backgroundColor: colors.card},
  targetBtnOn: {borderColor: colors.primary, backgroundColor: colors.primaryDark},
  targetText: {color: colors.text, fontWeight: '700', fontSize: 13},
  row: {backgroundColor: colors.surface, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.cardBorder},
  rowOn: {borderColor: colors.primary},
  rowLabel: {color: colors.textMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase'},
  rowValue: {color: colors.text, fontSize: 14, marginTop: 3},
  methodRow: {flexDirection: 'row', gap: 8, marginVertical: 10, flexWrap: 'wrap'},
  method: {backgroundColor: colors.card, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.cardBorder},
  methodText: {color: colors.text, fontWeight: '700', fontSize: 13},
  primary: {backgroundColor: colors.primary, borderRadius: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12},
  primaryOff: {opacity: 0.55},
  primaryText: {color: colors.bg, fontWeight: '800', fontSize: 14, textAlign: 'center'},
  secondary: {backgroundColor: colors.card, borderRadius: 14, minHeight: 48, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.cardBorder},
  secondaryText: {color: colors.text, fontWeight: '700'},
  result: {paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line},
  resultTitle: {color: colors.text, fontWeight: '700', fontSize: 14},
  resultMeta: {color: colors.textMuted, fontSize: 12, marginTop: 2},
  hint: {color: colors.textMuted, fontSize: 13, lineHeight: 18, marginVertical: 6},
  warnTiny: {color: colors.warn, fontSize: 12, marginTop: 2},
  banner: {backgroundColor: '#451A03', borderRadius: 12, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: colors.warn},
  bannerText: {color: '#FDE68A', fontSize: 13, lineHeight: 18},
  field: {marginBottom: 8},
  fieldLabel: {color: colors.textMuted, fontSize: 12, fontWeight: '600', marginBottom: 4},
  fieldInput: {backgroundColor: colors.card, color: colors.text, borderRadius: 10, borderWidth: 1, borderColor: colors.cardBorder, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14},
  addressFull: {color: colors.text, fontSize: 16, fontWeight: '700', marginVertical: 8, lineHeight: 22},
  status: {alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4},
  statusText: {fontSize: 12, fontWeight: '800', color: '#F8FAFC'},
  status_verified: {backgroundColor: '#064E3B'},
  status_approximate: {backgroundColor: '#78350F'},
  status_pin: {backgroundColor: '#1E3A8A'},
  status_gps: {backgroundColor: '#164E63'},
  status_unresolved: {backgroundColor: '#7F1D1D'}
});
