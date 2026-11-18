Warning: truncated output (original token count: 46710)
Total output lines: 3514

/**
 * ELESEND Customer Mobile Application
 * 
 * Professional Native Android UI/UX Transformation
 * - Inspired by top-tier transit & delivery layouts (clean white cards, bold condensed typography, floating bottom sheets)
 * - Map-first parcel booking ("SEND A PACKAGE" with vehicle carousel & floating sheet)
 * - Structured Cargo booking ("Cargo" with Route/Hours, City-wide/City-to-City, dimension guides)
 * - Address selection bottom sheet with GPS quick-select, saved places & Ghana landmark search
 * - Modern Homepage with service cards (Delivery, Cargo, Food), "Where to?" pill & Ghanaian promos (Aboboyaa)
 * - Professional Customer Profile with quick actions (Orders, Support, Addresses, Settings)
 * - Full preservation of authoritative backend contracts, 10% food commission, 0-100% delivery tariffs,
 *   double-entry ledgers, rider-declared handover records, and offline resilience.
 */

import { runGuarded, useSignInState, signInWithPassword } from '../account-actions';
import { SUPPORT_PHONE } from '../config.js';
import { LegalNotice, termsAcceptance } from '../legal-notice';
import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet,
  Alert, ActivityIndicator, AppState, Linking, StatusBar,
  TouchableOpacity, Modal, Dimensions, Platform, Share
} from 'react-native';
import * as Location from 'expo-location';
import * as Crypto from 'expo-crypto';
import MapView, { Marker, RiderMarker, Polyline } from '../maps/map-adapter';
import { call, loadToken, saveToken, clearToken, ghc, BASE } from '../api';
import { acquireDevicePushToken, registerDevicePushChannel } from '../tracking';
import { EmergencyButton, RatingPrompts, TrustedContactCard } from '../rider-safety';
import DeleteAccountModal from '../delete-account';
import { detectCustomerLocation, buildConfirmedLocation, prepareDeviceLocation } from '../customer-location';
import {
  ENDPOINTS,
  toAddressPayload,
  isInsideServiceEnvelope,
  isConfirmedLocation,
  buildParcelQuoteRequest,
  buildParcelBookingRequest,
  isQuoteBoundToInputs,
  buildShipmentCancelRequest,
  buildFoodQuoteRequest,
  buildFoodOrderRequest,
  buildCheckoutRequest,
  formatPromotionSavingsSummary,
  buildChatMessageRequest
} from '../booking-contract';
import { normalizeGhanaPhone, isValidGhanaPhone, formatGhanaDisplayPhone } from '../phone';
import { colors, typography, spacing, radii, shadows } from '../theme';
import { customerStatus, paymentLabel } from '../status-labels';
import FareSummary from './FareSummary';
import RecipientPhoneModal from './RecipientPhoneModal';
import RiderCard from './RiderCard';
import { VoiceNoteBubble, VoiceNoteRecorder } from '../chat/VoiceNote';
import {
  GHANA_REGIONS,
  GHANA_REGIONAL_TOWNS,
  isValidGhanaPostGps,
  normalizeGhanaAddressText,
  formatGhanaAddressSummary,
  buildLocationRecord,
  parseGhanaInformalAddress,
  RESOLUTION_STATUSES,
  PROVENANCE_TYPES
} from '../manual-address';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const initialCreds = { phone: '', password: '', name: '' };

// Contract requirement: sanitizeAddressPayload
// Delegates to the tested booking contract: keeps the chosen place name and never
// returns placeholder text or invented coordinates.
function sanitizeAddressPayload(loc) {
  return toAddressPayload(loc);
}

// Builds the authoritative parcel quote body (no unknown keys; confirmed locations only).
function parcelQuoteBody(booking, pickup, destination, authPhone, paymentMethod, extraInstructions = '') {
  return buildParcelQuoteRequest({
    pickup,
    destination,
    vehicle: booking.vehicle,
    weightG: booking.weightG,
    lengthCm: booking.lengthCm,
    volumeL: booking.volumeL,
    paymentMethod: paymentMethod || booking.paymentMethod,
    recipientPhone: normalizeGhanaPhone(booking.recipientPhone || authPhone),
    description: booking.description || 'Package',
    destinationInstructions: extraInstructions || destination?.deliveryInstructions || ''
  });
}

