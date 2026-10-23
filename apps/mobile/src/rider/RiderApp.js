/**
 * ELESEND Rider (Courier) Mobile Application
 * 
 * Production-grade courier driver interface for:
 * - Online / Offline shift toggle with battery-conscious background GPS tracking
 * - Realtime broadcast delivery offers with atomic first-valid-accept
 * - Turn-by-turn navigation guidance to pickup and destination
 * - Pickup confirmation & recipient OTP handover verification
 * - In-person cash collection reporting
 * - Weekly Cash Commission Settlement & automated restriction monitoring
 * - Daily earnings overview & authorized Mobile Money withdrawal requests
 * 
 * Strict OWASP MASVS & safety adherence: enforces stationary state for offers,
 * zero customer screens, zero client-side pricing or commission manipulation.
 */

import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet,
  Alert, ActivityIndicator, AppState, Linking, StatusBar,
  TouchableOpacity, Modal
} from 'react-native';
import * as Location from 'expo-location';
import * as Crypto from 'expo-crypto';
import MapView, { Marker, RiderMarker, Polyline, openTurnByTurnNavigation } from '../maps/map-adapter';
import { call, loadToken, saveToken, clearToken, ghc, parseGhs, BASE } from '../api';
import { sample, startShiftTracking, stopShiftTracking } from '../tracking';
import { cacheJobs, readCachedJobs, clearCachedJobs } from '../offline';
import { normalizeGhanaPhone, isValidGhanaPhone } from '../phone';
import { colors, typography, spacing, radii } from '../theme';

const initialCreds = {
  phone: '',
  password: '',
  name: '',
  vehicle: 'motorcycle',
  maxWeightG: '20000',
  plateNumber: '',
  make: '',
  model: '',
  color: ''
};

const isStationary = speed => speed === null || speed < 2.5;

