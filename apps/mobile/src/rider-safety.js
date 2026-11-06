import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Share, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Location from 'expo-location';
import { BASE, call, ghc, parseGhs } from './api';
import { openTurnByTurnNavigation } from './maps/map-adapter';

const card = { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 12, padding: 14, marginBottom: 12 };
const title = { fontSize: 15, fontWeight: '800', color: '#0F172A', marginBottom: 6 };
const body = { fontSize: 13, color: '#475569', marginTop: 3 };
const input = { borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, padding: 10, marginTop: 8, color: '#0F172A' };
const button = { backgroundColor: '#0F172A', borderRadius: 8, padding: 11, alignItems: 'center', marginTop: 10 };
const buttonText = { color: '#FFFFFF', fontWeight: '700' };

export function EmergencyButton({ shipmentId }) {
  const [busy, setBusy] = useState(false);
  const [emergencyNumber, setEmergencyNumber] = useState('112');
  async function raise() {
    setBusy(true);
    try {
      const position = await Location.getLastKnownPositionAsync().catch(() => null);
      const res = await call('POST', '/api/v1/safety/emergency', {
        ...(shipmentId ? { shipmentId } : {}),
        ...(position ? { latitude: position.coords.latitude, longitude: position.coords.longitude } : {})
      });
      const number = res?.emergencyNumber || emergencyNumber;
      setEmergencyNumber(number);
      Alert.alert('Alert sent', res?.notified > 0
        ? `Your alert has been sent. If you are in danger, call ${number} now.`
        : `We could not confirm the alert was delivered. Call ${number} now if you are in danger.`,
      [{ text: `Call ${number}`, onPress: () => Linking.openURL(`tel:${number}`) }, { text: 'Close' }]);
    } catch (e) {
      Alert.alert('Alert not sent', `Call ${emergencyNumber} now if you are in danger.`, [{ text: `Call ${emergencyNumber}`, onPress: () => Linking.openURL(`tel:${emergencyNumber}`) }, { text: 'Close' }]);
    } finally { setBusy(false); }
  }
  return (
    <TouchableOpacity
      disabled={busy}
      accessibilityRole="button"
      style={[button, { backgroundColor: '#B91C1C', marginBottom: 12 }]}
      onPress={() => Alert.alert('Emergency', 'Send an emergency alert with your location?', [{ text: 'Cancel', style: 'cancel' }, { text: 'Send Alert', style: 'destructive', onPress: raise }])}>
      <Text style={buttonText}>{busy ? 'Sending...' : 'Emergency'}</Text>
    </TouchableOpacity>
  );
}

export function ShareLiveLocation({ shipmentId }) {
  if (!shipmentId) return null;
  return (
    <TouchableOpacity
      style={[button, { marginTop: 0, marginBottom: 12 }]}
      onPress={async () => {
        try {
          const res = await call('POST', '/api/v1/safety/share-link', { shipmentId });
          await Share.share({ message: `Follow my ELESEND delivery: ${BASE}${res.path}` });
        } catch (e) { Alert.alert('Could not share', e.message); }
      }}>
      <Text style={buttonText}>Share Live Location</Text>
    </TouchableOpacity>
  );
}

export function TrustedContactCard() {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [saved, setSaved] = useState(null);
  useEffect(() => { call('GET', '/api/v1/safety/trusted-contact').then(c => { if (c?.name) setSaved(c); }).catch(() => {}); }, []);
  return (
    <View style={card}>
      <Text style={title}>Trusted Contact</Text>
      <Text style={body}>{saved ? `${saved.name} (${saved.phone}) receives an SMS if you press Emergency.` : 'Choose someone to receive an SMS if you press Emergency.'}</Text>
      <TextInput style={input} placeholder="Name" placeholderTextColor="#94A3B8" value={name} onChangeText={setName} />
      <TextInput style={input} placeholder="Phone number" placeholderTextColor="#94A3B8" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
      <TouchableOpacity style={button} onPress={async () => {
        try { setSaved(await call('POST', '/api/v1/safety/trusted-contact', { name: name.trim(), phone: phone.trim() })); setName(''); setPhone(''); }
        catch (e) { Alert.alert('Could not save', e.message); }
      }}><Text style={buttonText}>Save Contact</Text></TouchableOpacity>
    </View>
  );
}

