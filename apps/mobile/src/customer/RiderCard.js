import React, { useEffect, useState } from 'react';
import { Image, Text, TouchableOpacity, View } from 'react-native';
import { call } from '../api';

const VEHICLE_NAMES = { motorcycle: 'Motorbike', bicycle: 'Bicycle', tricycle: 'Cargo tricycle', car: 'Car', pickup: 'Pickup', van: 'Van', truck: 'Truck', box_truck: 'Box truck', long_vehicle: 'Long vehicle' };

/**
 * Who is coming, as ride apps show it: photo, first name, plate and vehicle, so the customer and recipient can
 * check them at the door. When the rider's phone stops reporting, says so plainly and points to support.
 */
export default function RiderCard({ shipmentId, rider, lastSeen, onSupport }) {
  const [photo, setPhoto] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setPhoto(null);
    if (shipmentId && rider?.hasPhoto) {
      call('GET', `/api/v1/shipments/${shipmentId}/rider-photo`)
        .then(res => { if (!cancelled && res?.imageBase64) setPhoto(`data:image/jpeg;base64,${res.imageBase64}`); })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [shipmentId, rider?.hasPhoto]);

  if (!rider) return null;
  const name = rider.firstName || 'Your rider';
  const vehicle = [rider.color, rider.make, rider.model].filter(Boolean).join(' ') || VEHICLE_NAMES[rider.vehicle] || 'Motorbike';
  const verified = rider.verifiedBy === 'company' && rider.companyName ? `Checked by ${rider.companyName}` : 'ID checked by ELESEND';

  return (
    <View style={{ marginHorizontal: 16, marginBottom: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#F8FAFC', borderRadius: 14, padding: 12, borderWidth: 1, borderColor: '#E2E8F0' }}>
        {photo ? (
          <Image source={{ uri: photo }} accessibilityLabel={`Photo of ${name}`} style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: '#E2E8F0' }} />
        ) : (
          <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: '#E2E8F0', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#475569' }}>{name.slice(0, 1).toUpperCase()}</Text>
          </View>
        )}
        <View style={{ flex: 1, marginLeft: 12, minWidth: 0 }}>
          <Text style={{ fontSize: 17, fontWeight: '800', color: '#0F172A' }} numberOfLines={1}>{name}</Text>
          <Text style={{ fontSize: 13, color: '#475569', marginTop: 2 }} numberOfLines={1}>{vehicle}</Text>
          <Text style={{ fontSize: 12, color: '#0F766E', fontWeight: '700', marginTop: 2 }} numberOfLines={1}>✓ {verified}</Text>
        </View>
        {rider.plate ? (
          <View accessibilityLabel={`Number plate ${rider.plate}`} style={{ borderWidth: 2, borderColor: '#0F172A', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: '#FFFFFF', maxWidth: 130 }}>
            <Text style={{ fontSize: 15, fontWeight: '900', color: '#0F172A', letterSpacing: 0.5 }} numberOfLines={1} adjustsFontSizeToFit>{rider.plate}</Text>
          </View>
        ) : null}
      </View>
      {rider.plate ? (
        <Text style={{ fontSize: 12, color: '#475569', marginTop: 6 }}>Check the plate and face match before handing over or accepting anything.</Text>
      ) : null}

      {lastSeen ? (
        <View accessibilityLiveRegion="polite" style={{ marginTop: 10, backgroundColor: '#FFFBEB', borderColor: '#F59E0B', borderWidth: 1, borderRadius: 12, padding: 12 }}>
          <Text style={{ fontSize: 14, fontWeight: '800', color: '#78350F' }}>Rider's phone stopped sharing location</Text>
          <Text style={{ fontSize: 13, color: '#78350F', marginTop: 4, lineHeight: 19 }}>
            Last seen {lastSeen.minutesAgo} min ago at the grey pin on the map. Their phone may be off or out of network. ELESEND support has been alerted and will follow up.
          </Text>
          {onSupport ? (
            <TouchableOpacity accessibilityRole="button" onPress={onSupport} style={{ marginTop: 10, minHeight: 44, borderRadius: 10, backgroundColor: '#78350F', alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: '#FFFFFF', fontWeight: '800', fontSize: 14 }}>Message support</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
