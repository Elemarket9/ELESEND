import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { call } from '../api';
import { normalizeGhanaPhone, isValidGhanaPhone } from '../phone';

/** Lets the customer fix a mistyped recipient number before the parcel is handed over. */
export default function RecipientPhoneModal({ shipment, onClose, onChanged }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setValue(''); setError(''); }, [shipment?.id]);

  async function save() {
    const phone = normalizeGhanaPhone(value);
    if (!isValidGhanaPhone(phone)) { setError('Enter a valid Ghana number, for example 024 123 4567'); return; }
    setBusy(true); setError('');
    try {
      const res = await call('POST', `/api/v1/shipments/${shipment.id}/recipient`, { recipientPhone: phone });
      onChanged?.(res);
      onClose();
    } catch (e) {
      setError(e?.message || 'Could not change the number. Try again.');
    } finally { setBusy(false); }
  }

  return (
    <Modal visible={!!shipment} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.45)' }}>
        <View style={{ backgroundColor: '#FFFFFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 22 }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: '#0F172A' }}>Change recipient number</Text>
          <Text style={{ fontSize: 14, color: '#475569', marginTop: 6, lineHeight: 20 }}>
            The handover code is sent to this number. If a code was already sent to the old number, it stops working and the rider requests a new one.
          </Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            placeholder="024 123 4567"
            placeholderTextColor="#64748B"
            keyboardType="phone-pad"
            autoFocus
            accessibilityLabel="New recipient phone number"
            style={{ borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 12, paddingHorizontal: 14, minHeight: 48, fontSize: 16, color: '#0F172A', marginTop: 16 }}
          />
          {Boolean(error) && <Text style={{ color: '#B91C1C', fontSize: 13, marginTop: 8 }}>{error}</Text>}
          <View style={{ flexDirection: 'row', marginTop: 18 }}>
            <TouchableOpacity onPress={onClose} disabled={busy} style={{ flex: 1, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#CBD5E1', marginRight: 10 }}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#0F172A' }}>Keep current</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={save} disabled={busy} style={{ flex: 1, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0F766E' }}>
              {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={{ fontSize: 15, fontWeight: '700', color: '#FFFFFF' }}>Save number</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