export function RatingPrompts() {
  const [items, setItems] = useState([]);
  const load = useCallback(() => call('GET', '/api/v1/ratings/pending').then(r => setItems(r || [])).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  if (!items.length) return null;
  return (
    <View style={card}>
      <Text style={title}>Rate Recent Deliveries</Text>
      {items.map(item => (
        <View key={item.id} style={{ marginTop: 8 }}>
          <Text style={body}>Rate the {item.rate} on delivery {String(item.id).slice(0, 8)}</Text>
          <View style={{ flexDirection: 'row', marginTop: 4 }}>
            {[1, 2, 3, 4, 5].map(stars => (
              <TouchableOpacity key={stars} accessibilityLabel={`${stars} stars`} style={{ padding: 6 }} onPress={async () => {
                try { await call('POST', `/api/v1/ratings/${item.id}`, { stars }); load(); }
                catch (e) { Alert.alert('Could not save rating', e.message); }
              }}><Text style={{ fontSize: 24 }}>⭐</Text></TouchableOpacity>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

export function RiderTools() {
  const [goals, setGoals] = useState(null);
  const [rating, setRating] = useState(null);
  const [areas, setAreas] = useState([]);
  const [referral, setReferral] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [dailyGoal, setDailyGoal] = useState('');
  const [weeklyGoal, setWeeklyGoal] = useState('');
  const [code, setCode] = useState('');
  useEffect(() => {
    call('GET', '/api/v1/rider/goals').then(setGoals).catch(() => {});
    call('GET', '/api/v1/me/rating').then(setRating).catch(() => {});
    call('GET', '/api/v1/rider/demand-areas').then(r => setAreas(r?.areas || [])).catch(() => {});
    call('GET', '/api/v1/rider/referral').then(setReferral).catch(() => {});
    call('GET', '/api/v1/rider/campaigns').then(r => setCampaigns(r?.campaigns || [])).catch(() => {});
  }, []);
  const toMinor = text => (text.trim() ? parseGhs(text) : null);
  return (
    <View>
      <View style={card}>
        <Text style={title}>Today's Earnings</Text>
        {goals && <Text style={body}>Today {ghc(goals.todayMinor)}{goals.dailyGoalMinor ? ` of ${ghc(goals.dailyGoalMinor)}` : ''}</Text>}
        {goals && <Text style={body}>This week {ghc(goals.weekMinor)}{goals.weeklyGoalMinor ? ` of ${ghc(goals.weeklyGoalMinor)}` : ''}</Text>}
        {rating?.total > 0 && <Text style={body}>Your rating {rating.average} from {rating.total} deliveries</Text>}
        <TextInput style={input} placeholder="Daily goal (GH₵)" placeholderTextColor="#94A3B8" keyboardType="decimal-pad" value={dailyGoal} onChangeText={setDailyGoal} />
        <TextInput style={input} placeholder="Weekly goal (GH₵)" placeholderTextColor="#94A3B8" keyboardType="decimal-pad" value={weeklyGoal} onChangeText={setWeeklyGoal} />
        <TouchableOpacity style={button} onPress={async () => {
          try { setGoals(await call('POST', '/api/v1/rider/goals', { dailyGoalMinor: toMinor(dailyGoal), weeklyGoalMinor: toMinor(weeklyGoal) })); }
          catch (e) { Alert.alert('Could not save goals', e.message); }
        }}><Text style={buttonText}>Save Goals</Text></TouchableOpacity>
      </View>
      <View style={card}>
        <Text style={title}>Busy Areas</Text>
        {!areas.length && <Text style={body}>No busy areas right now.</Text>}
        {areas.map(a => (
          <TouchableOpacity key={`${a.latitude},${a.longitude}`} onPress={() => openTurnByTurnNavigation({ latitude: a.latitude, longitude: a.longitude, label: 'Busy Area' })}>
            <Text style={[body, { color: '#0F172A', paddingVertical: 4 }]}>{a.orders} customers waiting{a.distanceMeters != null ? `, ${(a.distanceMeters / 1000).toFixed(1)} km away` : ''}. Open map</Text>
          </TouchableOpacity>
        ))}
      </View>
      {campaigns.length > 0 && (
        <View style={card}>
          <Text style={title}>Rewards</Text>
          {campaigns.map(k => <Text key={k.id} style={body}>{k.title}: {k.completed} of {k.targetDeliveries} deliveries for {ghc(k.rewardMinor)} commission credit</Text>)}
        </View>
      )}
      <View style={card}>
        <Text style={title}>Invite Riders</Text>
        {referral && <Text style={body}>Your code {referral.code}. {referral.earned} of {referral.invited} invited riders completed {referral.targetDeliveries} deliveries.</Text>}
        {referral?.rewardMinor > 0 && <Text style={body}>You get {ghc(referral.rewardMinor)} commission credit for each one.</Text>}
        <TextInput style={input} placeholder="Enter a referral code" placeholderTextColor="#94A3B8" autoCapitalize="characters" value={code} onChangeText={setCode} />
        <TouchableOpacity style={button} onPress={async () => {
          try { await call('POST', '/api/v1/rider/referral', { code: code.trim() }); setCode(''); Alert.alert('Code added'); }
          catch (e) { Alert.alert('Could not add code', e.message); }
        }}><Text style={buttonText}>Apply Code</Text></TouchableOpacity>
      </View>
    </View>
  );
}
