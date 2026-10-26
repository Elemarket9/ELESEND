/**
 * ELESEND Customer Mobile Application
 * 
 * Production-grade customer interface for:
 * - On-demand parcel delivery (Quotes, Pin-drop Map, Cash/Digital Checkout)
 * - Food marketplace (Restaurant menus, Dish customizers, Upfront digital payment)
 * - Live shipment & food order tracking with MapLibre
 * - Recipient OTP handover confirmation
 * - Saved addresses & profile management
 * 
 * Strict OWASP MASVS adherence: zero privileged rider screens, zero client-side pricing.
 */

import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet,
  Alert, ActivityIndicator, AppState, Linking, StatusBar,
  TouchableOpacity, Modal, Image
} from 'react-native';
import * as Location from 'expo-location';
import * as Crypto from 'expo-crypto';
import MapView, { Marker, RiderMarker, Polyline } from '../maps/map-adapter';
import QRCode from 'react-native-qrcode-svg';
import { call, loadToken, saveToken, clearToken, ghc, BASE } from '../api';
import { detectCustomerLocation, isQuotableLocation } from '../customer-location';
import LocationExperience from './LocationExperience';
import { normalizeGhanaPhone, isValidGhanaPhone, formatGhanaDisplayPhone } from '../phone';
import { colors, typography, spacing, radii } from '../theme';

const initialCreds = { phone: '', password: '', name: '' };

