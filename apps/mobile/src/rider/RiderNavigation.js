import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import { useKeepAwake } from 'expo-keep-awake';
import { call } from '../api';
import { colors, radii } from '../theme';
import MapView, { Marker, Polyline, RiderMarker, openTurnByTurnNavigation } from '../maps/map-adapter';
import { OFF_ROUTE_METERS, formatDistance, formatDuration, hasArrived, locateOnRoute, rerouteCheck, stepArrow, upcomingStep, usableFix, voicePrompt } from './navigation-logic.mjs';

const FOLLOW_ZOOM = 16.5;
const ROUTE_RETRY_MS = 15000;
const REFUSALS_BEFORE_RESET = 3;
const MOVING_MPS = 1.5;
// Keeps a route if this screen is closed and reopened without a connection. Lost if the app is killed.
const savedRoutes = new Map();
const SAVED_ROUTE_MS = 2 * 3600000;

/** Turn-by-turn directions on our own map, from our own routing server. */
export default function RiderNavigation({ shipmentId, target, label, onClose }) {
  useKeepAwake();
  const [muted, setMuted] = useState(false);
  const voice = useRef({});
  const map = useRef(null);
  const routeKey = `${shipmentId}:${target.latitude},${target.longitude}`;
  const saved = savedRoutes.get(routeKey);
  const [route, setRoute] = useState(saved && Date.now() - saved.at < SAVED_ROUTE_MS ? saved.route : null);
  const progress = useRef(null);
  const [position, setPosition] = useState(null);
  const [failed, setFailed] = useState('');
  const [rerouting, setRerouting] = useState(false);
  const [following, setFollowing] = useState(true);
  const reroute = useRef({});
  const lastFix = useRef(null);
  const refused = useRef(0);
  const busy = useRef(false);
  const haveRoute = useRef(Boolean(route));

  const fetchRoute = async from => {
    if (busy.current) return;
    busy.current = true;
    try {
      const next = await call('POST', '/api/v1/rider/navigation', { shipmentId, latitude: from.latitude, longitude: from.longitude, ...(Number.isFinite(from.heading) && from.speed >= MOVING_MPS ? { heading: from.heading } : {}) });
      haveRoute.current = true;
      voice.current = {};
      progress.current = null;
      savedRoutes.set(routeKey, { route: next, at: Date.now() });
      setRoute(next);
      setFailed('');
    } catch (e) {
      setFailed(e.message || 'Directions are not available right now.');
    } finally {
      busy.current = false;
      setRerouting(false);
    }
  };

  useEffect(() => {
    let active = true, watch = null, lastAsk = 0;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') { setFailed('Allow location to get directions.'); return; }
        if (!active) return;
        const subscription = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 2000, distanceInterval: 5 },
          fix => {
            if (!active) return;
            let here = usableFix(lastFix.current, fix);
            if (!here && ++refused.current >= REFUSALS_BEFORE_RESET) here = usableFix(null, fix, Date.now(), { trustClock: false });
            if (!here) return;
            refused.current = 0;
            lastFix.current = here;
            setPosition(here);
            // Keep trying until the first route arrives, in case the first request failed.
            if (!haveRoute.current && Date.now() - lastAsk >= ROUTE_RETRY_MS) { lastAsk = Date.now(); fetchRoute(here); }
          }
        );
        if (active) watch = subscription; else subscription.remove?.();
      } catch (e) {
        setFailed(e.message || 'Your location could not be read.');
      }
    })();
    return () => { active = false; watch?.remove?.(); };
  }, [shipmentId]);

  const points = useMemo(() => (route?.geometry?.coordinates || []).map(([longitude, latitude]) => ({ latitude, longitude })), [route]);
  const place = useMemo(() => {
    const found = locateOnRoute(position, points, { after: progress.current });
    if (found && found.offRouteMeters <= OFF_ROUTE_METERS) progress.current = found.traveledMeters;
    return found;
  }, [position, points]);
  const next = place ? upcomingStep(route.steps, place.traveledMeters, place.routeMeters) : null;
  const arrived = hasArrived(place);
  const secondsLeft = place && route?.distanceMeters ? route.durationSeconds * (place.remainingMeters / route.distanceMeters) : route?.durationSeconds;

  useEffect(() => {
    if (!place || !position || arrived) return;
    const check = rerouteCheck(reroute.current, { offRouteMeters: place.offRouteMeters, accuracy: position.accuracy, now: Date.now() });
    reroute.current = check;
    if (check.reroute) { setRerouting(true); fetchRoute(position); }
  }, [position]);

  useEffect(() => {
    if (following && position) map.current?.animateCamera({ center: position, zoom: FOLLOW_ZOOM, heading: position.heading, pitch: 45 }, { duration: 800 });
  }, [position, following]);

  useEffect(() => {
    if (!next) return;
    const prompt = voicePrompt(voice.current, { index: next.index, metersToStep: next.metersToStep, step: next.step, speed: position?.speed });
    voice.current = prompt.state;
    // A newer instruction replaces an unfinished one, so nothing is spoken late.
    if (prompt.say && !muted) { Speech.stop(); Speech.speak(prompt.say, { language: 'en' }); }
  }, [next?.index, next?.metersToStep, muted]);
  useEffect(() => () => { Speech.stop(); }, []);

  const otherApp = () => openTurnByTurnNavigation({ ...target, label });

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.screen}>
        <MapView
          ref={map}
          night
          style={StyleSheet.absoluteFill}
          initialRegion={{ latitude: target.latitude, longitude: target.longitude, longitudeDelta: 0.02 }}
          onPanDrag={() => setFollowing(false)}>
          {points.length > 1 && <Polyline coordinates={points} strokeColor={colors.primary} strokeWidth={7} />}
          <Marker coordinate={target} title={label} pinColor={colors.brandCoral} />
          {position && <RiderMarker coordinate={position} heading={position.heading || 0} title="You" />}
        </MapView>

        <View style={styles.instruction}>
          {arrived ? (
            <Text style={styles.instructionText}>🏁 You have arrived at {label}</Text>
          ) : next ? (
            <View style={styles.instructionRow}>
              <Text style={styles.arrow}>{stepArrow(next.step)}</Text>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.stepDistance}>{formatDistance(next.metersToStep)}</Text>
                <Text style={styles.instructionText} numberOfLines={2}>{next.step.instruction}</Text>
              </View>
            </View>
          ) : failed ? (
            <Text style={styles.instructionText}>{failed}</Text>
          ) : (
            <View style={styles.instructionRow}>
              <ActivityIndicator color={colors.primary} />
              <Text style={[styles.instructionText, { marginLeft: 10 }]}>Finding your route</Text>
            </View>
          )}
          {rerouting && <Text style={styles.rerouting}>Finding a new route</Text>}
          {!rerouting && failed && next && <Text style={styles.rerouting}>No new route yet. Showing the last one.</Text>}
        </View>

        {!following && (
          <TouchableOpacity accessibilityRole="button" style={styles.recenter} onPress={() => setFollowing(true)}>
            <Text style={styles.recenterText}>Re-centre</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity accessibilityRole="switch" accessibilityState={{ checked: !muted }} accessibilityLabel="Voice directions" style={styles.voice} onPress={() => { Speech.stop(); setMuted(v => !v); }}>
          <Text style={styles.recenterText}>{muted ? '🔇' : '🔊'}</Text>
        </TouchableOpacity>

        <View style={styles.footer}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.footerTime}>{secondsLeft ? formatDuration(secondsLeft) : ' '}</Text>
            <Text style={styles.footerSub} numberOfLines={1}>
              {place ? `${formatDistance(place.remainingMeters)} to ${label}` : label}
            </Text>
          </View>
          <TouchableOpacity accessibilityRole="button" style={styles.footerBtn} onPress={otherApp}>
            <Text style={styles.footerBtnText}>Other map</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" style={[styles.footerBtn, styles.exitBtn]} onPress={onClose}>
            <Text style={styles.exitText}>Exit</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  instruction: { position: 'absolute', top: 44, left: 12, right: 12, backgroundColor: colors.surface, borderRadius: radii.lg, padding: 14, borderWidth: 1, borderColor: colors.cardBorder },
  instructionRow: { flexDirection: 'row', alignItems: 'center' },
  arrow: { fontSize: 38, color: colors.primary, width: 54, textAlign: 'center', fontWeight: '800' },
  stepDistance: { fontSize: 22, fontWeight: '800', color: colors.text },
  instructionText: { fontSize: 15, fontWeight: '600', color: colors.text, marginTop: 2 },
  rerouting: { fontSize: 13, color: colors.primary, marginTop: 6 },
  voice: { position: 'absolute', top: 150, right: 12, width: 46, height: 46, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderRadius: radii.full, borderWidth: 1, borderColor: colors.cardBorder },
  recenter: { position: 'absolute', bottom: 104, alignSelf: 'center', backgroundColor: colors.surface, borderRadius: radii.full, paddingVertical: 10, paddingHorizontal: 18, borderWidth: 1, borderColor: colors.cardBorder },
  recenterText: { color: colors.text, fontWeight: '700', fontSize: 14 },
  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface, padding: 14, paddingBottom: 24, borderTopWidth: 1, borderColor: colors.cardBorder },
  footerTime: { fontSize: 20, fontWeight: '800', color: colors.primary },
  footerSub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  footerBtn: { minHeight: 46, justifyContent: 'center', paddingHorizontal: 12, borderRadius: radii.md, borderWidth: 1, borderColor: colors.cardBorder },
  footerBtnText: { color: colors.text, fontWeight: '700', fontSize: 13 },
  exitBtn: { backgroundColor: colors.brandCoral, borderColor: colors.brandCoral },
  exitText: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 }
});
