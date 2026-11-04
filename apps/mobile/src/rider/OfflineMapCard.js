import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Text, TouchableOpacity, View } from 'react-native';
import * as Location from 'expo-location';
import { OfflineManager } from '@maplibre/maplibre-react-native';
import { API_BASE_URL } from '../config.js';

const PACK = 'elesend-my-area';
const HALF_SPAN_DEGREES = 0.3; // About 65 km across
const card = { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 12, padding: 14, marginBottom: 12 };
const title = { fontSize: 15, fontWeight: '800', color: '#0F172A', marginBottom: 6 };
const body = { fontSize: 13, color: '#475569', marginTop: 3 };
const button = { backgroundColor: '#0F172A', borderRadius: 8, padding: 11, alignItems: 'center', marginTop: 10 };
const buttonText = { color: '#FFFFFF', fontWeight: '700', fontSize: 13 };

/** Saves the map around the rider, so it still shows when the network is weak. */
export default function OfflineMapCard() {
  const [percent, setPercent] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    OfflineManager.getPack(PACK).then(pack => setSaved(Boolean(pack))).catch(() => {});
  }, []);

  async function download() {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') throw Error('Allow location so we know which area to save.');
      const here = await Location.getLastKnownPositionAsync() || await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = here.coords;
      await OfflineManager.deletePack(PACK).catch(() => {});
      setPercent(0);
      await OfflineManager.createPack({
        name: PACK,
        styleURL: `${API_BASE_URL}/api/v1/maps/style.json`,
        bounds: [[longitude + HALF_SPAN_DEGREES, latitude + HALF_SPAN_DEGREES], [longitude - HALF_SPAN_DEGREES, latitude - HALF_SPAN_DEGREES]],
        minZoom: 8,
        maxZoom: 14
      }, (_pack, progress) => {
        const done = Number(progress?.percentage) || 0;
        setPercent(done);
        if (done >= 100) { setPercent(null); setSaved(true); }
      }, (_pack, error) => {
        setPercent(null);
        Alert.alert('Map could not be saved', error?.message || 'Check your connection and try again.');
      });
    } catch (e) {
      setPercent(null);
      Alert.alert('Map could not be saved', e.message);
    }
  }

  async function remove() {
    await OfflineManager.deletePack(PACK).catch(() => {});
    setSaved(false);
  }

  return (
    <View style={card}>
      <Text style={title}>Offline map</Text>
      <Text style={body}>{saved ? 'The map around where you saved it works without internet. Directions still need a connection.' : 'Save the map for about 30 km around you, on Wi-Fi if you can. Directions still need a connection.'}</Text>
      {percent !== null ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 8 }}>
          <ActivityIndicator />
          <Text style={body}>Saving {Math.round(percent)}%</Text>
        </View>
      ) : (
        <TouchableOpacity accessibilityRole="button" style={button} onPress={download}>
          <Text style={buttonText}>{saved ? 'Save this area instead' : 'Save map for my area'}</Text>
        </TouchableOpacity>
      )}
      {saved && percent === null && (
        <TouchableOpacity accessibilityRole="button" style={{ padding: 10, alignItems: 'center' }} onPress={remove}>
          <Text style={body}>Remove saved map</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
