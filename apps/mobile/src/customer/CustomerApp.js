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
import { detectCustomerLocation, buildConfirmedLocation } from '../customer-location';
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
  const [placeQuery, setPlaceQuery] = useState('');
  const [placesList, setPlacesList] = useState([]);
  const [detectedLocation, setDetectedLocation] = useState(null);
  const [detectingGps, setDetectingGps] = useState(false);
  const [locationTarget, setLocationTarget] = useState('pickup');
  const [deliveryInstructions, setDeliveryInstructions] = useState('');
  const [ghanaAddress, setGhanaAddress] = useState('');
  const [ghanaAddressLookup, setGhanaAddressLookup] = useState(false);
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
  const [foodQuote, setFoodQuote] = useState(null);
  const [foodPaymentMethod, setFoodPaymentMethod] = useState('MOMO');
  const [myFoodOrders, setMyFoodOrders] = useState([]);
  const [activeFoodTracking, setActiveFoodTracking] = useState(null);

  const addressLookupEpoch = useRef(0);
  const mapRef = useRef(null);
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

    call('GET', '/api/v1/maps/config')
      .then(v => setGhanaAddressLookup(v.ghanaPostGpsLookup === true))
      .catch(() => {});

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
  async function runPlaceSearch() {
    if (placeQuery.trim().length < 2) return;
    const res = await call('GET', `/api/v1/maps/search?q=${encodeURIComponent(placeQuery.trim())}`);
    setPlacesList(res || []);
  }

  function pickPlace(p) {
    const target = booking.pickup ? 'destination' : 'pickup';
    const pin = { latitude: p.latitude, longitude: p.longitude, address: `${p.name} • ${p.label}` };
    updateBooking(target, pin);
    mapRef.current?.animateToRegion({
      latitude: pin.latitude,
      longitude: pin.longitude,
      latitudeDelta: 0.012,
      longitudeDelta: 0.012
    }, 500);
    setPlacesList([]);
    setPlaceQuery('');
  }

  async function useCurrentLocation(target = 'pickup') {
    setLocationTarget(target);
    setDetectingGps(true);
    const res = await detectCustomerLocation({
      locationApi: Location,
      reverseGeocodeApi: async (lat, lon) => call('GET', `/api/v1/maps/reverse?lat=${lat}&lon=${lon}`),
      timeoutMs: 12000
    });
    setDetectingGps(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setDetectedLocation(res);
    mapRef.current?.animateToRegion({
      latitude: res.coordinates.latitude,
      longitude: res.coordinates.longitude,
      latitudeDelta: 0.008,
      longitudeDelta: 0.008
    }, 600);

    const pin = {
      latitude: res.coordinates.latitude,
      longitude: res.coordinates.longitude,
      address: res.displayAddress,
      accuracyMeters: res.accuracyMeters,
      detectedByGps: true
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

  function handleMapPress(e) {
    if (step !== 0) return;
    const coord = e.nativeEvent.coordinate;
    const target = locationTarget || (booking.pickup ? 'destination' : 'pickup');
    updateBooking(target, {
      address: `Selected Pin (${coord.latitude.toFixed(4)}, ${coord.longitude.toFixed(4)})`,
      latitude: coord.latitude,
      longitude: coord.longitude
    });
    call('GET', `/api/v1/maps/reverse?lat=${coord.latitude}&lon=${coord.longitude}`)
      .then(res => {
        if (res?.address) {
          updateBooking(target, {
            address: res.address,
            latitude: coord.latitude,
            longitude: coord.longitude
          });
        }
      })
      .catch(() => {});
  }

  function sanitizeAddressPayload(loc) {
    if (!loc) return null;
    return {
      address: String(loc.address || '').trim(),
      latitude: Number(loc.latitude),
      longitude: Number(loc.longitude)
    };
  }

  async function requestParcelQuote(overrides = {}) {
    const nextBooking = { ...booking, ...overrides };
    if (!nextBooking.pickup) throw Error('Set pickup location');
    if (!nextBooking.destination) throw Error('Set destination location');
    const recipient = normalizeGhanaPhone(nextBooking.recipientPhone);
    if (!isValidGhanaPhone(recipient)) throw Error('Enter a valid Ghana recipient phone');

    const input = {
      pickup: sanitizeAddressPayload(nextBooking.pickup),
      destination: sanitizeAddressPayload(nextBooking.destination),
      vehicle: nextBooking.vehicle,
      recipientPhone: recipient,
      weightG: Number(nextBooking.weightG) || 1500,
      description: nextBooking.description || 'Package',
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

      {/* TAB CONTENT */}
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">

        {/* ================================================================= */}
        {/* TAB 1: SEND PARCEL */}
        {/* ================================================================= */}
        {tab === 'Send' && (
          <View>
            {/* Step Stepper */}
            <View style={styles.stepperRow}>
              {['1. Location', '2. Package', '3. Confirm'].map((label, idx) => (
                <View key={label} style={[styles.stepBadge, step === idx && styles.stepBadgeActive, step > idx && styles.stepBadgeComplete]}>
                  <Text style={[styles.stepBadgeText, step === idx && styles.stepBadgeTextActive]}>{label}</Text>
                </View>
              ))}
            </View>

            {/* STEP 0: LOCATIONS & MAP */}
            {step === 0 && (
              <View style={styles.card}>
                <Text style={styles.cardHeading}>Pickup & Delivery Points</Text>
                <Text style={styles.cardSubheading}>Search Ghanaian landmarks or drop pins directly on the map.</Text>

                {/* GPS Auto-detect Button */}
                <TouchableOpacity
                  onPress={() => execute(() => useCurrentLocation(booking.pickup ? 'destination' : 'pickup'))}
                  style={styles.gpsDetectBtn}
                  disabled={detectingGps}>
                  {detectingGps ? <ActivityIndicator size="small" color="#FFFFFF" style={{ marginRight: 8 }} /> : <Text style={{ fontSize: 18, marginRight: 8 }}>📍</Text>}
                  <Text style={styles.gpsDetectText}>{detectingGps ? 'Locating device...' : 'Use My Current Location'}</Text>
                </TouchableOpacity>

                {/* Landmark Search */}
                <View style={styles.searchRow}>
                  <TextInput
                    placeholder="Search landmark (e.g. Accra Mall, Kejetia)"
                    placeholderTextColor={colors.textMuted}
                    style={[styles.input, { flex: 1 }]}
                    value={placeQuery}
                    onChangeText={setPlaceQuery}
                    onSubmitEditing={() => execute(runPlaceSearch)}
                  />
                  <TouchableOpacity onPress={() => execute(runPlaceSearch)} style={styles.searchActionBtn}>
                    <Text style={styles.searchActionText}>Search</Text>
                  </TouchableOpacity>
                </View>

                {/* Search Results */}
                {placesList.length > 0 && (
                  <View style={styles.dropdownList}>
                    {placesList.map((p, i) => (
                      <TouchableOpacity key={i} onPress={() => pickPlace(p)} style={styles.dropdownItem}>
                        <Text style={styles.placeTitle}>📍 {p.name}</Text>
                        <Text style={styles.placeSub}>{p.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {/* Quick Ghana Landmark Chips */}
                <View style={styles.chipsRow}>
                  {[
                    { name: 'Accra Mall', latitude: 5.6214, longitude: -0.1741, label: 'Tetteh Quarshie' },
                    { name: 'Kotoka Airport', latitude: 5.6052, longitude: -0.1717, label: 'Airport Area' },
                    { name: 'Kejetia Market', latitude: 6.6961, longitude: -1.6244, label: 'Central Kumasi' },
                    { name: 'Tema Harbour', latitude: 5.6322, longitude: 0.0076, label: 'Tema Hub' }
                  ].map(chip => (
                    <TouchableOpacity key={chip.name} onPress={() => pickPlace(chip)} style={styles.chip}>
                      <Text style={styles.chipText}>📍 {chip.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Pickup & Destination Cards */}
                <View style={styles.addressSummaryCard}>
                  <View style={styles.addressRow}>
                    <Text style={styles.addressIcon}>🟢</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.addressType}>Pickup Location</Text>
                      <Text style={styles.addressText}>{booking.pickup?.address || 'Not selected (Tap map or search)'}</Text>
                    </View>
                  </View>
                  <View style={styles.addressDivider} />
                  <View style={styles.addressRow}>
                    <Text style={styles.addressIcon}>🔴</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.addressType}>Destination Location</Text>
                      <Text style={styles.addressText}>{booking.destination?.address || 'Not selected (Tap map or search)'}</Text>
                    </View>
                  </View>
                </View>

                {/* Private Map View */}
                <View style={styles.mapContainer}>
                  <MapView
                    ref={mapRef}
                    initialRegion={{ latitude: 5.6037, longitude: -0.1870, longitudeDelta: 0.12 }}
                    style={StyleSheet.absoluteFill}
                    onPress={handleMapPress}>
                    {booking.pickup && (
                      <Marker coordinate={booking.pickup} pinColor={colors.primary} title="Pickup" />
                    )}
                    {booking.destination && (
                      <Marker coordinate={booking.destination} pinColor={colors.danger} title="Destination" />
                    )}
                  </MapView>
                </View>

                <TouchableOpacity
                  onPress={() => {
                    if (!booking.pickup) { setError('Please select a pickup point'); return; }
                    if (!booking.destination) { setError('Please select a delivery destination'); return; }
                    setStep(1);
                  }}
                  style={[styles.primaryBtn, { marginTop: 16 }]}>
                  <Text style={styles.primaryBtnText}>Continue to Package Details →</Text>
                </TouchableOpacity>
              </View>
            )}

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

                  {selectedDish?.modifiers?.map(mod => (
                    <View key={mod.id} style={{ marginTop: 12 }}>
                      <Text style={styles.modifierTitle}>{mod.name} {mod.is_required ? '(Required)' : '(Optional)'}</Text>
                      {mod.options?.map(opt => (
                        <TouchableOpacity
                          key={opt.id}
                          onPress={() => toggleModifierOption(opt.id, mod)}
                          style={[styles.modifierOptionRow, selectedOptions.includes(opt.id) && styles.modifierOptionRowActive]}>
                          <Text style={styles.optionName}>{opt.name}</Text>
                          <Text style={styles.optionPrice}>+{ghc(opt.price_minor)}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ))}

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
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  splashTitle: { fontSize: 28, fontWeight: '800', color: colors.text, marginTop: 16 },
  splashSubtitle: { fontSize: 13, color: colors.primary, letterSpacing: 2, marginTop: 4 },
  brandIconBox: { width: 56, height: 56, borderRadius: 16, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  brandIconText: { fontSize: 32, fontWeight: '900', color: colors.bg },
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
  primaryBtn: { backgroundColor: colors.primary, borderRadius: radii.md, padding: 14, alignItems: 'center', justifyContent: 'center' },
  primaryBtnText: { color: colors.bg, fontSize: 15, fontWeight: '700' },
  secondaryBtn: { backgroundColor: colors.card, borderRadius: radii.md, padding: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.cardBorder },
  secondaryBtnText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  dangerBtn: { backgroundColor: '#7F1D1D', borderRadius: radii.md, padding: 12, alignItems: 'center', justifyContent: 'center' },
  dangerBtnText: { color: '#FCA5A5', fontSize: 13, fontWeight: '700' },
  switchAuthBtn: { marginTop: 16, alignItems: 'center', padding: 8 },
  switchAuthText: { color: colors.primary, fontSize: 13, fontWeight: '600' },
  errorBox: { backgroundColor: '#450A0A', padding: 12, borderRadius: radii.md, marginHorizontal: 16, marginTop: 8, borderWidth: 1, borderColor: colors.danger },
  errorText: { color: '#F87171', fontSize: 13, fontWeight: '600' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 48, paddingBottom: 14, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerBadge: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  headerBadgeText: { fontSize: 18, fontWeight: '900', color: colors.bg },
  headerTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  headerSubtitle: { fontSize: 12, color: colors.textMuted },
  logoutBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: radii.sm, backgroundColor: colors.card },
  logoutBtnText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  tabBar: { flexDirection: 'row', backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
  tabItem: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabItemActive: { borderBottomWidth: 2, borderBottomColor: colors.primary },
  tabText: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  tabTextActive: { color: colors.primary, fontWeight: '700' },
  scrollContent: { padding: 16 },
  stepperRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  stepBadge: { flex: 1, paddingVertical: 8, backgroundColor: colors.card, borderRadius: radii.sm, alignItems: 'center' },
  stepBadgeActive: { backgroundColor: colors.cardBorder, borderWidth: 1, borderColor: colors.primary },
  stepBadgeComplete: { backgroundColor: colors.primaryDark },
  stepBadgeText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  stepBadgeTextActive: { color: colors.primary, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, borderWidth: 1, borderColor: colors.cardBorder, marginBottom: 16 },
  cardHeading: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 4 },
  cardSubheading: { fontSize: 13, color: colors.textMuted, marginBottom: 14 },
  gpsDetectBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, padding: 12, borderRadius: radii.md, marginBottom: 12, borderWidth: 1, borderColor: colors.cardBorder },
  gpsDetectText: { color: colors.primary, fontWeight: '600', fontSize: 13 },
  searchRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  searchActionBtn: { backgroundColor: colors.card, borderRadius: radii.md, paddingHorizontal: 16, justifyContent: 'center', borderWidth: 1, borderColor: colors.cardBorder },
  searchActionText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  dropdownList: { backgroundColor: colors.card, borderRadius: radii.md, marginBottom: 12, borderWidth: 1, borderColor: colors.cardBorder, overflow: 'hidden' },
  dropdownItem: { padding: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
  placeTitle: { fontSize: 14, fontWeight: '600', color: colors.text },
  placeSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 },
  chip: { backgroundColor: colors.card, paddingVertical: 6, paddingHorizontal: 10, borderRadius: radii.full, borderWidth: 1, borderColor: colors.cardBorder },
  chipText: { fontSize: 12, color: colors.textMuted, fontWeight: '500' },
  addressSummaryCard: { backgroundColor: colors.card, borderRadius: radii.md, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: colors.cardBorder },
  addressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  addressIcon: { fontSize: 14 },
  addressType: { fontSize: 11, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' },
  addressText: { fontSize: 13, color: colors.text, marginTop: 2 },
  addressDivider: { height: 1, backgroundColor: colors.line, marginVertical: 8 },
  mapContainer: { height: 220, borderRadius: radii.md, overflow: 'hidden', borderWidth: 1, borderColor: colors.cardBorder },
  vehicleRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  vehicleCard: { flex: 1, backgroundColor: colors.card, borderRadius: radii.md, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: colors.cardBorder },
  vehicleCardActive: { borderColor: colors.primary, backgroundColor: colors.cardBorder },
  vehicleLabel: { fontSize: 13, fontWeight: '700', color: colors.text },
  vehicleCap: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  quoteSummaryBox: { backgroundColor: colors.card, borderRadius: radii.md, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: colors.cardBorder, marginTop: 10 },
  quoteAmount: { fontSize: 28, fontWeight: '800', color: colors.primary },
  quoteDetails: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  paymentMethodRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  paymentMethodCard: { flex: 1, backgroundColor: colors.card, borderRadius: radii.md, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: colors.cardBorder },
  paymentMethodCardActive: { borderColor: colors.primary, backgroundColor: colors.cardBorder },
  paymentMethodText: { fontSize: 13, fontWeight: '700', color: colors.text },
  cashPayerRow: { marginTop: 14 },
  pillBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: radii.full, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder },
  pillBtnActive: { backgroundColor: colors.primaryDark, borderColor: colors.primary },
  pillBtnText: { fontSize: 13, color: colors.text, fontWeight: '600' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  cartBadgeBtn: { backgroundColor: colors.primary, paddingVertical: 6, paddingHorizontal: 12, borderRadius: radii.full },
  cartBadgeText: { color: colors.bg, fontSize: 12, fontWeight: '700' },
  restaurantCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: colors.cardBorder },
  restHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  restName: { fontSize: 16, fontWeight: '700', color: colors.text },
  restOpenBadge: { backgroundColor: '#064E3B', paddingVertical: 3, paddingHorizontal: 8, borderRadius: radii.sm },
  restOpenText: { color: '#6EE7B7', fontSize: 10, fontWeight: '800' },
  restCuisine: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  restDeliveryInfo: { fontSize: 12, color: colors.primary, marginTop: 6 },
  modalScreen: { flex: 1, backgroundColor: colors.bg },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 48, paddingBottom: 12, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
  modalTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  closeBtn: { padding: 8 },
  closeBtnText: { color: colors.primary, fontWeight: '700', fontSize: 14 },
  menuCatTitle: { fontSize: 16, fontWeight: '800', color: colors.primary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 },
  dishCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, padding: 12, borderRadius: radii.md, marginBottom: 8, borderWidth: 1, borderColor: colors.cardBorder },
  dishName: { fontSize: 14, fontWeight: '700', color: colors.text },
  dishPrice: { fontSize: 13, color: colors.primary, fontWeight: '600', marginTop: 2 },
  addDishBtn: { backgroundColor: colors.card, paddingVertical: 6, paddingHorizontal: 12, borderRadius: radii.md, borderWidth: 1, borderColor: colors.primary },
  addDishBtnText: { color: colors.primary, fontSize: 12, fontWeight: '700' },
  modalOverlay: { flex: 1, backgroundColor: '#000000AA', justifyContent: 'center', padding: 20 },
  dishCustomizerCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 20, borderWidth: 1, borderColor: colors.cardBorder },
  dishModalTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  dishModalPrice: { fontSize: 16, fontWeight: '800', color: colors.primary, marginTop: 4 },
  modifierTitle: { fontSize: 13, fontWeight: '700', color: colors.textMuted, marginBottom: 6 },
  modifierOptionRow: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: colors.card, padding: 10, borderRadius: radii.sm, marginBottom: 6, borderWidth: 1, borderColor: colors.cardBorder },
  modifierOptionRowActive: { borderColor: colors.primary, backgroundColor: colors.cardBorder },
  optionName: { fontSize: 13, color: colors.text },
  optionPrice: { fontSize: 13, color: colors.primary, fontWeight: '600' },
  cartItemRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, padding: 12, borderRadius: radii.md, marginBottom: 8 },
  cartItemName: { fontSize: 14, fontWeight: '700', color: colors.text },
  cartItemPrice: { fontSize: 13, color: colors.primary, marginTop: 2 },
  foodQuoteBox: { backgroundColor: colors.surface, borderRadius: radii.md, padding: 14, marginTop: 16, borderWidth: 1, borderColor: colors.cardBorder },
  foodSummaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  foodSummaryLabel: { fontSize: 14, color: colors.textMuted },
  foodSummaryVal: { fontSize: 14, color: colors.text, fontWeight: '600' },
  activeOrderCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: colors.cardBorder },
  orderCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  orderId: { fontSize: 15, fontWeight: '700', color: colors.text },
  statusBadge: { backgroundColor: colors.card, paddingVertical: 4, paddingHorizontal: 10, borderRadius: radii.full, borderWidth: 1, borderColor: colors.primary },
  statusBadgeText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  orderAmount: { fontSize: 14, color: colors.textMuted, marginTop: 6 },
  otpBanner: { backgroundColor: colors.card, borderRadius: radii.md, padding: 14, marginTop: 12, alignItems: 'center', borderWidth: 1, borderColor: colors.primary },
  otpBannerTitle: { fontSize: 12, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' },
  otpBannerCode: { fontSize: 32, fontWeight: '900', color: colors.primary, letterSpacing: 8, marginVertical: 4 },
  otpBannerHelp: { fontSize: 11, color: colors.textMuted, textAlign: 'center' },
  emptyCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 32, alignItems: 'center', marginTop: 20 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  emptySub: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: 4 }
});
