/**
 * ELESEND Rider (Courier) Mobile Application
 * 
 * Production-grade courier driver interface for:
 * - Online / Offline shift toggle with battery-conscious background GPS tracking
 * - Realtime broadcast delivery offers with atomic first-valid-accept
 * - Turn-by-turn navigation guidance to pickup and destination
 * - Rider-confirmed physical pickup and delivery handovers
 * - In-person cash collection reporting
 * - Weekly Cash Commission Settlement & automated restriction monitoring
 * - Daily earnings overview & authorized Mobile Money withdrawal requests
 * 
 * Strict OWASP MASVS & safety adherence: enforces stationary state for offers,
 * zero customer screens, zero client-side pricing or commission manipulation.
 */

import { runGuarded, useSignInState, signInWithPassword } from '../account-actions';
import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet,
  Alert, ActivityIndicator, AppState, Linking, StatusBar,
  TouchableOpacity, Modal, Vibration
} from 'react-native';
import * as Location from 'expo-location';
import { WithdrawalHistory } from '../rider-withdrawal-history';
import { CompanyInvitations } from '../rider-company-invitations';
import { EmergencyButton, RatingPrompts, RiderTools, ShareLiveLocation, TrustedContactCard } from '../rider-safety';
import * as Crypto from 'expo-crypto';
import MapView, { Marker, RiderMarker, Polyline, openTurnByTurnNavigation } from '../maps/map-adapter';
import { call, loadToken, saveToken, clearToken, ghc, parseGhs, BASE } from '../api';
import DeleteAccountModal from '../delete-account';
import { LegalNotice, termsAcceptance } from '../legal-notice';
import CompanyHome from '../company/CompanyHome';
import { sample, startShiftTracking, stopShiftTracking, subscribeBackgroundOfferAlerts, acquireDevicePushToken, registerDevicePushChannel } from '../tracking';
import { cacheJobs, readCachedJobs, readLastCachedJobs, clearCachedJobs } from '../offline';
import { normalizeGhanaPhone, isValidGhanaPhone } from '../phone';
import { colors, typography, spacing, radii } from '../theme';
import { riderStatus } from '../status-labels';
import RiderNavigation from './RiderNavigation';
import { cashToCollect } from './handover-logic.mjs';
import { VoiceNoteBubble, VoiceNoteRecorder } from '../chat/VoiceNote';
import OfflineMapCard from './OfflineMapCard';
import { prepareDeviceLocation } from '../customer-location';

const initialCreds = {
  phone: '',
  password: '',
  name: '',
  accountType: 'rider',
  sendDeliveries: true,
  provideRiders: true,
  vehicle: 'motorcycle',
  maxWeightG: '20000',
  plateNumber: '',
  make: '',
  model: '',
  color: ''
};

const isStationary = speed => speed === null || speed < 2.5;

function BrandRow({ tagline }) {
  return (
    <View style={styles.brandRow}>
      <View style={styles.brandBadge}><Text style={styles.brandBadgeText}>E</Text></View>
      <View>
        <Text style={styles.brandTitle}>ELESEND</Text>
        <Text style={styles.brandTagline}>{tagline}</Text>
      </View>
    </View>
  );
}

