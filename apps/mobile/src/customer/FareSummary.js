import React, { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { ghc } from '../api';

const row = { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 };
const label = { fontSize: 13, color: '#475569' };
const value = { fontSize: 13, color: '#0F172A', fontWeight: '600' };

function Line({ name, amount }) {
  return (
    <View style={row}>
      <Text style={label}>{name}</Text>
      <Text style={value}>{amount}</Text>
    </View>
  );
}

/** Price, estimated trip time, and how the price is worked out, before the customer books. */
export default function FareSummary({ quote }) {
  const [open, setOpen] = useState(false);
  const fare = quote.fareBreakdown;
  const km = Number(quote.distanceMeters || 0) / 1000;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      activeOpacity={0.8}
      onPress={() => setOpen(v => !v)}
      style={{ backgroundColor: '#F8FAFC', borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', padding: 12, marginTop: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: '#0F172A' }}>{ghc(quote.amount_minor)}</Text>
          {quote.etaMinutes && <Text style={label}>About {quote.etaMinutes.low} to {quote.etaMinutes.high} min trip, {km.toFixed(1)} km</Text>}
        </View>
        <Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A' }}>{open ? 'Hide' : 'How it adds up'}</Text>
      </View>
      {open && (
        <View style={{ marginTop: 6 }}>
          <Line name="Start" amount={ghc(fare.startMinor)} />
          <Line name="Per km" amount={ghc(fare.perKmMinor)} />
          <Line name="Per minute" amount={ghc(fare.perMinuteMinor)} />
          <Line name="Minimum price" amount={ghc(fare.minimumMinor)} />
          {fare.rushHourMultiplier > 1 && <Line name="Busy time" amount={`${fare.rushHourMultiplier}×`} />}
          {fare.waitPerMinuteMinor > 0 && (
            <Text style={[label, { marginTop: 8 }]}>
              Waiting: {fare.waitFreeMinutes} minutes free at each stop, then {ghc(fare.waitPerMinuteMinor)} per minute, up to {ghc(fare.waitMaxMinor)}. Cash orders only.
            </Text>
          )}
          <Text style={[label, { marginTop: 8 }]}>Trip time is an estimate and can change with traffic.</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}
