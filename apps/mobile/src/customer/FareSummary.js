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
          {quote.etaMinutes && <Text style={label}>{quote.etaMinutes.includesPickup ? `Delivered in about ${quote.etaMinutes.low} to ${quote.etaMinutes.high} min` : `About ${quote.etaMinutes.low} to ${quote.etaMinutes.high} min trip, plus the rider reaching the pickup`}, {km.toFixed(1)} km</Text>}
        </View>
        <Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A' }}>{open ? 'Hide' : 'See rates'}</Text>
      </View>
      {open && (
        <View style={{ marginTop: 6 }}>
          <Line name="Base" amount={ghc(fare.baseMinor ?? fare.startMinor)} />
          <Line name={fare.pricingEngine === 'long_vehicle_heavy_freight_v1' ? `Road distance charge (${(Number(fare.distanceMeters || 0) / 1000).toFixed(1)} billed km, return factor included)` : `Distance (${km.toFixed(1)} km)`} amount={ghc(fare.distanceMinor ?? 0)} />
          {fare.pricingEngine === 'long_vehicle_heavy_freight_v1' && <Line name={`Loaded tonne-km (${(Number(fare.weightG || 0) / 1000000).toFixed(2)} t × road distance)`} amount={ghc(fare.tonneKmMinor ?? 0)} />}
          {fare.pricingEngine !== 'long_vehicle_heavy_freight_v1' && <Line name={`Time (${fare.pricedMinutes} min)`} amount={ghc(fare.timeMinor ?? 0)} />}
          {fare.helpers > 0 && <Line name={`Helpers (${fare.helpers} × ${ghc(fare.helperUnitMinor)})`} amount={ghc(fare.helperMinor)} />}
          {fare.pickupFloorsNoLift > 0 && <Line name={`Pickup floors without a lift (${fare.pickupFloorsNoLift} × ${ghc(fare.floorUnitMinor)})`} amount={ghc(fare.pickupFloorMinor)} />}
          {fare.dropoffFloorsNoLift > 0 && <Line name={`Drop-off floors without a lift (${fare.dropoffFloorsNoLift} × ${ghc(fare.floorUnitMinor)})`} amount={ghc(fare.dropoffFloorMinor)} />}
          <Line name="Minimum price" amount={ghc(fare.minimumMinor)} />
          {fare.rushHourMultiplier > 1 && <Line name="Busy-time multiplier" amount={`${fare.rushHourMultiplier}×`} />}
          {fare.bookingFeeMinor > 0 && <Line name="Booking fee" amount={ghc(fare.bookingFeeMinor)} />}
          <Line name="Waiting after free loading time" amount={fare.waitingEnabled ? `${fare.waitFreeMinutes} min free, then ${ghc(fare.waitPerMinuteMinor)}/min (up to ${ghc(fare.waitMaxMinor)})` : `${fare.waitFreeMinutes} min free; waiting fees are currently off`} />
          {(fare.tolls || []).map(toll => <Line key={toll.name} name={`Toll: ${toll.name}`} amount={ghc(toll.amountMinor)} />)}
          {quote.liabilityStatement && <Text style={[label, { marginTop: 8 }]}>{quote.liabilityStatement}</Text>}
          <Text style={[label, { marginTop: 8 }]}>Declared goods value is recorded for disputes only. ELESEND does not sell insurance.</Text>
          <Text style={[label, { marginTop: 8 }]}>Trip time is an estimate from pickup to dropoff, and can change with traffic. Time for a rider to reach the pickup is extra.</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}