export default function RiderApp() {
  const [auth, setAuth] = useState(null);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const {
    phoneState, setPhoneState, phoneChallenge, setPhoneChallenge, phoneCode, setPhoneCode,
    credentials, setCredentials, isSignup, setIsSignup, loading, setLoading, busy, setBusy, error, setError,
    forgotModal, setForgotModal, recoveryPhone, setRecoveryPhone, recoveryChallenge, setRecoveryChallenge,
    recoveryCode, setRecoveryCode, recoveryNewPassword, setRecoveryNewPassword,
    requestPasswordRecoveryChallenge, submitPasswordReset
  } = useSignInState(initialCreds);
  const [tab, setTab] = useState('Jobs'); // 'Jobs' | 'Manifest' | 'Earnings' | 'Profile'

  // Courier Operational State
  const [online, setOnline] = useState(false);
  const [vehicle, setVehicle] = useState(null);
  const [offers, setOffers] = useState([]);
  const [navigating, setNavigating] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [speed, setSpeed] = useState(null);
  const [mapReportShipment, setMapReportShipment] = useState(null);
  const [mapReportNotes, setMapReportNotes] = useState('');
  const [trackingSeconds, setTrackingSeconds] = useState(15);
  const [shifts, setShifts] = useState(null);
  const [offlineCopy, setOfflineCopy] = useState(null);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);

  // Financial & Weekly Settlement State
  const [commSummary, setCommSummary] = useState(null);
  const [financeSnapshot, setFinanceSnapshot] = useState(null);
  const [momoModal, setMomoModal] = useState(false);
  const [momoNetwork, setMomoNetwork] = useState('MTN');
  const [momoPhone, setMomoPhone] = useState('');
  const [momoAmount, setMomoAmount] = useState('');
  const [withdrawModal, setWithdrawModal] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [finalPayout, setFinalPayout] = useState(false);
  const availableNow = financeSnapshot?.availableNowMinor || 0;
  const withdrawalMin = financeSnapshot?.withdrawalMinMinor || 0;
  const withdrawalFee = financeSnapshot?.withdrawalFeeMinor || 0;
  const canWithdraw = availableNow > 0 && availableNow >= withdrawalMin && availableNow > withdrawalFee;
  const [withdrawPassword, setWithdrawPassword] = useState('');
  const withdrawKey = useRef(null);
  const [licence, setLicence] = useState(null);
  const [licenceModal, setLicenceModal] = useState(false);
  const [riderDocuments, setRiderDocuments] = useState([]);
  const [riderProfile, setRiderProfile] = useState(null);
  const [profileForm, setProfileForm] = useState({ displayName: '', vehiclePlate: '' });
  const [licenceForm, setLicenceForm] = useState({ legalName: '', ghanaCardNumber: '', licenceNumber: '', licenceClass: '', expiresOn: '', vehiclePlate: '' });
  const [payoutName, setPayoutName] = useState('');

  // Active Handover & OTP State
  const [reportedCash, setReportedCash] = useState({});

  // Order-Scoped Real-Time Chat State (Customer & Restaurant)
  const [riderChatModal, setRiderChatModal] = useState(false);
  const [riderChatConv, setRiderChatConv] = useState(null);
  const [riderChatMessages, setRiderChatMessages] = useState([]);
  const [riderChatInput, setRiderChatInput] = useState('');
  const [riderUnreadTotal, setRiderUnreadTotal] = useState(0);

  const watch = useRef(null);
  const prevOffersRef = useRef(new Set());

  const edit = (k, v) => setCredentials(c => ({ ...c, [k]: v }));

  const execute = task => runGuarded(task, { busy, setBusy, setError });

  async function applyManifest(m) {
    if (m) {
      setManifest(m);
      setOfflineCopy(null);
      await cacheJobs(auth.id, m).catch(() => {});
      return;
    }
    const cached = await readCachedJobs(auth.id).catch(() => null);
    if (cached) { setOfflineCopy(cached); setManifest(null); }
  }

  // Auth Initialization
  useEffect(() => {
    (async () => {
      try {
        const token = await loadToken();
        if (token) {
          const user = await call('GET', '/api/v1/me');
          if (user.kind === 'rider' || user.kind === 'company') {
            const pStatus = await call('GET', '/api/v1/me/phone').catch(() => ({ phone: user.phone || '', verified: false }));
            setPhoneState(pStatus);
            setAuth({ ...user, phone: pStatus.phone || user.phone || '' });
          } else {
            await clearToken();
            setAuth(null);
            setPhoneState(null);
            setError('Please sign in with a rider or company account on this application.');
          }
        }
      } catch (e) {
        if (e.status===401 || e.status===403) {
          await clearToken();
          await clearCachedJobs();
        } else if (await loadToken()) {
          setOfflineCopy(await readLastCachedJobs().catch(()=>null));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Opens the rider app as soon as ELESEND approves this account.
  useEffect(() => {
    if (auth?.kind !== 'rider' || !auth.awaitingApproval || phoneState?.verified === false) return;
    const t = setInterval(() => {
      call('GET', '/api/v1/me').then(user => {
        if (!user.awaitingApproval) setAuth(current => ({ ...current, awaitingApproval: false }));
      }).catch(() => {});
    }, 20000);
    return () => clearInterval(t);
  }, [auth?.kind, auth?.awaitingApproval, phoneState?.verified]);

  // Periodic Refresh + Background Offer Alert Channel (Screen-Off / Battery-Saving Resilient)
  useEffect(() => {
    if (!auth || auth.kind !== 'rider' || auth.awaitingApproval || phoneState?.verified === false) return;
    let cancelled = false;

    acquireDevicePushToken({ appScope: 'rider' })
      .then(acquired => (acquired?.ok && acquired?.pushToken) ? registerDevicePushChannel({ appScope: 'rider', pushToken: acquired.pushToken, deviceId: acquired.deviceId, platform: acquired.platform || 'android', appState: AppState.currentState || 'active', backgroundLocationEnabled: Boolean(online) }) : { registered: false, available: false })
      .catch(() => null);

    const applyOfferList = currentOffers => {
      const list = Array.isArray(currentOffers) ? currentOffers : Array.isArray(currentOffers?.offers) ? currentOffers.offers : [];
      const currentIds = list.map(x => x.offerId || x.id);
      const hasNewOffer = currentIds.some(id => !prevOffersRef.current.has(id));
      if (vibrationEnabled && hasNewOffer && list.length > 0) {
        try { Vibration.vibrate([0, 400, 200, 400]); } catch {}
      } else if (list.length === 0) {
        try { Vibration.cancel(); } catch {}
      }
      prevOffersRef.current = new Set(currentIds);
      setOffers(list);
    };

    const unsubscribeBackgroundAlerts = subscribeBackgroundOfferAlerts(bgOffers => {
      if (!cancelled && online) {
        applyOfferList(bgOffers);
      }
    });

    let pollCount = 0;
    const poll = async ({ allowBackground = false } = {}) => {
      if (cancelled) return;
      if (!allowBackground && AppState.currentState && AppState.currentState !== 'active') {
        if (online) {
          const bgOffers = await call('GET', '/api/v1/rider/offers').catch(() => null);
          if (!cancelled && Array.isArray(bgOffers)) applyOfferList(bgOffers);
        }
        return;
      }
      try {
        // Offers are checked every time. The rest changes rarely, which saves the rider's data and the request limit.
        pollCount += 1;
        const refreshJobs = pollCount % 2 === 1;
        const refreshAccount = pollCount % 6 === 1;
        const [m, o, v, cs, fin] = await Promise.all([
          refreshJobs ? call('GET', '/api/v1/rider/manifest').catch(() => null) : Promise.resolve(undefined),
          online ? call('GET', '/api/v1/rider/offers').catch(() => null) : Promise.resolve([]),
          refreshAccount ? call('GET', '/api/v1/rider/vehicle').catch(() => null) : Promise.resolve(null),
          refreshAccount ? call('GET', '/api/v1/rider/commissions/summary').catch(() => null) : Promise.resolve(null),
          refreshAccount ? call('GET', '/api/v1/rider/wallet/summary').catch(() => null) : Promise.resolve(null)
        ]);
        if (!cancelled) {
          if (m !== undefined) await applyManifest(m);
          // A failed check says nothing about offers, so the one on screen stays.
          if (o) applyOfferList(o);
          if (v) {
            setVehicle(v);
            setOnline(v.online);
          }
          if (cs) setCommSummary(cs);
          if (fin) setFinanceSnapshot(fin);
        }
      } catch (e) {
        if (cancelled) return;
        if (e.status === 401) {
          await clearToken();
          setAuth(null);
          setPhoneState(null);
          setError('You have been signed out. Please sign in again.');
          return;
        }
        setError(e.message);
      }
    };

    const appStateSub = AppState.addEventListener?.('change', nextState => {
      if (nextState === 'active') {
        poll({ allowBackground: true });
      }
    });

    poll({ allowBackground: true });
    const interval = setInterval(() => poll(), online ? 3500 : 12000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      unsubscribeBackgroundAlerts();
      appStateSub?.remove?.();
      try { Vibration.cancel(); } catch {}
    };
  }, [auth, online, phoneState?.verified, vibrationEnabled]);

  // Ask for location when the app opens so going online is quicker. Nothing is uploaded until
  // the rider goes online, and company accounts, which do not use GPS, are not asked.
  useEffect(() => {
    if (!loading && auth?.kind !== 'company') prepareDeviceLocation(Location);
  }, [loading, auth?.kind]);

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
                const locRes = await call('POST', '/api/v1/rider/location', v);
                if (mounted && Array.isArray(locRes?.pendingOffers) && locRes.pendingOffers.length > 0) {
                  setOffers(locRes.pendingOffers);
                }
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
    const { data, normPhone, pStatus } = await signInWithPassword(credentials, user => {
      if (user.kind !== 'rider' && user.kind !== 'company') throw Error('This account is registered as a customer. Please use the standard ELESEND app.');
    });
    setPhoneState(pStatus);
    setAuth({ ...data.user, phone: pStatus.phone || normPhone });
    setCredentials(initialCreds);
    if (!pStatus.verified) {
      try {
        setPhoneChallenge(await call('POST', '/api/v1/me/phone-challenge', {}));
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

    if (credentials.accountType === 'company') {
      const services = [credentials.sendDeliveries && 'delivery', credentials.provideRiders && 'riders'].filter(Boolean);
      if (credentials.name.trim().length < 2) throw Error('Enter your company name');
      if (!services.length) throw Error('Choose at least one service');
      await call('POST', '/api/v1/auth/register', { phone: normPhone, password: credentials.password, kind: 'company', name: credentials.name.trim(), services, ...termsAcceptance() });
      setIsSignup(false);
      await signIn();
      return;
    }

    if (credentials.name.trim().length < 2) throw Error('Enter your name. Customers see your first name');
    const body = {
      phone: normPhone,
      password: credentials.password,
      kind: 'rider',
      name: credentials.name.trim().slice(0, 60),
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

    await call('POST', '/api/v1/auth/register', { ...body, ...termsAcceptance() });
    setIsSignup(false);
    await signIn();
  }

  async function openLicenceAndDocuments() {
    setLicence(await call('GET', '/api/v1/rider/licence'));
    const docs = await call('GET', '/api/v1/rider/documents').catch(() => null);
    setRiderDocuments(docs?.documents || []);
    setRiderProfile(docs || null);
    setProfileForm(f => ({ displayName: f.displayName || docs?.displayName || '', vehiclePlate: f.vehiclePlate || docs?.vehiclePlate || '' }));
    setLicenceModal(true);
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

  async function finishAccountDeletion() {
    try { await stopShiftTracking(); } catch {}
    await clearCachedJobs();
    await clearToken();
    setDeleteAccountOpen(false);
    setAuth(null);
    setPhoneState(null);
    setPhoneChallenge(null);
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
    try { Vibration.cancel(); } catch {}
    await call('POST', `/api/v1/shipments/${offer.id}/accept`, { offerId: offer.offerId });
    setOffers(prev => prev.filter(x => x.offerId !== offer.offerId));
    setTab('Manifest');
    const m = await call('GET', '/api/v1/rider/manifest').catch(() => null);
    await applyManifest(m);
  }

  async function declineOffer(offer) {
    try { Vibration.cancel(); } catch {}
    await call('POST', '/api/v1/rider/offers/decline', { shipmentId: offer.id, offerId: offer.offerId });
    setOffers(prev => prev.filter(x => x.offerId !== offer.offerId));
  }

  // The rider declares that the physical handover happened. This is not an SMS recipient proof.
  // Server-side authorization, stop order, cash collection, prepaid food and ledger checks remain mandatory.
  async function confirmPhysicalHandover(shipment, kind) {
    if (!isStationary(speed)) throw Error('Stop safely before confirming a handover');
    const response = await call('POST', `/api/v1/shipments/${shipment.id}/handover`, {
      kind, confirmed: true
    });
    if (response?.waitingFee?.collection === 'collect_cash') {
      Alert.alert('Waiting fee', `You waited ${Math.round(response.waitingFee.waitedSeconds / 60)} min here. Collect ${ghc(response.waitingFee.feeMinor)} waiting fee in cash. You keep all of it.`);
    }
    const m = await call('GET', '/api/v1/rider/manifest').catch(() => null);
    setManifest(m);
    setError(kind === 'pickup' ? 'Pickup recorded.'
      : kind === 'return' ? 'Parcel return recorded; settlement updated.'
      : 'Delivery marked complete. The recipient can dispute a missing parcel.');
  }

  function askPhysicalHandover(shipment,kind) {
    const title = kind === 'pickup' ? 'Confirm parcel collected'
      : kind === 'return' ? 'Confirm parcel returned' : 'Confirm parcel handed over';
    const explanation = kind === 'pickup'
      ? 'Only confirm after you physically receive the parcel from the sender or restaurant.'
      : kind === 'return'
        ? 'Only confirm after physically returning the parcel to its sender.'
        : 'Only confirm after physically handing the parcel to its recipient. This is your declaration, not customer-verified delivery proof.';
    Alert.alert(title,explanation,[
      {text:'Cancel',style:'cancel'},
      {text:'I Confirm Handover',onPress:()=>execute(()=>confirmPhysicalHandover(shipment,kind))}
    ]);
  }

  async function collectAndConfirm(shipment,kind){
    const cash=cashToCollect(shipment, kind, reportedCash);
    if(cash){
      Alert.alert(
        'Confirm Cash Collection',
        `Collect ${ghc(cash.amountMinor)} in cash from the ${cash.payer} before confirming ${kind}.`,
        [
          {text:'Cancel',style:'cancel'},
          {text:'I Collected Full Cash',onPress:()=>execute(async()=>{
            await call('POST','/api/v1/rider/cash-report',{
              shipmentId:shipment.id,reportedMinor:cash.amountMinor,
              cashPayer:cash.payer,idempotencyKey:Crypto.randomUUID()
            });
            setReportedCash(r=>({...r,[shipment.id]:true}));
            askPhysicalHandover(shipment,kind);
          })}
        ]
      );
      return;
    }
    askPhysicalHandover(shipment,kind);
  }

  async function initiatePickupVerification(shipment) {
    await collectAndConfirm(shipment,'pickup');
  }

  async function initiateDeliveryVerification(shipment) {
    if (!isStationary(speed)) throw Error('Stop safely before confirming delivery');
    await collectAndConfirm(shipment,'delivery');
  }

  async function initiateReturnVerification(shipment) {
    Alert.alert('Return requires review',
      'No SMS code is needed. Tell ELESEND support or the sender that the parcel has been returned. An administrator must confirm the return before settlement.');
  }

  async function releaseAssignment(shipmentId, reason = 'Unable to complete pickup before custody') {
    await call('POST', '/api/v1/rider/assignments/release', { shipmentId, reason });
    if (riderChatConv?.shipmentId === shipmentId) {
      setRiderChatModal(false);
      setRiderChatConv(null);
      setRiderChatMessages([]);
    }
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

  // --- Order-Scoped Real-Time Chat (Customer & Restaurant) ---
  async function openRiderOrderChat({ conversationType, shipmentId, foodOrderId }) {
    try {
      const conv = await call('POST', '/api/v1/chat/conversations', {
        conversationType,
        shipmentId: shipmentId || null,
        foodOrderId: foodOrderId || null
      });
      setRiderChatConv(conv);
      setRiderChatModal(true);
      await refreshRiderChatMessages(conv.id);
    } catch (e) {
      setError(e.message || 'Unable to open order chat');
    }
  }

  async function refreshRiderChatMessages(conversationId) {
    if (!conversationId) return;
    try {
      const res = await call('GET', `/api/v1/chat/conversations/${conversationId}/messages`);
      setRiderChatConv(res.conversation);
      const msgs = res.messages || [];
      setRiderChatMessages(msgs);
      const lastSeq = msgs.length > 0 ? msgs[msgs.length - 1].seq : 0;
      if (lastSeq > 0) {
        await call('POST', `/api/v1/chat/conversations/${conversationId}/read`, { upToSeq: lastSeq }).catch(() => null);
      }
    } catch (e) {
      // If rider was reassigned or membership revoked, clear and close immediately
      setRiderChatModal(false);
      setRiderChatConv(null);
      setRiderChatMessages([]);
    }
  }

  async function sendRiderChatMessage({ messageType = 'text', bodyText = '', quickReplyKey = null }) {
    if (!riderChatConv?.id) return;
    if (messageType === 'text' && !isStationary(speed)) {
      setError('Stop safely before typing a custom message, or tap a one-tap quick reply.');
      return;
    }
    try {
      const msg = await call('POST', `/api/v1/chat/conversations/${riderChatConv.id}/messages`, {
        clientMessageId: Crypto.randomUUID(),
        messageType,
        bodyText,
        quickReplyKey
      });
      setRiderChatInput('');
      setRiderChatMessages(prev => (prev.some(m => m.id === msg.id) ? prev : [...prev, msg]));
    } catch (e) {
      setError(e.message || 'Failed to send message');
    }
  }

  async function reportRiderChatAbuse(reasonCategory = 'harassment') {
    if (!riderChatConv?.id) return;
    try {
      await call('POST', `/api/v1/chat/conversations/${riderChatConv.id}/report`, {
        reasonCategory,
        details: 'Reported by courier from order chat'
      });
      Alert.alert('Report Submitted', 'ELESEND Safety & Support has received your report.');
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    if (!riderChatModal || !riderChatConv?.id) return;
    const t = setInterval(() => {
      refreshRiderChatMessages(riderChatConv.id);
    }, 3000);
    return () => clearInterval(t);
  }, [riderChatModal, riderChatConv?.id]);

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

  const networkPicker = (
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
  );

  async function submitLicence() {
    const form = licenceForm;
    const bicycle = riderProfile?.vehicle === 'bicycle';
    await call('POST', '/api/v1/rider/licence', {
      legalName: form.legalName.trim(),
      ghanaCardNumber: form.ghanaCardNumber.trim(),
      ...(!bicycle && form.licenceNumber.trim() ? { licenceNumber: form.licenceNumber.trim() } : {}),
      expiresOn: form.expiresOn.trim(),
      ...(!bicycle && form.licenceClass.trim() ? { licenceClass: form.licenceClass.trim() } : {}),
      ...(form.vehiclePlate.trim() ? { vehiclePlate: form.vehiclePlate.trim() } : {})
    });
    setLicence(await call('GET', '/api/v1/rider/licence'));
    setError('Details saved. Now add your photos.');
  }

  async function saveCompanyRiderProfile() {
    const saved = await call('POST', '/api/v1/rider/profile', {
      displayName: profileForm.displayName.trim(),
      ...(riderProfile?.vehicle !== 'bicycle' && profileForm.vehiclePlate.trim() ? { vehiclePlate: profileForm.vehiclePlate.trim() } : {})
    });
    setRiderProfile(p => ({ ...(p || {}), ...saved }));
    setError(`Saved. Add your profile photo, then ask ${riderProfile?.companyName || 'your company'} to approve you.`);
  }

  async function openDocumentUpload() {
    const res = await call('POST', '/api/v1/rider/documents/upload-link', {});
    if (res?.path) await Linking.openURL(`${BASE}${res.path}`);
  }

  async function startIdentityPhotos() {
    const res = await call('POST', '/api/v1/rider/licence/identity-check', {});
    if (res?.url) await Linking.openURL(res.url);
  }

  async function requestWithdrawal() {
    // The key survives a lost connection, so a repeat press cannot start a second withdrawal.
    withdrawKey.current = withdrawKey.current || Crypto.randomUUID();
    const res = await call('POST', '/api/v1/rider/wallet/withdraw', { idempotencyKey: withdrawKey.current, ...(finalPayout ? { finalPayout: true } : {}), password: withdrawPassword });
    withdrawKey.current = null;
    setFinalPayout(false);
    setConfirmWithdraw(false);
    setWithdrawPassword('');
    const amount = ghc(res?.amountMinor || 0);
    setError(res?.status === 'paid'
      ? `${amount} sent to your Mobile Money.`
      : res?.status === 'failed'
        ? `Your withdrawal of ${amount} failed and the money is back in your balance.`
        : `Your withdrawal of ${amount} is processing.`);
    const fin = await call('GET', '/api/v1/rider/wallet/summary').catch(() => null);
    if (fin) setFinanceSnapshot(fin);
  }

  async function submitWithdrawalRequest() {
    const accountName = payoutName.trim();
    if (accountName.length < 2) throw Error('Enter the name on your Mobile Money account');

    await call('POST', '/api/v1/me/payout-beneficiary', {
      momoNetwork: momoNetwork === 'Telecel' ? 'TELECEL' : momoNetwork,
      accountName
    });

    setWithdrawModal(false);
    setPayoutName('');
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
  if (!auth && offlineCopy) {
    return <ScrollView contentContainerStyle={{padding:24}}>
      <Text>Saved deliveries — view only</Text>
      <Text>Last saved: {offlineCopy.cachedAt}. Connect to refresh before taking any action.</Text>
      {offlineCopy.shipments.map(job=><Text key={job.id} style={styles.offlineText}>{job.details?.pickup} → {job.details?.destination}</Text>)}
      {offlineCopy.stops.map((stop,index)=><Text key={index} style={styles.offlineText}>{stop.kind}: {stop.shipmentId}</Text>)}
      <Pressable onPress={async()=>{await clearToken();await clearCachedJobs();setOfflineCopy(null);}}><Text>Sign out and clear saved jobs</Text></Pressable>
    </ScrollView>;
  }
  if (!auth) {
    return (
      <View style={styles.screen}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <ScrollView contentContainerStyle={styles.authScroll} keyboardShouldPersistTaps="handled">
          <View style={styles.authHeader}>
            <BrandRow tagline="Rider and company app" />
            <Text style={styles.authSubtitle}>Deliver on your schedule and see the commission on every job before you accept it.</Text>
          </View>

          {!!error && (
            <Pressable onPress={() => setError('')} style={styles.errorBox}>
              <Text style={styles.errorText}>⚠️ {error}</Text>
            </Pressable>
          )}

          <View style={styles.authCard}>
            <Text style={styles.authCardTitle}>{isSignup ? (credentials.accountType === 'company' ? 'Company Registration' : 'Rider registration') : 'Rider & Company Sign In'}</Text>
            <Text style={styles.authCardSubtitle}>{isSignup ? (credentials.accountType === 'company' ? 'Register to send deliveries, provide riders, or both' : 'Register your vehicle to start accepting delivery offers') : 'Sign in to go online and earn'}</Text>

            {isSignup && (
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>I am registering as</Text>
                <View style={styles.vehicleRow}>
                  {[{ id: 'rider', label: 'A rider' }, { id: 'company', label: 'A company' }].map(option => (
                    <TouchableOpacity
                      key={option.id}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: credentials.accountType === option.id }}
                      style={[styles.vehicleChoice, credentials.accountType === option.id && styles.vehicleChoiceActive]}
                      onPress={() => edit('accountType', option.id)}>
                      <Text style={styles.vehicleChoiceTitle}>{option.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {isSignup && credentials.accountType === 'company' && (
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Company Name</Text>
                <TextInput
                  placeholder="Registered company name"
                  placeholderTextColor={colors.textMuted}
                  maxLength={160}
                  style={styles.input}
                  value={credentials.name}
                  onChangeText={v => edit('name', v)}
                />
                <Text style={[styles.inputLabel, { marginTop: 12 }]}>What will you use ELESEND for?</Text>
                {[{ key: 'sendDeliveries', label: 'Send our deliveries' }, { key: 'provideRiders', label: 'Provide riders' }].map(option => (
                  <TouchableOpacity
                    key={option.key}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: credentials[option.key] }}
                    style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10 }}
                    onPress={() => edit(option.key, !credentials[option.key])}>
                    <Text style={styles.inputLabel}>{option.label}</Text>
                    <Text style={styles.inputLabel}>{credentials[option.key] ? '☑' : '☐'}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

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

            {isSignup && credentials.accountType === 'rider' && (
              <View style={{ marginTop: 6 }}>
                <Text style={styles.inputLabel}>Your name</Text>
                <TextInput
                  placeholder="As customers should see it, like Kwame Asante"
                  placeholderTextColor={colors.textMuted}
                  maxLength={60}
                  style={[styles.input, { marginBottom: 14 }]}
                  value={credentials.name}
                  onChangeText={v => edit('name', v)}
                />
                <Text style={styles.inputLabel}>Vehicle Class</Text>
                <View style={styles.vehicleRow}>
                  {[
                    { id: 'motorcycle', label: '🛵 Motorbike', sub: 'Up to 20kg' },
                    { id: 'car', label: '🚗 Car', sub: 'Up to 150kg' }
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

            {isSignup && <LegalNotice style={{ color: colors.textMuted }} linkColor={colors.primary} />}

            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => execute(isSignup ? signUp : signIn)}
              style={[styles.primaryBtn, { marginTop: 16 }]}
              disabled={busy}>
              {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.primaryBtnText}>{isSignup ? 'Create account' : 'Sign in'}</Text>}
            </TouchableOpacity>

            {!isSignup && (
              <TouchableOpacity
                onPress={() => {
                  setForgotModal(v => !v);
                  setRecoveryPhone(credentials.phone || '');
                  setError('');
                }}
                style={styles.switchAuthBtn}>
                <Text style={styles.switchAuthText}>Forgot password? Recover via SMS</Text>
              </TouchableOpacity>
            )}

            {forgotModal && !isSignup && (
              <View style={{ marginTop: 14, padding: 14, borderRadius: radii.md, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line }}>
                <Text style={styles.authCardTitle}>Recover Courier Password</Text>
                <Text style={styles.authCardSubtitle}>Verify your registered Ghana phone with a 6-digit SMS code to set a new password.</Text>
                <TextInput
                  placeholder="Registered phone (e.g. 024 123 4567)"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="phone-pad"
                  style={[styles.input, { marginTop: 8 }]}
                  value={recoveryPhone}
                  onChangeText={setRecoveryPhone}
                />
                <TouchableOpacity
                  onPress={() => execute(requestPasswordRecoveryChallenge)}
                  style={[styles.secondaryBtn, { marginTop: 10 }]}
                  disabled={busy}>
                  <Text style={styles.secondaryBtnText}>Send 6-Digit Recovery Code</Text>
                </TouchableOpacity>
                {recoveryChallenge?.challengeId && (
                  <View style={{ marginTop: 12 }}>
                    <TextInput
                      placeholder="6-Digit SMS Code"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="number-pad"
                      maxLength={6}
                      style={styles.input}
                      value={recoveryCode}
                      onChangeText={setRecoveryCode}
                    />
                    <TextInput
                      placeholder="New Password (12–128 characters)"
                      placeholderTextColor={colors.textMuted}
                      secureTextEntry
                      maxLength={128}
                      style={[styles.input, { marginTop: 8 }]}
                      value={recoveryNewPassword}
                      onChangeText={setRecoveryNewPassword}
                    />
                    <TouchableOpacity
                      onPress={() => execute(submitPasswordReset)}
                      style={[styles.primaryBtn, { marginTop: 10 }]}
                      disabled={busy}>
                      <Text style={styles.primaryBtnText}>Verify Code & Reset Password</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            )}

            <TouchableOpacity
              onPress={() => { setIsSignup(!isSignup); setForgotModal(false); setError(''); }}
              style={styles.switchAuthBtn}>
              <Text style={styles.switchAuthText}>
                {isSignup ? 'Already registered? Sign In' : 'New rider or company? Register here'}
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
            <BrandRow tagline={auth?.kind === 'company' ? 'VERIFY COMPANY PHONE' : 'VERIFY COURIER PHONE'} />
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
            <TouchableOpacity accessibilityRole="button" style={styles.switchAuthBtn} onPress={() => setDeleteAccountOpen(true)}>
              <Text style={[styles.switchAuthText, { color: '#FCA5A5' }]}>Delete Account</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      <DeleteAccountModal
        visible={deleteAccountOpen}
        onClose={() => setDeleteAccountOpen(false)}
        onDeleted={finishAccountDeletion}
      />
      </View>
    );
  }

  const companyRider = licence?.status === 'not_required';
  const bicycleRider = riderProfile?.vehicle === 'bicycle';
  const documentLabel = kind => ({ profile_photo: 'Profile photo', ghana_card_photo: 'Ghana Card photo', licence_photo: "Driver's licence photo", insurance: 'Insurance', roadworthiness: 'Roadworthiness' }[kind] || kind.replaceAll('_', ' '));
  const documentList = (
    <>
      {riderDocuments.map(d => (
        <Text key={d.kind} style={[styles.momoSub, { marginTop: 6 }]}>
          {documentLabel(d.kind)}: {d.status}{d.rejectionReason ? ` (${d.rejectionReason})` : ''}
        </Text>
      ))}
      <TouchableOpacity disabled={busy} onPress={() => execute(openDocumentUpload)} style={[styles.secondaryBtn, { marginTop: 10 }]}>
        <Text style={styles.secondaryBtnText}>{companyRider ? 'Upload Profile Photo' : 'Upload Photos & Certificates'}</Text>
      </TouchableOpacity>
    </>
  );
  const licenceDocumentsModal = (
            <Modal visible={licenceModal} animationType="fade" transparent>
              <ScrollView style={{ flex: 1, backgroundColor: '#000000AA' }} contentContainerStyle={styles.modalScrollBody} keyboardShouldPersistTaps="handled">
                {companyRider ? (
                  <View style={styles.momoCard}>
                    <Text style={styles.momoTitle}>Your rider profile</Text>
                    <Text style={styles.momoSub}>
                      {licence.companyName} checks your identity, so ELESEND does not need your Ghana Card. Add your name{bicycleRider ? '' : ', number plate'} and a clear photo of your face, then ask {licence.companyName} to approve you. Customers see your photo, first name{bicycleRider ? '' : ' and plate'}.
                    </Text>
                    <Text style={[styles.inputLabel, { marginTop: 10 }]}>Your name</Text>
                    <TextInput placeholderTextColor={colors.textMuted} style={styles.input} maxLength={60} value={profileForm.displayName} onChangeText={value => setProfileForm(f => ({ ...f, displayName: value }))} />
                    {!bicycleRider && (
                      <>
                        <Text style={[styles.inputLabel, { marginTop: 10 }]}>Number plate, exactly as on the vehicle</Text>
                        <TextInput placeholder="M-22-GR 1234" placeholderTextColor={colors.textMuted} style={styles.input} maxLength={20} autoCapitalize="characters" value={profileForm.vehiclePlate} onChangeText={value => setProfileForm(f => ({ ...f, vehiclePlate: value }))} />
                      </>
                    )}
                    {documentList}
                    <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
                      <TouchableOpacity onPress={() => setLicenceModal(false)} style={[styles.secondaryBtn, { flex: 1 }]}>
                        <Text style={styles.secondaryBtnText}>Close</Text>
                      </TouchableOpacity>
                      <TouchableOpacity disabled={busy} onPress={() => execute(saveCompanyRiderProfile)} style={[styles.primaryBtn, { flex: 2 }]}>
                        <Text style={styles.primaryBtnText}>Save</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                <View style={styles.momoCard}>
                  <Text style={styles.momoTitle}>{bicycleRider ? 'Ghana Card' : "Ghana Card & Driver's Licence"}</Text>
                  <Text style={styles.momoSub}>
                    {licence?.status === 'approved' ? `Approved, valid until ${licence.validUntil}.`
                      : licence?.status === 'pending' ? 'Waiting for review. You can start deliveries once it is approved.'
                        : licence?.status === 'rejected' ? `Rejected: ${licence.rejectionReason}. Please correct it and submit again.`
                          : bicycleRider ? 'Required before you can take deliveries.' : 'Both are required before you can take deliveries.'}
                  </Text>
                  <Text style={[styles.inputLabel, { marginTop: 10 }]}>Full name, as on your Ghana Card</Text>
                  <TextInput placeholderTextColor={colors.textMuted} style={styles.input} value={licenceForm.legalName} onChangeText={value => setLicenceForm(f => ({ ...f, legalName: value }))} />
                  <Text style={[styles.inputLabel, { marginTop: 10 }]}>Ghana Card number</Text>
                  <TextInput placeholder={licence?.ghanaCardOnFile ? 'On file. Enter again to change' : 'GHA-123456789-0'} placeholderTextColor={colors.textMuted} style={styles.input} maxLength={20} value={licenceForm.ghanaCardNumber} autoCapitalize="characters" onChangeText={value => setLicenceForm(f => ({ ...f, ghanaCardNumber: value }))} />
                  {!bicycleRider && (
                    <>
                      <Text style={[styles.inputLabel, { marginTop: 10 }]}>Driver's licence number</Text>
                      <TextInput placeholderTextColor={colors.textMuted} style={styles.input} value={licenceForm.licenceNumber} autoCapitalize="characters" onChangeText={value => setLicenceForm(f => ({ ...f, licenceNumber: value }))} />
                      <Text style={[styles.inputLabel, { marginTop: 10 }]}>Licence class</Text>
                      <TextInput placeholderTextColor={colors.textMuted} style={styles.input} value={licenceForm.licenceClass} autoCapitalize="characters" onChangeText={value => setLicenceForm(f => ({ ...f, licenceClass: value }))} />
                    </>
                  )}
                  <Text style={[styles.inputLabel, { marginTop: 10 }]}>{bicycleRider ? 'Ghana Card expiry date' : 'Licence expiry date'} (year-month-day, like 2028-06-30)</Text>
                  <TextInput placeholderTextColor={colors.textMuted} style={styles.input} value={licenceForm.expiresOn} onChangeText={value => setLicenceForm(f => ({ ...f, expiresOn: value }))} />
                  {!bicycleRider && (
                    <>
                      <Text style={[styles.inputLabel, { marginTop: 10 }]}>Number plate, exactly as on the vehicle</Text>
                      <TextInput placeholder="M-22-GR 1234" placeholderTextColor={colors.textMuted} style={styles.input} value={licenceForm.vehiclePlate} autoCapitalize="characters" onChangeText={value => setLicenceForm(f => ({ ...f, vehiclePlate: value }))} />
                    </>
                  )}
                  {licence && licence.status !== 'missing' && licence.identityAvailable && (
                    <Text style={[styles.momoSub, { marginTop: 10 }]}>
                      Photo check: {licence.identityStatus === 'approved' ? 'passed'
                        : licence.identityStatus === 'in_progress' ? 'in progress'
                          : licence.identityStatus === 'failed' ? `failed. ${licence.identityReason || ''}` : 'not started'}
                    </Text>
                  )}
                  {licence && licence.status !== 'missing' && licence.identityAvailable && licence.identityStatus !== 'approved' && (
                    <TouchableOpacity disabled={busy} onPress={() => execute(startIdentityPhotos)} style={[styles.primaryBtn, { marginTop: 10 }]}>
                      <Text style={styles.primaryBtnText}>Take Licence Photo and Selfie</Text>
                    </TouchableOpacity>
                  )}
                  {documentList}
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
                    <TouchableOpacity onPress={() => setLicenceModal(false)} style={[styles.secondaryBtn, { flex: 1 }]}>
                      <Text style={styles.secondaryBtnText}>Close</Text>
                    </TouchableOpacity>
                    <TouchableOpacity disabled={busy} onPress={() => execute(submitLicence)} style={[styles.primaryBtn, { flex: 2 }]}>
                      <Text style={styles.primaryBtnText}>Save Details</Text>
                    </TouchableOpacity>
                  </View>
                </View>
                )}
              </ScrollView>
            </Modal>
  );

  if (auth?.kind === 'rider' && auth.awaitingApproval) {
    return (
      <View style={styles.screen}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <ScrollView contentContainerStyle={styles.authScroll}>
          <View style={styles.authHeader}>
            <BrandRow tagline="ACCOUNT UNDER REVIEW" />
            <Text style={styles.authSubtitle}>Add your Ghana Card, licence and photos. Your jobs screen opens automatically once you are approved. Riding for a company? Ask them to invite your phone number, then accept below.</Text>
          </View>
          <View style={styles.authCard}>
            {!!error && <Text style={styles.errorText}>⚠️ {error}</Text>}
            <CompanyInvitations onChange={() => execute(openLicenceAndDocuments)} />
            <TouchableOpacity accessibilityRole="button" style={styles.primaryBtn} disabled={busy} onPress={() => execute(openLicenceAndDocuments)}>
              <Text style={styles.primaryBtnText}>My Profile & Documents</Text>
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" onPress={() => execute(logout)} style={styles.switchAuthBtn}>
              <Text style={styles.switchAuthText}>Sign Out</Text>
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" style={styles.switchAuthBtn} onPress={() => setDeleteAccountOpen(true)}>
              <Text style={[styles.switchAuthText, { color: '#FCA5A5' }]}>Delete Account</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
        {licenceDocumentsModal}
        <DeleteAccountModal visible={deleteAccountOpen} onClose={() => setDeleteAccountOpen(false)} onDeleted={finishAccountDeletion} />
      </View>
    );
  }

  if (auth?.kind === 'company') {
    return (
      <View style={styles.screen}>
        <StatusBar barStyle="dark-content" backgroundColor="#F8FAFC" />
        <CompanyHome onSignOut={() => execute(logout)} onDeleteAccount={() => setDeleteAccountOpen(true)} />
        <DeleteAccountModal visible={deleteAccountOpen} onClose={() => setDeleteAccountOpen(false)} onDeleted={finishAccountDeletion} />
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
            <Text style={styles.headerTitle}>Rider</Text>
            <Text style={styles.headerSubtitle}>{auth.phone} • {vehicle?.vehicle || 'motorcycLE'}</Text>
          </View>
        </View>

        {offlineCopy && <View style={{padding:16}}>
          <Text style={styles.offlineText}>Saved jobs (view only), {offlineCopy.cachedAt}</Text>
          {offlineCopy.stops.map((stop,index)=><Text key={index} style={styles.offlineText}>{stop.kind}: {stop.shipmentId}</Text>)}
          {offlineCopy.shipments.map(job=><Text key={job.id} style={styles.offlineText}>{job.details?.pickup} → {job.details?.destination}</Text>)}
        </View>}
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
            🗺️ Route
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setTab('Earnings')}
          style={[styles.tabItem, tab === 'Earnings' && styles.tabItemActive]}>
          <Text style={[styles.tabText, tab === 'Earnings' && styles.tabTextActive]}>
            💰 Wallet
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
            <CompanyInvitations />
            <TouchableOpacity
              accessibilityRole="switch"
              accessibilityState={{ checked: Boolean(manifest?.optedIn) }}
              disabled={busy}
              onPress={() => execute(async () => {
                await call('POST', '/api/v1/rider/multi-stop', { enabled: !manifest?.optedIn });
                setManifest(await call('GET', '/api/v1/rider/manifest'));
              })}
              style={styles.carryToggle}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.carryToggleTitle}>Carry parcels going my way</Text>
                <Text style={styles.carryToggleSub}>Extra parcels only on your route. Each one earns its own pay.</Text>
              </View>
              <View style={[styles.carryTogglePill, manifest?.optedIn && styles.carryTogglePillOn]}>
                <Text style={[styles.carryToggleState, manifest?.optedIn && styles.carryToggleStateOn]}>{manifest?.optedIn ? 'On' : 'Off'}</Text>
              </View>
            </TouchableOpacity>
            {online && shifts && shifts.background === false && (
              <View style={styles.motionWarningBanner}>
                <Text style={styles.motionWarningTitle}>⚠️ Battery saver may stop your offers</Text>
                <Text style={styles.motionWarningSub}>
                  Allow "All the time" location and disable Battery Saver for ELESEND Rider so offers and GPS alerts continue when your screen is off ({shifts.reason || 'background permission required'}).
                </Text>
              </View>
            )}

            {!isStationary(speed) && (
              <View style={styles.motionWarningBanner}>
                <Text style={styles.motionWarningTitle}>⚠️ You are moving</Text>
                <Text style={styles.motionWarningSub}>
                  Speed exceeds 9 km/h. For your safety, stop safely roadside before accepting delivery jobs.
                </Text>
              </View>
            )}

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
                    <Text style={styles.earningsPillText}>Earn {ghc(o.entitlement_minor ?? o.amount_minor)}</Text>
                  </View>
                  <Text style={styles.offerDistance}>{Math.round(((o.pickupRoadMeters ?? o.distance_m) || 0) / 100) / 10} km</Text>
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

                <Text style={styles.offerPackageInfo}>📦 {o.description || 'Standard Package'} • {o.vehicle || vehicle?.vehicle || 'motorcycle'}</Text>

                <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`Decline offer for ${o.description || 'Package'}`}
                    onPress={() => execute(() => declineOffer(o))}
                    style={[styles.secondaryBtn, { flex: 1, minHeight: 56 }]}>
                    <Text style={styles.secondaryBtnText}>Decline</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`Accept job for ${o.description || 'Package'} earning ${ghc(o.entitlement_minor ?? o.amount_minor)}`}
                    onPress={() => execute(() => acceptOffer(o))}
                    style={[styles.primaryBtn, { flex: 2, minHeight: 56 }, !isStationary(speed) && { opacity: 0.6 }]}
                    disabled={!isStationary(speed)}>
                    <Text style={styles.primaryBtnText}>{isStationary(speed) ? 'Accept Job ⚡' : 'Stop to Accept 🛑'}</Text>
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
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <EmergencyButton shipmentId={manifest?.shipments?.[0]?.id} />
            <ShareLiveLocation shipmentId={manifest?.shipments?.[0]?.id} />
          </View>
        )}
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
                        <Text style={styles.stageBadgeText}>{riderStatus(s.state)}</Text>
                      </View>
                    </View>

                    <Text style={styles.manifestPaymentType}>
                      Payment: {s.payment_method === 'CASH' ? '💵 Cash on Delivery' : '📱 Paid Digitally'}
                    </Text>

                    <Text style={styles.manifestPackageInfo}>
                      📦 {s.description || 'Standard Package'}
                    </Text>

                    {Boolean(s.pickup?.address) && (
                      <Text style={styles.manifestRoutePoint}>
                        🟢 Pickup: {s.pickup.address}
                      </Text>
                    )}
                    {Boolean(s.destination?.address) && (
                      <Text style={styles.manifestRoutePoint}>
                        🏁 Dropoff: {s.destination.address}
                      </Text>
                    )}

                    {/* Turn-by-Turn GPS Button */}
                    <TouchableOpacity
                      onPress={() => {
                        const toPickup = s.state === 'RIDER_ASSIGNED' || s.state === 'RETURN_REQUESTED';
                        const target = toPickup ? s.pickup : s.destination;
                        if (target) setNavigating({ shipmentId: s.id, target, label: s.state === 'RETURN_REQUESTED' ? 'the sender' : toPickup ? 'pickup' : 'dropoff' });
                      }}
                      style={styles.navButton}>
                      <Text style={styles.navButtonText}>📍 Start navigation</Text>
                    </TouchableOpacity>

                    {/* Order-Scoped Chat Buttons (Customer & Kitchen) */}
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel="Chat with Customer"
                        onPress={() => execute(() => openRiderOrderChat({ conversationType: 'CUSTOMER_RIDER', shipmentId: s.id, foodOrderId: s.food_order_id }))}
                        style={[styles.secondaryBtn, { flex: 1, minHeight: 46, borderColor: colors.primary }]}>
                        <Text style={[styles.secondaryBtnText, { color: colors.primary }]}>💬 Chat Customer</Text>
                      </TouchableOpacity>
                      {Boolean(s.food_order_id || s.restaurant_id) && (
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel="Chat with Restaurant Kitchen"
                          onPress={() => execute(() => openRiderOrderChat({ conversationType: 'RIDER_RESTAURANT', shipmentId: s.id, foodOrderId: s.food_order_id }))}
                          style={[styles.secondaryBtn, { flex: 1, minHeight: 46 }]}>
                          <Text style={styles.secondaryBtnText}>🍲 Chat Kitchen</Text>
                        </TouchableOpacity>
                      )}
                    </View>

                    {/* Verification & Handover Action Buttons */}
                    {s.state === 'RIDER_ASSIGNED' && (
                      <View>
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel="Confirm pickup"
                          onPress={() => execute(() => initiatePickupVerification(s))}
                          style={[styles.primaryBtn, { marginTop: 10, minHeight: 56 }]}>
                          <Text style={styles.primaryBtnText}>Confirm pickup</Text>
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
                        {/* Call Customer for Unclear Entrance / Unmapped Road (Phase 5) */}
                        <View style={{ flexDirection: 'row', gap: 8, marginVertical: 8 }}>
                          <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel="Call Customer for Directions"
                            onPress={() => {
                              const phone = s.recipient_phone || s.customer_phone;
                              if (phone) Linking.openURL(`tel:${phone}`).catch(() => Alert.alert('Call Failed', `Direct phone: ${phone}`));
                              else Alert.alert('Customer Phone', 'Phone number unavailable for this shipment.');
                            }}
                            style={[styles.secondaryBtn, { flex: 1, borderColor: colors.primary, minHeight: 48, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 }]}>
                            <Text style={{ fontSize: 16 }}>📞</Text>
                            <Text style={[styles.secondaryBtnText, { color: colors.primary }]}>Call Customer</Text>
                          </TouchableOpacity>

                          <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel="Help Improve ELESEND Map"
                            onPress={() => { setMapReportNotes(''); setMapReportShipment(s.id); }}
                            style={[styles.secondaryBtn, { flex: 1, minHeight: 48, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 }]}>
                            <Text style={{ fontSize: 16 }}>🗺️</Text>
                            <Text style={styles.secondaryBtnText}>Improve Map</Text>
                          </TouchableOpacity>
                        </View>
                        {s.payment_method === 'CASH' && !reportedCash[s.id] && (
                          <View style={styles.codWarningBanner}>
                            <Text style={styles.codWarningTitle}>⚠️ CASH ON DELIVERY REQUIRED</Text>
                            <Text style={styles.codWarningSub}>
                              Collect {ghc(s.amount_minor)} in cash from the recipient BEFORE confirming delivery. Do not release the parcel without full cash.
                            </Text>
                          </View>
                        )}
                        {s.state === 'PICKUP_VERIFIED' && (
                          <TouchableOpacity
                            accessibilityRole="button"
                            onPress={() => execute(() => transitionShipment(s.id, 'start'))}
                            style={[styles.secondaryBtn, { marginTop: 10, minHeight: 56 }]}>
                            <Text style={styles.secondaryBtnText}>Start Delivery Transit</Text>
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel="Confirm physical handover"
                          onPress={() => execute(() => initiateDeliveryVerification(s))}
                          style={[styles.primaryBtn, { marginTop: 10, minHeight: 56 }]}>
                          <Text style={styles.primaryBtnText}>
                            {s.payment_method === 'CASH' && !reportedCash[s.id]
                              ? `Collect ${ghc(s.amount_minor)} cash, then confirm`
                              : "Confirm Delivery"}
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
                        onPress={() => execute(() => initiateReturnVerification(s))}
                        style={[styles.primaryBtn, { marginTop: 10 }]}>
                        <Text style={styles.primaryBtnText}>Return Review Instructions</Text>
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

            {/* Rider map issue report modal */}
            <Modal visible={Boolean(mapReportShipment)} animationType="fade" transparent onRequestClose={() => setMapReportShipment(null)}>
              <View style={styles.otpCard}>
                <Text style={styles.otpCardTitle}>Report a missing road</Text>
                <Text>Stop safely and describe the issue. Reports require review before map publication.</Text>
                <TextInput accessibilityLabel="Map report description" value={mapReportNotes} onChangeText={setMapReportNotes} placeholder="Describe the missing road" multiline />
                <TouchableOpacity accessibilityRole="button" onPress={() => execute(async () => {
                  if (!isStationary(speed)) throw Error('Stop safely before reporting a map issue');
                  if (mapReportNotes.trim().length < 10) throw Error('Describe the issue in at least 10 characters');
                  const permission=await Location.requestForegroundPermissionsAsync();
                  if (permission.status !== 'granted') throw Error('Location permission is required for a map report');
                  const position=await Location.getCurrentPositionAsync({accuracy:Location.Accuracy.High});
                  await call('POST','/api/v1/rider/map-report',{shipmentId:mapReportShipment,reportType:'missing_road',latitude:position.coords.latitude,longitude:position.coords.longitude,notes:mapReportNotes.trim(),currentSpeedMps:Math.max(0,position.coords.speed ?? speed ?? 0)});
                  setMapReportShipment(null);
                  Alert.alert('Report received','Your observation is awaiting geographic review.');
                })}><Text>Submit for review</Text></TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" onPress={() => setMapReportShipment(null)}><Text>Cancel</Text></TouchableOpacity>
              </View>
            </Modal>
            {/* Rider Order-Scoped Real-Time Chat Modal */}
            <Modal visible={riderChatModal} animationType="slide" onRequestClose={() => setRiderChatModal(false)}>
              <View style={[styles.screen, { paddingTop: 48, paddingHorizontal: 16, paddingBottom: 16 }]}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.cardBorder }}>
                  <View>
                    <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>
                      💬 {riderChatConv?.conversationType || 'Order Chat'}
                    </Text>
                    <Text style={{ fontSize: 11, color: colors.textMuted }}>
                      Assignment Epoch #{riderChatConv?.assignmentEpoch || 1} • {riderChatConv?.state || 'ACTIVE'}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity
                      onPress={() => reportRiderChatAbuse('harassment')}
                      style={{ backgroundColor: '#450A0A', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 }}>
                      <Text style={{ color: '#FCA5A5', fontSize: 11, fontWeight: '700' }}>🚩 Report</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setRiderChatModal(false)}
                      style={{ backgroundColor: colors.card, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 }}>
                      <Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>✕ Close</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <ScrollView style={{ flex: 1, marginVertical: 12 }}>
                  {riderChatMessages.map(msg => {
                    const isMine = msg.senderRole === 'rider';
                    return (
                      <View
                        key={msg.id}
                        style={{
                          alignSelf: isMine ? 'flex-end' : 'flex-start',
                          backgroundColor: isMine ? colors.primaryDark : colors.surface,
                          borderRadius: 10,
                          padding: 10,
                          marginBottom: 8,
                          maxWidth: '84%',
                          borderWidth: 1,
                          borderColor: isMine ? colors.primary : colors.cardBorder
                        }}>
                        <Text style={{ fontSize: 10, color: colors.textMuted, fontWeight: '700' }}>
                          {String(msg.senderRole || '').toUpperCase()} • #{msg.seq}
                        </Text>
                        {msg.messageType === 'voice_note' ? <VoiceNoteBubble message={msg} color={colors.text} /> : (
                        <Text style={{ fontSize: 13, color: colors.text, marginTop: 2 }}>
                          {msg.body || msg.bodyText || (msg.messageType === 'location_pin' ? `📍 Pin: ${msg.locationPin?.label || ''}` : '')}
                        </Text>
                        )}
                        <Text style={{ fontSize: 10, color: colors.textMuted, marginTop: 4, textAlign: 'right' }}>
                          {msg.deliveryStatus || 'SENT'}
                        </Text>
                      </View>
                    );
                  })}
                </ScrollView>

                {/* Stationary-Safe Large Quick-Reply Buttons */}
                <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 6 }}>
                  ⚡ One-Tap Safe Courier Replies:
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 44, marginBottom: 10 }}>
                  {[
                    { key: 'rider_on_my_way', label: "I'm on my way." },
                    { key: 'rider_arrived_pickup', label: "I've arrived at the pickup point." },
                    { key: 'rider_confirm_entrance', label: 'Please confirm the entrance.' },
                    { key: 'rider_traffic_delay', label: 'There is a delay due to traffic.' },
                    { key: 'rider_waiting_gate', label: "I'm waiting at the gate." }
                  ].map(preset => (
                    <TouchableOpacity
                      key={preset.key}
                      onPress={() => sendRiderChatMessage({ messageType: 'quick_reply', quickReplyKey: preset.key, bodyText: preset.label })}
                      style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.primary, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, marginRight: 8 }}>
                      <Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>{preset.label}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput
                    style={[{ minWidth: 0 }, styles.input, { flex: 1 }]}
                    editable={isStationary(speed)}
                    placeholder={isStationary(speed) ? 'Type message (when stationary)...' : 'Stop moving to type custom text'}
                    placeholderTextColor={colors.textMuted}
                    value={riderChatInput}
                    onChangeText={setRiderChatInput}
                  />
                  {riderChatConv?.conversationType === 'CUSTOMER_RIDER' && (
                    <VoiceNoteRecorder
                      conversationId={riderChatConv.id}
                      color={colors.text}
                      disabled={!isStationary(speed)}
                      disabledReason="Stop safely before recording a voice note."
                      onSent={message => setRiderChatMessages(prev => (prev.some(m => m.id === message.id) ? prev : [...prev, message]))}
                      onError={setError}
                    />
                  )}
                  <TouchableOpacity
                    disabled={!isStationary(speed)}
                    onPress={() => sendRiderChatMessage({ messageType: 'text', bodyText: riderChatInput })}
                    style={[styles.primaryBtn, { minHeight: 46, paddingHorizontal: 18 }, !isStationary(speed) && { opacity: 0.5 }]}>
                    <Text style={styles.primaryBtnText}>Send</Text>
                  </TouchableOpacity>
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
                <Text style={[styles.debtRowVal, { fontWeight: '800' }]}>{ghc(availableNow)}</Text>
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
                onPress={() => execute(openLicenceAndDocuments)}
                style={[styles.secondaryBtn, { marginTop: 12 }]}>
                <Text style={styles.secondaryBtnText}>Licence & Documents</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setWithdrawModal(true)}
                style={[styles.primaryBtn, { marginTop: 12 }]}>
                <Text style={styles.primaryBtnText}>Payout Account</Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={busy || !canWithdraw}
                onPress={() => setConfirmWithdraw(true)}
                style={[styles.primaryBtn, { marginTop: 8, opacity: canWithdraw ? 1 : 0.5 }]}>
                <Text style={styles.primaryBtnText}>
                  {canWithdraw
                    ? `Withdraw ${ghc(availableNow)}`
                    : availableNow > 0
                      ? `${ghc(withdrawalMin - availableNow)} more to withdraw`
                      : 'Nothing to withdraw yet'}
                </Text>
              </TouchableOpacity>
              {availableNow > withdrawalFee && availableNow < withdrawalMin && (
                <TouchableOpacity
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => { setFinalPayout(true); setConfirmWithdraw(true); }}
                  style={[styles.secondaryBtn, { marginTop: 8 }]}>
                  <Text style={styles.secondaryBtnText}>Closing your account? Withdraw {ghc(availableNow)}</Text>
                </TouchableOpacity>
              )}
              {canWithdraw && (
                <Text style={[styles.momoSub, { marginTop: 6 }]}>You receive {ghc(availableNow - withdrawalFee)} after the {ghc(withdrawalFee)} transfer fee.</Text>
              )}
              {financeSnapshot?.onHoldMinor > 0 && (
                <Text style={[styles.momoSub, { marginTop: 6 }]}>{ghc(financeSnapshot.onHoldMinor)} on hold from recent deliveries.</Text>
              )}
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
                  {networkPicker}

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
            {licenceDocumentsModal}

            <Modal visible={confirmWithdraw} animationType="fade" transparent>
              <View style={styles.modalOverlay}>
                <View style={styles.momoCard}>
                  <Text style={styles.momoTitle}>Withdraw {ghc(availableNow)}</Text>
                  <Text style={styles.momoSub}>You receive {ghc(availableNow - withdrawalFee)} on Mobile Money ({auth.phone}) after the {ghc(withdrawalFee)} transfer fee. Enter your password to confirm.</Text>
                  <TextInput
                    secureTextEntry
                    autoCapitalize="none"
                    placeholder="Password"
                    placeholderTextColor={colors.textMuted}
                    style={[styles.input, { marginTop: 12 }]}
                    value={withdrawPassword}
                    onChangeText={setWithdrawPassword}
                  />
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
                    <TouchableOpacity onPress={() => { setConfirmWithdraw(false); setWithdrawPassword(''); }} style={[styles.secondaryBtn, { flex: 1 }]}>
                      <Text style={styles.secondaryBtnText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity disabled={busy || !withdrawPassword} onPress={() => execute(requestWithdrawal)} style={[styles.primaryBtn, { flex: 2 }]}>
                      <Text style={styles.primaryBtnText}>Withdraw</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </Modal>

            <Modal visible={withdrawModal} animationType="fade" transparent>
              <View style={styles.modalOverlay}>
                <View style={styles.momoCard}>
                  <Text style={styles.momoTitle}>Payout Details</Text>
                  <Text style={styles.momoSub}>Payouts go to Mobile Money on your verified phone ({auth.phone}).</Text>

                  <Text style={[styles.inputLabel, { marginTop: 12 }]}>Select Network</Text>
                  {networkPicker}

                  <Text style={[styles.inputLabel, { marginTop: 12 }]}>Name on Mobile Money Account</Text>
                  <TextInput
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="words"
                    style={styles.input}
                    value={payoutName}
                    onChangeText={setPayoutName}
                  />

                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
                    <TouchableOpacity onPress={() => setWithdrawModal(false)} style={[styles.secondaryBtn, { flex: 1 }]}>
                      <Text style={styles.secondaryBtnText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => execute(submitWithdrawalRequest)} style={[styles.primaryBtn, { flex: 2 }]}>
                      <Text style={styles.primaryBtnText}>Save Payout Details</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </Modal>

            <TouchableOpacity onPress={() => execute(logout)} style={styles.switchAuthBtn} accessibilityRole="button">
              <Text style={styles.switchAuthText}>Sign Out</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setDeleteAccountOpen(true)} style={styles.switchAuthBtn} accessibilityRole="button">
              <Text style={[styles.switchAuthText, { color: '#FCA5A5' }]}>Delete Account</Text>
            </TouchableOpacity>
          </View>
        )}
        {tab === 'Earnings' && (
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <CompanyInvitations />
            <OfflineMapCard />
            <WithdrawalHistory refreshKey={`${financeSnapshot?.inPayoutMinor}:${availableNow}`} />
            <RatingPrompts />
            <RiderTools />
            <TrustedContactCard />
          </View>
        )}
      </ScrollView>
      <DeleteAccountModal
        visible={deleteAccountOpen}
        onClose={() => setDeleteAccountOpen(false)}
        onDeleted={finishAccountDeletion}
      />
      {navigating && <RiderNavigation key={navigating.shipmentId} {...navigating} onClose={() => setNavigating(null)} />}
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
  countryBadge: { flexShrink: 0, backgroundColor: colors.card, borderRadius: radii.md, borderWidth: 1, borderColor: colors.cardBorder, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  flag: { fontSize: 16 },
  countryCode: { color: colors.text, fontWeight: '600', fontSize: 14 },
  phoneInput: { flex: 1, minWidth: 0, backgroundColor: colors.card, borderRadius: radii.md, borderWidth: 1, borderColor: colors.cardBorder, padding: 12, color: colors.text, fontSize: 14 },
  vehicleRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  vehicleChoice: { flex: 1, backgroundColor: colors.card, borderRadius: radii.md, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: colors.cardBorder },
  vehicleChoiceActive: { borderColor: colors.primary, backgroundColor: colors.cardBorder },
  vehicleChoiceTitle: { fontSize: 13, fontWeight: '700', color: colors.text },
  vehicleChoiceSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  primaryBtn: { backgroundColor: colors.primary, borderRadius: radii.md, minHeight: 56, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  primaryBtnText: { color: colors.bg, fontSize: 15, fontWeight: '700' },
  carryToggle: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginTop: 12, marginBottom: 12, padding: 14, backgroundColor: colors.card, borderRadius: radii.md, borderWidth: 1, borderColor: colors.cardBorder },
  carryToggleTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  carryToggleSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  carryTogglePill: { minWidth: 48, alignItems: 'center', paddingVertical: 6, paddingHorizontal: 10, borderRadius: radii.full, borderWidth: 1, borderColor: colors.cardBorder },
  carryTogglePillOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  carryToggleState: { fontSize: 12, fontWeight: '700', color: colors.textMuted },
  carryToggleStateOn: { color: colors.bg },
  offlineText: { color: colors.text, fontSize: 13, marginTop: 6 },
  secondaryBtn: { backgroundColor: colors.card, borderRadius: radii.md, minHeight: 56, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.cardBorder },
  secondaryBtnText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  codWarningBanner: { backgroundColor: '#78350F', borderRadius: radii.md, padding: 12, marginTop: 10, borderWidth: 1, borderColor: '#F59E0B' },
  codWarningTitle: { color: '#FDE68A', fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },
  codWarningSub: { color: '#FEF3C7', fontSize: 12, marginTop: 2, lineHeight: 16 },
  motionWarningBanner: { backgroundColor: '#451A03', borderRadius: radii.md, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#D97706' },
  motionWarningTitle: { color: '#FCD34D', fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },
  motionWarningSub: { color: '#FEF3C7', fontSize: 12, marginTop: 2, lineHeight: 16 },
  manifestRoutePoint: { fontSize: 13, color: colors.text, marginTop: 6, lineHeight: 18 },
  manifestPackageInfo: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  modalCodAlert: { backgroundColor: '#451A03', borderRadius: radii.md, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: '#D97706' },
  modalCodAlertTitle: { color: '#FCD34D', fontSize: 12, fontWeight: '800' },
  modalCodAlertText: { color: '#FEF3C7', fontSize: 12, marginTop: 2 },
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
  modalScrollBody: { flexGrow: 1, justifyContent: 'center', padding: 20 },
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
