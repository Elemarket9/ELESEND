import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, RefreshControl, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { BASE, call, ghc } from '../api';

const page = { flex: 1, backgroundColor: '#F8FAFC' };
const card = { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 12, padding: 14, marginBottom: 12 };
const heading = { fontSize: 15, fontWeight: '800', color: '#0F172A', marginBottom: 6 };
const body = { fontSize: 13, color: '#475569', marginTop: 3 };
const strong = { fontSize: 14, fontWeight: '700', color: '#0F172A' };
const row = { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 };
const input = { borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, padding: 11, color: '#0F172A', marginTop: 8 };
const button = { backgroundColor: '#0F172A', borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 10 };
const buttonText = { color: '#FFFFFF', fontWeight: '700' };
const plain = { borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, padding: 11, alignItems: 'center', marginTop: 10 };
const notice = { backgroundColor: '#FEF3C7', borderRadius: 10, padding: 12, marginBottom: 12 };
const NETWORKS = ['MTN', 'TELECEL', 'AT'];

/** What a company owner sees in the Rider app. Riders, earnings and payout details are managed here. */
export default function CompanyHome({ onSignOut, onDeleteAccount }) {
  const [profile, setProfile] = useState(null);
  const [riders, setRiders] = useState([]);
  const [waiting, setWaiting] = useState([]);
  const [phone, setPhone] = useState('');
  const [network, setNetwork] = useState('MTN');
  const [accountName, setAccountName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await call('GET', '/api/v1/company/profile');
      setProfile(next);
      if (next.status === 'approved' && next.services.includes('riders')) {
        const [fleet, open] = await Promise.all([call('GET', '/api/v1/company/riders'), call('GET', '/api/v1/company/invitations')]);
        setRiders(fleet);
        setWaiting(open);
      }
    } catch (e) {
      setMessage(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async task => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await task();
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  };
  const invite = () => run(async () => {
    const result = await call('POST', '/api/v1/company/invitations', { phone: phone.trim() });
    setPhone('');
    setMessage(result.message);
    await load();
  });
  const savePayout = () => run(async () => {
    await call('POST', '/api/v1/me/payout-beneficiary', { momoNetwork: network, accountName: accountName.trim() });
    setAccountName('');
    setMessage('Payout account saved.');
  });
  const setServices = services => run(async () => {
    await call('PUT', '/api/v1/company/services', { services });
    await load();
  });
  const toggle = service => {
    const next = profile.services.includes(service) ? profile.services.filter(s => s !== service) : [...profile.services, service];
    if (!next.length) { setMessage('Keep at least one service turned on.'); return; }
    setServices(next);
  };
  const removeRider = rider => Alert.alert('Remove this rider?', 'They go back to ELESEND review before they can ride again.', [
    { text: 'Keep', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => run(async () => { await call('POST', `/api/v1/company/riders/${rider.id}/remove`, {}); await load(); }) }
  ]);
  const cancelInvite = id => run(async () => { await call('POST', `/api/v1/company/invitations/${id}/revoke`, {}); await load(); });

  if (!profile) {
    return (
      <View style={[page, { justifyContent: 'center', alignItems: 'center', padding: 20 }]}>
        {loading ? <ActivityIndicator /> : <Text style={body}>{message || 'Could not load your company.'}</Text>}
        {!loading && <TouchableOpacity accessibilityRole="button" style={plain} onPress={load}><Text style={strong}>Try again</Text></TouchableOpacity>}
        <TouchableOpacity accessibilityRole="button" style={plain} onPress={onSignOut}><Text style={strong}>Sign out</Text></TouchableOpacity>
      </View>
    );
  }
  const approved = profile.status === 'approved';
  const hasRiders = profile.services.includes('riders');
  const hasDelivery = profile.services.includes('delivery');
  const balance = profile.balance || {};
  return (
    <ScrollView style={page} contentContainerStyle={{ padding: 16, paddingTop: 48 }} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
      <Text style={{ fontSize: 20, fontWeight: '800', color: '#0F172A', marginBottom: 12 }}>{profile.name}</Text>
      {!approved && (
        <View style={notice}>
          <Text style={{ color: '#92400E' }}>
            {profile.status === 'pending' ? 'ELESEND is reviewing your company. You can invite riders and send deliveries once you are approved.' : `Your company is ${profile.status}. Please contact ELESEND support.`}
          </Text>
        </View>
      )}
      {!!message && <View style={card}><Text style={body}>{message}</Text></View>}

      {hasRiders && (
        <View style={card}>
          <Text style={heading}>Earnings</Text>
          <View style={row}><Text style={body}>Riders online</Text><Text style={strong}>{profile.riders?.online ?? 0} of {profile.riders?.total ?? 0}</Text></View>
          <View style={row}><Text style={body}>Not yet paid</Text><Text style={strong}>{ghc(balance.unpaidEarningsMinor)}</Text></View>
          <View style={row}><Text style={body}>Cash commission owed</Text><Text style={strong}>{ghc(balance.debtMinor)}</Text></View>
          <View style={row}><Text style={body}>Next payout</Text><Text style={strong}>{ghc(balance.nextPayoutMinor)}</Text></View>
        </View>
      )}

      {hasRiders && approved && (
        <View style={card}>
          <Text style={heading}>Riders</Text>
          <Text style={body}>Riders must be approved by ELESEND first. They accept your invitation in this app.</Text>
          <TextInput style={input} placeholder="Rider phone number" placeholderTextColor="#94A3B8" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
          <TouchableOpacity accessibilityRole="button" style={button} disabled={busy || !phone.trim()} onPress={invite}><Text style={buttonText}>Send invitation</Text></TouchableOpacity>
          {riders.map(rider => (
            <View key={rider.id} style={row}>
              <View style={{ flex: 1 }}>
                <Text style={strong}>{rider.phone}</Text>
                <Text style={body}>{rider.vehicle} · {rider.online ? 'Online' : 'Offline'} · {rider.completed_jobs} completed</Text>
              </View>
              <TouchableOpacity accessibilityRole="button" onPress={() => removeRider(rider)}><Text style={{ color: '#B91C1C', fontWeight: '700' }}>Remove</Text></TouchableOpacity>
            </View>
          ))}
          {waiting.map(item => (
            <View key={item.id} style={row}>
              <Text style={body}>Waiting: number ending {item.rider_phone_ending}</Text>
              <TouchableOpacity accessibilityRole="button" onPress={() => cancelInvite(item.id)}><Text style={strong}>Cancel</Text></TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {hasRiders && (
        <View style={card}>
          <Text style={heading}>Payout account</Text>
          <Text style={body}>Earnings are paid once a day to this Mobile Money account, after any commission owed. The number used is your verified phone.</Text>
          <View style={[row, { justifyContent: 'flex-start', gap: 8 }]}>
            {NETWORKS.map(option => (
              <TouchableOpacity key={option} accessibilityRole="button" style={{ borderWidth: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, borderColor: option === network ? '#0F172A' : '#CBD5E1', backgroundColor: option === network ? '#0F172A' : '#FFFFFF' }} onPress={() => setNetwork(option)}>
                <Text style={{ fontWeight: '700', color: option === network ? '#FFFFFF' : '#0F172A' }}>{option}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TextInput style={input} placeholder="Account name" placeholderTextColor="#94A3B8" value={accountName} onChangeText={setAccountName} maxLength={100} />
          <TouchableOpacity accessibilityRole="button" style={button} disabled={busy || accountName.trim().length < 2} onPress={savePayout}><Text style={buttonText}>Save payout account</Text></TouchableOpacity>
        </View>
      )}

      <View style={card}>
        <Text style={heading}>Services</Text>
        <TouchableOpacity accessibilityRole="checkbox" accessibilityState={{ checked: hasDelivery }} style={row} disabled={busy} onPress={() => toggle('delivery')}><Text style={strong}>Send our deliveries</Text><Text style={strong}>{hasDelivery ? 'On' : 'Off'}</Text></TouchableOpacity>
        <TouchableOpacity accessibilityRole="checkbox" accessibilityState={{ checked: hasRiders }} style={row} disabled={busy} onPress={() => toggle('riders')}><Text style={strong}>Provide riders</Text><Text style={strong}>{hasRiders ? 'On' : 'Off'}</Text></TouchableOpacity>
      </View>

      {hasDelivery && (
        <View style={card}>
          <Text style={heading}>Bookings and API keys</Text>
          <Text style={body}>Book deliveries and connect your own system in the company portal. Sign in with this same phone number and password.</Text>
          <TouchableOpacity accessibilityRole="link" style={plain} onPress={() => Linking.openURL(`${BASE}/company`)}><Text style={strong}>Open company portal</Text></TouchableOpacity>
        </View>
      )}

      <TouchableOpacity accessibilityRole="button" style={plain} onPress={onSignOut}><Text style={strong}>Sign out</Text></TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" style={{ padding: 16, alignItems: 'center' }} onPress={onDeleteAccount}><Text style={{ color: '#B91C1C', fontWeight: '700' }}>Delete Account</Text></TouchableOpacity>
    </ScrollView>
  );
}
