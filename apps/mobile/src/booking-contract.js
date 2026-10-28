/**
 * ELESEND customer booking contract (pure, framework-free, Node-testable).
 *
 * Every request body / path the customer app sends for quotes, bookings, food orders,
 * cancellation and checkout is built here so it can be verified against the REAL
 * backend router and zod schemas (see tests/customer-booking-contract.test.mjs).
 *
 * Backend references:
 *  - POST /api/v1/quotes            -> platform.mjs quoteSchema (.strict(): unknown keys are rejected)
 *  - POST /api/v1/shipments         -> platform.mjs book() (Idempotency-Key header required)
 *  - POST /api/v1/shipments/:id/transition {action:'cancel'} -> platform.mjs transition()
 *  - POST /api/v1/shipments/:id/checkout -> checkout.mjs payer schema {idempotencyKey, email?}
 *  - POST /api/v1/food-orders/quote / POST /api/v1/food-orders -> restaurant-orders.mjs
 */

// Server-side parcel service envelope (pricing-surge.mjs validateGhanaBoundary). The client
// must never accept a point the authoritative quote endpoint will reject.
export const SERVICE_ENVELOPE = Object.freeze({ minLat: 4.7, maxLat: 11.2, minLon: -3.3, maxLon: 1.2 });

export function isInsideServiceEnvelope(point) {
  const lat = Number(point?.latitude);
  const lon = Number(point?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= SERVICE_ENVELOPE.minLat && lat <= SERVICE_ENVELOPE.maxLat &&
    lon >= SERVICE_ENVELOPE.minLon && lon <= SERVICE_ENVELOPE.maxLon;
}

export const ENDPOINTS = Object.freeze({
  parcelQuote: '/api/v1/quotes',
  parcelBook: '/api/v1/shipments',
  shipmentTransition: id => `/api/v1/shipments/${id}/transition`,
  shipmentCheckout: id => `/api/v1/shipments/${id}/checkout`,
  foodQuote: '/api/v1/food-orders/quote',
  foodOrder: '/api/v1/food-orders',
  foodCancel: id => `/api/v1/food-orders/${id}/cancel`,
  restaurantOffers: id => `/api/v1/restaurants/${id}/offers`,
  chatConversations: '/api/v1/chat/conversations',
  chatMessages: id => `/api/v1/chat/conversations/${id}/messages`,
  chatDelivered: id => `/api/v1/chat/conversations/${id}/delivered`,
  chatRead: id => `/api/v1/chat/conversations/${id}/read`,
  chatTyping: id => `/api/v1/chat/conversations/${id}/typing`,
  chatMute: id => `/api/v1/chat/conversations/${id}/mute`,
  chatReport: id => `/api/v1/chat/conversations/${id}/report`,
  chatEscalate: id => `/api/v1/chat/conversations/${id}/escalate`
});

/**
 * Address payload accepted by platform.mjs `address` schema:
 *   {address: string(5..400), latitude, longitude}  (.strict()).
 * Keeps the human-readable place name (title) the customer actually chose, instead of
 * only the generic region summary, so riders see "Kotoka International Airport (T3)".
 * Returns null when coordinates are not resolved — never invents coordinates.
 */
export function toAddressPayload(loc) {
  if (!loc) return null;
  const latitude = Number(loc.latitude ?? loc.coordinates?.latitude);
  const longitude = Number(loc.longitude ?? loc.coordinates?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const title = typeof loc.title === 'string' ? loc.title.trim() : '';
  const summary = typeof loc.address === 'string' ? loc.address.trim() : '';
  let text = title && summary && !summary.toLowerCase().includes(title.toLowerCase())
    ? `${title}, ${summary}`
    : (title || summary);
  if (text.length < 5) text = `${text} (pin ${latitude.toFixed(5)}, ${longitude.toFixed(5)})`.trim();
  return { address: text.slice(0, 400), latitude, longitude };
}

/** A location may be priced only after the customer explicitly confirmed it. */
export function isConfirmedLocation(loc) {
  return Boolean(loc && loc.customerConfirmed === true && toAddressPayload(loc) && isInsideServiceEnvelope(toAddressPayload(loc)));
}

/**
 * Body for POST /api/v1/quotes. Only keys present in quoteSchema are sent.
 * Throws a user-facing error instead of sending unconfirmed or unresolved locations.
 */
export function buildParcelQuoteRequest({ pickup, destination, vehicle, weightG, paymentMethod, recipientPhone, description, cashPayer, destinationInstructions }) {
  if (!isConfirmedLocation(pickup)) throw new Error('Please confirm your pickup location on the map before requesting a price.');
  if (!isConfirmedLocation(destination)) throw new Error('Please confirm your delivery location on the map before requesting a price.');
  const dest = toAddressPayload(destination);
  const rawNote = destinationInstructions ?? destination?.deliveryInstructions;
  const note = typeof rawNote === 'string' ? rawNote.trim() : '';
  if (note) {
    // Backend has no separate delivery-notes field/endpoint; the instruction travels with the
    // destination address text that riders see (truncated to the 400-char schema limit).
    dest.address = `${dest.address} [Instructions: ${note}]`.slice(0, 400);
  }
  const body = {
    pickup: toAddressPayload(pickup),
    destination: dest,
    vehicle: ['motorcycle', 'car', 'van'].includes(vehicle) ? vehicle : 'motorcycle',
    weightG: Number.isInteger(Number(weightG)) && Number(weightG) > 0 ? Number(weightG) : 1500,
    recipientPhone: String(recipientPhone || ''),
    description: typeof description === 'string' && description.trim().length >= 2 ? description.trim().slice(0, 500) : 'Package'
  };
  if (['CASH', 'MOMO', 'CARD', 'QR', 'DIGITAL'].includes(paymentMethod)) body.paymentMethod = paymentMethod;
  if (['sender', 'recipient'].includes(cashPayer)) body.cashPayer = cashPayer;
  return body;
}

/** Body + request options for POST /api/v1/shipments. `options` is passed as call()'s 4th argument. */
export function buildParcelBookingRequest(quoteId, idempotencyKey) {
  if (!quoteId) throw new Error('Please calculate a valid quote first');
  if (!/^[\w-]{8,128}$/.test(String(idempotencyKey || ''))) throw new Error('Invalid booking idempotency key');
  return { body: { quoteId }, options: { idempotencyKey } };
}

/**
 * Verifies that a quote's stored requestBody still matches the current booking inputs
 * so that stale or mutated quotes cannot be booked.
 */
export function isQuoteBoundToInputs(quoted, currentQuoteBody) {
  if (!quoted || !quoted.id || !quoted.requestBody || !currentQuoteBody) return false;
  const q = quoted.requestBody;
  const c = currentQuoteBody;
  if (q.vehicle !== c.vehicle) return false;
  if ((q.paymentMethod || 'CASH') !== (c.paymentMethod || 'CASH')) return false;
  if (Number(q.weightG) !== Number(c.weightG)) return false;
  if (Math.abs(Number(q.pickup?.latitude) - Number(c.pickup?.latitude)) > 1e-6) return false;
  if (Math.abs(Number(q.pickup?.longitude) - Number(c.pickup?.longitude)) > 1e-6) return false;
  if (Math.abs(Number(q.destination?.latitude) - Number(c.destination?.latitude)) > 1e-6) return false;
  if (Math.abs(Number(q.destination?.longitude) - Number(c.destination?.longitude)) > 1e-6) return false;
  return true;
}

export function buildShipmentCancelRequest(reason = 'Customer cancelled via app') {
  return { action: 'cancel', reason: String(reason).slice(0, 1000) };
}

/** Food quote body (restaurant-orders.mjs quoteFoodOrder schema, .strict()). */
export function buildFoodQuoteRequest({ restaurantId, cartItems, deliveryAddress, deliveryLocation, customerPhone, specialInstructions, promoCode, promoCodes, campaignIds }) {
  if (!isConfirmedLocation(deliveryLocation)) {
    throw new Error('Please set and confirm your delivery location on the map first.');
  }
  const lat = Number(deliveryLocation?.latitude ?? deliveryLocation?.coordinates?.latitude);
  const lon = Number(deliveryLocation?.longitude ?? deliveryLocation?.coordinates?.longitude);
  const text = String(deliveryAddress || deliveryLocation.title || deliveryLocation.address || '').trim();
  if (text.length < 3) throw new Error('Please enter a delivery address or landmark.');
  const req = {
    restaurantId,
    items: (cartItems || []).map(c => ({ itemId: c.itemId, quantity: Number(c.quantity) || 1, options: (c.options || []).map(o => o.id) })),
    deliveryAddress: text.slice(0, 255),
    deliveryLatitude: lat,
    deliveryLongitude: lon,
    customerPhone: String(customerPhone || ''),
    specialInstructions: String(specialInstructions || '').slice(0, 300)
  };
  if (typeof promoCode === 'string' && promoCode.trim().length > 0) {
    req.promoCode = promoCode.trim().toUpperCase().slice(0, 40);
  }
  if (Array.isArray(promoCodes) && promoCodes.length > 0) {
    req.promoCodes = promoCodes.map(c => String(c).trim().toUpperCase()).filter(Boolean).slice(0, 5);
  }
  if (Array.isArray(campaignIds) && campaignIds.length > 0) {
    req.campaignIds = campaignIds.slice(0, 5);
  }
  return req;
}

/** Food order: same body as the quote plus paymentMethod; Idempotency-Key header required. */
export function buildFoodOrderRequest(quoteBody, idempotencyKey, paymentMethod = 'MOMO') {
  if (!['MOMO', 'CARD', 'QR'].includes(paymentMethod)) throw new Error('Food orders require upfront digital payment');
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(String(idempotencyKey || ''))) throw new Error('Invalid food order idempotency key');
  return { body: { ...quoteBody, paymentMethod }, options: { idempotencyKey } };
}

/** Checkout initiation (checkout.mjs payer schema: {idempotencyKey, email?} .strict()). */
export function buildCheckoutRequest(idempotencyKey, email) {
  const body = { idempotencyKey };
  if (typeof email === 'string' && /.+@.+\..+/.test(email.trim())) body.email = email.trim();
  return body;
}

/** Formats promotion savings and line-item discount breakdown from an authoritative food quote. */
export function formatPromotionSavingsSummary(foodQuote) {
  if (!foodQuote) return null;
  const foodDiscountMinor = Number(foodQuote.foodDiscountMinor || 0);
  const deliveryDiscountMinor = Number(foodQuote.deliveryDiscountMinor || 0);
  const totalDiscountMinor = Number(foodQuote.totalDiscountMinor || (foodDiscountMinor + deliveryDiscountMinor));
  const appliedPromotions = Array.isArray(foodQuote.appliedPromotions) ? foodQuote.appliedPromotions : [];
  return {
    hasDiscount: totalDiscountMinor > 0,
    foodDiscountMinor,
    deliveryDiscountMinor,
    totalDiscountMinor,
    grossTotalMinor: Number(foodQuote.grossTotalMinor || (Number(foodQuote.subtotalMinor || 0) + Number(foodQuote.deliveryFeeMinor || 0))),
    netTotalMinor: Number(foodQuote.totalMinor || 0),
    appliedPromotions,
    savingsText: totalDiscountMinor > 0 ? `You save GH₵ ${(totalDiscountMinor / 100).toFixed(2)}` : null
  };
}

/** Builds a validated order-scoped chat message request body. */
export function buildChatMessageRequest({ clientMessageId, messageType = 'text', body = '', quickReplyKey = null, locationPin = null }) {
  const idStr = String(clientMessageId || `msg-${Date.now()}`).trim();
  if (idStr.length < 4) throw new Error('Valid clientMessageId required');
  const req = {
    clientMessageId: idStr.slice(0, 120),
    messageType
  };
  if (messageType === 'quick_reply') {
    if (quickReplyKey) req.quickReplyKey = String(quickReplyKey);
    if (body) req.body = String(body).trim();
  } else if (messageType === 'location_pin') {
    if (!locationPin || locationPin.confirmed !== true || !isInsideServiceEnvelope(locationPin)) {
      throw new Error('Shared location pin must be explicitly confirmed and inside Ghana service bounds.');
    }
    req.locationPin = {
      latitude: Number(locationPin.latitude),
      longitude: Number(locationPin.longitude),
      label: String(locationPin.label || 'Confirmed Map Pin (Advisory Only)').slice(0, 200),
      confirmed: true
    };
    if (body) req.body = String(body).trim();
  } else {
    const trimmed = String(body || '').trim();
    if (!trimmed) throw new Error('Message cannot be empty');
    req.body = trimmed.slice(0, 1000);
  }
  return req;
}
