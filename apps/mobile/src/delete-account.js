import React, { useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { call } from './api';

/** In-app account deletion, which app stores require for apps with accounts. */
export default function DeleteAccountModal({ visible, onClose, onDeleted }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const close = () => {
    setPassword('');
    setError('');
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await call('POST', '/api/v1/me/delete-account', { password });
      setPassword('');
      await onDeleted();
    } catch (err) {
      setError(err.message || 'Could not delete your account. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={{ flex: 1, justifyContent: 'center', padding: 20, backgroundColor: 'rgba(15,23,42,0.6)' }}>
        <View style={{ backgroundColor: '#FFFFFF', borderRadius: 14, padding: 18 }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: '#0F172A', marginBottom: 8 }}>Delete your account?</Text>
          <Text style={{ fontSize: 14, color: '#475569', marginBottom: 12 }}>
            This signs you out everywhere and removes your phone number and login. It cannot be undone. Delivery and payment records are kept where the law or accounting requires them.
          </Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            placeholder="Enter your password to confirm"
            accessibilityLabel="Password"
            style={{ borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, padding: 12, marginBottom: 10 }}
          />
          {error ? <Text style={{ color: '#B91C1C', marginBottom: 10 }}>{error}</Text> : null}
          <TouchableOpacity
            disabled={busy || !password}
            onPress={submit}
            style={{ backgroundColor: '#B91C1C', opacity: busy || !password ? 0.5 : 1, borderRadius: 8, padding: 13, alignItems: 'center', marginBottom: 8 }}>
            {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={{ color: '#FFFFFF', fontWeight: '700' }}>Delete account</Text>}
          </TouchableOpacity>
          <TouchableOpacity disabled={busy} onPress={close} style={{ padding: 11, alignItems: 'center' }}>
            <Text style={{ color: '#334155', fontWeight: '600' }}>Keep my account</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