export default function CustomerApp() {
  const [auth, setAuth] = useState(null);
  const {
    phoneState, setPhoneState, phoneChallenge, setPhoneChallenge, phoneCode, setPhoneCode,
    credentials, setCredentials, isSignup, setIsSignup, loading, setLoading, busy, setBusy, error, setError,
    forgotModal, setForgotModal, recoveryPhone, setRecoveryPhone, recoveryChallenge, setRecoveryChallenge,
    recoveryCode, setRecoveryCode, recoveryNewPassword, setRecoveryNewPassword,
    requestPasswordRecoveryChallenge, submitPasswordReset
  } = useSignInState(initialCreds);

  // Primary Navigation: 'Home' | 'Send' | 'Cargo' | 'Food' | 'Activity' | 'Profile'
  const [tab, setTab] = useState('Home');

  // Parcel / Courier Booking State
  const [step, setStep] = useState(0); // 0: Location & Vehicle, 1: Details & Payer, 2: Checkout / Review
  const [booking, setBooking] = useState({
    pickup: null,
    destination: null,
    vehicle: 'motorcycle',
    recipientPhone: '',
    recipientName: '',
    weightG: '1500',
    lengthCm: '',
    volumeL: '',
    description: 'Package',
    parcelCategory: 'general',
    parcelSize: 'small',
    paymentMethod: 'CASH',
    cashPayer: 'recipient'
  });
  const [quoted, setQuoted] = useState(null);
  const [myShipments, setMyShipments] = useState([]);
  const [trackingShipment, setTrackingShipment] = useState(null);
  const [liveCourier, setLiveCourier] = useState(null);
  const [liveRider, setLiveRider] = useState(null);
  const [courierLastSeen, setCourierLastSeen] = useState(null);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [vehicleTariffs, setVehicleTariffs] = useState([]);
  // Starting prices come from the live tariff, and are hidden until it loads.
  const vehicleFromPrice = vehicle => {
    const tariff = vehicleTariffs.find(row => row.vehicle === vehicle);
    return tariff ? `from ${ghc(Math.max(Number(tariff.minimum_minor) || 0, Number(tariff.base_minor) || 0))}` : null;
  };
  const [deliveryEta, setDeliveryEta] = useState(null);
  const [shareToken, setShareToken] = useState(null);
  // The server sets this rate, so customers see the same fee before and at checkout.
  const digitalFeeNote = () => {
    const bps = paymentMethods.find?.(m => m.processingFeeBps)?.processingFeeBps;
    return bps ? `A ${(bps / 100).toFixed(2)}% payment processing fee is added at checkout.` : null;
  };
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
  const [addressModalVisible, setAddressModalVisible] = useState(false);
  const [addressMode, setAddressMode] = useState('search'); // 'search' | 'gps' | 'manual'
  const [manualForm, setManualForm] = useState({
    region: '',
    city: '',
    community: '',
    landmark: '',
    buildingDescription: '',
    street: '',
    houseNumber: '',
    ghanaPostGps: '',
    deliveryInstructions: ''
  });
  const [addressConfirmModal, setAddressConfirmModal] = useState(false);
  const [recipientEdit, setRecipientEdit] = useState(null);
  const [pendingAddressRecord, setPendingAddressRecord] = useState(null);
  const [confirmTarget, setConfirmTarget] = useState('pickup');
  const [isSearching, setIsSearching] = useState(false);
  const searchTimerRef = useRef(null);
  const confirmMapRef = useRef(null);

  // Cargo Booking Specific State
  const [cargoMode, setCargoMode] = useState('Route'); // 'Route' | 'Hours'
  const [cargoScope, setCargoScope] = useState('City-wide'); // 'City-wide' | 'City to City'
  const [cargoBodyType, setCargoBodyType] = useState('aboboyaa'); // 'aboboyaa' | 'van' | 'pickup'

  // Food Marketplace State
  const [foodRestaurants, setFoodRestaurants] = useState([]);
  const [foodNotice, setFoodNotice] = useState('');
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
  const [promoCodeInput, setPromoCodeInput] = useState('');
  const [appliedPromoCode, setAppliedPromoCode] = useState('');

  // Order-Scoped Real-Time Chat State
  const [chatModalVisible, setChatModalVisible] = useState(false);
  const [activeConversation, setActiveConversation] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatTyping, setChatTyping] = useState([]);
  const [chatText, setChatText] = useState('');
  const [chatSending, setChatSending] = useState(false);

  // Shortcuts come from this customer's own deliveries, never from a built-in list of places.
  const recentPlaces = [];
  for (const shipment of myShipments) {
    const place = shipment?.destination;
    if (!place?.address || !Number.isFinite(Number(place.latitude)) || !Number.isFinite(Number(place.longitude))) continue;
    const title = String(place.address).replace(/\s*\[Instructions:[^\]]*\]/gi, '').trim();
    if (!title || recentPlaces.some(item => item.title === title)) continue;
    recentPlaces.push({ title, subtitle: 'Recent delivery', icon: '📍', lat: Number(place.latitude), lon: Number(place.longitude) });
    if (recentPlaces.length >= 6) break;
  }

  const addressLookupEpoch = useRef(0);
  const quoteSeqRef = useRef(0);
  const mapRef = useRef(null);

  const edit = (k, v) => setCredentials(c => ({ ...c, [k]: v }));
  const updateBooking = (k, v) => {
    if (k === 'pickup' || k === 'destination') addressLookupEpoch.current++;
    quoteSeqRef.current++;
    setBooking(b => ({ ...b, [k]: v }));
    setQuoted(null);
  };

  const execute = task => runGuarded(task, { busy, setBusy, setError });

  // Lets ELESEND reach this customer about refunds and delays when the app is closed.
  useEffect(() => {
    if (!auth?.id || phoneState?.verified === false) return;
    acquireDevicePushToken({ appScope: 'customer', channelId: 'elesend-updates' })
      .then(acquired => (acquired?.ok && acquired?.pushToken)
        ? registerDevicePushChannel({ appScope: 'customer', pushToken: acquired.pushToken, deviceId: acquired.deviceId, platform: acquired.platform || 'android', appState: 'active', backgroundLocationEnabled: false })
        : null)
      .catch(() => null);
  }, [auth?.id, phoneState?.verified]);

  // Ask for location as soon as the app opens, before sign-in, so GPS is ready.
  const locationReady = useRef(null);
  if (!locationReady.current) locationReady.current = prepareDeviceLocation(Location);

  // Once signed in, fill in the current location: a recent device fix first, then a measured one.
  useEffect(() => {
    if (!auth?.id) return;
    (async () => {
      if (await locationReady.current !== 'granted') return;
      const first = await requestLocation({ silent: true, quickFirst: true });
      if (first?.ok && first.isLastKnown) await requestLocation({ silent: true });
    })();
  }, [auth?.id]);

  // Restaurants are listed by distance, so reload them when the location arrives.
  useEffect(() => {
    if (auth?.id && detectedLocation?.coordinates) loadFoodRestaurants();
  }, [auth?.id, detectedLocation?.latitude, detectedLocation?.longitude]);

  // Auth Initialization
  useEffect(() => {
    (async () => {
      try {
        const token = await loadToken();
        if (token) {
          const user = await call('GET', '/api/v1/me');
          if (user.kind === 'customer' || user.kind === 'business') {
            const pStatus = await call('GET', '/api/v1/me/phone').catch(() => ({ phone: user.phone || '', verified: false }));
            await call('POST', '/api/v1/me/terms', termsAcceptance()).catch(() => {});
            setPhoneState(pStatus);
            setAuth({ ...user, phone: pStatus.phone || user.phone || '', name: user.name || 'Valued Customer' });
          } else {
            await clearToken();
            setAuth(null);
            setPhoneState(null);
            setError('Please sign in with a Customer account on this application.');
          }
        }
      } catch (e) {
        // Only a rejected session signs the customer out, never a weak network.
        if (e.status === 401 || e.status === 403) await clearToken();
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

    call('GET', '/api/v1/pricing/vehicles')
      .then(rows => setVehicleTariffs(Array.isArray(rows) ? rows : []))
      .catch(() => setVehicleTariffs([]));

    call('GET', '/api/v1/maps/config')
      .then(v => setGhanaAddressLookup(v.ghanaPostGpsLookup === true))
      .catch(() => {});

    loadFoodRestaurants();
    refreshActivity();
  }, [auth, phoneState?.verified]);

  // Periodic Refresh for Active Deliveries in Activity Tab
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
    const interval = setInterval(poll, 6000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [auth, phoneState?.verified, tab]);

  // Live Tracking Polling for Modal
  useEffect(() => {
    if (!trackingShipment?.id) {
      setLiveCourier(null);
      setLiveRider(null);
      setCourierLastSeen(null);
      setDeliveryEta(null);
      setShareToken(null);
      return;
    }
    let cancelled = false;
    const fetchLiveTracking = async () => {
      try {
        const trk = await call('GET', `/api/v1/public-track/${trackingShipment.id}`);
        if (!cancelled) {
          setLiveCourier(trk?.courier || null);
          setLiveRider(trk?.rider || null);
          setCourierLastSeen(trk?.lastSeen || null);
          setDeliveryEta(trk?.deliveryEta || null);
          setShareToken(trk?.trackingToken || null);
          if (trk?.riderPhone && !trackingShipment.rider_phone) {
            setTrackingShipment(ts => ts ? { ...ts, rider_phone: trk.riderPhone } : null);
          }
        }
      } catch {}
    };
    fetchLiveTracking();
    const interval = setInterval(fetchLiveTracking, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [trackingShipment?.id]);

  async function signIn() {
    const { data, normPhone, pStatus } = await signInWithPassword(credentials, user => {
      if (user.kind !== 'customer' && user.kind !== 'business') throw Error('This account is registered as a courier driver. Please use the ELESEND Rider app.');
    });
    setPhoneState(pStatus);
    await call('POST', '/api/v1/me/terms', termsAcceptance()).catch(() => {});
    setAuth({ ...data.user, phone: pStatus.phone || normPhone, name: data.user.name || credentials.name || 'Valued Customer' });
    setCredentials(initialCreds);
    if (!pStatus.verified) {
      try {
        setPhoneChallenge(await call('POST', '/api/v1/me/phone-challenge', {}));
      } catch (e) {
        setError(e.message || 'Enter verification code or request a new code.');
      }
    } else {
      setTab('Home');
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
      name: credentials.name || 'Customer',
      ...termsAcceptance()
    });
    await signIn();
  }

  async function verifyOtp() {
    if (!phoneCode || phoneCode.trim().length !== 6) throw Error('Enter 6-digit verification code');
    await call('POST', '/api/v1/me/phone-verify', {
      challengeId: phoneChallenge?.challengeId,
      code: phoneCode.trim()
    });
    setPhoneState({ phone: auth.phone, verified: true });
    setPhoneChallenge(null);
    setPhoneCode('');
    setTab('Home');
  }

  // silent: the launch lookup. It fills in the location without opening a panel or showing errors.
  async function requestLocation({ silent = false, quickFirst = false } = {}) {
    setDetectingGps(true);
    try {
      const res = await detectCustomerLocation({
        locationApi: Location,
        reverseGeocodeApi: async (lat, lon) => {
          try {
            return await call('GET', `/api/v1/maps/reverse?lat=${lat}&lon=${lon}`);
          } catch {
            return null;
          }
        },
        timeoutMs: 12000,
        quickFirst
      });

      if (!res.ok && silent) return res;
      if (!res.ok) {
        if (res.error === 'services_disabled') {
          Alert.alert(
            'Device Location Disabled',
            'GPS location services are turned off on your Android device. Would you like to type your address manually or search landmarks?',
            [
              { text: 'Search Landmark', onPress: () => { setLocationTarget(locationTarget || 'pickup'); setAddressModalVisible(true); } },
              { text: 'Cancel', style: 'cancel' }
            ]
          );
        } else if (res.error === 'permission_denied') {
          Alert.alert(
            'Location Permission Required',
            'ELESEND needs location access to pinpoint nearby couriers, display pickup estimates, and calculate accurate route tariffs across Ghana. You can also enter an address manually.',
            [
              { text: 'Enter Manually', onPress: () => { setLocationTarget(locationTarget || 'pickup'); setAddressModalVisible(true); } },
              { text: 'OK', style: 'default' }
            ]
          );
        } else {
          Alert.alert(
            'GPS Fix Unavailable',
            res.message || 'Unable to retrieve precise GPS coordinates. You can select your address from the landmark list or pin on map.',
            [
              { text: 'Retry', onPress: () => requestLocation() },
              { text: 'Enter Manually', onPress: () => { setLocationTarget(locationTarget || 'pickup'); setAddressModalVisible(true); } },
              { text: 'Cancel', style: 'cancel' }
            ]
          );
        }
        return;
      }

      const detected = {
        latitude: res.coordinates.latitude,
        longitude: res.coordinates.longitude,
        // `coordinates` is read by selectGpsLocation, EGIA proximity search and manual preview.
        coordinates: { latitude: res.coordinates.latitude, longitude: res.coordinates.longitude },
        address: res.displayAddress || 'Current GPS Location',
        displayAddress: res.displayAddress || 'Current GPS Location',
        locality: res.recognizedNearby || '',
        city: res.reverseGeocode?.city || '',
        region: res.region || '',
        accuracyMeters: res.accuracyMeters,
        accuracyTier: res.accuracyTier,
        accuracyLabel: res.accuracyLabel,
        isLastKnown: res.isLastKnown,
        advisory: res.advisory,
        detectedAt: res.detectedAt,
        requiresConfirmation: true
      };
      setDetectedLocation(detected);

      // Smoothly recenter camera to user's location (only when the Send map is mounted)
      if (mapRef.current?.animateToRegion) {
        mapRef.current.animateToRegion({
          latitude: detected.latitude,
          longitude: detected.longitude,
          latitudeDelta: 0.015,
          longitudeDelta: 0.015
        }, 800);
      }

      if (silent) return res;

      // Never write a GPS fix into the booking silently (it may be a cached or approximate fix).
      // The customer reviews it on the confirmation panel and can drag the pin before confirming.
      openGpsConfirmation(detected);
    } catch (e) {
      if (silent) return null;
      Alert.alert('GPS Notice', 'Unable to retrieve precise GPS coordinates. You can select your address from the landmark list or pin on map.');
    } finally {
      setDetectingGps(false);
    }
  }

  // Interactive Marker Pin Dragging (Required by contract)
  function handleMarkerDragEnd(target, coord) {
    if (!isInsideServiceEnvelope(coord)) {
      Alert.alert('Out of Bounds', 'The selected coordinates are outside ELESEND service areas in Ghana.');
      return;
    }
    const previous = booking[target] || {};
    const movedSignificantly = previous.coordinates
      ? Math.hypot((coord.latitude - previous.coordinates.latitude), (coord.longitude - previous.coordinates.longitude)) > 0.002
      : true;
    const baseUpdated = {
      ...previous,
      title: movedSignificantly ? `Pinned point (${coord.latitude.toFixed(4)}, ${coord.longitude.toFixed(4)})` : (previous.title || 'Pinned location'),
      address: movedSignificantly ? `Custom Pinned Point (${coord.latitude.toFixed(4)}, ${coord.longitude.toFixed(4)})` : (previous.address || `Custom Pinned Point (${coord.latitude.toFixed(4)}, ${coord.longitude.toFixed(4)})`),
      coordinates: { latitude: coord.latitude, longitude: coord.longitude },
      latitude: coord.latitude,
      longitude: coord.longitude,
      requiresConfirmation: false,
      customerConfirmed: true,
      resolutionStatus: RESOLUTION_STATUSES.CUSTOMER_CONFIRMED,
      provenance: PROVENANCE_TYPES.MANUAL_PIN
    };
    updateBooking(target, baseUpdated);
    call('GET', `/api/v1/maps/reverse?lat=${coord.latitude}&lon=${coord.longitude}`)
      .then(rev => {
        if (rev?.name || rev?.label) {
          updateBooking(target, {
            ...baseUpdated,
            title: rev.name || baseUpdated.title,
            address: rev.label || baseUpdated.address
          });
        }
      })
      .catch(() => {});

    // Refresh quote if both locations are confirmed
    const otherTarget = target === 'pickup' ? 'destination' : 'pickup';
    const other = booking[otherTarget];
    if (isConfirmedLocation(other)) {
      const p = target === 'pickup' ? baseUpdated : other;
      const d = target === 'destination' ? baseUpdated : other;
      const reqSeq = ++quoteSeqRef.current;
      try {
        const reqBody = parcelQuoteBody(booking, p, d, auth.phone, booking.paymentMethod, deliveryInstructions);
        call('POST', ENDPOINTS.parcelQuote, reqBody)
          .then(q => {
            if (reqSeq === quoteSeqRef.current) {
              setQuoted({ ...q, requestBody: reqBody, bookingIdempotencyKey: `idemp_${Crypto.randomUUID()}` });
            }
          })
          .catch(err => {
            if (reqSeq === quoteSeqRef.current) setError(err.message);
          });
      } catch (err) {
        setError(err.message);
      }
    }
  }

  // Debounced Intelligent Location Search (EGIA + Gazetteer fallback)
  function searchLandmarks(query) {
    setPlaceQuery(query);
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }
    if (!query || query.trim().length < 2) {
      setPlacesList([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    searchTimerRef.current = setTimeout(async () => {
      const coords = detectedLocation?.coordinates;
      const near = coords && Number.isFinite(Number(coords.latitude)) && Number.isFinite(Number(coords.longitude)) ? coords : null;
      const params = new URLSearchParams({q: query.trim()});
      if (near) {
        params.set('lat', String(near.latitude));
        params.set('lon', String(near.longitude));
      }
      try {
        // Gazetteer ranking is authoritative. EGIA can add a restaurant that the gazetteer does not list,
        // but a weak EGIA hit must not hide the ranked list.
        const [egiaRes, gazRes] = await Promise.all([
          call('POST', '/api/v1/maps/egia/search', {query: query.trim(), coordinates: near, limit: 8}).catch(() => []),
          call('GET', `/api/v1/maps/search?${params.toString()}`).catch(() => [])
        ]);
        const egiaList = Array.isArray(egiaRes) ? egiaRes : (egiaRes?.results || []);
        const gazList = Array.isArray(gazRes) ? gazRes : (gazRes?.results || []);
        const digital = [...gazList, ...egiaList].find(row => row?.type === 'digital_address' && Number.isFinite(Number(row.latitude)))
          || [...gazList, ...egiaList].find(row => row?.type === 'digital_address');
        if (digital) {
          setPlacesList([digital]);
          return;
        }
        const seen = new Set();
        const merged = [];
        for (const row of [...gazList, ...egiaList]) {
          const key = `${String(row?.name || '').toLowerCase()}|${Number(row?.latitude).toFixed(4)}|${Number(row?.longitude).toFixed(4)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(row);
        }
        setPlacesList(merged.slice(0, 8));
      } catch {
        setPlacesList([]);
      } finally {
        setIsSearching(false);
      }
    }, 250);
  }

  // Select item from search results or default shortcuts -> opens Confirmation Panel
  function selectAddressItem(item) {
    const lat = Number(item.lat ?? item.latitude);
    const lon = Number(item.lon ?? item.longitude);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
    const rec = buildLocationRecord({
      components: {
        region: item.region || '',
        city: item.city || item.locality || '',
        community: item.locality || item.community || '',
        landmark: item.category === 'landmark' ? item.name : '',
        buildingDescription: '',
        deliveryInstructions: deliveryInstructions
      },
      coordinates: hasCoords ? { latitude: lat, longitude: lon } : null,
      provenance: item.candidateType === 'mapped_restaurant' ? PROVENANCE_TYPES.SEARCH_EGIA : PROVENANCE_TYPES.SEARCH_GAZETTEER,
      resolutionStatus: item.is_registered_merchant ? RESOLUTION_STATUSES.VERIFIED : (hasCoords ? RESOLUTION_STATUSES.APPROXIMATE : RESOLUTION_STATUSES.UNRESOLVED),
      confidenceLevel: item.confidence || 75,
      customerConfirmed: false,
      rawCustomerInput: placeQuery
    });
    rec.title = item.title || item.name || item.address;
    rec.subtitle = item.subtitle || item.category || `${item.locality || ''} ${item.region || ''}`.trim();
    setPendingAddressRecord(rec);
    setConfirmTarget(locationTarget);
    setAddressConfirmModal(true);
  }

  // Select detected device GPS position -> opens Confirmation Panel
  function selectGpsLocation() {
    if (!detectedLocation?.coordinates) {
      requestLocation();
      return;
    }
    openGpsConfirmation(detectedLocation);
  }

  // GPS fixes are never auto-confirmed: approximate or cached fixes must be reviewed/refined.
  function openGpsConfirmation(fix) {
    if (!fix?.coordinates) return;
    const precise = fix.accuracyTier === 'high' && !fix.isLastKnown;
    const rec = buildLocationRecord({
      components: {
        region: fix.region || '',
        city: fix.city || '',
        community: fix.locality || '',
        landmark: fix.recognizedNearby || fix.locality || '',
        deliveryInstructions: deliveryInstructions
      },
      coordinates: fix.coordinates,
      provenance: PROVENANCE_TYPES.GPS,
      resolutionStatus: RESOLUTION_STATUSES.APPROXIMATE,
      confidenceLevel: precise ? 90 : fix.accuracyTier === 'moderate' ? 70 : 45,
      customerConfirmed: false
    });
    rec.title = fix.displayAddress || 'Current GPS Location';
    rec.subtitle = `${fix.isLastKnown ? 'Cached device fix — ' : 'GPS '}${fix.accuracyLabel || ''}`.trim();
    rec.advisory = fix.advisory || null;
    setPendingAddressRecord(rec);
    setConfirmTarget(locationTarget);
    setAddressConfirmModal(true);
  }

  // Manual address entry geocode preview -> opens Confirmation Panel
  async function previewManualAddress() {
    if (!manualForm.community.trim() && !manualForm.landmark.trim() && !manualForm.city.trim()) {
      Alert.alert('Details Missing', 'Please enter at least your community, town, or nearby landmark.');
      return;
    }
    const summary = formatGhanaAddressSummary(manualForm);
    const queryText = [manualForm.community, manualForm.landmark, manualForm.city, manualForm.region].filter(Boolean).join(' ');
    let candidateCoords = null;
    let candidateConfidence = 40;
    let candidateStatus = RESOLUTION_STATUSES.UNRESOLVED;
    let prov = PROVENANCE_TYPES.MANUAL_UNRESOLVED;

    if (queryText.trim().length >= 3) {
      try {
        const searchRes = await call('POST', '/api/v1/maps/egia/search', {
          query: queryText,
          coordinates: detectedLocation?.coordinates || null,
          limit: 1
        });
        const first = Array.isArray(searchRes) ? searchRes[0] : searchRes?.results?.[0];
        if (first && Number.isFinite(Number(first.latitude)) && Number.isFinite(Number(first.longitude))) {
          candidateCoords = { latitude: Number(first.latitude), longitude: Number(first.longitude) };
          candidateConfidence = first.confidence || 65;
          candidateStatus = RESOLUTION_STATUSES.APPROXIMATE;
          prov = PROVENANCE_TYPES.SEARCH_EGIA;
        }
      } catch {}
    }

    if (!candidateCoords && manualForm.ghanaPostGps && isValidGhanaPostGps(manualForm.ghanaPostGps)) {
      // The GhanaPostGPS code is preserved as entered, but it is NOT resolved to coordinates
      // client-side. The customer must place the pin; we never substitute a default point.
      prov = PROVENANCE_TYPES.GHANAPOST_GPS;
      candidateStatus = RESOLUTION_STATUSES.UNRESOLVED;
    }
    // When nothing resolved, candidateCoords stays null: the confirmation panel asks the
    // customer to tap the map to place the pin (zero fabricated coordinates).

    const rec = buildLocationRecord({
      components: manualForm,
      coordinates: candidateCoords,
      provenance: prov,
      resolutionStatus: candidateStatus,
      confidenceLevel: candidateConfidence,
      customerConfirmed: false,
      deliveryInstructions: manualForm.deliveryInstructions || deliveryInstructions,
      rawCustomerInput: summary
    });
    rec.title = summary;
    rec.subtitle = `${manualForm.community ? manualForm.community + ', ' : ''}${manualForm.city}${manualForm.region ? ' (' + manualForm.region + ')' : ''}`;
    setPendingAddressRecord(rec);
    setConfirmTarget(locationTarget);
    setAddressConfirmModal(true);
  }

  // Interactive pin adjustment inside Confirmation Panel (drag existing pin or tap to place one)
  function handleConfirmationPinDrag(coord) {
    if (!isInsideServiceEnvelope(coord)) {
      Alert.alert('Out of Bounds', 'The selected coordinates are outside ELESEND service areas in Ghana.');
      return;
    }
    setPendingAddressRecord(prev => {
      if (!prev) return null;
      return {
        ...prev,
        coordinates: { latitude: coord.latitude, longitude: coord.longitude },
        latitude: coord.latitude,
        longitude: coord.longitude,
        provenance: PROVENANCE_TYPES.MANUAL_PIN,
        resolutionStatus: RESOLUTION_STATUSES.CUSTOMER_CONFIRMED,
        confidenceLevel: 95,
        pinPlacedByCustomer: true,
        requiresConfirmation: false
      };
    });
  }

  // Commit address from Confirmation Panel into booking
  async function confirmPendingAddress() {
    if (!pendingAddressRecord) return;
    if (!pendingAddressRecord.coordinates ||
        !Number.isFinite(pendingAddressRecord.coordinates.latitude) ||
        !Number.isFinite(pendingAddressRecord.coordinates.longitude)) {
      Alert.alert('Pin Required', 'We could not locate this address automatically. Tap the map to place the pin at your exact building or junction.');
      return;
    }
    if (!isInsideServiceEnvelope(pendingAddressRecord.coordinates)) {
      Alert.alert('Out of Bounds', 'The selected coordinates are outside ELESEND service areas in Ghana.');
      return;
    }
    const finalRecord = {
      ...pendingAddressRecord,
      latitude: pendingAddressRecord.coordinates.latitude,
      longitude: pendingAddressRecord.coordinates.longitude,
      requiresConfirmation: false,
      customerConfirmed: true,
      resolutionStatus: pendingAddressRecord.resolutionStatus === RESOLUTION_STATUSES.VERIFIED
        ? RESOLUTION_STATUSES.VERIFIED
        : RESOLUTION_STATUSES.CUSTOMER_CONFIRMED
    };
    updateBooking(confirmTarget, finalRecord);
    setAddressConfirmModal(false);
    setAddressModalVisible(false);
    setPlaceQuery('');
    setPlacesList([]);

    // Automatically calculate authoritative backend quote if both points are confirmed
    const otherTarget = confirmTarget === 'pickup' ? 'destination' : 'pickup';
    const otherLoc = booking[otherTarget];
    if (isConfirmedLocation(otherLoc)) {
      const p = confirmTarget === 'pickup' ? finalRecord : otherLoc;
      const d = confirmTarget === 'destination' ? finalRecord : otherLoc;
      const reqSeq = ++quoteSeqRef.current;
      try {
        const reqBody = parcelQuoteBody(booking, p, d, auth.phone);
        const quote = await call('POST', ENDPOINTS.parcelQuote, reqBody);
        if (reqSeq === quoteSeqRef.current) {
          setQuoted({ ...quote, requestBody: reqBody, bookingIdempotencyKey: `idemp_${Crypto.randomUUID()}` });
        }
      } catch (err) {
        if (reqSeq === quoteSeqRef.current) setError(err.message);
      }
    }
  }

  async function getParcelQuote() {
    if (!booking.pickup || !booking.destination) {
      Alert.alert('Address Missing', 'Please select both pickup and destination locations.');
      return;
    }
    // Throws a user-facing error if either end is unconfirmed or unresolved.
    const reqSeq = ++quoteSeqRef.current;
    const body = parcelQuoteBody(booking, booking.pickup, booking.destination, auth.phone, booking.paymentMethod, deliveryInstructions);
    const quote = await call('POST', ENDPOINTS.parcelQuote, body);
    if (reqSeq === quoteSeqRef.current) {
      setQuoted({ ...quote, requestBody: body, bookingIdempotencyKey: `idemp_${Crypto.randomUUID()}` });
      setStep(1);
    }
  }

  // Step 2 Requote when payment method changes (Contract requirement)
  async function changeParcelPaymentTerms(newMethod) {
    updateBooking('paymentMethod', newMethod);
    if (isConfirmedLocation(booking.pickup) && isConfirmedLocation(booking.destination)) {
      const reqSeq = ++quoteSeqRef.current;
      try {
        const reqBody = parcelQuoteBody(booking, booking.pickup, booking.destination, auth.phone, newMethod, deliveryInstructions);
        const quote = await call('POST', ENDPOINTS.parcelQuote, reqBody);
        if (reqSeq === quoteSeqRef.current) {
          setQuoted({ ...quote, requestBody: reqBody, bookingIdempotencyKey: `idemp_${Crypto.randomUUID()}` });
        }
      } catch (err) {
        if (reqSeq === quoteSeqRef.current) setError(err.message);
      }
    }
  }

  async function bookParcel() {
    const currentBody = parcelQuoteBody(booking, booking.pickup, booking.destination, auth.phone, booking.paymentMethod, deliveryInstructions);
    if (!isQuoteBoundToInputs(quoted, currentBody)) {
      throw new Error('Your delivery details changed after the price was quoted. Please refresh your quote.');
    }
    const idempKey = quoted?.bookingIdempotencyKey || `idemp_${Crypto.randomUUID()}`;
    const { body, options } = buildParcelBookingRequest(quoted?.id, idempKey);
    const shipment = await call('POST', ENDPOINTS.parcelBook, body, options);
    if (booking.paymentMethod && booking.paymentMethod !== 'CASH') {
      await startOrResumeCheckout(shipment.id, booking.paymentMethod);
    } else {
      Alert.alert('Booking Confirmed!', `Parcel shipment #${shipment.id.slice(0, 8)} has been booked. Nearby couriers are being notified.`);
    }
    setStep(0);
    setQuoted(null);
    setTab('Activity');
    refreshActivity();
  }

  async function startOrResumeCheckout(shipmentId, paymentMethod) {
    const res = await call('POST', ENDPOINTS.shipmentCheckout(shipmentId),
      buildCheckoutRequest(`chk_${Crypto.randomUUID()}`, paymentEmail));
    const url = res?.checkoutUrl || res?.authorizationUrl;
    if (url) {
      Linking.openURL(url);
    } else {
      Alert.alert('Checkout Initiated', 'Payment request sent. Please approve the prompt on your mobile money phone.');
    }
    refreshActivity();
  }

  async function cancelOrder(id, isFood = false, shipmentState = null, foodState = null) {
    const terms = isFood ? null : await call('GET', `/api/v1/shipments/${id}/cancel-terms`).catch(() => null);
    Alert.alert(
      'Cancel Delivery',
      terms?.feeMinor > 0
        ? `A rider is already on the way, so ${ghc(terms.feeMinor)} goes to them and ${ghc(terms.refundMinor)} is refunded. Cancel this delivery?`
        : 'Are you sure you want to cancel this delivery?',
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Yes, Cancel',
          style: 'destructive',
          onPress: () => execute(async () => {
            if (isFood) {
              await call('POST', ENDPOINTS.foodCancel(id), {
                reason: 'Customer cancelled via app'
              });
            } else {
              await call('POST', ENDPOINTS.shipmentTransition(id), buildShipmentCancelRequest());
            }
            refreshActivity();
          })
        }
      ]
    );
  }

  async function loadFoodRestaurants() {
    try {
      // Prefer a confirmed GPS fix; never invent Accra/Osu coordinates for discovery bias.
      const targetCoords = detectedLocation?.coordinates
        || (Number.isFinite(Number(detectedLocation?.latitude)) && Number.isFinite(Number(detectedLocation?.longitude))
          ? { latitude: Number(detectedLocation.latitude), longitude: Number(detectedLocation.longitude) }
          : null);
      if (!targetCoords) {
        setFoodRestaurants([]);
        setFoodNotice('location');
        return;
      }
      const data = await call('GET', `/api/v1/restaurants?lat=${targetCoords.latitude}&lon=${targetCoords.longitude}`);
      setFoodRestaurants(Array.isArray(data) ? data : (data?.restaurants || []));
      setFoodNotice('');
    } catch {
      setFoodRestaurants([]);
      setFoodNotice('failed');
    }
  }

  async function selectRestaurant(rest) {
    setSelectedRest(rest);
    try {
      const menu = await call('GET', `/api/v1/restaurants/${rest.id}/menu`);
      const flatItems = Array.isArray(menu?.items)
        ? menu.items
        : [
            ...(menu?.categories || []).flatMap(c => c.items || []),
            ...(menu?.uncategorized || [])
          ];
      setRestMenu({ ...(menu || {}), items: flatItems });
    } catch {
      setRestMenu({ categories: [], items: [] });
    }
  }

  function openDishCustomizer(dish) {
    setSelectedDish(dish);
    setSelectedOptions([]);
    setDishModal(true);
  }

  function toggleModifierOption(modifier, option) {
    const maxSel = modifier.max_selections ?? modifier.max_selection ?? 1;
    const isSingle = maxSel === 1;
    const isSelected = selectedOptions.some(o => o.id === option.id);
    if (isSingle) {
      setSelectedOptions(opts => [...opts.filter(o => o.modifier_id !== modifier.id), option]);
    } else {
      if (isSelected) {
        setSelectedOptions(opts => opts.filter(o => o.id !== option.id));
      } else {
        const currentCount = selectedOptions.filter(o => o.modifier_id === modifier.id).length;
        if (currentCount < (maxSel || 10)) {
          setSelectedOptions(opts => [...opts, option]);
        }
      }
    }
  }

  function addDishToCart() {
    if (!selectedDish) return;
    const mods = selectedDish.modifiers || [];
    for (const mod of mods) {
      const minSel = mod.min_selections ?? mod.min_selection ?? (mod.is_required ? 1 : 0);
      if (minSel > 0) {
        const picked = selectedOptions.filter(o => o.modifier_id === mod.id);
        if (picked.length < minSel) {
          Alert.alert('Required Selection Missing', `Please select at least ${minSel} option(s) for "${mod.name}".`);
          return;
        }
      }
    }
    const cartEntry = {
      cartId: Crypto.randomUUID(),
      itemId: selectedDish.id,
      name: selectedDish.name,
      priceMinor: selectedDish.price_minor,
      options: [...selectedOptions]
    };
    setCartItems(items => [...items, cartEntry]);
    setDishModal(false);
    setSelectedDish(null);
    setSelectedOptions([]);
  }

  // `deliveryLocation` is passed explicitly (avoids the stale-state first-tap bug) and must be a
  // customer-confirmed location. No default/fabricated coordinates are ever used for food orders.
  async function getFoodCheckoutQuote(deliveryLocation = foodDeliveryCoords, codeOverride = appliedPromoCode) {
    if (!selectedRest || cartItems.length === 0) return;
    const activeCode = typeof codeOverride === 'string' ? codeOverride.trim() : '';
    const quoteBody = buildFoodQuoteRequest({
      restaurantId: selectedRest.id,
      cartItems,
      deliveryAddress: foodDeliveryAddress,
      deliveryLocation,
      customerPhone: normalizeGhanaPhone(foodRecipientPhone || auth.phone),
      specialInstructions: foodInstructions,
      promoCode: activeCode || undefined
    });
    const quote = await call('POST', ENDPOINTS.foodQuote, quoteBody);
    setAppliedPromoCode(activeCode);
    setFoodQuote({ ...quote, requestBody: quoteBody, orderIdempotencyKey: `food_${Crypto.randomUUID()}` });
  }

  async function submitFoodOrder() {
    if (foodQuote?.totalMinor === undefined || !foodQuote?.requestBody) throw Error('Please calculate quote first');
    const idempKey = foodQuote.orderIdempotencyKey || `food_${Crypto.randomUUID()}`;
    const { body, options } = buildFoodOrderRequest(foodQuote.requestBody, idempKey, 'MOMO');
    const order = await call('POST', ENDPOINTS.foodOrder, body, options);
    const orderId = order?.orderId || order?.id || '';
    if (order?.shipment_id) {
      await startOrResumeCheckout(order.shipment_id, 'MOMO');
    } else {
      Alert.alert('Order Placed!', `Your food order #${String(orderId).slice(0, 8)} is awaiting payment and restaurant confirmation.`);
    }
    setCartItems([]);
    setCartModal(false);
    setSelectedRest(null);
    setFoodQuote(null);
    setPromoCodeInput('');
    setAppliedPromoCode('');
    setTab('Activity');
    refreshActivity();
  }

  async function refreshActivity() {
    try {
      const [s, f] = await Promise.all([
        call('GET', '/api/v1/shipments').catch(() => []),
        call('GET', '/api/v1/food-orders').catch(() => [])
      ]);
      setMyShipments(s);
      setMyFoodOrders(f);
    } catch {}
  }

  // Order-Scoped Real-Time Chat Actions
  async function openOrderChat({ conversationType, shipmentId = null, foodOrderId = null }) {
    try {
      const conv = await call('POST', ENDPOINTS.chatConversations, {
        conversationType,
        shipmentId: shipmentId || undefined,
        foodOrderId: foodOrderId || undefined
      });
      setActiveConversation(conv);
      setChatModalVisible(true);
      await refreshChatMessages(conv.id);
    } catch (e) {
      Alert.alert('Chat Unavailable', e.message || 'Could not open conversation for this order.');
    }
  }

  async function refreshChatMessages(convId = activeConversation?.id) {
    if (!convId) return;
    try {
      const data = await call('GET', ENDPOINTS.chatMessages(convId));
      setActiveConversation(data.conversation);
      setChatMessages(data.messages || []);
      setChatTyping(data.typing || []);
      if (data.conversation?.unreadCount > 0) {
        await call('POST', ENDPOINTS.chatRead(convId), {}).catch(() => {});
      }
    } catch {}
  }

  useEffect(() => {
    if (!chatModalVisible || !activeConversation?.id) return;
    let cancelled = false;
    const pollChat = async () => {
      if (cancelled || AppState.currentState !== 'active') return;
      await refreshChatMessages(activeConversation.id);
    };
    const interval = setInterval(pollChat, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [chatModalVisible, activeConversation?.id]);

  async function sendCustomerChatMessage(messageType = 'text', customBody = null, quickReplyKey = null, locationPin = null) {
    if (!activeConversation?.id || chatSending) return;
    setChatSending(true);
    try {
      const payload = buildChatMessageRequest({
        clientMessageId: `cust_${Crypto.randomUUID()}`,
        messageType,
        body: customBody !== null ? customBody : chatText,
        quickReplyKey,
        locationPin
      });
      await call('POST', ENDPOINTS.chatMessages(activeConversation.id), payload);
      if (messageType === 'text') setChatText('');
      await refreshChatMessages(activeConversation.id);
    } catch (e) {
      Alert.alert('Message Not Sent', e.message || 'Could not send message.');
    } finally {
      setChatSending(false);
    }
  }

  async function shareConfirmedLocationPinInChat() {
    const confirmedLoc = isConfirmedLocation(booking.destination)
      ? booking.destination
      : isConfirmedLocation(detectedLocation)
      ? detectedLocation
      : null;
    if (!confirmedLoc) {
      Alert.alert('Confirmed Pin Required', 'Please confirm your location on the map first before sharing an advisory pin.');
      return;
    }
    await sendCustomerChatMessage('location_pin', null, null, {
      latitude: Number(confirmedLoc.latitude ?? confirmedLoc.coordinates?.latitude),
      longitude: Number(confirmedLoc.longitude ?? confirmedLoc.coordinates?.longitude),
      label: `${confirmedLoc.title || confirmedLoc.address || 'Customer Gate Pin'} (Advisory Only)`,
      confirmed: true
    });
  }

  async function escalateCustomerChat() {
    if (!activeConversation?.id) return;
    try {
      const res = await call('POST', ENDPOINTS.chatEscalate(activeConversation.id), {
        supportCategory: 'order_issue',
        summary: 'Customer escalated active order conversation for support assistance.'
      });
      if (res?.supportConversation) {
        setActiveConversation(res.supportConversation);
        await refreshChatMessages(res.supportConversation.id);
        Alert.alert('Escalated to ELESEND Support', 'You are now connected with ELESEND Support for this order.');
      }
    } catch (e) {
      Alert.alert('Escalation Failed', e.message);
    }
  }

  async function reportCustomerChatAbuse(category = 'inappropriate_messages') {
    if (!activeConversation?.id) return;
    try {
      await call('POST', ENDPOINTS.chatReport(activeConversation.id), {
        category,
        details: 'Customer reported conversation from mobile app for safety review.'
      });
      Alert.alert('Report Submitted', 'ELESEND Safety & Support has received your report.');
    } catch (e) {
      Alert.alert('Report Failed', e.message);
    }
  }

  // ===========================================================================
  // SCREEN: AUTHENTICATION / ONBOARDING (Modern ELESEND Card Style)
  // ===========================================================================
  if (!auth) {
    return (
      <View style={styles.authContainer}>
        <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />
        <ScrollView contentContainerStyle={styles.authScroll} keyboardShouldPersistTaps="handled">
          <View style={styles.authHeader}>
            <View style={styles.logoBadge}>
              <Text style={styles.logoBadgeText}>E</Text>
            </View>
            <Text style={styles.authBrandTitle}>ELESEND</Text>
            <Text style={styles.authTagline}>GHANA'S FAST RELIABLE DELIVERY</Text>
          </View>

          <View style={styles.authCard}>
            <Text style={styles.authCardTitle}>{isSignup ? 'Create Account' : 'Welcome Back'}</Text>
            <Text style={styles.authCardSubtitle}>
              {isSignup ? 'Sign up to send packages, cargo & order food' : 'Sign in with your Ghana mobile number'}
            </Text>

            {Boolean(error) && (
              <View style={styles.errorBanner}>
                <Text style={styles.errorBannerText}>{error}</Text>
              </View>
            )}

            {isSignup && (
              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>Your Full Name</Text>
                <TextInput
                  style={styles.formInput}
                  placeholder="e.g. Kwame Mensah"
                  placeholderTextColor={colors.textPlaceholder}
                  value={credentials.name}
                  onChangeText={v => edit('name', v)}
                />
              </View>
            )}

            <View style={styles.formGroup}>
              <Text style={styles.formLabel}>Phone Number</Text>
              <View style={styles.phoneInputRow}>
                <View style={styles.ghanaBadge}>
                  <Text style={{ fontSize: 18 }}>🇬🇭</Text>
                  <Text style={styles.ghanaCode}>+233</Text>
                </View>
                <TextInput
                  style={styles.phoneInput}
                  placeholder="024 123 4567"
                  placeholderTextColor={colors.textPlaceholder}
                  keyboardType="phone-pad"
                  value={credentials.phone}
                  onChangeText={v => edit('phone', v)}
                />
              </View>
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.formLabel}>Password (12–128 characters)</Text>
              <TextInput
                style={styles.formInput}
                placeholder="Enter secure password"
                placeholderTextColor={colors.textPlaceholder}
                secureTextEntry
                value={credentials.password}
                onChangeText={v => edit('password', v)}
              />
            </View>

            {isSignup && <LegalNotice style={{ color: '#475569' }} linkColor="#0F766E" />}

            <TouchableOpacity
              style={styles.primaryActionButton}
              disabled={busy}
              onPress={() => execute(isSignup ? signUp : signIn)}>
              {busy ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryActionText}>{isSignup ? 'Create Account' : 'Sign In'}</Text>
              )}
            </TouchableOpacity>

            {!isSignup && (
              <TouchableOpacity
                style={styles.switchAuthTouch}
                onPress={() => {
                  setForgotModal(v => !v);
                  setRecoveryPhone(credentials.phone || '');
                  setError('');
                }}>
                <Text style={styles.switchAuthText}>Forgot password? Recover via SMS</Text>
              </TouchableOpacity>
            )}

            {forgotModal && !isSignup && (
              <View style={{ marginTop: 12, padding: 14, borderRadius: 12, backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#E2E8F0' }}>
                <Text style={{ fontWeight: '800', fontSize: 15, color: colors.textDark }}>Recover Account Password</Text>
                <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 4 }}>
                  Verify your registered Ghana phone with a 6-digit SMS code to set a new password.
                </Text>
                <TextInput
                  style={[styles.formInput, { marginTop: 10 }]}
                  placeholder="Registered phone (e.g. 024 123 4567)"
                  placeholderTextColor={colors.textPlaceholder}
                  keyboardType="phone-pad"
                  value={recoveryPhone}
                  onChangeText={setRecoveryPhone}
                />
                <TouchableOpacity
                  style={[styles.primaryActionButton, { marginTop: 10, backgroundColor: '#1E293B' }]}
                  disabled={busy}
                  onPress={() => execute(requestPasswordRecoveryChallenge)}>
                  <Text style={styles.primaryActionText}>Send 6-Digit Recovery Code</Text>
                </TouchableOpacity>
                {recoveryChallenge?.challengeId && (
                  <View style={{ marginTop: 10 }}>
                    <TextInput
                      style={styles.formInput}
                      placeholder="6-Digit SMS Code"
                      placeholderTextColor={colors.textPlaceholder}
                      keyboardType="number-pad"
                      maxLength={6}
                      value={recoveryCode}
                      onChangeText={setRecoveryCode}
                    />
                    <TextInput
                      style={[styles.formInput, { marginTop: 8 }]}
                      placeholder="New Password (12–128 characters)"
                      placeholderTextColor={colors.textPlaceholder}
                      secureTextEntry
                      maxLength={128}
                      value={recoveryNewPassword}
                      onChangeText={setRecoveryNewPassword}
                    />
                    <TouchableOpacity
                      style={[styles.primaryActionButton, { marginTop: 10 }]}
                      disabled={busy}
                      onPress={() => execute(submitPasswordReset)}>
                      <Text style={styles.primaryActionText}>Verify Code & Reset Password</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            )}

            <TouchableOpacity
              style={styles.switchAuthTouch}
              onPress={() => { setIsSignup(!isSignup); setForgotModal(false); setError(''); }}>
              <Text style={styles.switchAuthText}>
                {isSignup ? 'Already have an account? Sign In' : "Don't have an account? Sign Up"}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  // ===========================================================================
  // SCREEN: OTP VERIFICATION
  // ===========================================================================
  if (phoneState && !phoneState.verified) {
    return (
      <View style={styles.authContainer}>
        <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />
        <View style={[styles.authCard, { margin: 24, marginTop: 80 }]}>
          <Text style={{ fontSize: 32, marginBottom: 8 }}>🔑</Text>
          <Text style={styles.authCardTitle}>Verify Your Phone</Text>
          <Text style={styles.authCardSubtitle}>
            We sent a 6-digit verification code to {auth.phone}. Please enter it below:
          </Text>

          {Boolean(error) && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorBannerText}>{error}</Text>
            </View>
          )}

          <TextInput
            style={[styles.formInput, { textAlign: 'center', fontSize: 24, letterSpacing: 8, fontWeight: '800' }]}
            placeholder="••••••"
            placeholderTextColor={colors.textPlaceholder}
            keyboardType="number-pad"
            maxLength={6}
            value={phoneCode}
            onChangeText={setPhoneCode}
          />

          <TouchableOpacity
            style={[styles.primaryActionButton, { marginTop: 20 }]}
            disabled={busy}
            onPress={() => execute(verifyOtp)}>
            {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryActionText}>Verify Phone</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.switchAuthTouch}
            onPress={() => execute(async () => {
              const ch = await call('POST', '/api/v1/me/phone-challenge', {});
              setPhoneChallenge(ch);
              Alert.alert('Code Sent', 'A fresh 6-digit code has been sent.');
            })}>
            <Text style={styles.switchAuthText}>Resend Code via SMS</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ===========================================================================
  // MAIN APPLICATION LAYOUT (Yango-Style Light Canvas, Full Screen Map & Floating Sheets)
  // ===========================================================================
  return (
    <View style={styles.mainCanvas}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />

      {/* Top Universal App Header */}
      <View style={styles.topHeaderBar}>
        <TouchableOpacity style={styles.menuIconCircle} onPress={() => setTab('Profile')}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.textDark }}>☰</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.locationBreadcrumb} onPress={requestLocation}>
          <Text style={styles.brandTitleText}>ELESEND</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text style={styles.locationSubtitleText} numberOfLines={1}>
              {detectedLocation?.address || 'Set your location'}
            </Text>
            <Text style={{ fontSize: 12, color: colors.textSecondary }}>›</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity style={styles.profileAvatarCircle} onPress={() => setTab('Profile')}>
          <Text style={{ fontSize: 15 }}>👤</Text>
        </TouchableOpacity>
      </View>

      {/* Main Screen Body by Active Tab */}
      <View style={{ flex: 1 }}>

        {/* -------------------------------------------------------------------
            TAB 1: HOMEPAGE (Reference 5: Service cards, "Where to?", promos)
        --------------------------------------------------------------------- */}
        {tab === 'Home' && (
          <ScrollView contentContainerStyle={styles.homeScroll} showsVerticalScrollIndicator={false}>
            {/* Service Category Cards (3-column visual grid) */}
            <View style={styles.serviceCardsGrid}>
              {/* Delivery (Parcel) */}
              <TouchableOpacity
                style={styles.serviceCard}
                activeOpacity={0.85}
                onPress={() => { setBooking(b => ({ ...b, vehicle: 'motorcycle' })); setTab('Send'); }}>
                <View style={styles.serviceIllustrationBox}>
                  <Text style={{ fontSize: 36 }}>🏍…16710 tokens truncated…ext>
                </View>
              ) : pendingAddressRecord?.resolutionStatus === RESOLUTION_STATUSES.APPROXIMATE ? (
                <View style={[styles.statusBadge, { backgroundColor: '#FEF3C7', borderColor: '#FCD34D' }]}>
                  <Text style={[styles.statusBadgeText, { color: '#92400E' }]}>🟡 Approximate Location</Text>
                </View>
              ) : (
                <View style={[styles.statusBadge, { backgroundColor: '#F1F5F9', borderColor: '#CBD5E1' }]}>
                  <Text style={[styles.statusBadgeText, { color: '#475569' }]}>⚪ Unresolved Coordinates</Text>
                </View>
              )}

              {pendingAddressRecord?.manualComponents?.region ? (
                <View style={[styles.statusBadge, { backgroundColor: '#F8FAFC', borderColor: '#E2E8F0' }]}>
                  <Text style={[styles.statusBadgeText, { color: '#334155' }]}>
                    📍 {pendingAddressRecord.manualComponents.region}
                  </Text>
                </View>
              ) : null}
            </View>

            {/* Interactive Map Preview with Draggable Pin */}
            <View style={styles.confirmMapContainer}>
              <MapView
                ref={confirmMapRef}
                style={StyleSheet.absoluteFill}
                accessibilityLabel="Location confirmation map. Tap to place or move the pin."
                onPress={e => handleConfirmationPinDrag(e.nativeEvent.coordinate)}
                initialRegion={{
                  // Camera start point only (never stored as an address coordinate).
                  latitude: pendingAddressRecord?.coordinates?.latitude ?? detectedLocation?.latitude ?? 5.6037,
                  longitude: pendingAddressRecord?.coordinates?.longitude ?? detectedLocation?.longitude ?? -0.1870,
                  longitudeDelta: pendingAddressRecord?.coordinates ? 0.03 : 0.12
                }}>
                {pendingAddressRecord?.coordinates && (
                  <Marker
                    coordinate={pendingAddressRecord.coordinates}
                    pinColor={confirmTarget === 'pickup' ? colors.primary : colors.danger}
                    draggable
                    onDragEnd={e => handleConfirmationPinDrag(e.nativeEvent.coordinate)}
                    title="Drag to exact gate"
                  />
                )}
              </MapView>

              {/* Floating Helper Banner */}
              <View pointerEvents="none" style={styles.confirmMapTipBanner}>
                <Text style={styles.confirmMapTipText}>
                  {pendingAddressRecord?.coordinates
                    ? '📍 Drag the pin to your exact building, gate, or junction'
                    : '📍 Address not found on the map — tap the map to place your pin'}
                </Text>
              </View>
            </View>
            {pendingAddressRecord?.advisory ? (
              <Text style={[styles.inputMicroLabel, { marginTop: 6, color: '#92400E' }]}>{pendingAddressRecord.advisory}</Text>
            ) : null}

            {/* Handover & Landmark Instructions (Required by contract) */}
            <View style={{ marginTop: 10 }}>
              <Text style={styles.inputMicroLabel}>Handover & Landmark Instructions (Optional)</Text>
              <TextInput
                style={styles.sheetNoteInput}
                placeholder="e.g. Opposite blue water kiosk, call upon arrival"
                placeholderTextColor={colors.textPlaceholder}
                value={pendingAddressRecord?.deliveryInstructions || deliveryInstructions}
                onChangeText={t => {
                  setDeliveryInstructions(t);
                  setPendingAddressRecord(prev => prev ? ({ ...prev, deliveryInstructions: t }) : null);
                }}
              />
            </View>

            {/* Action Buttons */}
            <View style={styles.confirmActionRow}>
              <TouchableOpacity
                style={styles.confirmEditBtn}
                onPress={() => setAddressConfirmModal(false)}>
                <Text style={styles.confirmEditBtnText}>Edit Details</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.confirmCommitBtn}
                onPress={confirmPendingAddress}>
                <Text style={styles.confirmCommitBtnText}>Confirm Location ›</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* =====================================================================
          MODAL: LIVE COURIER TRACKING (MapLibre with RiderMarker & Polyline)
      ======================================================================= */}
      <Modal visible={Boolean(trackingShipment)} animationType="slide" onRequestClose={() => setTrackingShipment(null)}>
        <View style={{ flex: 1, backgroundColor: '#FFFFFF' }}>
          <View style={styles.trackingModalHeader}>
            <TouchableOpacity onPress={() => setTrackingShipment(null)} style={styles.trackingCloseButton}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: colors.textDark }}>✕ Close</Text>
            </TouchableOpacity>
            <Text style={styles.trackingHeaderTitle}>Live Courier Tracking</Text>
            <View style={{ width: 40 }} />
          </View>

          <RiderCard
            shipmentId={trackingShipment?.id}
            rider={liveRider}
            lastSeen={courierLastSeen}
            onSupport={() => openOrderChat({ conversationType: 'CUSTOMER_SUPPORT', shipmentId: trackingShipment.id })}
          />

          {/* Call Courier Bar */}
          {['RIDER_ASSIGNED', 'PICKUP_VERIFIED', 'IN_TRANSIT'].includes(trackingShipment?.state) && Boolean(trackingShipment?.rider_phone || trackingShipment?.riderPhone || trackingShipment?.details?.rider_phone) && (
            <View style={{ paddingHorizontal: 16, paddingBottom: 10, flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity
                style={[styles.callCourierButton, { flex: 1 }]}
                onPress={() => Linking.openURL(`tel:${trackingShipment.rider_phone || trackingShipment.riderPhone || trackingShipment.details?.rider_phone}`)}>
                <Text style={styles.callCourierText}>
                  📞 Call Courier ({formatGhanaDisplayPhone(trackingShipment.rider_phone || trackingShipment.riderPhone || trackingShipment.details?.rider_phone)})
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.callCourierButton, { backgroundColor: '#0F172A', paddingHorizontal: 14 }]}
                onPress={() => openOrderChat({ conversationType: 'CUSTOMER_RIDER', shipmentId: trackingShipment.id })}>
                <Text style={styles.callCourierText}>💬 Chat Courier</Text>
              </TouchableOpacity>
            </View>
          )}

          <EmergencyButton shipmentId={trackingShipment?.id} />
          {shareToken ? (
            <TouchableOpacity
              accessibilityRole="button"
              style={{ paddingHorizontal: 16, paddingVertical: 10 }}
              onPress={() => Share.share({ message: `Track this ELESEND delivery: ${BASE}/track/${shareToken}` }).catch(() => null)}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: colors.primary }}>Share tracking link</Text>
            </TouchableOpacity>
          ) : null}

          {deliveryEta?.message ? (
            <Text accessibilityLiveRegion="polite" style={{ paddingHorizontal: 16, paddingVertical: 10, fontSize: 14, fontWeight: '700', color: '#0F172A', backgroundColor: '#F1F5F9' }}>
              {deliveryEta.message}
            </Text>
          ) : null}

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
              {(liveCourier || trackingShipment?.courier) && (
                <RiderMarker
                  coordinate={{
                    latitude: (liveCourier || trackingShipment.courier).latitude,
                    longitude: (liveCourier || trackingShipment.courier).longitude
                  }}
                  heading={(liveCourier || trackingShipment.courier).heading || 0}
                  vehicle={(liveCourier || trackingShipment.courier).vehicle || trackingShipment?.vehicle || 'motorcycle'}
                  title="Courier"
                />
              )}
              {!liveCourier && courierLastSeen && (
                <Marker
                  coordinate={{ latitude: courierLastSeen.latitude, longitude: courierLastSeen.longitude }}
                  pinColor="#64748B"
                  title={`Rider last seen ${courierLastSeen.minutesAgo} min ago`}
                />
              )}
              {(liveCourier || trackingShipment?.courier) && trackingShipment?.destination && (
                <Polyline
                  coordinates={[
                    {
                      latitude: (liveCourier || trackingShipment.courier).latitude,
                      longitude: (liveCourier || trackingShipment.courier).longitude
                    },
                    {
                      latitude: trackingShipment.destination.latitude,
                      longitude: trackingShipment.destination.longitude
                    }
                  ]}
                  strokeColor={colors.primary}
                  strokeWidth={4}
                />
              )}
            </MapView>
          </View>
        </View>
      </Modal>

      <DeleteAccountModal
        visible={deleteAccountOpen}
        onClose={() => setDeleteAccountOpen(false)}
        onDeleted={async () => {
          await clearToken();
          setDeleteAccountOpen(false);
          setAuth(null);
        }}
      />

      {/* =====================================================================
          MODAL: DISH CUSTOMIZER (Required modifier checks & Radio vs Checkbox)
      ======================================================================= */}
      <Modal visible={dishModal} animationType="slide" transparent onRequestClose={() => setDishModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.customizerCard}>
            <Text style={styles.customizerTitle}>{selectedDish?.name}</Text>
            <Text style={styles.customizerPrice}>{ghc(selectedDish?.price_minor)}</Text>

            <ScrollView style={{ maxHeight: 260, marginVertical: 12 }}>
              {(selectedDish?.modifiers || []).map(mod => {
                const isSingle = (mod.max_selections ?? mod.max_selection ?? 1) === 1;
                const minSel = mod.min_selections ?? mod.min_selection ?? (mod.is_required ? 1 : 0);
                return (
                  <View key={mod.id} style={{ marginBottom: 12 }}>
                    <Text style={styles.modifierGroupName}>{mod.name} {minSel > 0 ? '(Required)' : '(Optional)'}</Text>
                    {(mod.options || []).map(opt => {
                      const isSelected = selectedOptions.some(o => o.id === opt.id);
                      return (
                        <TouchableOpacity
                          key={opt.id}
                          style={styles.modifierOptionRow}
                          onPress={() => toggleModifierOption(mod, opt)}>
                          {/* Contract requirement: isSingle ? (isSelected ? '◉' : '○') : (isSelected ? '☑' : '☐') */}
                          <Text style={{ fontSize: 16, marginRight: 8, color: colors.primary }}>
                            {isSingle ? (isSelected ? '◉' : '○') : (isSelected ? '☑' : '☐')}
                          </Text>
                          <Text style={{ flex: 1, fontSize: 14, color: colors.textDark }}>{opt.name}</Text>
                          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary }}>+{ghc(opt.price_minor ?? opt.extra_minor ?? 0)}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                );
              })}
            </ScrollView>

            <TouchableOpacity style={styles.primaryActionButton} onPress={addDishToCart}>
              <Text style={styles.primaryActionText}>Add to Cart</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.closeSheetButton} onPress={() => setDishModal(false)}>
              <Text style={styles.closeSheetText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* =====================================================================
          MODAL: FOOD CART & CHECKOUT
      ======================================================================= */}
      <Modal visible={cartModal} animationType="slide" onRequestClose={() => setCartModal(false)}>
        <View style={{ flex: 1, backgroundColor: '#FFFFFF', padding: 20, paddingTop: 48 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.cartTitleBold}>Your Food Cart</Text>
            <TouchableOpacity onPress={() => setCartModal(false)}>
              <Text style={{ fontSize: 18, color: colors.textSecondary }}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={{ flex: 1, marginVertical: 16 }}>
            {cartItems.map(item => (
              <View key={item.cartId} style={styles.cartItemRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cartItemName}>{item.name}</Text>
                  {item.options.map(o => (
                    <Text key={o.id} style={styles.cartItemOptionSub}>+ {o.name}</Text>
                  ))}
                </View>
                <Text style={styles.cartItemPrice}>{ghc(item.priceMinor)}</Text>
              </View>
            ))}

            {/* Food delivery address fields */}
            <View style={{ marginTop: 14 }}>
              <Text style={styles.inputMicroLabel}>Delivery Address</Text>
              <TextInput
                style={styles.sheetNoteInput}
                placeholder="Dropoff address or landmark"
                placeholderTextColor={colors.textPlaceholder}
                value={foodDeliveryAddress}
                onChangeText={setFoodDeliveryAddress}
              />
              <Text style={[styles.inputMicroLabel, { marginTop: 6 }]}>
                {isConfirmedLocation(booking.destination)
                  ? `Delivery pin: ${booking.destination.title || booking.destination.address}`
                  : 'Delivery pin not set — confirm your delivery location on the map first.'}
              </Text>
              {!isConfirmedLocation(booking.destination) && (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Set delivery location on map"
                  style={[styles.primaryActionButton, { marginTop: 8, backgroundColor: colors.textDark }]}
                  onPress={() => { setCartModal(false); setLocationTarget('destination'); setAddressModalVisible(true); }}>
                  <Text style={styles.primaryActionText}>Set Delivery Location</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Promo Code Entry */}
            <View style={{ marginTop: 14 }}>
              <Text style={styles.inputMicroLabel}>Promo Code / Voucher</Text>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <TextInput
                  style={[styles.sheetNoteInput, { flex: 1, marginBottom: 0 }]}
                  placeholder="Enter promo code (e.g. WELCOME20)"
                  placeholderTextColor={colors.textPlaceholder}
                  autoCapitalize="characters"
                  value={promoCodeInput}
                  onChangeText={setPromoCodeInput}
                />
                {Boolean(appliedPromoCode) && (
                  <TouchableOpacity
                    style={{ backgroundColor: '#FEE2E2', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8 }}
                    onPress={() => {
                      setPromoCodeInput('');
                      setAppliedPromoCode('');
                      const confirmed = isConfirmedLocation(booking.destination) ? booking.destination : null;
                      if (confirmed) execute(() => getFoodCheckoutQuote(confirmed, ''));
                    }}>
                    <Text style={{ color: '#DC2626', fontWeight: '700', fontSize: 12 }}>Remove</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>

            <TouchableOpacity
              style={[styles.primaryActionButton, { marginTop: 14 }]}
              onPress={() => {
                const confirmed = isConfirmedLocation(booking.destination) ? booking.destination : null;
                setFoodDeliveryCoords(confirmed);
                execute(() => getFoodCheckoutQuote(confirmed, promoCodeInput));
              }}>
              <Text style={styles.primaryActionText}>Calculate Food Quote</Text>
            </TouchableOpacity>

            {/* Contract requirement: foodQuote.subtotalMinor & foodQuote.totalMinor */}
            {Boolean(foodQuote) && (
              <View style={styles.foodQuoteBox}>
                <View style={styles.foodQuoteRow}>
                  <Text style={styles.foodQuoteLabel}>Food Subtotal</Text>
                  <Text style={styles.foodQuoteValue}>{ghc(foodQuote.subtotalMinor)}</Text>
                </View>
                {Number(foodQuote.foodDiscountMinor || 0) > 0 && (
                  <View style={styles.foodQuoteRow}>
                    <Text style={[styles.foodQuoteLabel, { color: '#059669' }]}>Food Promo Discount</Text>
                    <Text style={[styles.foodQuoteValue, { color: '#059669' }]}>-{ghc(foodQuote.foodDiscountMinor)}</Text>
                  </View>
                )}
                <View style={styles.foodQuoteRow}>
                  <Text style={styles.foodQuoteLabel}>Delivery Fee</Text>
                  <Text style={styles.foodQuoteValue}>{ghc(foodQuote.deliveryFeeMinor)}</Text>
                </View>
                {Number(foodQuote.deliveryDiscountMinor || 0) > 0 && (
                  <View style={styles.foodQuoteRow}>
                    <Text style={[styles.foodQuoteLabel, { color: '#059669' }]}>Delivery Promo Discount</Text>
                    <Text style={[styles.foodQuoteValue, { color: '#059669' }]}>-{ghc(foodQuote.deliveryDiscountMinor)}</Text>
                  </View>
                )}
                {(foodQuote.appliedPromotions || []).map(p => (
                  <Text key={p.campaignId || p.title} style={{ fontSize: 11, color: '#059669', fontWeight: '600', marginTop: 2 }}>
                    🎁 {p.badgeText || p.title} ({p.promoCode || 'Auto-applied'})
                  </Text>
                ))}
                <View style={[styles.foodQuoteRow, { borderTopWidth: 1, borderTopColor: '#E2E8F0', paddingTop: 8, marginTop: 4 }]}>
                  <Text style={[styles.foodQuoteLabel, { fontWeight: '800', color: colors.textDark }]}>Total</Text>
                  <Text style={[styles.foodQuoteValue, { fontWeight: '800', color: colors.brandCoral }]}>{ghc(foodQuote.totalMinor)}</Text>
                </View>
                {digitalFeeNote() && (
                  <Text style={{ fontSize: 11, color: colors.textSecondary, marginTop: 6 }}>{digitalFeeNote()}</Text>
                )}
              </View>
            )}
          </ScrollView>

          {Boolean(foodQuote) && (
            <TouchableOpacity style={styles.primaryActionButton} onPress={() => execute(submitFoodOrder)}>
              <Text style={styles.primaryActionText}>Submit & Pay with Mobile Money</Text>
            </TouchableOpacity>
          )}
        </View>
      </Modal>

      {/* =====================================================================
          MODAL: ORDER-SCOPED REAL-TIME CHAT (Rider / Restaurant / Support)
      ======================================================================= */}
      <Modal visible={chatModalVisible} animationType="slide" onRequestClose={() => setChatModalVisible(false)}>
        <View style={{ flex: 1, backgroundColor: '#F8FAFC', paddingTop: 44 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#E2E8F0', backgroundColor: '#FFFFFF' }}>
            <View>
              <Text style={{ fontSize: 16, fontWeight: '800', color: colors.textDark }}>
                💬 {activeConversation?.conversationType || 'Order Chat'}
              </Text>
              <Text style={{ fontSize: 11, color: colors.textSecondary }}>
                State: {activeConversation?.state || 'ACTIVE'} • Epoch #{activeConversation?.assignmentEpoch || 1}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity
                style={{ backgroundColor: '#FEF3C7', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 }}
                onPress={escalateCustomerChat}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#B45309' }}>🎧 Escalate</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ backgroundColor: '#FEE2E2', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 }}
                onPress={() => reportCustomerChatAbuse('inappropriate_messages')}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#DC2626' }}>🚩 Report</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setChatModalVisible(false)} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
                <Text style={{ fontSize: 18, color: colors.textSecondary }}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={{ backgroundColor: '#EFF6FF', paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#BFDBFE' }}>
            <Text style={{ fontSize: 11, color: '#1E40AF', fontWeight: '600' }}>
              🔒 Safety Notice: Check your parcel at handover. Rider confirmation is not customer-verified proof. Report missing items promptly. Chat cannot alter paid delivery addresses.
            </Text>
          </View>

          <ScrollView style={{ flex: 1, padding: 14 }}>
            {chatMessages.map(msg => {
              const isMine = msg.senderRole === 'customer';
              return (
                <View
                  key={msg.id}
                  style={{
                    alignSelf: isMine ? 'flex-end' : 'flex-start',
                    backgroundColor: msg.senderRole === 'system' ? '#F1F5F9' : isMine ? '#0F172A' : '#FFFFFF',
                    borderRadius: 12,
                    padding: 10,
                    marginBottom: 8,
                    maxWidth: '82%',
                    borderWidth: isMine ? 0 : 1,
                    borderColor: '#E2E8F0'
                  }}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: isMine ? '#94A3B8' : '#64748B', marginBottom: 2 }}>
                    {String(msg.senderRole || '').toUpperCase()} • #{msg.seq}
                  </Text>
                  {msg.messageType === 'voice_note' ? <VoiceNoteBubble message={msg} color={isMine ? '#FFFFFF' : '#0F172A'} /> : (
                  <Text style={{ fontSize: 13, color: isMine ? '#FFFFFF' : '#0F172A' }}>
                    {msg.body || msg.bodyText || (msg.messageType === 'location_pin' ? `📍 Pin: ${msg.locationPin?.label || ''}` : '')}
                  </Text>
                  )}
                  <Text style={{ fontSize: 10, color: isMine ? '#CBD5E1' : '#94A3B8', marginTop: 4, textAlign: 'right' }}>
                    {msg.deliveryStatus || 'SENT'}
                  </Text>
                </View>
              );
            })}
            {Array.isArray(chatTyping) && chatTyping.length > 0 && (
              <Text style={{ fontSize: 11, color: '#64748B', fontStyle: 'italic' }}>Participant is typing...</Text>
            )}
          </ScrollView>

          {/* Customer Quick Replies & Confirmed Location Pin Share */}
          <View style={{ backgroundColor: '#FFFFFF', paddingHorizontal: 12, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#E2E8F0' }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
              {[
                { key: 'cust_landmark_shop', label: 'Near the landmark shop.' },
                { key: 'cust_call_arrival', label: 'Please call on arrival.' },
                { key: 'cust_coming_outside', label: "I'm coming outside now." },
                { key: 'cust_main_entrance', label: 'Deliver to main entrance.' }
              ].map(preset => (
                <TouchableOpacity
                  key={preset.key}
                  style={{ backgroundColor: '#F1F5F9', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6, marginRight: 6 }}
                  onPress={() => sendCustomerChatMessage('quick_reply', preset.label, preset.key)}>
                  <Text style={{ fontSize: 11, color: '#0F172A', fontWeight: '600' }}>{preset.label}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={{ backgroundColor: '#ECFDF5', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6, marginRight: 6 }}
                onPress={shareConfirmedLocationPinInChat}>
                <Text style={{ fontSize: 11, color: '#059669', fontWeight: '700' }}>📍 Share Confirmed Pin</Text>
              </TouchableOpacity>
            </ScrollView>

            <View style={{ flexDirection: 'row', gap: 8, paddingBottom: 16, alignItems: 'center' }}>
              <TextInput
                style={[styles.sheetNoteInput, { flex: 1, minWidth: 0, marginBottom: 0 }]}
                placeholder="Type an order message..."
                placeholderTextColor={colors.textPlaceholder}
                value={chatText}
                onChangeText={setChatText}
              />
              {activeConversation?.conversationType === 'CUSTOMER_RIDER' && (
                <VoiceNoteRecorder
                  conversationId={activeConversation.id}
                  onSent={message => setChatMessages(prev => (prev.some(m => m.id === message.id) ? prev : [...prev, message]))}
                  onError={text => Alert.alert('Voice note', text)}
                />
              )}
              <TouchableOpacity
                style={{ backgroundColor: colors.brandCoral, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 10 }}
                onPress={() => sendCustomerChatMessage('text', chatText)}>
                <Text style={{ color: '#FFFFFF', fontWeight: '800', fontSize: 13 }}>Send</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Bottom Global App Navigation Tabs */}
      <View style={styles.bottomNavTabBar}>
        <TouchableOpacity style={styles.navTabItem} onPress={() => setTab('Home')}>
          <Text style={[styles.navTabIcon, tab === 'Home' && styles.navTabIconActive]}>🏠</Text>
          <Text style={[styles.navTabLabel, tab === 'Home' && styles.navTabLabelActive]}>Home</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.navTabItem} onPress={() => setTab('Send')}>
          <Text style={[styles.navTabIcon, tab === 'Send' && styles.navTabIconActive]}>📦</Text>
          <Text style={[styles.navTabLabel, tab === 'Send' && styles.navTabLabelActive]}>Delivery</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.navTabItem} onPress={() => setTab('Cargo')}>
          <Text style={[styles.navTabIcon, tab === 'Cargo' && styles.navTabIconActive]}>🚚</Text>
          <Text style={[styles.navTabLabel, tab === 'Cargo' && styles.navTabLabelActive]}>Cargo</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.navTabItem} onPress={() => setTab('Food')}>
          <Text style={[styles.navTabIcon, tab === 'Food' && styles.navTabIconActive]}>🍲</Text>
          <Text style={[styles.navTabLabel, tab === 'Food' && styles.navTabLabelActive]}>Food</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.navTabItem} onPress={() => setTab('Activity')}>
          <Text style={[styles.navTabIcon, tab === 'Activity' && styles.navTabIconActive]}>📋</Text>
          <Text style={[styles.navTabLabel, tab === 'Activity' && styles.navTabLabelActive]}>Activity</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const HEADER_CIRCLE = { width: 38, height: 38, borderRadius: 19, backgroundColor: '#F1F5F9', alignItems: 'center', justifyContent: 'center' };

const styles = StyleSheet.create({
  // Global Canvas (Modern Light Theme)
  mainCanvas: { flex: 1, backgroundColor: '#F8FAFC' },
  topHeaderBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'android' ? 44 : 52,
    paddingBottom: 12,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9'
  },
  menuIconCircle: HEADER_CIRCLE,
  locationBreadcrumb: { alignItems: 'center' },
  brandTitleText: { fontSize: 17, fontWeight: '900', color: '#0F172A', letterSpacing: 0.5 },
  locationSubtitleText: { fontSize: 12, fontWeight: '500', color: '#475569', maxWidth: 180 },
  profileAvatarCircle: HEADER_CIRCLE,

  // Auth & Onboarding
  authContainer: { flex: 1, backgroundColor: '#FFFFFF' },
  authScroll: { padding: 24, paddingTop: 60 },
  authHeader: { alignItems: 'center', marginBottom: 28 },
  logoBadge: { width: 56, height: 56, borderRadius: 16, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  logoBadgeText: { fontSize: 32, fontWeight: '900', color: '#0F172A' },
  authBrandTitle: { fontSize: 24, fontWeight: '900', color: '#0F172A' },
  authTagline: { fontSize: 11, fontWeight: '700', color: colors.primary, letterSpacing: 1.5, marginTop: 2 },
  authCard: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 22, borderWidth: 1, borderColor: '#E2E8F0', ...shadows.card },
  authCardTitle: { fontSize: 22, fontWeight: '800', color: '#0F172A', marginBottom: 4 },
  authCardSubtitle: { fontSize: 13, color: '#64748B', marginBottom: 20 },
  errorBanner: { backgroundColor: '#FEF2F2', padding: 10, borderRadius: 10, borderWidth: 1, borderColor: '#FCA5A5', marginBottom: 14 },
  errorBannerText: { color: '#B91C1C', fontSize: 12, fontWeight: '600' },
  formGroup: { marginBottom: 14 },
  formLabel: { fontSize: 12, fontWeight: '700', color: '#334155', marginBottom: 6, textTransform: 'uppercase' },
  formInput: { backgroundColor: '#F8FAFC', borderRadius: 12, borderWidth: 1, borderColor: '#CBD5E1', padding: 12, fontSize: 14, color: '#0F172A' },
  phoneInputRow: { flexDirection: 'row', gap: 8 },
  ghanaBadge: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#F1F5F9', borderRadius: 12, borderWidth: 1, borderColor: '#CBD5E1', paddingHorizontal: 12 },
  ghanaCode: { fontSize: 14, fontWeight: '700', color: '#0F172A' },
  phoneInput: { flex: 1, minWidth: 0, backgroundColor: '#F8FAFC', borderRadius: 12, borderWidth: 1, borderColor: '#CBD5E1', padding: 12, fontSize: 14, color: '#0F172A' },
  primaryActionButton: { backgroundColor: colors.brandCoral, borderRadius: 14, padding: 15, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  primaryActionText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  switchAuthTouch: { marginTop: 16, alignItems: 'center', padding: 6 },
  switchAuthText: { color: colors.primary, fontSize: 13, fontWeight: '700' },

  // Homepage Styles (Reference 5)
  homeScroll: { padding: 16, paddingBottom: 100 },
  serviceCardsGrid: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  serviceCard: { flex: 1, backgroundColor: '#FFFFFF', borderRadius: 18, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0', ...shadows.card },
  serviceIllustrationBox: { width: 64, height: 64, borderRadius: 14, backgroundColor: '#F8FAFC', alignItems: 'center', justifyContent: 'center', marginBottom: 8, position: 'relative' },
  parcelBoxBadge: { position: 'absolute', bottom: -2, right: -2, backgroundColor: '#FFFFFF', borderRadius: 6, padding: 2 },
  cargoBoxBadge: { position: 'absolute', bottom: -2, right: -2, backgroundColor: '#FFFFFF', borderRadius: 6, padding: 2 },
  foodBowlBadge: { position: 'absolute', bottom: -2, right: -2, backgroundColor: '#FFFFFF', borderRadius: 6, padding: 2 },
  serviceCardLabel: { fontSize: 14, fontWeight: '800', color: '#0F172A' },
  serviceCardSub: { fontSize: 11, color: '#64748B', marginTop: 2 },
  whereToSearchPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 28, padding: 14, paddingHorizontal: 16, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 16, ...shadows.card },
  carIconBox: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#F1F5F9', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  whereToPlaceholder: { flex: 1, fontSize: 16, fontWeight: '700', color: '#0F172A' },
  whereToChevron: { fontSize: 20, fontWeight: '700', color: '#94A3B8' },
  recentDestinationsGroup: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 8, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 16, ...shadows.card },
  recentDestinationRow: { flexDirection: 'row', alignItems: 'center', padding: 12, borderBottomWidth: 1, borderBottomColor: '#F8FAFC' },
  landmarkIconBox: { width: 36, height: 36, borderRadius: 10, backgroundColor: '#F1F5F9', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  landmarkTitle: { fontSize: 14, fontWeight: '700', color: '#0F172A' },
  landmarkSub: { fontSize: 12, color: '#64748B', marginTop: 2 },
  landmarkDistanceBadge: { fontSize: 11, fontWeight: '600', color: colors.primary, backgroundColor: '#E6FAF5', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  promoCardsSection: { gap: 12 },
  promoBannerCard: { borderRadius: 20, padding: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', ...shadows.card },
  promoTagBadge: { fontSize: 10, fontWeight: '800', color: '#FEF08A', letterSpacing: 1, marginBottom: 4 },
  promoHeadline: { fontSize: 18, fontWeight: '900', color: '#FFFFFF', letterSpacing: 0.5 },
  promoBody: { fontSize: 12, color: '#E2E8F0', marginTop: 4, lineHeight: 17 },
  promoActionButton: { marginTop: 10, alignSelf: 'flex-start', backgroundColor: '#FFFFFF', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  promoActionText: { color: '#0F172A', fontSize: 12, fontWeight: '800' },

  // Parcel Screen Styles (Reference 4)
  mapScreenContainer: { flex: 1 },
  floatingTopControls: { position: 'absolute', top: 50, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', zIndex: 10 },
  floatingBackCircle: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', ...shadows.floating },
  floatingGpsButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', ...shadows.floating },
  floatingBottomSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    padding: 18,
    paddingBottom: 28,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    ...shadows.bottomSheet
  },
  sheetHandleBar: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#CBD5E1', alignSelf: 'center', marginBottom: 12 },
  sheetDisplayTitle: { fontSize: 18, fontWeight: '900', color: '#0F172A', letterSpacing: 0.5, marginBottom: 12 },
  sheetRouteBox: { backgroundColor: '#F8FAFC', borderRadius: 16, padding: 10, borderWidth: 1, borderColor: '#E2E8F0' },
  sheetAddressRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  pickupSquareIcon: { width: 28, height: 28, borderRadius: 8, backgroundColor: '#0F172A', alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  dropoffSquareIcon: { width: 28, height: 28, borderRadius: 8, backgroundColor: colors.brandCoral, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  sheetAddressLabel: { fontSize: 10, fontWeight: '700', color: '#64748B', textTransform: 'uppercase' },
  sheetAddressText: { fontSize: 13, fontWeight: '600', color: '#0F172A', marginTop: 1 },
  sheetInnerDivider: { height: 1, backgroundColor: '#E2E8F0', marginVertical: 6 },
  sheetChevron: { fontSize: 16, color: '#94A3B8' },
  targetPillRow: { flexDirection: 'row', gap: 8, marginVertical: 10 },
  targetPill: { flex: 1, paddingVertical: 8, borderRadius: 20, backgroundColor: '#F1F5F9', alignItems: 'center' },
  targetPillActive: { backgroundColor: '#0F172A' },
  targetPillText: { fontSize: 12, fontWeight: '700', color: '#475569' },
  targetPillTextActive: { color: '#FFFFFF' },
  vehicleCarousel: { flexDirection: 'row', gap: 10, paddingVertical: 4 },
  vehicleOptionCard: { width: 112, backgroundColor: '#F8FAFC', borderRadius: 16, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  vehicleOptionCardActive: { borderColor: colors.brandCoral, backgroundColor: '#FFF5F3' },
  vehicleOptionName: { fontSize: 12, fontWeight: '800', color: '#0F172A', marginTop: 2 },
  vehicleOptionPrice: { fontSize: 11, fontWeight: '700', color: colors.brandCoral, marginTop: 1 },
  inputMicroLabel: { fontSize: 11, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', marginBottom: 4 },
  sheetNoteInput: { backgroundColor: '#F8FAFC', borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', padding: 10, fontSize: 13, color: '#0F172A' },
  sheetBottomBar: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  paymentMethodPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#F1F5F9', paddingVertical: 14, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1, borderColor: '#E2E8F0' },
  paymentMethodPillText: { fontSize: 13, fontWeight: '700', color: '#0F172A' },
  orderFormCtaButton: { flex: 1, backgroundColor: colors.brandCoral, borderRadius: 16, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  orderFormCtaText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },

  // Cargo Screen Styles (Reference 2)
  cargoScroll: { padding: 16, paddingBottom: 100 },
  cargoHeaderCard: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 16, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 12, ...shadows.card },
  cargoIconBadge: { width: 38, height: 38, borderRadius: 10, backgroundColor: '#FEE2E2', alignItems: 'center', justifyContent: 'center' },
  cargoTitle: { fontSize: 18, fontWeight: '900', color: '#0F172A' },
  cargoSubBreadcrumb: { fontSize: 12, color: '#64748B' },
  closeRoundButton: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#F1F5F9', alignItems: 'center', justifyContent: 'center' },
  aboutCargoBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 18, padding: 16, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 12, ...shadows.card },
  aboutCargoTitle: { fontSize: 15, fontWeight: '800', color: '#0F172A' },
  aboutCargoSub: { fontSize: 12, color: '#64748B', marginTop: 2 },
  cargoSectionCard: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 16, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 12, ...shadows.card },
  sectionHeaderTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A', marginBottom: 12 },
  segmentedControl: { flexDirection: 'row', backgroundColor: '#F1F5F9', borderRadius: 12, padding: 3, marginBottom: 14 },
  segmentBtn: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 10 },
  segmentBtnActive: { backgroundColor: '#FFFFFF', ...shadows.card },
  segmentBtnText: { fontSize: 13, fontWeight: '600', color: '#64748B' },
  segmentBtnTextActive: { fontWeight: '800', color: '#0F172A' },
  cargoAddressGroup: { backgroundColor: '#F8FAFC', borderRadius: 14, padding: 10, borderWidth: 1, borderColor: '#E2E8F0' },
  cargoAddressRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  cargoFieldLabel: { fontSize: 10, fontWeight: '700', color: '#64748B', textTransform: 'uppercase' },
  cargoFieldValue: { fontSize: 13, fontWeight: '600', color: '#0F172A' },
  detailsPillButton: { backgroundColor: '#FFFFFF', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: '#E2E8F0' },
  detailsPillText: { fontSize: 12, fontWeight: '700', color: '#0F172A' },
  waitingTimeBadge: { marginTop: 12, alignSelf: 'flex-start', backgroundColor: '#F1F5F9', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  waitingTimeText: { fontSize: 11, fontWeight: '600', color: '#475569' },
  cargoSubTabs: { flexDirection: 'row', gap: 20, marginVertical: 8, paddingHorizontal: 4 },
  cargoSubTab: { paddingBottom: 6 },
  cargoSubTabActive: { borderBottomWidth: 3, borderBottomColor: '#0F172A' },
  cargoSubTabText: { fontSize: 14, fontWeight: '600', color: '#64748B' },
  cargoSubTabTextActive: { fontWeight: '800', color: '#0F172A' },
  dimensionCard: { backgroundColor: '#F8FAFC', borderRadius: 16, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  dimensionDiagramBox: { alignItems: 'center', marginBottom: 10 },
  dimensionPillsRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  dimensionBadge: { backgroundColor: '#E2E8F0', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, fontSize: 11, fontWeight: '700', color: '#334155' },
  bodyTypeName: { fontSize: 15, fontWeight: '800', color: '#0F172A' },
  bodyTypeCapacity: { fontSize: 12, color: '#64748B', marginTop: 2, textAlign: 'center' },
  cargoBottomBar: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 16, borderWidth: 1, borderColor: '#E2E8F0', ...shadows.card },
  cargoPriceOverview: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  cargoPaymentMethod: { fontSize: 14, fontWeight: '700', color: '#0F172A' },
  cargoPriceValue: { fontSize: 18, fontWeight: '900', color: '#0F172A' },
  cargoOrderButton: { backgroundColor: '#F1F5F9', borderRadius: 16, paddingVertical: 14, alignItems: 'center' },
  cargoOrderButtonText: { fontSize: 16, fontWeight: '800', color: '#64748B' },
  cargoOrderButtonSub: { fontSize: 11, color: '#94A3B8', marginTop: 2 },

  // Food Screen Styles
  foodScroll: { padding: 16, paddingBottom: 100 },
  foodMarketHeader: { marginBottom: 14 },
  foodMarketTitle: { fontSize: 20, fontWeight: '900', color: '#0F172A' },
  foodMarketSubtitle: { fontSize: 13, color: '#64748B', marginTop: 2 },
  modernRestCard: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 16, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 12, ...shadows.card },
  restCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  restTitleText: { fontSize: 16, fontWeight: '800', color: '#0F172A' },
  restAddressSub: { fontSize: 12, color: '#64748B', marginTop: 2 },
  openPill: { backgroundColor: '#DCFCE7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  openPillText: { fontSize: 10, fontWeight: '800', color: '#15803D' },
  restDeliveryMeta: { fontSize: 12, fontWeight: '600', color: colors.primary, marginTop: 8 },
  restaurantDetailBox: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 16, borderWidth: 1, borderColor: '#E2E8F0', marginVertical: 14 },
  menuSectionHeader: { fontSize: 16, fontWeight: '800', color: '#0F172A', marginBottom: 12 },
  dishRowCard: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  dishTitleText: { fontSize: 14, fontWeight: '700', color: '#0F172A' },
  dishPriceText: { fontSize: 13, fontWeight: '800', color: colors.primary, marginTop: 2 },
  addDishButton: { backgroundColor: '#F1F5F9', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: '#E2E8F0' },
  addDishButtonText: { fontSize: 12, fontWeight: '800', color: '#0F172A' },
  floatingCartButton: { position: 'absolute', bottom: 80, left: 20, right: 20, backgroundColor: colors.brandCoral, borderRadius: 24, paddingVertical: 14, alignItems: 'center', ...shadows.floating },
  floatingCartText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },

  // Activity Screen Styles
  activityScroll: { padding: 16, paddingBottom: 100 },
  activitySectionTitle: { fontSize: 20, fontWeight: '900', color: '#0F172A', marginBottom: 14 },
  modernActiveOrderCard: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 16, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 12, ...shadows.card },
  orderCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  orderIdText: { fontSize: 15, fontWeight: '800', color: '#0F172A' },
  statusPillBadge: { flexShrink: 1, marginLeft: 8, backgroundColor: '#F1F5F9', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statusPillText: { fontSize: 11, fontWeight: '800', color: '#0F766E' },
  orderFareText: { fontSize: 13, color: '#64748B', marginTop: 4 },
  otpSecurityBanner: { backgroundColor: '#FEF3C7', borderRadius: 12, padding: 12, marginTop: 12, alignItems: 'center', borderWidth: 1, borderColor: '#FDE68A' },
  otpSecurityHeader: { fontSize: 11, fontWeight: '800', color: '#92400E', textTransform: 'uppercase' },
  otpSecurityCaption: { fontSize: 13, color: '#78350F', textAlign: 'center', lineHeight: 19, marginTop: 4 },
  callCourierButton: { marginTop: 10, backgroundColor: '#F1F5F9', borderRadius: 12, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  callCourierText: { fontSize: 13, fontWeight: '700', color: '#0F172A' },
  activeOrderActionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  pastOrderRow: { flexDirection: 'row', backgroundColor: '#FFFFFF', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 8 },
  liveTrackButton: { flexGrow: 1, flexBasis: '45%', minHeight: 46, backgroundColor: colors.brandCoral, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  liveTrackText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800', textAlign: 'center' },
  cancelSmallButton: { flexGrow: 1, flexBasis: '45%', minHeight: 46, backgroundColor: '#FEE2E2', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  cancelSmallText: { color: '#B91C1C', fontSize: 13, fontWeight: '800', textAlign: 'center' },
  emptyStateBox: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 32, alignItems: 'center', marginTop: 24, borderWidth: 1, borderColor: '#E2E8F0' },
  emptyStateTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A', textAlign: 'center' },
  emptyStateSub: { fontSize: 13, color: '#64748B', textAlign: 'center', marginTop: 4 },

  // Profile Screen Styles (Reference 3)
  profileScroll: { padding: 16, paddingBottom: 100 },
  profileBackRow: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', marginBottom: 12, borderWidth: 1, borderColor: '#E2E8F0' },
  profileHeaderBox: { alignItems: 'center', marginBottom: 20 },
  profileAvatarLarge: { width: 84, height: 84, borderRadius: 42, backgroundColor: '#E0F2FE', alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  profileNameBold: { fontSize: 20, fontWeight: '900', color: '#0F172A', letterSpacing: 0.5 },
  profilePhoneSub: { fontSize: 13, color: '#64748B', marginTop: 2 },
  profileQuickActionsRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 16 },
  quickActionCircle: { alignItems: 'center' },
  circleIconBox: { width: 50, height: 50, borderRadius: 25, backgroundColor: '#F1F5F9', alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  quickActionLabel: { fontSize: 12, fontWeight: '700', color: '#0F172A' },
  profileTaskBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#EFF6FF', borderRadius: 16, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: '#DBEAFE' },
  progressCircleBadge: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#BFDBFE', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  progressCircleText: { fontSize: 12, fontWeight: '800', color: '#1E40AF' },
  profileTaskTitle: { fontSize: 14, fontWeight: '800', color: '#1E3A8A' },
  profileTaskSub: { fontSize: 11, color: '#3B82F6', marginTop: 1 },
  profileGroupCard: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 6, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 14, ...shadows.card },
  profileMenuItem: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  menuItemIcon: { fontSize: 18, marginRight: 14 },
  menuItemTitle: { fontSize: 14, fontWeight: '700', color: '#0F172A' },
  menuItemSub: { fontSize: 11, color: '#64748B', marginTop: 2 },
  menuItemChevron: { fontSize: 18, color: '#94A3B8' },
  profileItemDivider: { height: 1, backgroundColor: '#F8FAFC', marginHorizontal: 14 },

  // Address Selection Bottom Sheet Modal (Reference 1)
  modalOverlay: { flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' },
  addressSheetCard: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 18, paddingBottom: 32 },
  addressModalHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
  addressModalHeaderTitle: { fontSize: 18, fontWeight: '900', color: '#0F172A' },
  addressModalHeaderSub: { fontSize: 12, color: '#64748B', marginTop: 2 },
  addressTopCard: { backgroundColor: '#F8FAFC', borderRadius: 16, padding: 12, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 12 },
  addressTopRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  addressInputTag: { fontSize: 10, fontWeight: '700', color: '#64748B', textTransform: 'uppercase' },
  addressInlineInput: { fontSize: 14, fontWeight: '600', color: '#0F172A', paddingVertical: 2 },
  addressActionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  addressActionTitle: { fontSize: 14, fontWeight: '800', color: '#0F172A' },
  addressActionSub: { fontSize: 11, color: '#64748B', marginTop: 1 },
  landmarkListItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  landmarkItemIcon: { fontSize: 18, marginRight: 12 },
  landmarkItemTitle: { fontSize: 14, fontWeight: '700', color: '#0F172A' },
  landmarkItemSub: { fontSize: 11, color: '#64748B', marginTop: 2 },
  closeSheetButton: { marginTop: 14, backgroundColor: '#F1F5F9', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  closeSheetText: { fontSize: 13, fontWeight: '700', color: '#475569' },

  // Mode Selection Row
  modeSelectorRow: { flexDirection: 'row', backgroundColor: '#F1F5F9', borderRadius: 14, padding: 4, marginBottom: 12, gap: 4 },
  modeTabBtn: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 10 },
  modeTabBtnActive: { backgroundColor: '#FFFFFF', ...shadows.sm },
  modeTabBtnText: { fontSize: 12, fontWeight: '600', color: '#64748B' },
  modeTabBtnTextActive: { color: '#0F172A', fontWeight: '800' },

  // Search Input
  searchInputContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F8FAFC', borderRadius: 14, borderWidth: 1, borderColor: '#E2E8F0', paddingHorizontal: 12, paddingVertical: 8, marginBottom: 10 },
  searchInlineInput: { flex: 1, fontSize: 14, color: '#0F172A', fontWeight: '500' },
  partnerBadge: { backgroundColor: '#FEF3C7', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: '#FCD34D' },
  partnerBadgeText: { fontSize: 9, fontWeight: '800', color: '#92400E' },
  shortcutSectionTag: { fontSize: 11, fontWeight: '800', color: '#94A3B8', letterSpacing: 0.5, marginTop: 12, marginBottom: 6, textTransform: 'uppercase' },
  emptySearchBox: { padding: 24, alignItems: 'center' },
  emptySearchTitle: { fontSize: 15, fontWeight: '800', color: '#0F172A', marginBottom: 4 },
  emptySearchSub: { fontSize: 12, color: '#64748B', textAlign: 'center', marginBottom: 14 },
  switchManualBtn: { backgroundColor: '#EFF6FF', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: '#BFDBFE' },
  switchManualBtnText: { fontSize: 13, fontWeight: '700', color: '#1E40AF' },

  // GPS Mode Styles
  gpsContainer: { paddingVertical: 8 },
  gpsStatusCard: { flexDirection: 'row', backgroundColor: '#F0FDF4', borderRadius: 18, padding: 16, borderWidth: 1, borderColor: '#BBF7D0', marginBottom: 14 },
  gpsRadarIconBox: { width: 50, height: 50, borderRadius: 25, backgroundColor: '#DCFCE7', alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  gpsStatusTitle: { fontSize: 15, fontWeight: '800', color: '#14532D' },
  gpsStatusAccuracy: { fontSize: 12, fontWeight: '700', color: '#15803D', marginTop: 2 },
  gpsAddressDisplay: { fontSize: 13, color: '#166534', marginTop: 6, lineHeight: 18 },
  gpsActionBtnRow: { flexDirection: 'row', gap: 10 },
  gpsRefreshBtn: { flex: 1, backgroundColor: '#F1F5F9', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  gpsRefreshBtnText: { fontSize: 13, fontWeight: '700', color: '#334155' },
  gpsConfirmBtn: { flex: 1.5, backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  gpsConfirmBtnText: { fontSize: 13, fontWeight: '800', color: '#0F172A' },

  // Manual Address Form Styles
  manualFieldTag: { fontSize: 11, fontWeight: '800', color: '#475569', letterSpacing: 0.5, marginTop: 10, marginBottom: 4, textTransform: 'uppercase' },
  chipScrollRow: { gap: 6, paddingVertical: 4, marginBottom: 6 },
  regionPillChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, backgroundColor: '#F1F5F9', borderWidth: 1, borderColor: '#E2E8F0' },
  regionPillChipActive: { backgroundColor: '#101827', borderColor: '#101827' },
  regionPillText: { fontSize: 12, fontWeight: '600', color: '#475569' },
  regionPillTextActive: { color: '#FFFFFF', fontWeight: '800' },
  townPillChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#CBD5E1' },
  townPillChipActive: { backgroundColor: colors.brandCoral, borderColor: colors.brandCoral },
  townPillText: { fontSize: 11, fontWeight: '600', color: '#334155' },
  townPillTextActive: { color: '#FFFFFF', fontWeight: '800' },
  manualFormInput: { backgroundColor: '#F8FAFC', borderRadius: 12, borderWidth: 1, borderColor: '#CBD5E1', padding: 10, fontSize: 13, color: '#0F172A', marginBottom: 4 },
  previewManualBtn: { marginTop: 14, backgroundColor: colors.brandCoral, borderRadius: 14, paddingVertical: 14, alignItems: 'center', ...shadows.sm },
  previewManualBtnText: { fontSize: 14, fontWeight: '800', color: '#FFFFFF' },

  // Address Confirmation Sheet Modal (Phase 6)
  confirmSheetCard: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 18, paddingBottom: 28 },
  confirmHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  confirmHeaderTitle: { fontSize: 18, fontWeight: '900', color: '#0F172A' },
  confirmHeaderSub: { fontSize: 12, color: '#64748B', marginTop: 2 },
  confirmBadgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 1 },
  statusBadgeText: { fontSize: 11, fontWeight: '700' },
  confirmMapContainer: { height: 210, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 8 },
  confirmMapTipBanner: { position: 'absolute', bottom: 8, left: 8, right: 8, backgroundColor: 'rgba(15, 23, 42, 0.88)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, alignItems: 'center' },
  confirmMapTipText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  confirmActionRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  confirmEditBtn: { flex: 1, backgroundColor: '#F1F5F9', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  confirmEditBtnText: { fontSize: 13, fontWeight: '700', color: '#475569' },
  confirmCommitBtn: { flex: 1.6, backgroundColor: colors.brandCoral, borderRadius: 14, paddingVertical: 14, alignItems: 'center', ...shadows.sm },
  confirmCommitBtnText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },

  // Tracking Modal
  trackingModalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 48, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#E2E8F0' },
  trackingCloseButton: { padding: 6 },
  trackingHeaderTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A' },

  // Customizer Modal
  customizerCard: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 32 },
  customizerTitle: { fontSize: 18, fontWeight: '800', color: '#0F172A' },
  customizerPrice: { fontSize: 16, fontWeight: '800', color: colors.primary, marginTop: 2 },
  modifierGroupName: { fontSize: 12, fontWeight: '800', color: '#334155', textTransform: 'uppercase', marginBottom: 6 },
  modifierOptionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F8FAFC' },

  // Food Cart Modal
  cartTitleBold: { fontSize: 20, fontWeight: '900', color: '#0F172A' },
  cartItemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  cartItemName: { fontSize: 14, fontWeight: '700', color: '#0F172A' },
  cartItemOptionSub: { fontSize: 11, color: '#64748B', marginTop: 1 },
  cartItemPrice: { fontSize: 14, fontWeight: '800', color: colors.primary },
  foodQuoteBox: { backgroundColor: '#F8FAFC', borderRadius: 14, padding: 12, marginTop: 14, borderWidth: 1, borderColor: '#E2E8F0' },
  foodQuoteRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  foodQuoteLabel: { fontSize: 13, color: '#475569' },
  foodQuoteValue: { fontSize: 13, fontWeight: '700', color: '#0F172A' },

  // Bottom Universal Navigation Tab Bar
  bottomNavTabBar: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    paddingVertical: 8,
    paddingBottom: Platform.OS === 'android' ? 12 : 24
  },
  navTabItem: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  navTabIcon: { fontSize: 20, color: '#94A3B8', marginBottom: 2 },
  navTabIconActive: { color: colors.brandCoral },
  navTabLabel: { fontSize: 11, fontWeight: '600', color: '#94A3B8' },
  navTabLabelActive: { color: '#0F172A', fontWeight: '800' }
});