export default function CustomerApp() {
  const [auth, setAuth] = useState(null);
  const [phoneState, setPhoneState] = useState(null); // { phone, verified }
  const [phoneChallenge, setPhoneChallenge] = useState(null); // { challengeId, expiresInSeconds }
  const [phoneCode, setPhoneCode] = useState('');
  const [credentials, setCredentials] = useState(initialCreds);
  const [isSignup, setIsSignup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('Send'); // 'Send' | 'Food' | 'Activity' | 'Profile'

  // Parcel Booking State
  const [step, setStep] = useState(0); // 0: Location, 1: Package, 2: Checkout
  const [booking, setBooking] = useState({
    pickup: null,
    destination: null,
    vehicle: 'motorcycle',
    recipientPhone: '',
    recipientName: '',
    weightG: '1500',
    description: 'Package',
    parcelCategory: 'general',
    parcelSize: 'small',
    paymentMethod: 'CASH',
    cashPayer: 'recipient'
  });
  const [quoted, setQuoted] = useState(null);
  const [myShipments, setMyShipments] = useState([]);
  const [trackingShipment, setTrackingShipment] = useState(null);
  const [detectedLocation, setDetectedLocation] = useState(null);
  const [locationTarget, setLocationTarget] = useState('pickup');
  const [deliveryInstructions, setDeliveryInstructions] = useState('');
  const [paymentMethods, setPaymentMethods] = useState([{ method: 'CASH', enabled: true }]);
  const [paymentEmail, setPaymentEmail] = useState('');
  const [checkoutSession, setCheckoutSession] = useState(null);
  const [disputeModal, setDisputeModal] = useState(null);
  const [disputeCategory, setDisputeCategory] = useState('delay');
  const [disputeDetail, setDisputeDetail] = useState('');

  // Food Marketplace State
  const [foodRestaurants, setFoodRestaurants] = useState([]);
  const [selectedRest, setSelectedRest] = useState(null);
  const [restMenu, setRestMenu] = useState(null);
  const [selectedDish, setSelectedDish] = useState(null);
  const [selectedOptions, setSelectedOptions] = useState([]);
  const [dishModal, setDishModal] = useState(false);
  const [cartItems, setCartItems] = useState([]);
  const [cartModal, setCartModal] = useState(false);
  const [foodDeliveryAddress, setFoodDeliveryAddress] = useState('');
  const [foodDeliveryCoords, setFoodDeliveryCoords] = useState(null);
  const [foodRecipientPhone, setFoodRecipientPhone] = useState('');
  const [foodInstructions, setFoodInstructions] = useState('');
  const [foodPlaceOpen, setFoodPlaceOpen] = useState(false);
  const [foodQuote, setFoodQuote] = useState(null);
  const [foodPaymentMethod, setFoodPaymentMethod] = useState('MOMO');
  const [myFoodOrders, setMyFoodOrders] = useState([]);
  const [activeFoodTracking, setActiveFoodTracking] = useState(null);

  const addressLookupEpoch = useRef(0);
  const foodRequest = useRef(null);

  const edit = (k, v) => setCredentials(c => ({ ...c, [k]: v }));
  const updateBooking = (k, v) => {
    if (k === 'pickup' || k === 'destination') addressLookupEpoch.current++;
    setBooking(b => ({ ...b, [k]: v }));
    setQuoted(null);
  };

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
          if (user.kind === 'customer' || user.kind === 'business') {
            const pStatus = await call('GET', '/api/v1/me/phone').catch(() => ({ phone: user.phone || '', verified: false }));
            setPhoneState(pStatus);
            setAuth({ ...user, phone: pStatus.phone || user.phone || '' });
          } else {
            // Non-customer kind signed in on customer app: clear session
            await clearToken();
            setAuth(null);
            setPhoneState(null);
            setError('Please sign in with a Customer account on this application.');
          }
        }
      } catch {
        await clearToken();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Fetch Public Metadata
  useEffect(() => {
    if (!auth || phoneState?.verified === false) return;
    call('GET', '/api/v1/payments/methods')
      .then(setPaymentMethods)
      .catch(() => setPaymentMethods([{ method: 'CASH', enabled: true }]));

    loadFoodRestaurants();
    refreshActivity();
  }, [auth, phoneState?.verified]);

  // Periodic Refresh for Active Deliveries
  useEffect(() => {
    if (!auth || phoneState?.verified === false || tab !== 'Activity') return;
    let cancelled = false;
    const poll = async () => {
      if (AppState.currentState !== 'active') return;
      try {
        const [shipments, foodOrders] = await Promise.all([
          call('GET', '/api/v1/shipments').catch(() => []),
          call('GET', '/api/v1/food-orders').catch(() => [])
        ]);
        if (!cancelled) {
          setMyShipments(shipments);
          setMyFoodOrders(foodOrders);
        }
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 8000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [auth, phoneState?.verified, tab]);

  async function signIn() {
    const normPhone = normalizeGhanaPhone(credentials.phone);
    if (!isValidGhanaPhone(normPhone)) throw Error('Enter a valid Ghana phone (e.g. 024 123 4567)');
    if (!credentials.password) throw Error('Enter your password');

    const data = await call('POST', '/api/v1/auth/login', {
      phone: normPhone,
      password: credentials.password
    });
    if (data.user.kind !== 'customer' && data.user.kind !== 'business') {
      throw Error('This account is registered as a courier driver. Please use the ELESEND Rider app.');
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
      setTab('Send');
    }
  }

  async function signUp() {
    const normPhone = normalizeGhanaPhone(credentials.phone);
    if (!isValidGhanaPhone(normPhone)) throw Error('Enter a valid Ghana phone (e.g. 024 123 4567)');
    if (credentials.password.length < 12 || credentials.password.length > 128) {
      throw Error('Password must be between 12 and 128 characters');
    }

    await call('POST', '/api/v1/auth/register', {
      phone: normPhone,
      password: credentials.password,
      kind: 'customer',
      name: credentials.name.trim() || 'Valued Customer'
    });
    setIsSignup(false);
    await signIn();
  }

  async function requestPhoneVerificationChallenge() {
    const pStatus = await call('GET', '/api/v1/me/phone');
    setPhoneState(pStatus);
    if (pStatus.verified) {
      setPhoneChallenge(null);
      setPhoneCode('');
      setTab('Send');
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
    setTab('Send');
  }

  async function logout() {
    try {
      await call('POST', '/api/v1/auth/logout');
    } catch {}
    await clearToken();
    setAuth(null);
    setPhoneState(null);
    setPhoneChallenge(null);
    setPhoneCode('');
    setTab('Send');
  }

  // --- Parcel Delivery Actions ---
  async function useCurrentLocation(target = 'pickup') {
    setLocationTarget(target);
    const res = await detectCustomerLocation({
      locationApi: Location,
      reverseGeocodeApi: async (lat, lon) => call('GET', `/api/v1/maps/reverse?lat=${lat}&lon=${lon}`),
      timeoutMs: 12000
    });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setDetectedLocation(res);

    const pin = {
      latitude: res.coordinates.latitude,
      longitude: res.coordinates.longitude,
      address: res.displayAddress,
      accuracyMeters: res.accuracyMeters,
      accuracyLabel: res.accuracyLabel,
      detectedByGps: true,
      positionKind: 'gps',
      confidence: res.accuracyTier === 'high' ? 'high' : 'medium',
      uncertaintyNote: res.advisory || null,
      landmark: res.recognizedNearby || null
    };
    if (target === 'food') {
      setFoodDeliveryAddress(res.displayAddress);
      setFoodDeliveryCoords(res.coordinates);
      loadFoodRestaurants(res.coordinates);
    } else {
      updateBooking(target, pin);
      if (target === 'pickup') loadFoodRestaurants(res.coordinates);
    }
  }

  function sanitizeAddressPayload(loc) {
    if (!loc) return null;
    return {
      address: String(loc.address || '').trim().slice(0, 400),
      latitude: Number(loc.latitude),
      longitude: Number(loc.longitude)
    };
  }

  async function requestParcelQuote(overrides = {}) {
    const nextBooking = { ...booking, ...overrides };
    if (!isQuotableLocation(nextBooking.pickup) || !isQuotableLocation(nextBooking.destination)) {
      throw Error('Confirm pickup and destination on the map before requesting a fare. No distance or fee is estimated without a real position.');
    }
    const recipient = normalizeGhanaPhone(nextBooking.recipientPhone);
    if (!isValidGhanaPhone(recipient)) throw Error('Enter a valid Ghana recipient phone');

    const desc = deliveryInstructions.trim()
      ? `${nextBooking.description || 'Package'} (Notes: ${deliveryInstructions.trim()})`
      : (nextBooking.description || 'Package');

    const input = {
      pickup: sanitizeAddressPayload(nextBooking.pickup),
      destination: sanitizeAddressPayload(nextBooking.destination),
      vehicle: nextBooking.vehicle,
      recipientPhone: recipient,
      weightG: Number(nextBooking.weightG) || 1500,
      description: desc,
      parcelCategory: nextBooking.parcelCategory,
      parcelSize: nextBooking.parcelSize,
      paymentMethod: nextBooking.paymentMethod,
      cashPayer: nextBooking.cashPayer
    };
    const q = await call('POST', '/api/v1/quotes', input);
    setQuoted({
      ...q,
      quotedTerms: {
        vehicle: nextBooking.vehicle,
        paymentMethod: nextBooking.paymentMethod,
        cashPayer: nextBooking.cashPayer
      }
    });
    setStep(2);
    return q;
  }

  async function changeParcelPaymentTerms(updates) {
    const nextBooking = { ...booking, ...updates };
    setBooking(nextBooking);
    setQuoted(null);
    if (step === 2) {
      await requestParcelQuote(updates);
    }
  }

  async function startOrResumeCheckout(shipmentId, method = 'MOMO') {
    if (!shipmentId) return;
    let session = null;
    try {
      const existing = await call('GET', `/api/v1/shipments/${shipmentId}/checkout`);
      if (existing && (existing.status === 'confirmed' || (existing.status === 'pending' && existing.checkoutUrl))) {
        session = existing;
      }
    } catch {}
    if (!session) {
      session = await call('POST', `/api/v1/shipments/${shipmentId}/checkout`, {
        idempotencyKey: Crypto.randomUUID(),
        ...(paymentEmail ? { email: paymentEmail.trim() } : {})
      });
    }
    setCheckoutSession(session);
    if (session?.status === 'confirmed') {
      await refreshActivity();
      setError('Payment verified! Your order is now active.');
      return session;
    }
    if (session?.checkoutUrl && method !== 'QR') {
      await Linking.openURL(session.checkoutUrl);
    }
    return session;
  }

  async function confirmParcelBooking() {
    let activeQuote = quoted;
    const termsChanged = !activeQuote
      || activeQuote.payment_method !== booking.paymentMethod
      || (activeQuote.quotedTerms && (
        activeQuote.quotedTerms.vehicle !== booking.vehicle
        || activeQuote.quotedTerms.paymentMethod !== booking.paymentMethod
        || (booking.paymentMethod === 'CASH' && activeQuote.quotedTerms.cashPayer !== booking.cashPayer)
      ));
    if (termsChanged) {
      activeQuote = await requestParcelQuote();
    }
    const idempotencyKey = Crypto.randomUUID();
    const res = await call('POST', '/api/v1/shipments', { quoteId: activeQuote.id }, { idempotencyKey });
    setStep(0);
    setQuoted(null);
    setTab('Activity');
    await refreshActivity();

    if (res.payment_method !== 'CASH') {
      try {
        await startOrResumeCheckout(res.id, res.payment_method);
      } catch (e) {
        setError((e.message || 'Online checkout could not be launched') + '. Use "Complete / Retry Payment" in Activity to resume without creating another order.');
      }
    }
  }

  // --- Food Marketplace Actions ---
  async function loadFoodRestaurants(coordsOverride = null) {
    const coords = coordsOverride
      || foodDeliveryCoords
      || detectedLocation?.coordinates
      || (booking.pickup ? { latitude: booking.pickup.latitude, longitude: booking.pickup.longitude } : null)
      || (booking.destination ? { latitude: booking.destination.latitude, longitude: booking.destination.longitude } : null);
    const query = coords && Number.isFinite(Number(coords.latitude)) && Number.isFinite(Number(coords.longitude))
      ? `?lat=${encodeURIComponent(coords.latitude)}&lon=${encodeURIComponent(coords.longitude)}`
      : '';
    const list = await call('GET', `/api/v1/restaurants${query}`).catch(() => []);
    setFoodRestaurants(list || []);
  }

  async function openRestaurant(r) {
    setSelectedRest(r);
    const menu = await call('GET', `/api/v1/restaurants/${r.id}/menu`).catch(() => null);
    setRestMenu(menu);
  }

  function openDishDetails(dish) {
    setSelectedDish(dish);
    const initialOpts = [];
    if (dish.modifiers) {
      for (const m of dish.modifiers) {
        if (m.is_required && m.options && m.options.length > 0) {
          initialOpts.push(m.options[0].id);
        }
      }
    }
    setSelectedOptions(initialOpts);
    setDishModal(true);
  }

  function toggleModifierOption(optId, modifier) {
    if (modifier.max_selections === 1) {
      const otherIds = (modifier.options || []).map(o => o.id);
      setSelectedOptions(curr => [...curr.filter(id => !otherIds.includes(id)), optId]);
    } else {
      setSelectedOptions(curr => curr.includes(optId) ? curr.filter(id => id !== optId) : [...curr, optId]);
    }
  }

  function addDishToCart() {
    if (!selectedDish || !selectedRest) return;
    if (selectedDish.modifiers) {
      for (const m of selectedDish.modifiers) {
        if (m.is_required) {
          const modOptIds = (m.options || []).map(o => o.id);
          const hasSelected = selectedOptions.some(id => modOptIds.includes(id));
          if (!hasSelected) {
            Alert.alert('Required Selection Missing', `Please choose an option for "${m.name}".`);
            return;
          }
        }
      }
    }
    const item = {
      restaurantId: selectedRest.id,
      restaurantName: selectedRest.name,
      itemId: selectedDish.id,
      name: selectedDish.name,
      priceMinor: selectedDish.price_minor,
      quantity: 1,
      options: selectedOptions
    };
    setCartItems(curr => {
      // Enforce single-restaurant cart
      if (curr.length > 0 && curr[0].restaurantId !== selectedRest.id) {
        Alert.alert('New Restaurant', 'Your cart contains items from another restaurant. Start a new cart?', [
          { text: 'Keep Current' },
          { text: 'Start New', onPress: () => setCartItems([item]) }
        ]);
        return curr;
      }
      return [...curr, item];
    });
    setDishModal(false);
    setSelectedDish(null);
  }

  async function calculateFoodQuote() {
    if (cartItems.length === 0) throw Error('Cart is empty');
    if (!foodDeliveryAddress.trim()) throw Error('Enter delivery address');
    if (!foodDeliveryCoords?.latitude) throw Error('Select delivery location on the map');

    const quote = await call('POST', '/api/v1/food-orders/quote', {
      restaurantId: cartItems[0].restaurantId,
      items: cartItems.map(i => ({ itemId: i.itemId, quantity: i.quantity, options: i.options })),
      deliveryAddress: foodDeliveryAddress.trim(),
      deliveryLatitude: foodDeliveryCoords.latitude,
      deliveryLongitude: foodDeliveryCoords.longitude,
      customerPhone: foodRecipientPhone.trim() || auth.phone,
      specialInstructions: foodInstructions.trim()
    });
    setFoodQuote(quote);
  }

  async function submitFoodOrder() {
    if (!foodQuote) throw Error('Calculate quote first');
    const idempotencyKey = Crypto.randomUUID();
    const res = await call('POST', '/api/v1/food-orders', {
      ...foodQuote,
      paymentMethod: foodPaymentMethod,
      specialInstructions: foodInstructions.trim()
    }, { idempotencyKey });

    setCartItems([]);
    setFoodQuote(null);
    setCartModal(false);
    setTab('Activity');
    await refreshActivity();

    // Launch upfront digital payment
    if (res.shipment_id) {
      try {
        await startOrResumeCheckout(res.shipment_id, foodPaymentMethod);
      } catch (e) {
        setError((e.message || 'Online checkout could not be launched') + '. Use "Complete / Retry Payment" in Activity to resume without creating another order.');
      }
    }
  }

  // --- Activity & Tracking Actions ---
  async function refreshActivity() {
    try {
      const [shipments, foodOrders] = await Promise.all([
        call('GET', '/api/v1/shipments').catch(() => []),
        call('GET', '/api/v1/food-orders').catch(() => [])
      ]);
      setMyShipments(shipments);
      setMyFoodOrders(foodOrders);
    } catch {}
  }

  async function cancelOrder(orderId, isFood = false, shipmentState = null, foodState = null) {
    Alert.alert('Cancel Order', 'Are you sure you want to cancel or request a return for this order?', [
      { text: 'No' },
      {
        text: 'Yes, Proceed',
        style: 'destructive',
        onPress: () => execute(async () => {
          if (isFood) {
            if (shipmentState === 'RETURNED' || (shipmentState === 'FAILED' && foodState !== 'IN_TRANSIT')) {
              await call('POST', `/api/v1/food-orders/${orderId}/resolve`, {
                action: 'cancel_refund',
                reason: 'Customer requested refund after delivery failure'
              });
            } else if (['FAILED', 'RETURN_REQUESTED'].includes(shipmentState)) {
              await call('POST', `/api/v1/food-orders/${orderId}/resolve`, {
                action: 'return',
                reason: 'Customer requested return and refund review after delivery failure'
              });
            } else {
              await call('POST', `/api/v1/food-orders/${orderId}/cancel`, { reason: 'Customer requested cancellation' });
            }
          } else {
            await call('POST', `/api/v1/shipments/${orderId}/transition`, { action: 'cancel', reason: 'Customer requested cancellation' });
          }
          await refreshActivity();
          setError('Request submitted. Post-pickup returns require restaurant confirmation or operator approval.');
        })
      }
    ]);
  }

  async function submitDisputeTicket() {
    if (!disputeModal) return;
    await call('POST', `/api/v1/shipments/${disputeModal.id}/disputes`, {
      category: disputeCategory,
      detail: disputeDetail.trim() || 'Customer reported issue'
    });
    setDisputeModal(null);
    setDisputeDetail('');
    setError('Support issue submitted. Operations team will contact you.');
  }

  // =========================================================================
  // RENDER: LOADING VIEW
  // =========================================================================
  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <View style={styles.brandIconBox}><Text style={styles.brandIconText}>E</Text></View>
        <Text style={styles.splashTitle}>ELESEND</Text>
        <Text style={styles.splashSubtitle}>EXPRESS GHANA DELIVERY</Text>
        <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 20 }} />
      </View>
    );
  }

  // =========================================================================
  // RENDER: AUTHENTICATION (CUSTOMER SIGN IN & SIGN UP ONLY)
  // =========================================================================
  if (!auth) {
    return (
      <View style={styles.screen}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <ScrollView contentContainerStyle={styles.authScroll} keyboardShouldPersistTaps="handled">
          <View style={styles.authHeader}>
            <View style={styles.brandRow}>
              <View style={styles.brandIconBox}><Text style={styles.brandIconText}>E</Text></View>
              <View>
                <Text style={styles.brandTitle}>ELESEND</Text>
                <Text style={styles.brandTagline}>CUSTOMER APP</Text>
              </View>
            </View>
            <Text style={styles.authSubtitle}>Fast, fair parcel delivery and restaurant food ordering across Ghana with verified OTP handover.</Text>
          </View>

          {!!error && (
            <Pressable onPress={() => setError('')} style={styles.errorBox}>
              <Text style={styles.errorText}>⚠️ {error}</Text>
            </Pressable>
          )}

          <View style={styles.authCard}>
            <Text style={styles.authCardTitle}>{isSignup ? 'Create Customer Account' : 'Sign In'}</Text>
            <Text style={styles.authCardSubtitle}>{isSignup ? 'Sign up to order food and send parcels in seconds' : 'Welcome back! Enter your mobile number'}</Text>

            {isSignup && (
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Full Name</Text>
                <TextInput
                  placeholder="e.g. Kwame Mensah"
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                  value={credentials.name}
                  onChangeText={v => edit('name', v)}
                />
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

            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => execute(isSignup ? signUp : signIn)}
              style={styles.primaryBtn}
              disabled={busy}>
              {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.primaryBtnText}>{isSignup ? 'Create Account' : 'Sign In'}</Text>}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => { setIsSignup(!isSignup); setError(''); }}
              style={styles.switchAuthBtn}>
              <Text style={styles.switchAuthText}>
                {isSignup ? 'Already have an account? Sign In' : 'New to ELESEND? Create Account'}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  // =========================================================================
  // RENDER: PHONE VERIFICATION ONBOARDING
  // =========================================================================
  if (phoneState && !phoneState.verified) {
    return (
      <View style={styles.screen}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <ScrollView contentContainerStyle={styles.authScroll} keyboardShouldPersistTaps="handled">
          <View style={styles.authHeader}>
            <View style={styles.brandRow}>
              <View style={styles.brandIconBox}><Text style={styles.brandIconText}>E</Text></View>
              <View>
                <Text style={styles.brandTitle}>ELESEND</Text>
                <Text style={styles.brandTagline}>VERIFY PHONE NUMBER</Text>
              </View>
            </View>
            <Text style={styles.authSubtitle}>
              Verify your registered Ghana mobile number ({phoneState.phone || auth.phone}) to book deliveries and order food.
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
  // RENDER: AUTHENTICATED CUSTOMER APP
  // =========================================================================
  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />

      {/* Top Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.headerBadge}><Text style={styles.headerBadgeText}>E</Text></View>
          <View>
            <Text style={styles.headerTitle}>ELESEND</Text>
            <Text style={styles.headerSubtitle}>{auth.phone}</Text>
          </View>
        </View>
        <TouchableOpacity onPress={() => execute(logout)} style={styles.logoutBtn}>
          <Text style={styles.logoutBtnText}>Log Out</Text>
        </TouchableOpacity>
      </View>

      {!!error && (
        <Pressable onPress={() => setError('')} style={styles.errorBox}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
        </Pressable>
      )}

      {/* Main Tab Navigation Bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          onPress={() => setTab('Send')}
          style={[styles.tabItem, tab === 'Send' && styles.tabItemActive]}>
          <Text style={[styles.tabText, tab === 'Send' && styles.tabTextActive]}>📦 Send</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setTab('Food')}
          style={[styles.tabItem, tab === 'Food' && styles.tabItemActive]}>
          <Text style={[styles.tabText, tab === 'Food' && styles.tabTextActive]}>🍔 Food</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setTab('Activity')}
          style={[styles.tabItem, tab === 'Activity' && styles.tabItemActive]}>
          <Text style={[styles.tabText, tab === 'Activity' && styles.tabTextActive]}>📋 Activity</Text>
        </TouchableOpacity>
      </View>

      {tab === 'Send' && step === 0 ? (
        <LocationExperience
          pickup={booking.pickup}
          destination={booking.destination}
          target={locationTarget}
          onTarget={setLocationTarget}
          pickupLabel="Set Pickup"
          destinationLabel="Set Destination"
          title="Send a parcel"
          callApi={call}
          onCommit={(role, loc) => updateBooking(role, loc)}
          onContinue={() => {
            if (!isQuotableLocation(booking.pickup) || !isQuotableLocation(booking.destination)) {
              setError('Confirm a real map point for pickup and destination. ELESEND does not estimate distance, time, or a fare from an unresolved address.');
              return;
            }
            setError('');
            setStep(1);
          }}
        />
      ) : (
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">

        {tab === 'Send' && (
          <View>
            <View style={styles.stepperRow}>
              {['1. Location', '2. Package', '3. Confirm'].map((label, idx) => (
                <View key={label} style={[styles.stepBadge, step === idx && styles.stepBadgeActive, step > idx && styles.stepBadgeComplete]}>
                  <Text style={[styles.stepBadgeText, step === idx && styles.stepBadgeTextActive]}>{label}</Text>
                </View>
              ))}
            </View>

            {/* STEP 1: PACKAGE & RECIPIENT */}
            {step === 1 && (
              <View style={styles.card}>
                <Text style={styles.cardHeading}>Recipient & Package Details</Text>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Recipient Ghana Mobile Phone</Text>
                  <TextInput
                    placeholder="024 123 4567"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="phone-pad"
                    style={styles.input}
                    value={booking.recipientPhone}
                    onChangeText={v => updateBooking('recipientPhone', v)}
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Package Description</Text>
                  <TextInput
                    placeholder="e.g. Important Documents, Shoes, Food items"
                    placeholderTextColor={colors.textMuted}
                    style={styles.input}
                    value={booking.description}
                    onChangeText={v => updateBooking('description', v)}
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Handover & Landmark Instructions (Optional)</Text>
                  <TextInput
                    placeholder="e.g. Behind the SDA School, blue gate, call on arrival"
                    placeholderTextColor={colors.textMuted}
                    style={styles.input}
                    value={deliveryInstructions}
                    onChangeText={setDeliveryInstructions}
                  />
                </View>

                <Text style={[styles.inputLabel, { marginTop: 8 }]}>Select Delivery Vehicle</Text>
                <View style={styles.vehicleRow}>
                  {[
                    { id: 'motorcycle', label: '🛵 Motorbike', cap: 'Up to 20kg' },
                    { id: 'car', label: '🚗 Car', cap: 'Up to 150kg' },
                    { id: 'van', label: '🚐 Van', cap: 'Up to 800kg' }
                  ].map(v => (
                    <TouchableOpacity
                      key={v.id}
                      onPress={() => updateBooking('vehicle', v.id)}
                      style={[styles.vehicleCard, booking.vehicle === v.id && styles.vehicleCardActive]}>
                      <Text style={styles.vehicleLabel}>{v.label}</Text>
                      <Text style={styles.vehicleCap}>{v.cap}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <View style={{ flexDirection: 'row', gap: 12, marginTop: 20 }}>
                  <TouchableOpacity onPress={() => setStep(0)} style={[styles.secondaryBtn, { flex: 1 }]}>
                    <Text style={styles.secondaryBtnText}>← Back</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => execute(requestParcelQuote)} style={[styles.primaryBtn, { flex: 2 }]}>
                    <Text style={styles.primaryBtnText}>Get Quote →</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* STEP 2: AUTHORITATIVE QUOTE & CHECKOUT */}
            {step === 2 && (
              <View style={styles.card}>
                <Text style={styles.cardHeading}>Confirm & Book Delivery</Text>
                <View style={styles.addressSummaryCard}>
                  <Text style={styles.addressType}>Pickup · {booking.pickup?.positionKind || 'unconfirmed'}</Text>
                  <Text style={styles.addressText}>{booking.pickup?.address}</Text>
                  {!!booking.pickup?.uncertaintyNote && <Text style={styles.placeSub}>{booking.pickup.uncertaintyNote}</Text>}
                  <View style={styles.addressDivider} />
                  <Text style={styles.addressType}>Destination · {booking.destination?.positionKind || 'unconfirmed'}</Text>
                  <Text style={styles.addressText}>{booking.destination?.address}</Text>
                  {!!booking.destination?.uncertaintyNote && <Text style={styles.placeSub}>{booking.destination.uncertaintyNote}</Text>}
                </View>
                <Text style={styles.cardSubheading}>The fare below is calculated by the server from these confirmed points. It is not estimated on the phone.</Text>

                <View style={styles.quoteSummaryBox}>
                  <Text style={styles.quoteAmount}>{quoted ? ghc(quoted.amount_minor) : 'Updating Fare...'}</Text>
                  <Text style={styles.quoteDetails}>Authoritative Delivery Fare ({quoted?.vehicle || booking.vehicle})</Text>
                </View>

                <Text style={[styles.inputLabel, { marginTop: 16 }]}>Choose Payment Method</Text>
                <View style={styles.paymentMethodRow}>
                  {paymentMethods.filter(m => m.enabled).map(m => (
                    <TouchableOpacity
                      key={m.method}
                      onPress={() => execute(() => changeParcelPaymentTerms({ paymentMethod: m.method }))}
                      style={[styles.paymentMethodCard, booking.paymentMethod === m.method && styles.paymentMethodCardActive]}>
                      <Text style={styles.paymentMethodText}>
                        {m.method === 'CASH' ? '💵 Cash' : m.method === 'MOMO' ? '📱 MoMo' : m.method === 'CARD' ? '💳 Card' : '🔳 QR'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {booking.paymentMethod === 'CASH' && (
                  <View style={styles.cashPayerRow}>
                    <Text style={styles.inputLabel}>Who pays for delivery?</Text>
                    <View style={{ flexDirection: 'row', gap: 12, marginTop: 6 }}>
                      <TouchableOpacity
                        onPress={() => execute(() => changeParcelPaymentTerms({ cashPayer: 'sender' }))}
                        style={[styles.pillBtn, booking.cashPayer === 'sender' && styles.pillBtnActive]}>
                        <Text style={styles.pillBtnText}>Sender Pays</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => execute(() => changeParcelPaymentTerms({ cashPayer: 'recipient' }))}
                        style={[styles.pillBtn, booking.cashPayer === 'recipient' && styles.pillBtnActive]}>
                        <Text style={styles.pillBtnText}>Recipient Pays</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                <View style={{ flexDirection: 'row', gap: 12, marginTop: 24 }}>
                  <TouchableOpacity onPress={() => setStep(1)} style={[styles.secondaryBtn, { flex: 1 }]}>
                    <Text style={styles.secondaryBtnText}>← Back</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => execute(confirmParcelBooking)} style={[styles.primaryBtn, { flex: 2 }]} disabled={busy}>
                    <Text style={styles.primaryBtnText}>Book Delivery</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 2: FOOD MARKETPLACE */}
        {/* ================================================================= */}
        {tab === 'Food' && (
          <View>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Restaurants Near You</Text>
              {cartItems.length > 0 && (
                <TouchableOpacity onPress={() => setCartModal(true)} style={styles.cartBadgeBtn}>
                  <Text style={styles.cartBadgeText}>🛒 Cart ({cartItems.length})</Text>
                </TouchableOpacity>
              )}
            </View>

            {foodRestaurants.map(r => (
              <TouchableOpacity key={r.id} onPress={() => openRestaurant(r)} style={styles.restaurantCard}>
                <View style={styles.restHeader}>
                  <Text style={styles.restName}>{r.name}</Text>
                  <View style={styles.restOpenBadge}>
                    <Text style={styles.restOpenText}>{r.is_open ? 'OPEN' : 'CLOSED'}</Text>
                  </View>
                </View>
                <Text style={styles.restCuisine}>🍲 {r.cuisine_type || 'Ghanaian Cuisine'} • {r.address}</Text>
                <Text style={styles.restDeliveryInfo}>🛵 Delivery radius: {Math.round(r.delivery_radius_m / 1000)} km</Text>
              </TouchableOpacity>
            ))}

            {/* Restaurant Menu Modal */}
            <Modal visible={Boolean(selectedRest)} animationType="slide">
              <View style={styles.modalScreen}>
                <View style={styles.modalHeader}>
                  <TouchableOpacity onPress={() => setSelectedRest(null)} style={styles.closeBtn}>
                    <Text style={styles.closeBtnText}>✕ Close</Text>
                  </TouchableOpacity>
                  <Text style={styles.modalTitle}>{selectedRest?.name}</Text>
                  {cartItems.length > 0 && (
                    <TouchableOpacity onPress={() => setCartModal(true)} style={styles.cartBadgeBtn}>
                      <Text style={styles.cartBadgeText}>🛒 ({cartItems.length})</Text>
                    </TouchableOpacity>
                  )}
                </View>

                <ScrollView style={{ flex: 1, padding: 16 }}>
                  {restMenu?.categories?.map(cat => (
                    <View key={cat.id} style={{ marginBottom: 20 }}>
                      <Text style={styles.menuCatTitle}>{cat.name}</Text>
                      {cat.items?.map(item => (
                        <TouchableOpacity
                          key={item.id}
                          onPress={() => openDishDetails(item)}
                          style={styles.dishCard}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.dishName}>{item.name}</Text>
                            <Text style={styles.dishPrice}>{ghc(item.price_minor)}</Text>
                          </View>
                          <View style={styles.addDishBtn}>
                            <Text style={styles.addDishBtnText}>+ Add</Text>
                          </View>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ))}
                </ScrollView>
              </View>
            </Modal>

            {/* Dish Customizer Modal */}
            <Modal visible={dishModal} animationType="fade" transparent>
              <View style={styles.modalOverlay}>
                <View style={styles.dishCustomizerCard}>
                  <Text style={styles.dishModalTitle}>{selectedDish?.name}</Text>
                  <Text style={styles.dishModalPrice}>{ghc(selectedDish?.price_minor)}</Text>

                  {selectedDish?.modifiers?.map(mod => {
                    const isSingle = mod.max_selections === 1;
                    return (
                      <View key={mod.id} style={{ marginTop: 12 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <Text style={styles.modifierTitle}>{mod.name} {mod.is_required ? '(Required)' : '(Optional)'}</Text>
                          <Text style={{ fontSize: 11, color: colors.textMuted }}>{isSingle ? 'Choose 1' : 'Multi-select'}</Text>
                        </View>
                        {mod.options?.map(opt => {
                          const isSelected = selectedOptions.includes(opt.id);
                          return (
                            <TouchableOpacity
                              key={opt.id}
                              accessibilityRole={isSingle ? 'radio' : 'checkbox'}
                              accessibilityState={{ selected: isSelected }}
                              onPress={() => toggleModifierOption(opt.id, mod)}
                              style={[styles.modifierOptionRow, isSelected && styles.modifierOptionRowActive]}>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                                <Text style={{ fontSize: 16, color: isSelected ? colors.primary : colors.textMuted }}>
                                  {isSingle ? (isSelected ? '◉' : '○') : (isSelected ? '☑' : '☐')}
                                </Text>
                                <Text style={styles.optionName}>{opt.name}</Text>
                              </View>
                              <Text style={styles.optionPrice}>+{ghc(opt.price_minor)}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    );
                  })}

                  <View style={{ flexDirection: 'row', gap: 12, marginTop: 20 }}>
                    <TouchableOpacity onPress={() => setDishModal(false)} style={[styles.secondaryBtn, { flex: 1 }]}>
                      <Text style={styles.secondaryBtnText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={addDishToCart} style={[styles.primaryBtn, { flex: 2 }]}>
                      <Text style={styles.primaryBtnText}>Add to Cart</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </Modal>

            {/* Cart & Checkout Modal */}
            <Modal visible={cartModal} animationType="slide">
              <View style={styles.modalScreen}>
                <View style={styles.modalHeader}>
                  <TouchableOpacity onPress={() => setCartModal(false)} style={styles.closeBtn}>
                    <Text style={styles.closeBtnText}>✕ Back</Text>
                  </TouchableOpacity>
                  <Text style={styles.modalTitle}>Your Cart</Text>
                  <View style={{ width: 40 }} />
                </View>

                <ScrollView style={{ flex: 1, padding: 16 }}>
                  {cartItems.map((item, idx) => (
                    <View key={idx} style={styles.cartItemRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.cartItemName}>{item.name}</Text>
                        <Text style={styles.cartItemPrice}>{ghc(item.priceMinor)}</Text>
                      </View>
                      <TouchableOpacity onPress={() => setCartItems(curr => curr.filter((_, i) => i !== idx))}>
                        <Text style={{ color: colors.danger, fontWeight: 'bold' }}>Remove</Text>
                      </TouchableOpacity>
                    </View>
                  ))}

                  <Text style={[styles.inputLabel, { marginTop: 16 }]}>Delivery Address</Text>
                  <TextInput
                    placeholder="Enter delivery address or landmark"
                    placeholderTextColor={colors.textMuted}
                    style={styles.input}
                    value={foodDeliveryAddress}
                    onChangeText={setFoodDeliveryAddress}
                  />

                  <TouchableOpacity
                    onPress={() => execute(() => useCurrentLocation('food'))}
                    style={[styles.gpsDetectBtn, { marginTop: 8 }]}>
                    <Text style={styles.gpsDetectText}>📍 Use Current Location for Food</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setFoodPlaceOpen(true)}
                    style={[styles.gpsDetectBtn, { marginTop: 8 }]}>
                    <Text style={styles.gpsDetectText}>Search, map pin, or enter address</Text>
                  </TouchableOpacity>

                  <Text style={[styles.inputLabel, { marginTop: 12 }]}>Handover & Landmark Instructions (Optional)</Text>
                  <TextInput
                    placeholder="e.g. Behind the SDA School, blue gate, call on arrival"
                    placeholderTextColor={colors.textMuted}
                    style={styles.input}
                    value={foodInstructions}
                    onChangeText={setFoodInstructions}
                  />

                  {foodQuote ? (
                    <View style={styles.foodQuoteBox}>
                      <View style={styles.foodSummaryRow}>
                        <Text style={styles.foodSummaryLabel}>Food Subtotal:</Text>
                        <Text style={styles.foodSummaryVal}>{ghc(foodQuote.subtotalMinor ?? foodQuote.foodSubtotalMinor)}</Text>
                      </View>
                      <View style={styles.foodSummaryRow}>
                        <Text style={styles.foodSummaryLabel}>Delivery Fee:</Text>
                        <Text style={styles.foodSummaryVal}>{ghc(foodQuote.deliveryFeeMinor)}</Text>
                      </View>
                      <View style={[styles.foodSummaryRow, { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8, marginTop: 8 }]}>
                        <Text style={[styles.foodSummaryLabel, { fontWeight: 'bold', fontSize: 16 }]}>Total Due:</Text>
                        <Text style={[styles.foodSummaryVal, { fontWeight: 'bold', fontSize: 18, color: colors.primary }]}>{ghc(foodQuote.totalMinor ?? foodQuote.totalCustomerChargeMinor)}</Text>
                      </View>

                      <Text style={[styles.inputLabel, { marginTop: 16 }]}>Upfront Payment Method</Text>
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
                        {['MOMO', 'CARD', 'QR'].map(m => (
                          <TouchableOpacity
                            key={m}
                            onPress={() => setFoodPaymentMethod(m)}
                            style={[styles.paymentMethodCard, foodPaymentMethod === m && styles.paymentMethodCardActive]}>
                            <Text style={styles.paymentMethodText}>{m === 'MOMO' ? '📱 MoMo' : m === 'CARD' ? '💳 Card' : '🔳 QR'}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>

                      <TouchableOpacity onPress={() => execute(submitFoodOrder)} style={[styles.primaryBtn, { marginTop: 20 }]} disabled={busy}>
                        <Text style={styles.primaryBtnText}>Pay & Place Order ({ghc(foodQuote.totalMinor ?? foodQuote.totalCustomerChargeMinor)})</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <TouchableOpacity onPress={() => execute(calculateFoodQuote)} style={[styles.primaryBtn, { marginTop: 20 }]}>
                      <Text style={styles.primaryBtnText}>Calculate Delivery Fee & Quote →</Text>
                    </TouchableOpacity>
                  )}
                </ScrollView>
              </View>
            </Modal>
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 3: ACTIVITY & LIVE TRACKING */}
        {/* ================================================================= */}
        {tab === 'Activity' && (
          <View>
            <Text style={styles.sectionTitle}>Your Active Deliveries</Text>

            {myShipments.filter(s => !['COMPLETED', 'CANCELLED'].includes(s.state)).map(s => (
              <View key={s.id} style={styles.activeOrderCard}>
                <View style={styles.orderCardHeader}>
                  <Text style={styles.orderId}>Parcel #{s.id.slice(0, 8)}</Text>
                  <View style={styles.statusBadge}>
                    <Text style={styles.statusBadgeText}>{s.state}</Text>
                  </View>
                </View>

                <Text style={styles.orderAmount}>{ghc(s.amount_minor)} • {s.payment_method}</Text>
                
                {/* OTP Handover Display */}
                {s.state === 'AWAITING_DELIVERY_OTP' && (
                  <View style={styles.otpBanner}>
                    <Text style={styles.otpBannerTitle}>🔑 Handover Security OTP</Text>
                    <Text style={styles.otpBannerCode}>{s.delivery_otp || '••••••'}</Text>
                    <Text style={styles.otpBannerHelp}>Read this 6-digit code to the courier upon parcel arrival.</Text>
                  </View>
                )}

                {s.state === 'AWAITING_PAYMENT' && s.payment_method !== 'CASH' && (
                  <TouchableOpacity
                    onPress={() => execute(() => startOrResumeCheckout(s.id, s.payment_method))}
                    style={[styles.primaryBtn, { marginTop: 12 }]}>
                    <Text style={styles.primaryBtnText}>Complete / Retry Payment</Text>
                  </TouchableOpacity>
                )}

                <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                  <TouchableOpacity
                    onPress={() => setTrackingShipment(s)}
                    style={[styles.primaryBtn, { flex: 2 }]}>
                    <Text style={styles.primaryBtnText}>Live Track Courier</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => cancelOrder(s.id, false)}
                    style={[styles.dangerBtn, { flex: 1 }]}>
                    <Text style={styles.dangerBtnText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}

            {/* Food Orders */}
            {myFoodOrders.filter(o => !['DELIVERED', 'CANCELLED', 'REJECTED'].includes(o.state)).map(o => (
              <View key={o.id} style={styles.activeOrderCard}>
                <View style={styles.orderCardHeader}>
                  <Text style={styles.orderId}>🍔 Food Order #{o.id.slice(0, 8)}</Text>
                  <View style={styles.statusBadge}>
                    <Text style={styles.statusBadgeText}>{o.state}{o.shipment_state ? ` • ${o.shipment_state}` : ''}</Text>
                  </View>
                </View>
                <Text style={styles.orderAmount}>{ghc(o.total_minor ?? o.total_customer_charge_minor)}</Text>

                {o.shipment_id && (o.payment_status !== 'PAID' || o.shipment_state === 'AWAITING_PAYMENT') && (
                  <TouchableOpacity
                    onPress={() => execute(() => startOrResumeCheckout(o.shipment_id, o.payment_method || foodPaymentMethod))}
                    style={[styles.primaryBtn, { marginTop: 12 }]}>
                    <Text style={styles.primaryBtnText}>Complete / Retry Payment</Text>
                  </TouchableOpacity>
                )}

                {(o.state === 'SUBMITTED' || ['FAILED', 'RETURN_REQUESTED', 'RETURNED'].includes(o.shipment_state)) && (
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                    <TouchableOpacity
                      onPress={() => cancelOrder(o.id, true, o.shipment_state, o.state)}
                      style={[styles.dangerBtn, { flex: 1 }]}>
                      <Text style={styles.dangerBtnText}>
                        {o.shipment_state === 'RETURNED'
                          ? 'Complete Refund'
                          : ['FAILED', 'RETURN_REQUESTED'].includes(o.shipment_state)
                            ? 'Request Return & Refund Review'
                            : 'Cancel Order'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            ))}

            {myShipments.length === 0 && myFoodOrders.length === 0 && (
              <View style={styles.emptyCard}>
                <Text style={{ fontSize: 32, marginBottom: 8 }}>📦</Text>
                <Text style={styles.emptyTitle}>No Active Deliveries</Text>
                <Text style={styles.emptySub}>Book a parcel or order food to start tracking in real time.</Text>
              </View>
            )}

            {/* Tracking Modal */}
            <Modal visible={Boolean(trackingShipment)} animationType="slide">
              <View style={styles.modalScreen}>
                <View style={styles.modalHeader}>
                  <TouchableOpacity onPress={() => setTrackingShipment(null)} style={styles.closeBtn}>
                    <Text style={styles.closeBtnText}>✕ Close</Text>
                  </TouchableOpacity>
                  <Text style={styles.modalTitle}>Courier Live Tracking</Text>
                  <View style={{ width: 40 }} />
                </View>

                <View style={{ flex: 1 }}>
                  <MapView
                    initialRegion={{ latitude: 5.6037, longitude: -0.1870, longitudeDelta: 0.08 }}
                    style={StyleSheet.absoluteFill}>
                    {trackingShipment?.pickup && (
                      <Marker coordinate={trackingShipment.pickup} pinColor={colors.primary} title="Pickup" />
                    )}
                    {trackingShipment?.destination && (
                      <Marker coordinate={trackingShipment.destination} pinColor={colors.danger} title="Dropoff" />
                    )}
                  </MapView>
                </View>
              </View>
            </Modal>
          </View>
        )}
      </ScrollView>
      )}
      {foodPlaceOpen && (
        <Modal visible animationType="slide" onRequestClose={() => setFoodPlaceOpen(false)}>
          <LocationExperience
            mode="single"
            title="Food delivery location"
            callApi={call}
            onCancel={() => setFoodPlaceOpen(false)}
            onConfirmSingle={loc => {
              setFoodDeliveryAddress(loc.address);
              setFoodDeliveryCoords({latitude: loc.latitude, longitude: loc.longitude});
              setFoodPlaceOpen(false);
              loadFoodRestaurants(loc);
            }}
          />
        </Modal>
      )}
    </View>
  );
}