import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';
import { call } from './api';

const card = { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 12, padding: 14, marginBottom: 12 };
const title = { fontSize: 15, fontWeight: '800', color: '#0F172A', marginBottom: 6 };
const body = { fontSize: 13, color: '#475569', marginTop: 3 };
const row = { flexDirection: 'row', gap: 8, marginTop: 10 };
const yes = { flex: 1, backgroundColor: '#0F172A', borderRadius: 8, padding: 11, alignItems: 'center' };
const no = { flex: 1, borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, padding: 11, alignItems: 'center' };

/** Only appears when a company has invited this rider. Joining sends their company earnings to that company. */
export function CompanyInvitations() {
  const [invitations, setInvitations] = useState([]);
  const load = useCallback(() => call('GET', '/api/v1/rider/invitations').then(setInvitations).catch(() => {}), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);
  const answer = async (path, payload) => {
    try {
      await call('POST', path, payload);
    } catch (e) {
      Alert.alert('Could not update invitation', e.message);
    }
    load();
  };
  const accept = invitation => Alert.alert(
    `Join ${invitation.company_name}?`,
    'Earnings from jobs you complete while in this company are paid to the company, not to your own wallet. You will go offline when you join.',
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Join', onPress: () => answer('/api/v1/rider/invitations/accept', { invitationId: invitation.id }) }
    ]
  );
  if (!invitations.length) return null;
  return invitations.map(invitation => (
    <View key={invitation.id} style={card}>
      <Text style={title}>Company invitation</Text>
      <Text style={body}>{invitation.company_name} has invited you to ride for them.</Text>
      <View style={row}>
        <TouchableOpacity accessibilityRole="button" style={no} onPress={() => answer(`/api/v1/rider/invitations/${invitation.id}/decline`)}>
          <Text style={{ fontWeight: '700', color: '#0F172A' }}>Decline</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" style={yes} onPress={() => accept(invitation)}>
          <Text style={{ fontWeight: '700', color: '#FFFFFF' }}>Review</Text>
        </TouchableOpacity>
      </View>
    </View>
  ));
}