export default function RiderApp() {
  const [auth, setAuth] = useState(null);
  const [phoneState, setPhoneState] = useState(null); // { phone, verified }
  const [phoneChallenge, setPhoneChallenge] = useState(null); // { challengeId, expiresInSeconds }
  const [phoneCode, setPhoneCode] = useState('');
  const [credentials, setCredentials] = useState(initialCreds);
  const [isSignup, setIsSignup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('Jobs'); // 'Jobs' | 'Manifest' | 'Earnings' | 'Profile'

  // Courier Operational State
  const [online, setOnline] = useState(false);
  const [vehicle, setVehicle] = useState(null);
  const [offers, setOffers] = useState([]);
  const [manifest, setManifest] = useState(null);
  const [speed, setSpeed] = useState(null);
  const [trackingSeconds, setTrackingSeconds] = useState(15);
  const [shifts, setShifts] = useState(null);
  const [offlineCopy, setOfflineCopy] = useState(null);

  // Financial & Weekly Settlement State
  const [commSummary, setCommSummary] = useState(null);
  const [financeSnapshot, setFinanceSnapshot] = useState(null);
  const [momoModal, setMomoModal] = useState(false);
  const [momoNetwork, setMomoNetwork] = useState('MTN');
  const [momoPhone, setMomoPhone] = useState('');
  const [momoAmount, setMomoAmount] = useState('');
  const [withdrawModal, setWithdrawModal] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');

  // Active Handover & OTP State
  const [activeParcel, setActiveParcel] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [otp, setOtp] = useState('');
  const [reportedCash, setReportedCash] = useState({});

  const watch = useRef(null);

  const edit = (k, v) => setCredentials(c => ({ ...c, [k]: v }));

  const execute = async task => {
    if (busy) return;
    setBusy(true);
    try {
      setError('');
      await task();
    } catch (e) {
      setError(e.message || 'Operation failed');
    } finally {
      setBusy(false);
    }
  };

  // Auth Initialization
  useEffect(() => {
    (async () => {
      try {
        const token = await loadToken();
        if (token) {
          const user = await call('GET', '/api/v1/me');
          if (user.kind === 'rider') {
            const pStatus = await call('GET', '/api/v1/me/phone').catch(() => ({ phone: user.phone || '', verified: false }));
            setPhoneState(pStatus);
            setAuth({ ...user, phone: pStatus.phone || user.phone || '' });
          } else {
            await clearToken();
            setAuth(null);
            setPhoneState(null);
            setError('Please sign in with a Courier Rider account on this application.');
          }
        }
      } catch {
        await clearToken();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Periodic Refresh for Offers, Manifest, and Weekly Settlement
  useEffect(() => {
    if (!auth || auth.kind !== 'rider' || phoneState?.verified === false) return;
    let cancelled = false;

    const poll = async () => {
      if (cancelled || AppState.currentState !== 'active') return;
      try {
        const [m, o, v, cs, fin] = await Promise.all([
          call('GET', '/api/v1/rider/manifest').catch(() => null),
          online ? call('GET', '/api/v1/rider/offers').catch(() => []) : Promise.resolve([]),
          call('GET', '/api/v1/rider/vehicle').catch(() => null),
          call('GET', '/api/v1/rider/commissions/summary').catch(() => null),
          call('GET', '/api/v1/rider/wallet/summary').catch(() => null)
        ]);
        if (!cancelled) {
          if (m) setManifest(m);
          setOffers(o || []);
          if (v) {
            setVehicle(v);
            setOnline(v.online);
          }
          if (cs) setCommSummary(cs);
          if (fin) setFinanceSnapshot(fin);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    };

    poll();
    const interval = setInterval(poll, online ? 3500 : 12000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [auth, online, phoneState?.verified]);

  // GPS Movement & Location Tracking Watcher
  useEffect(() => {
    if (!auth || auth.kind !== 'rider' || phoneState?.verified === false || !online) return;
    let mounted = true;

    (async () => {
      try {
        const allowed = await Location.requestForegroundPermissionsAsync();
        if (allowed.status !== 'granted') {
          setError('GPS location access is required to receive nearby delivery offers');
          return;
        }

        watch.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, timeInterval: trackingSeconds * 1000, distanceInterval: 30 },
          async pos => {
            if (!mounted) return;
            setSpeed(pos.coords.speed >= 0 ? pos.coords.speed : null);
            const v = sample(pos);
            if (v && !shifts?.background) {
              try {
                await call('POST', '/api/v1/rider/location', v);
              } catch (e) {
                if (mounted) setError(e.message);
              }
            }
          }
        );
      } catch (e) {
        setError(e.message);
      }
    })();

    return () => {
      mounted = false;
      watch.current?.remove();
      watch.current = null;
    };
  }, [auth, online, phoneState?.verified, shifts?.background, trackingSeconds]);

  // --- Auth & Onboarding Actions ---
  async function signIn() {
    const normPhone = normalizeGhanaPhone(credentials.phone);
    if (!isValidGhanaPhone(normPhone)) throw Error('Enter a valid Ghana phone (e.g. 024 123 4567)');
    if (!credentials.password) throw Error('Enter your password');

    const data = await call('POST', '/api/v1/auth/login', {
      phone: normPhone,
      password: credentials.password
    });
    if (data.user.kind !== 'rider') {
      throw Error('This account is registered as a customer. Please use the standard ELESEND app.');
    }
    await saveToken(data.token);
    const pStatus = await call('GET', '/api/v1/me/phone').catch(() => ({ phone: normPhone, verified: false }));
    setPhoneState(pStatus);
    setAuth({ ...data.user, phone: pStatus.phone || normPhone });
    setCredentials(initialCreds);
    if (!pStatus.verified) {
      try {
        const ch = await call('POST', '/api/v1/me/phone-challenge', {});
        setPhoneChallenge(ch);
      } catch (e) {
        setError(e.message || 'Enter the verification code sent to your phone or request a new code.');
      }
    } else {
      setTab('Jobs');
    }
  }

  async function signUp() {
    const normPhone = normalizeGhanaPhone(credentials.phone);
    if (!isValidGhanaPhone(normPhone)) throw Error('Enter a valid Ghana phone (e.g. 024 123 4567)');
    if (credentials.password.length < 12 || credentials.password.length > 128) {
      throw Error('Password must be between 12 and 128 characters');
    }

    const body = {
      phone: normPhone,
      password: credentials.password,
      kind: 'rider',
      vehicle: credentials.vehicle,
      maxWeightG: Number(credentials.maxWeightG) || 20000
    };
    if (credentials.vehicle === 'car') {
      if (!credentials.plateNumber.trim()) throw Error('Vehicle registration plate is required for cars');
      body.car = {
        plateNumber: credentials.plateNumber.trim(),
        make: credentials.make.trim() || 'Toyota',
        model: credentials.model.trim() || 'Vitz',
        color: credentials.color.trim() || 'Silver'
      };
    }

    await call('POST', '/api/v1/auth/register', body);
    setIsSignup(false);
    await signIn();
  }

  async function requestPhoneVerificationChallenge() {
    const pStatus = await call('GET', '/api/v1/me/phone');
    setPhoneState(pStatus);
    if (pStatus.verified) {
      setPhoneChallenge(null);
      setPhoneCode('');
      setTab('Jobs');
      return;
    }
    const ch = await call('POST', '/api/v1/me/phone-challenge', {});
    setPhoneChallenge(ch);
    setPhoneCode('');
    setError('Verification code sent via SMS to ' + (pStatus.phone || auth?.phone || 'your phone') + '.');
  }

  async function submitPhoneVerification() {
    if (!phoneChallenge?.challengeId) {
      throw Error('Request a verification code first');
    }
    if (!/^\d{6}$/.test(phoneCode.trim())) {
      throw Error('Enter the 6-digit verification code');
    }
    await call('POST', '/api/v1/me/phone-verify', {
      challengeId: phoneChallenge.challengeId,
      code: phoneCode.trim()
    });
    const pStatus = await call('GET', '/api/v1/me/phone').catch(() => ({ phone: phoneState?.phone || auth?.phone || '', verified: true }));
    setPhoneState({ ...pStatus, verified: true });
    setPhoneChallenge(null);
    setPhoneCode('');
    setTab('Jobs');
  }

  async function logout() {
    if (online) {
      try {
        await call('POST', '/api/v1/rider/availability', { online: false });
        await stopShiftTracking();
      } catch {}
    }
    try {
      await call('POST', '/api/v1/auth/logout');
    } catch {}
    await clearCachedJobs();
    await clearToken();
    setAuth(null);
    setPhoneState(null);
    setPhoneChallenge(null);
    setPhoneCode('');
    setOnline(false);
    setManifest(null);
    setOffers([]);
    setTab('Jobs');
  }

  // --- Dispatch & Shift Actions ---
  async function toggleOnline() {
    if (online) {
      await call('POST', '/api/v1/rider/availability', { online: false });
      await stopShiftTracking();
      setOnline(false);
      return;
    }

    // Check weekly commission restriction before going online
    if (commSummary?.isRestricted) {
      throw Error('Account is restricted due to overdue cash commission. Settle your weekly balance to go online.');
    }

    const allowed = await Location.requestForegroundPermissionsAsync();
    if (allowed.status !== 'granted') throw Error('GPS permission required before going online');

    const settings = await call('GET', '/api/v1/rider/dispatch-settings');
    setTrackingSeconds(settings.movingUploadSeconds || 15);

    await call('POST', '/api/v1/rider/availability', { online: true });
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      await call('POST', '/api/v1/rider/location', sample(loc));
      setOnline(true);
      try {
        setShifts(await startShiftTracking(settings));
      } catch (e) {
        setShifts({ background: false, reason: e.message });
      }
    } catch (e) {
      await call('POST', '/api/v1/rider/availability', { online: false }).catch(() => {});
      throw e;
    }
  }

  async function acceptOffer(offer) {
    if (!isStationary(speed)) throw Error('Please stop moving safely before accepting this job');
    await call('POST', `/api/v1/shipments/${offer.id}/accept`, { offerId: offer.offerId });
    setOffers(prev => prev.filter(x => x.offerId !== offer.offerId));
    setTab('Manifest');
    const m = await call('GET', '/api/v1/rider/manifest').catch(() => null);
    if (m) setManifest(m);
  }

  async function declineOffer(offer) {
    await call('POST', '/api/v1/rider/offers/decline', { shipmentId: offer.id, offerId: offer.offerId });
    setOffers(prev => prev.filter(x => x.offerId !== offer.offerId));
  }

  // --- Handover & OTP Verification Actions ---
  async function initiatePickupVerification(shipment) {
    if (!isStationary(speed)) throw Error('Stop safely before initiating pickup verification');
    const c = await call('POST', `/api/v1/shipments/${shipment.id}/pickup-challenge`, {});
    setActiveParcel({ ...shipment, kind: 'pickup' });
    setChallenge(c);
    setOtp('');
  }

  async function initiateDeliveryVerification(shipment) {
    if (!isStationary(speed)) throw Error('Stop safely before initiating delivery verification');
    
    // For cash deliveries, require cash report confirmation first
    if (shipment.payment_method === 'CASH' && !reportedCash[shipment.id] && shipment.cash_payer === 'recipient') {
      Alert.alert(
        'Confirm Cash Collection',
        `Collect ${ghc(shipment.amount_minor)} in cash from the recipient before verifying OTP.`,
        [
          { text: 'Cancel' },
          {
            text: 'I Collected Full Cash',
            onPress: () => execute(async () => {
              await call('POST', '/api/v1/rider/cash-report', {
                shipmentId: shipment.id,
                reportedMinor: shipment.amount_minor,
                cashPayer: shipment.cash_payer || 'recipient',
                idempotencyKey: Crypto.randomUUID()
              });
              setReportedCash(r => ({ ...r, [shipment.id]: true }));
              const c = await call('POST', `/api/v1/shipments/${shipment.id}/delivery-challenge`, {});
              setActiveParcel({ ...shipment, kind: 'delivery' });
              setChallenge(c);
              setOtp('');
            })
          }
        ]
      );
      return;
    }

    const c = await call('POST', `/api/v1/shipments/${shipment.id}/delivery-challenge`, {});
    setActiveParcel({ ...shipment, kind: 'delivery' });
    setChallenge(c);
    setOtp('');
  }

  async function submitOtpVerification() {
    if (!activeParcel || !challenge) return;
    if (otp.trim().length !== 6) throw Error('Enter the exact 6-digit handover OTP');

    await call('POST', `/api/v1/shipments/${activeParcel.id}/verify`, {
      challengeId: challenge.challengeId,
      code: otp.trim()
    });

    setChallenge(null);
    setActiveParcel(null);
    setOtp('');
    const m = await call('GET', '/api/v1/rider/manifest').catch(() => null);
    setManifest(m);
    setError('Delivery verified and completed! Earnings credited to your wallet.');
  }

  async function releaseAssignment(shipmentId, reason = 'Unable to complete pickup before custody') {
    await call('POST', '/api/v1/rider/assignments/release', { shipmentId, reason });
    const m = await call('GET', '/api/v1/rider/manifest').catch(() => null);
    setManifest(m);
    setError('Assignment released for reassignment.');
  }

  async function transitionShipment(shipmentId, action, reason) {
    const body = reason ? { action, reason } : { action };
    await call('POST', `/api/v1/shipments/${shipmentId}/transition`, body);
    const m = await call('GET', '/api/v1/rider/manifest').catch(() => null);
    setManifest(m);
    setError(`Shipment updated (${action}).`);
  }

  // --- Financial & Commission Actions ---
  async function submitMomoRepayment() {
    if (!momoAmount.trim()) throw Error('Enter settlement amount in GH₵');
    const minor = parseGhs(momoAmount);
    const phone = normalizeGhanaPhone(momoPhone || auth.phone);
    if (!isValidGhanaPhone(phone)) throw Error('Enter valid Ghana phone for Mobile Money prompt');

    // Server validates amount against outstanding debt and policy limits; the app never computes balances.
    const res = await call('POST', '/api/v1/rider/wallet/topups', {
      amountMinor: minor,
      momoPhone: phone,
      momoNetwork,
      idempotencyKey: Crypto.randomUUID()
    });

    setMomoModal(false);
    setMomoAmount('');
    if (res?.checkoutUrl) await Linking.openURL(res.checkoutUrl).catch(() => null);
    setError(`Repayment of ${ghc(minor)} started. Your debt only reduces after ELESEND verifies the payment.`);
    const [cs, w] = await Promise.all([
      call('GET', '/api/v1/rider/commissions/summary').catch(() => null),
      call('GET', '/api/v1/rider/wallet/summary').catch(() => null)
    ]);
    if (cs) setCommSummary(cs);
    if (w) setFinanceSnapshot(w);
  }

  async function submitWithdrawalRequest() {
    const destination = (withdrawAmount || auth.phone || '').trim();
    if (!destination) throw Error('Enter your verified payout recipient reference or Mobile Money phone');

    await call('POST', '/api/v1/me/payout-beneficiary', {
      recipientReference: destination,
      accountNumber: normalizeGhanaPhone(auth.phone),
      accountName: `Rider ${auth.phone}`
    });

    setWithdrawModal(false);
    setWithdrawAmount('');
    setError('Verified payout beneficiary saved for digital order settlements.');
    const fin = await call('GET', '/api/v1/rider/wallet/summary').catch(() => null);
    if (fin) setFinanceSnapshot(fin);
  }

  // =========================================================================
  // RENDER: LOADING VIEW
  // =========================================================================
  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <View style={styles.brandBadge}><Text style={styles.brandBadgeText}>E</Text></View>
        <Text style={styles.splashTitle}>ELESEND RIDER</Text>
        <Text style={styles.splashSubtitle}>COURIER LOGISTICS NETWORK</Text>
        <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 20 }} />
      </View>
    );
  }

  // =========================================================================
  // RENDER: COURIER ONBOARDING & AUTHENTICATION
  // =========================================================================
  if (!auth) {
    return (
      <View style={styles.screen}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <ScrollView contentContainerStyle={styles.authScroll} keyboardShouldPersistTaps="handled">
          <View style={styles.authHeader}>
            <View style={styles.brandRow}>
              <View style={styles.brandBadge}><Text style={styles.brandBadgeText}>E</Text></View>
              <View>
                <Text style={styles.brandTitle}>ELESEND</Text>
                <Text style={styles.brandTagline}>RIDER COURIER APP</Text>
              </View>
            </View>
            <Text style={styles.authSubtitle}>Drive and earn on your schedule with transparent, administrator-published commission and clear weekly settlements.</Text>
          </View>

          {!!error && (
            <Pressable onPress={() => setError('')} style={styles.errorBox}>
              <Text style={styles.errorText}>⚠️ {error}</Text>
            </Pressable>
          )}

          <View style={styles.authCard}>
            <Text style={styles.authCardTitle}>{isSignup ? 'Courier Driver Registration' : 'Courier Sign In'}</Text>
            <Text style={styles.authCardSubtitle}>{isSignup ? 'Register your vehicle to start accepting delivery offers' : 'Sign in to go online and earn'}</Text>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Mobile Phone</Text>
              <View style={styles.phoneInputRow}>
                <View style={styles.countryBadge}>
                  <Text style={styles.flag}>🇬🇭</Text>
                  <Text style={styles.countryCode}>+233</Text>
                </View>
                <TextInput
                  placeholder="024 123 4567"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="phone-pad"
                  style={styles.phoneInput}
                  value={credentials.phone}
                  onChangeText={v => edit('phone', v)}
                />
              </View>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Password {isSignup ? '(12–128 characters)' : ''}</Text>
              <TextInput
                placeholder={isSignup ? 'Enter password (12–128 characters)' : 'Enter password'}
                placeholderTextColor={colors.textMuted}
                secureTextEntry
                maxLength={128}
                style={styles.input}
                value={credentials.password}
                onChangeText={v => edit('password', v)}
              />
            </View>

            {isSignup && (
              <View style={{ marginTop: 6 }}>
                <Text style={styles.inputLabel}>Vehicle Class</Text>
                <View style={styles.vehicleRow}>
                  {[
                    { id: 'motorcycle', label: '🛵 Motorbike', sub: 'Up to 20kg' },
                    { id: 'car', label: '🚗 Car', sub: 'Up to 150kg' },
                    { id: 'van', label: '🚐 Van', sub: 'Up to 800kg' }
                  ].map(v => (
                    <TouchableOpacity
                      key={v.id}
                      onPress={() => {
                        edit('vehicle', v.id);
                        edit('maxWeightG', v.id === 'motorcycle' ? '20000' : v.id === 'car' ? '150000' : '800000');
                      }}
                      style={[styles.vehicleChoice, credentials.vehicle === v.id && styles.vehicleChoiceActive]}>
                      <Text style={styles.vehicleChoiceTitle}>{v.label}</Text>
                      <Text style={styles.vehicleChoiceSub}>{v.sub}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {credentials.vehicle === 'car' && (
                  <View style={{ marginTop: 12 }}>
                    <TextInput
                      placeholder="License Plate (e.g. GR-2024-26)"
                      placeholderTextColor={colors.textMuted}
                      style={styles.input}
                      value={credentials.plateNumber}
                      onChangeText={v => edit('plateNumber', v)}
                    />
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                      <TextInput
                        placeholder="Make (e.g. Toyota)"
                        placeholderTextColor={colors.textMuted}
                        style={[styles.input, { flex: 1 }]}
                        value={credentials.make}
                        onChangeText={v => edit('make', v)}
                      />
                      <TextInput
                        placeholder="Model (e.g. Vitz)"
                        placeholderTextColor={colors.textMuted}
                        style={[styles.input, { flex: 1 }]}
                        value={credentials.model}
                        onChangeText={v => edit('model', v)}
                      />
                    </View>
                  </View>
                )}
              </View>
            )}

            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => execute(isSignup ? signUp : signIn)}
              style={styles.primaryBtn}
              disabled={busy}>
              {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.primaryBtnText}>{isSignup ? 'Complete Registration' : 'Sign In as Driver'}</Text>}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => { setIsSignup(!isSignup); setError(''); }}
              style={styles.switchAuthBtn}>
              <Text style={styles.switchAuthText}>
                {isSignup ? 'Already registered? Sign In' : 'New courier? Register here'}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  // =========================================================================
  // RENDER: COURIER PHONE VERIFICATION ONBOARDING
  // =========================================================================
  if (phoneState && !phoneState.verified) {
    return (
      <View style={styles.screen}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <ScrollView contentContainerStyle={styles.authScroll} keyboardShouldPersistTaps="handled">
          <View style={styles.authHeader}>
            <View style={styles.brandRow}>
              <View style={styles.brandBadge}><Text style={styles.brandBadgeText}>E</Text></View>
              <View>
                <Text style={styles.brandTitle}>ELESEND</Text>
                <Text style={styles.brandTagline}>VERIFY COURIER PHONE</Text>
              </View>
            </View>
            <Text style={styles.authSubtitle}>
              Verify your registered Ghana mobile number ({phoneState.phone || auth.phone}) before going online for dispatch.
            </Text>
          </View>

          {!!error && (
            <Pressable onPress={() => setError('')} style={styles.errorBox}>
              <Text style={styles.errorText}>⚠️ {error}</Text>
            </Pressable>
          )}

          <View style={styles.authCard}>
            <Text style={styles.authCardTitle}>Enter 6-Digit SMS Code</Text>
            <Text style={styles.authCardSubtitle}>
              {phoneChallenge?.challengeId
                ? 'Enter the 6-digit verification code sent to your mobile number.'
                : 'Tap "Send / Resend Verification Code" to receive a 6-digit SMS code.'}
            </Text>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Verification Code</Text>
              <TextInput
                placeholder="000000"
                placeholderTextColor={colors.textMuted}
                keyboardType="number-pad"
                maxLength={6}
                style={styles.input}
                value={phoneCode}
                onChangeText={setPhoneCode}
              />
            </View>

            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => execute(submitPhoneVerification)}
              style={styles.primaryBtn}
              disabled={busy || !phoneChallenge?.challengeId}>
              {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.primaryBtnText}>Verify Phone & Continue</Text>}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => execute(requestPhoneVerificationChallenge)}
              style={[styles.secondaryBtn, { marginTop: 12 }]}
              disabled={busy}>
              <Text style={styles.secondaryBtnText}>Send / Resend Verification Code</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => execute(logout)}
              style={styles.switchAuthBtn}>
              <Text style={styles.switchAuthText}>Sign Out / Use Another Account</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  // =========================================================================
  // RENDER: COURIER OPERATIONAL APP
  // =========================================================================
  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />

      {/* Top Courier Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.headerBadge}><Text style={styles.headerBadgeText}>🛵</Text></View>
          <View>
            <Text style={styles.headerTitle}>COURIER RIDER</Text>
            <Text style={styles.headerSubtitle}>{auth.phone} • {vehicle?.vehicle?.toUpperCase() || 'MOTORCYCLE'}</Text>
          </View>
        </View>

        {/* Online / Offline Switch */}
        <TouchableOpacity
          onPress={() => execute(toggleOnline)}
          style={[styles.onlineToggleBtn, online ? styles.onlineToggleActive : styles.onlineToggleOffline]}>
          <View style={[styles.onlineDot, { backgroundColor: online ? colors.primary : colors.danger }]} />
          <Text style={styles.onlineToggleText}>{online ? 'ONLINE' : 'OFFLINE'}</Text>
        </TouchableOpacity>
      </View>

      {/* Overdue Restriction Warning Banner */}
      {commSummary?.isRestricted && (
        <View style={styles.restrictionBanner}>
          <Text style={styles.restrictionTitle}>⚠️ DISPATCH RESTRICTED (OVERDUE COMMISSION)</Text>
          <Text style={styles.restrictionSub}>You have overdue commission of {ghc(commSummary.totalOutstandingMinor)}. Please settle to receive new delivery offers.</Text>
          <TouchableOpacity onPress={() => setMomoModal(true)} style={styles.settleNowBtn}>
            <Text style={styles.settleNowBtnText}>Settle via Mobile Money Now</Text>
          </TouchableOpacity>
        </View>
      )}

      {!!error && (
        <Pressable onPress={() => setError('')} style={styles.errorBox}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
        </Pressable>
      )}

      {/* Navigation Tab Bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          onPress={() => setTab('Jobs')}
          style={[styles.tabItem, tab === 'Jobs' && styles.tabItemActive]}>
          <Text style={[styles.tabText, tab === 'Jobs' && styles.tabTextActive]}>
            ⚡ Offers {offers.length > 0 ? `(${offers.length})` : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setTab('Manifest')}
          style={[styles.tabItem, tab === 'Manifest' && styles.tabItemActive]}>
          <Text style={[styles.tabText, tab === 'Manifest' && styles.tabTextActive]}>
            🗺️ Active Route
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setTab('Earnings')}
          style={[styles.tabItem, tab === 'Earnings' && styles.tabItemActive]}>
          <Text style={[styles.tabText, tab === 'Earnings' && styles.tabTextActive]}>
            💰 Wallet & Debt
          </Text>
        </TouchableOpacity>
      </View>

      {/* TAB CONTENT */}
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">

        {/* ================================================================= */}
        {/* TAB 1: LIVE DELIVERY OFFERS */}
        {/* ================================================================= */}
        {tab === 'Jobs' && (
          <View>
            {!online && (
              <View style={styles.offlineNoticeCard}>
                <Text style={styles.offlineNoticeTitle}>You are currently Offline</Text>
                <Text style={styles.offlineNoticeSub}>Tap the toggle at the top right to go online and receive nearby delivery requests.</Text>
                <TouchableOpacity onPress={() => execute(toggleOnline)} style={[styles.primaryBtn, { marginTop: 12 }]}>
                  <Text style={styles.primaryBtnText}>Go Online</Text>
                </TouchableOpacity>
              </View>
            )}

            {online && offers.length === 0 && (
              <View style={styles.searchingCard}>
                <ActivityIndicator size="small" color={colors.primary} style={{ marginBottom: 12 }} />
                <Text style={styles.searchingTitle}>Searching for nearby delivery jobs...</Text>
                <Text style={styles.searchingSub}>Stay online. New parcel and food orders within your travel zone will appear here automatically.</Text>
              </View>
            )}

            {online && offers.map(o => (
              <View key={o.offerId} style={styles.offerCard}>
                <View style={styles.offerHeader}>
                  <View style={styles.earningsPill}>
                    <Text style={styles.earningsPillText}>Earn {ghc(o.amount_minor)}</Text>
                  </View>
                  <Text style={styles.offerDistance}>{Math.round(o.distance_m / 100) / 10} km</Text>
                </View>

                <View style={styles.routeBox}>
                  <View style={styles.routePoint}>
                    <Text style={styles.routeDotGreen}>🟢</Text>
                    <Text style={styles.routeAddress}>{o.pickup?.address || 'Pickup Point'}</Text>
                  </View>
                  <View style={styles.routeLine} />
                  <View style={styles.routePoint}>
                    <Text style={styles.routeDotRed}>🔴</Text>
                    <Text style={styles.routeAddress}>{o.destination?.address || 'Delivery Address'}</Text>
                  </View>
                </View>

                <Text style={styles.offerPackageInfo}>📦 {o.description || 'Standard Package'} • {o.vehicle}</Text>

                <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                  <TouchableOpacity
                    onPress={() => execute(() => declineOffer(o))}
                    style={[styles.secondaryBtn, { flex: 1 }]}>
                    <Text style={styles.secondaryBtnText}>Decline</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => execute(() => acceptOffer(o))}
                    style={[styles.primaryBtn, { flex: 2 }]}>
                    <Text style={styles.primaryBtnText}>Accept Job ⚡</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 2: ACTIVE MANIFEST & NAVIGATION */}
        {/* ================================================================= */}
        {tab === 'Manifest' && (
          <View>
            {manifest?.stops && manifest.stops.length > 0 ? (
              <View>
                <Text style={styles.sectionHeading}>Your Assigned Deliveries</Text>

                {manifest.stops.map(s => (
                  <View key={s.id} style={styles.manifestCard}>
                    <View style={styles.manifestCardHeader}>
                      <Text style={styles.manifestShipmentId}>Order #{s.id.slice(0, 8)}</Text>
                      <View style={styles.stageBadge}>
                        <Text style={styles.stageBadgeText}>{s.state}</Text>
                      </View>
                    </View>

                    <Text style={styles.manifestPaymentType}>
                      Payment: {s.payment_method === 'CASH' ? '💵 Cash on Delivery' : '📱 Paid Digitally'}
                    </Text>

                    {/* Turn-by-Turn GPS Button */}
                    <TouchableOpacity
                      onPress={() => {
                        const target = s.state === 'RIDER_ASSIGNED' ? s.pickup : s.destination;
                        if (target) openTurnByTurnNavigation(target);
                      }}
                      style={styles.navButton}>
                      <Text style={styles.navButtonText}>📍 Open Turn-by-Turn Navigation</Text>
                    </TouchableOpacity>

                    {/* Verification & Handover Action Buttons */}
                    {s.state === 'RIDER_ASSIGNED' && (
                      <View>
                        <TouchableOpacity
                          onPress={() => execute(() => initiatePickupVerification(s))}
                          style={[styles.primaryBtn, { marginTop: 10 }]}>
                          <Text style={styles.primaryBtnText}>Confirm Package Pickup</Text>
                        </TouchableOpacity>
                        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                          <TouchableOpacity
                            onPress={() => execute(() => releaseAssignment(s.id, 'Rider released before pickup'))}
                            style={[styles.secondaryBtn, { flex: 1 }]}>
                            <Text style={styles.secondaryBtnText}>Release / Reassign</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => execute(() => transitionShipment(s.id, 'fail', 'Pickup failed at origin'))}
                            style={[styles.secondaryBtn, { flex: 1 }]}>
                            <Text style={styles.secondaryBtnText}>Pickup Failed</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}

                    {['PICKUP_VERIFIED', 'IN_TRANSIT', 'AWAITING_DELIVERY_OTP'].includes(s.state) && (
                      <View>
                        {s.state === 'PICKUP_VERIFIED' && (
                          <TouchableOpacity
                            onPress={() => execute(() => transitionShipment(s.id, 'start'))}
                            style={[styles.secondaryBtn, { marginTop: 10 }]}>
                            <Text style={styles.secondaryBtnText}>Start Delivery Transit</Text>
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity
                          onPress={() => execute(() => initiateDeliveryVerification(s))}
                          style={[styles.primaryBtn, { marginTop: 10 }]}>
                          <Text style={styles.primaryBtnText}>
                            {s.payment_method === 'CASH' && !reportedCash[s.id]
                              ? `Collect Cash (${ghc(s.amount_minor)}) & Verify OTP`
                              : 'Verify Recipient Handover OTP'}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => execute(() => transitionShipment(s.id, 'fail', 'Recipient unreachable or delivery failed'))}
                          style={[styles.secondaryBtn, { marginTop: 8 }]}>
                          <Text style={styles.secondaryBtnText}>Report Delivery Failure</Text>
                        </TouchableOpacity>
                      </View>
                    )}

                    {s.state === 'FAILED' && (
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                        <TouchableOpacity
                          onPress={() => execute(() => releaseAssignment(s.id, 'Released after pre-pickup failure'))}
                          style={[styles.secondaryBtn, { flex: 1 }]}>
                          <Text style={styles.secondaryBtnText}>Release (Pre-Pickup)</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => execute(() => transitionShipment(s.id, 'return', 'Returning undelivered package to origin'))}
                          style={[styles.primaryBtn, { flex: 1 }]}>
                          <Text style={styles.primaryBtnText}>Request Return</Text>
                        </TouchableOpacity>
                      </View>
                    )}

                    {s.state === 'RETURN_REQUESTED' && (
                      <TouchableOpacity
                        onPress={() => execute(() => transitionShipment(s.id, 'returned', 'Package returned to sender/kitchen'))}
                        style={[styles.primaryBtn, { marginTop: 10 }]}>
                        <Text style={styles.primaryBtnText}>Confirm Returned to Origin</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
              </View>
            ) : (
              <View style={styles.emptyCard}>
                <Text style={{ fontSize: 32, marginBottom: 8 }}>🛵</Text>
                <Text style={styles.emptyTitle}>No Active Delivery Route</Text>
                <Text style={styles.emptySub}>You have no pending assignments. Check the Offers tab when online.</Text>
              </View>
            )}

            {/* Handover OTP Entry Modal */}
            <Modal visible={Boolean(activeParcel && challenge)} animationType="fade" transparent>
              <View style={styles.modalOverlay}>
                <View style={styles.otpCard}>
                  <Text style={styles.otpCardTitle}>🔑 Verify Delivery Handover</Text>
                  <Text style={styles.otpCardSub}>Ask the recipient for their 6-digit confirmation code.</Text>

                  <TextInput
                    placeholder="000 000"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="number-pad"
                    maxLength={6}
                    style={styles.otpInput}
                    value={otp}
                    onChangeText={setOtp}
                  />

                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
                    <TouchableOpacity
                      onPress={() => { setActiveParcel(null); setChallenge(null); setOtp(''); }}
                      style={[styles.secondaryBtn, { flex: 1 }]}>
                      <Text style={styles.secondaryBtnText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => execute(submitOtpVerification)}
                      style={[styles.primaryBtn, { flex: 2 }]}
                      disabled={otp.length !== 6}>
                      <Text style={styles.primaryBtnText}>Verify & Complete</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </Modal>
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 3: EARNINGS, CASH COMMISSION & SETTLEMENT */}
        {/* ================================================================= */}
        {tab === 'Earnings' && (
          <View>
            {/* Wallet (server-derived from ELESEND ledgers) */}
            <View style={styles.walletCard}>
              <Text style={styles.walletLabel}>Wallet Balance</Text>
              <Text style={[styles.walletAmount, { color: (financeSnapshot?.walletBalanceMinor || 0) < 0 ? colors.danger : colors.text }]}>
                {(financeSnapshot?.walletBalanceMinor || 0) < 0 ? '-' : ''}{ghc(Math.abs(financeSnapshot?.walletBalanceMinor || 0))}
              </Text>
              <View style={styles.debtRow}>
                <Text style={styles.debtRowLabel}>Unpaid digital earnings:</Text>
                <Text style={styles.debtRowVal}>{ghc(financeSnapshot?.availableEarningsMinor || 0)}</Text>
              </View>
              <View style={styles.debtRow}>
                <Text style={styles.debtRowLabel}>Withdrawable now:</Text>
                <Text style={[styles.debtRowVal, { fontWeight: '800' }]}>{ghc(financeSnapshot?.withdrawableMinor || 0)}</Text>
              </View>
              {(financeSnapshot?.inPayoutMinor || 0) > 0 && (
                <View style={styles.debtRow}>
                  <Text style={styles.debtRowLabel}>Payout in progress:</Text>
                  <Text style={styles.debtRowVal}>{ghc(financeSnapshot.inPayoutMinor)}</Text>
                </View>
              )}
              {(financeSnapshot?.companyEarningsMinor || 0) > 0 && (
                <Text style={styles.debtSub}>Fleet-company job earnings ({ghc(financeSnapshot.companyEarningsMinor)}) are paid to your company.</Text>
              )}
              <TouchableOpacity
                onPress={() => setWithdrawModal(true)}
                style={[styles.primaryBtn, { marginTop: 12 }]}>
                <Text style={styles.primaryBtnText}>Payout Account</Text>
              </TouchableOpacity>
            </View>

            {/* Commission debt and assignment eligibility */}
            <View style={styles.debtCard}>
              <Text style={styles.debtHeading}>ELESEND Commission Balance</Text>
              <Text style={styles.debtSub}>Commission on cash deliveries is owed to ELESEND. Future digital earnings are applied to it automatically.</Text>
              {financeSnapshot?.debtRestricted && (
                <Text style={[styles.debtSub, { color: colors.danger, fontWeight: '700' }]}>
                  New delivery offers are paused: your balance reached the {ghc(financeSnapshot.debtLimitMinor || 0)} limit. You can still repay, view history and finish current jobs.
                </Text>
              )}
              <View style={styles.debtRow}>
                <Text style={styles.debtRowLabel}>Outstanding commission:</Text>
                <Text style={[styles.debtRowVal, { color: (financeSnapshot?.outstandingDebtMinor || 0) > 0 ? colors.danger : colors.text }]}>{ghc(financeSnapshot?.outstandingDebtMinor || 0)}</Text>
              </View>
              <View style={styles.debtRow}>
                <Text style={styles.debtRowLabel}>Maximum allowed:</Text>
                <Text style={styles.debtRowVal}>{ghc(financeSnapshot?.debtLimitMinor || 0)}</Text>
              </View>
              <View style={styles.debtRow}>
                <Text style={styles.debtRowLabel}>Overdue (weekly cycle):</Text>
                <Text style={[styles.debtRowVal, { color: commSummary?.overdueCommissionMinor > 0 ? colors.danger : colors.text }]}>
                  {ghc(commSummary?.overdueCommissionMinor || 0)}
                </Text>
              </View>
              <View style={[styles.debtRow, { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8, marginTop: 8 }]}>
                <Text style={[styles.debtRowLabel, { fontWeight: '700', color: colors.text }]}>Recovered from earnings:</Text>
                <Text style={[styles.debtRowVal, { fontWeight: '800', color: colors.primary }]}>
                  {ghc(financeSnapshot?.lifetime?.debtRecoveredFromEarningsMinor || 0)}
                </Text>
              </View>
              {(financeSnapshot?.restrictions || []).filter(r => r.code !== 'DEBT_LIMIT_REACHED').map(r => (
                <Text key={r.code} style={[styles.debtSub, { color: colors.danger }]}>Account check: {r.code.replace(/_/g, ' ').toLowerCase()}</Text>
              ))}

              <TouchableOpacity
                disabled={!financeSnapshot?.repayment?.canRepay}
                onPress={() => setMomoModal(true)}
                style={[styles.settleBtn, { marginTop: 14, opacity: financeSnapshot?.repayment?.canRepay ? 1 : 0.5 }]}>
                <Text style={styles.settleBtnText}>Repay Commission</Text>
              </TouchableOpacity>
            </View>

            {/* Mobile Money Repayment Modal */}
            <Modal visible={momoModal} animationType="fade" transparent>
              <View style={styles.modalOverlay}>
                <View style={styles.momoCard}>
                  <Text style={styles.momoTitle}>Settle Commission via MoMo</Text>
                  <Text style={styles.momoSub}>A prompt will be sent directly to your phone to approve the payment.</Text>

                  <Text style={[styles.inputLabel, { marginTop: 12 }]}>Select Network</Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                    {['MTN', 'Telecel', 'AT'].map(net => (
                      <TouchableOpacity
                        key={net}
                        onPress={() => setMomoNetwork(net)}
                        style={[styles.networkPill, momoNetwork === net && styles.networkPillActive]}>
                        <Text style={styles.networkPillText}>{net}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <Text style={[styles.inputLabel, { marginTop: 12 }]}>Amount in GH₵</Text>
                  <TextInput
                    placeholder="e.g. 26.00"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                    style={styles.input}
                    value={momoAmount}
                    onChangeText={setMomoAmount}
                  />

                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
                    <TouchableOpacity onPress={() => setMomoModal(false)} style={[styles.secondaryBtn, { flex: 1 }]}>
                      <Text style={styles.secondaryBtnText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => execute(submitMomoRepayment)} style={[styles.primaryBtn, { flex: 2 }]}>
                      <Text style={styles.primaryBtnText}>Send MoMo Prompt</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </Modal>

            {/* Withdrawal Modal */}
            <Modal visible={withdrawModal} animationType="fade" transparent>
              <View style={styles.modalOverlay}>
                <View style={styles.momoCard}>
                  <Text style={styles.momoTitle}>Withdraw Earnings</Text>
                  <Text style={styles.momoSub}>Funds will be transferred to your registered phone ({auth.phone}).</Text>

                  <Text style={[styles.inputLabel, { marginTop: 12 }]}>Amount to Withdraw in GH₵</Text>
                  <TextInput
                    placeholder="e.g. 50.00"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                    style={styles.input}
                    value={withdrawAmount}
                    onChangeText={setWithdrawAmount}
                  />

                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
                    <TouchableOpacity onPress={() => setWithdrawModal(false)} style={[styles.secondaryBtn, { flex: 1 }]}>
                      <Text style={styles.secondaryBtnText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => execute(submitWithdrawalRequest)} style={[styles.primaryBtn, { flex: 2 }]}>
                      <Text style={styles.primaryBtnText}>Confirm Withdrawal</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </Modal>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  splashTitle: { fontSize: 26, fontWeight: '800', color: colors.text, marginTop: 16 },
  splashSubtitle: { fontSize: 12, color: colors.primary, letterSpacing: 2, marginTop: 4 },
  brandBadge: { width: 56, height: 56, borderRadius: 16, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  brandBadgeText: { fontSize: 30, fontWeight: '900', color: colors.bg },
  authScroll: { padding: 24, paddingTop: 60 },
  authHeader: { marginBottom: 28 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 12 },
  brandTitle: { fontSize: 24, fontWeight: '800', color: colors.text },
  brandTagline: { fontSize: 11, fontWeight: '700', color: colors.primary, letterSpacing: 1.5 },
  authSubtitle: { fontSize: 14, color: colors.textMuted, lineHeight: 20 },
  authCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 20, borderWidth: 1, borderColor: colors.cardBorder },
  authCardTitle: { fontSize: 20, fontWeight: '700', color: colors.text, marginBottom: 4 },
  authCardSubtitle: { fontSize: 13, color: colors.textMuted, marginBottom: 20 },
  inputGroup: { marginBottom: 14 },
  inputLabel: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 6 },
  input: { backgroundColor: colors.card, borderRadius: radii.md, borderWidth: 1, borderColor: colors.cardBorder, padding: 12, color: colors.text, fontSize: 14 },
  phoneInputRow: { flexDirection: 'row', gap: 8 },
  countryBadge: { backgroundColor: colors.card, borderRadius: radii.md, borderWidth: 1, borderColor: colors.cardBorder, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  flag: { fontSize: 16 },
  countryCode: { color: colors.text, fontWeight: '600', fontSize: 14 },
  phoneInput: { flex: 1, backgroundColor: colors.card, borderRadius: radii.md, borderWidth: 1, borderColor: colors.cardBorder, padding: 12, color: colors.text, fontSize: 14 },
  vehicleRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  vehicleChoice: { flex: 1, backgroundColor: colors.card, borderRadius: radii.md, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: colors.cardBorder },
  vehicleChoiceActive: { borderColor: colors.primary, backgroundColor: colors.cardBorder },
  vehicleChoiceTitle: { fontSize: 13, fontWeight: '700', color: colors.text },
  vehicleChoiceSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  primaryBtn: { backgroundColor: colors.primary, borderRadius: radii.md, padding: 14, alignItems: 'center', justifyContent: 'center' },
  primaryBtnText: { color: colors.bg, fontSize: 15, fontWeight: '700' },
  secondaryBtn: { backgroundColor: colors.card, borderRadius: radii.md, padding: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.cardBorder },
  secondaryBtnText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  switchAuthBtn: { marginTop: 16, alignItems: 'center', padding: 8 },
  switchAuthText: { color: colors.primary, fontSize: 13, fontWeight: '600' },
  errorBox: { backgroundColor: '#450A0A', padding: 12, borderRadius: radii.md, marginHorizontal: 16, marginTop: 8, borderWidth: 1, borderColor: colors.danger },
  errorText: { color: '#F87171', fontSize: 13, fontWeight: '600' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 48, paddingBottom: 14, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerBadge: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.primary },
  headerBadgeText: { fontSize: 18 },
  headerTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  headerSubtitle: { fontSize: 12, color: colors.textMuted },
  onlineToggleBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14, borderRadius: radii.full, borderWidth: 1 },
  onlineToggleActive: { backgroundColor: '#064E3B', borderColor: colors.primary },
  onlineToggleOffline: { backgroundColor: colors.card, borderColor: colors.cardBorder },
  onlineDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  onlineToggleText: { fontSize: 12, fontWeight: '800', color: colors.text },
  restrictionBanner: { backgroundColor: '#450A0A', padding: 14, borderBottomWidth: 1, borderBottomColor: colors.danger },
  restrictionTitle: { fontSize: 13, fontWeight: '800', color: '#FCA5A5' },
  restrictionSub: { fontSize: 12, color: '#FECACA', marginTop: 2, lineHeight: 16 },
  settleNowBtn: { backgroundColor: colors.primary, paddingVertical: 6, paddingHorizontal: 12, borderRadius: radii.sm, marginTop: 8, alignSelf: 'flex-start' },
  settleNowBtnText: { color: colors.bg, fontSize: 12, fontWeight: '700' },
  tabBar: { flexDirection: 'row', backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
  tabItem: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabItemActive: { borderBottomWidth: 2, borderBottomColor: colors.primary },
  tabText: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  tabTextActive: { color: colors.primary, fontWeight: '700' },
  scrollContent: { padding: 16 },
  offlineNoticeCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: colors.cardBorder },
  offlineNoticeTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 6 },
  offlineNoticeSub: { fontSize: 13, color: colors.textMuted, textAlign: 'center', lineHeight: 18 },
  searchingCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: colors.cardBorder },
  searchingTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 4 },
  searchingSub: { fontSize: 13, color: colors.textMuted, textAlign: 'center', lineHeight: 18 },
  offerCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: colors.primary },
  offerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  earningsPill: { backgroundColor: colors.primaryDark, paddingVertical: 4, paddingHorizontal: 12, borderRadius: radii.full },
  earningsPillText: { color: colors.text, fontWeight: '800', fontSize: 15 },
  offerDistance: { fontSize: 14, fontWeight: '700', color: colors.textMuted },
  routeBox: { backgroundColor: colors.card, borderRadius: radii.md, padding: 12, marginVertical: 12, borderWidth: 1, borderColor: colors.cardBorder },
  routePoint: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  routeDotGreen: { fontSize: 12 },
  routeDotRed: { fontSize: 12 },
  routeAddress: { fontSize: 13, color: colors.text, flex: 1 },
  routeLine: { width: 2, height: 16, backgroundColor: colors.cardBorder, marginLeft: 5, marginVertical: 4 },
  offerPackageInfo: { fontSize: 13, color: colors.textMuted },
  sectionHeading: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 12 },
  manifestCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: colors.cardBorder },
  manifestCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  manifestShipmentId: { fontSize: 16, fontWeight: '700', color: colors.text },
  stageBadge: { backgroundColor: colors.card, paddingVertical: 4, paddingHorizontal: 10, borderRadius: radii.full, borderWidth: 1, borderColor: colors.primary },
  stageBadgeText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  manifestPaymentType: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  navButton: { backgroundColor: colors.card, padding: 10, borderRadius: radii.md, marginTop: 12, alignItems: 'center', borderWidth: 1, borderColor: colors.cardBorder },
  navButtonText: { color: colors.primary, fontSize: 13, fontWeight: '700' },
  walletCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: colors.cardBorder },
  walletLabel: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  walletAmount: { fontSize: 32, fontWeight: '900', color: colors.primary, marginVertical: 6 },
  debtCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 18, borderWidth: 1, borderColor: colors.cardBorder },
  debtHeading: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 4 },
  debtSub: { fontSize: 12, color: colors.textMuted, marginBottom: 14, lineHeight: 16 },
  debtRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  debtRowLabel: { fontSize: 13, color: colors.textMuted },
  debtRowVal: { fontSize: 13, color: colors.text, fontWeight: '600' },
  settleBtn: { backgroundColor: '#B45309', padding: 12, borderRadius: radii.md, alignItems: 'center' },
  settleBtnText: { color: '#FEF3C7', fontSize: 14, fontWeight: '700' },
  modalOverlay: { flex: 1, backgroundColor: '#000000AA', justifyContent: 'center', padding: 20 },
  otpCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 24, borderWidth: 1, borderColor: colors.cardBorder },
  otpCardTitle: { fontSize: 18, fontWeight: '700', color: colors.text, textAlign: 'center' },
  otpCardSub: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: 4, marginBottom: 16 },
  otpInput: { backgroundColor: colors.card, borderRadius: radii.md, borderWidth: 1, borderColor: colors.primary, padding: 16, color: colors.primary, fontSize: 28, fontWeight: '900', textAlign: 'center', letterSpacing: 8 },
  momoCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 20, borderWidth: 1, borderColor: colors.cardBorder },
  momoTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  momoSub: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  networkPill: { flex: 1, paddingVertical: 8, backgroundColor: colors.card, borderRadius: radii.sm, alignItems: 'center', borderWidth: 1, borderColor: colors.cardBorder },
  networkPillActive: { borderColor: colors.primary, backgroundColor: colors.cardBorder },
  networkPillText: { fontSize: 13, fontWeight: '700', color: colors.text },
  emptyCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 32, alignItems: 'center', marginTop: 20 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  emptySub: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: 4 }
});
