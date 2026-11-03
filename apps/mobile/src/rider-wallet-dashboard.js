import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Share, Text, TouchableOpacity, View } from 'react-native';
import { call, ghc } from './api';

const card = { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 12, padding: 14, marginBottom: 12 };
const title = { fontSize: 15, fontWeight: '800', color: '#0F172A', marginBottom: 6 };
const body = { fontSize: 13, color: '#475569', marginTop: 3 };
const strong = { fontSize: 14, fontWeight: '700', color: '#0F172A' };
const row = { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 };
const button = { backgroundColor: '#0F172A', borderRadius: 8, padding: 11, alignItems: 'center', marginTop: 10 };
const buttonText = { color: '#FFFFFF', fontWeight: '700' };

const STATUS = {
  initiating: 'Processing', pending: 'Processing', needs_review: 'Being checked',
  paid: 'Sent', failed: 'Failed, money returned', reversed: 'Returned to your balance'
};
const LABELS = {
  digital_delivery_earnings: 'Delivery earnings', withdrawal_paid: 'Withdrawal', withdrawal_reversed: 'Withdrawal returned',
  cash_commission: 'Cash commission owed', debt_repayment: 'Commission repaid', debt_recovered_from_earnings: 'Commission taken from earnings',
  debt_waiver: 'Commission waived', debt_reinstated: 'Commission reinstated', prepaid_credit: 'Prepaid credit', promotion_credit: 'Reward credit'
};
const when = value => (value ? new Date(value).toLocaleDateString() : '');

export function WalletDashboard() {
  const [summary, setSummary] = useState(null);
  const [history, setHistory] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    const [s, h, t] = await Promise.all([
      call('GET', '/api/v1/rider/wallet/summary').catch(() => null),
      call('GET', '/api/v1/rider/wallet/withdrawals').catch(() => null),
      call('GET', '/api/v1/rider/wallet/transactions?limit=20').catch(() => null)
    ]);
    setSummary(s);
    setHistory(h);
    setItems(t?.items || []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function shareStatement() {
    try {
      const statement = await call('GET', '/api/v1/rider/wallet/statement');
      await Share.share({ title: 'ELESEND statement', message: statement.csv });
    } catch (e) { Alert.alert('Could not create statement', e.message); }
  }

  return (
    <View>
      <View style={card}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={title}>My Wallet</Text>
          <TouchableOpacity accessibilityRole="button" onPress={load}><Text style={body}>Refresh</Text></TouchableOpacity>
        </View>
        {loading && !summary && <ActivityIndicator />}
        {!loading && !summary && <Text style={body}>Your wallet could not be loaded. Tap Refresh to try again.</Text>}
        {summary && (
          <View>
            <View style={row}><Text style={body}>Available now</Text><Text style={strong}>{ghc(summary.availableNowMinor)}</Text></View>
            <View style={row}><Text style={body}>On hold</Text><Text style={strong}>{ghc(summary.onHoldMinor)}</Text></View>
            <View style={row}><Text style={body}>Withdrawal in progress</Text><Text style={strong}>{ghc(summary.inPayoutMinor)}</Text></View>
            <View style={row}><Text style={body}>Commission owed</Text><Text style={strong}>{ghc(summary.outstandingDebtMinor)}</Text></View>
            {summary.companyEarningsMinor > 0 && <View style={row}><Text style={body}>Paid to your company</Text><Text style={strong}>{ghc(summary.companyEarningsMinor)}</Text></View>}
          </View>
        )}
        {history?.onHold && <Text style={[body, { color: '#B91C1C' }]}>Withdrawals are on hold on this account. Please contact support.</Text>}
      </View>

      <View style={card}>
        <Text style={title}>Withdrawals</Text>
        {history && !history.withdrawals.length && <Text style={body}>No withdrawals yet.</Text>}
        {history?.withdrawals.map(w => (
          <View key={w.id} style={{ marginTop: 10 }}>
            <View style={row}><Text style={strong}>{ghc(w.sentMinor)} sent</Text><Text style={body}>{STATUS[w.status] || w.status}</Text></View>
            <Text style={body}>{when(w.requestedAt)}, {w.deliveries} deliveries, {ghc(w.earnedMinor)} earned, {ghc(w.feeMinor)} fee</Text>
            {Boolean(w.transferCode) && <Text style={body}>Transfer code {w.transferCode}</Text>}
            {w.status === 'failed' && Boolean(w.failureReason) && <Text style={body}>{w.failureReason}</Text>}
          </View>
        ))}
      </View>

      <View style={card}>
        <Text style={title}>Recent Activity</Text>
        {!items.length && <Text style={body}>No activity yet.</Text>}
        {items.map(item => (
          <View key={`${item.source}-${item.id}`} style={row}>
            <Text style={[body, { flex: 1 }]}>{LABELS[item.type] || item.type} {when(item.at)}</Text>
            <Text style={strong}>{ghc(item.amountMinor)}</Text>
          </View>
        ))}
        <TouchableOpacity accessibilityRole="button" style={button} onPress={shareStatement}>
          <Text style={buttonText}>Share 30-Day Statement</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
