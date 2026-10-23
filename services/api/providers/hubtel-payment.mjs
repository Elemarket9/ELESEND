import {check} from '../security.mjs';
import {validatedCheckoutUrl} from '../checkout-policy.mjs';

/**
 * Hubtel Merchant Payment & Online Checkout Adapter
 * Complies with official Hubtel Merchant API specifications:
 * Endpoints:
 * - Online Checkout / Items Initiate: POST https://payproxyapi.hubtel.com/items/initiate
 * - Transaction Status Check: POST https://payproxyapi.hubtel.com/transaction/status
 * Authentication: HTTP Basic Auth (ClientId:ClientSecret)
 * Documentation: https://developers.hubtel.com/document/merchant-account-apis
 */
export function hubtelCheckout({
 clientId,
 clientSecret,
 merchantAccountNumber,
 fetchImpl = fetch,
 endpoint = process.env.HUBTEL_PAYMENT_ENDPOINT || 'https://payproxyapi.hubtel.com',
 allowedHost = 'payproxyapi.hubtel.com',
 allowedMethods = ['MOMO', 'CARD', 'QR'],
 callbackBaseUrl = process.env.HUBTEL_CALLBACK_BASE_URL,
 returnBaseUrl = process.env.HUBTEL_RETURN_BASE_URL,
 cancellationBaseUrl = process.env.HUBTEL_CANCELLATION_BASE_URL || returnBaseUrl,
 production = process.env.NODE_ENV === 'production'
} = {}) {
 check(typeof clientId === 'string' && clientId.trim().length > 0, 503, 'Hubtel ClientId required');
 check(typeof clientSecret === 'string' && clientSecret.trim().length > 0, 503, 'Hubtel ClientSecret required');
 check(merchantAccountNumber != null && String(merchantAccountNumber).trim().length > 0, 503, 'Hubtel Merchant Account Number required');
 const base=new URL(endpoint);
 check(base.protocol==='https:'&&base.hostname===allowedHost&&!base.username&&!base.password&&!base.search&&!base.hash&&!base.port,500,'Unapproved payment API endpoint');
 endpoint=base.toString().replace(/\/$/,'');

 const basicAuth = Buffer.from(`${clientId.trim()}:${clientSecret.trim()}`).toString('base64');
 const methods = allowedMethods.filter(v => ['MOMO', 'CARD', 'QR'].includes(v));
 const safeCallbackBase = (callbackBaseUrl || '').trim().replace(/\/$/, '');
 const safeReturnBase = (returnBaseUrl || '').trim().replace(/\/$/, '');
 const safeCancelBase = (cancellationBaseUrl || returnBaseUrl || '').trim().replace(/\/$/, '');

 async function remote(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
   const response = await fetchImpl(endpoint + path, {
    ...options,
    headers: {
     Authorization: `Basic ${basicAuth}`,
     'Content-Type': 'application/json',
     Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate',
     ...options.headers
    },
    signal: controller.signal,
    redirect: 'error'
   });

   check(response.ok, 502, `Hubtel payment request failed (HTTP ${response.status})`);
   const raw = await response.json();
   const code = raw?.ResponseCode || raw?.code;
   const isSuccess = code === '00' || code === '0000' || raw?.status === 'Success' || raw?.status === true;
   check(isSuccess, 502, raw?.ResponseMessage || raw?.message || 'Hubtel rejected transaction request');
   return raw.Data || raw.data || raw;
  } finally {
   clearTimeout(timer);
  }
 }

 async function verifyPayment(reference) {
  check(typeof reference === 'string' && /^[A-Za-z0-9._=-]{8,90}$/.test(reference), 400, 'Invalid payment reference');

  // Query Hubtel transaction status endpoint
  const data = await remote('/transaction/status', {
   method: 'POST',
   body: JSON.stringify({
    ClientReference: reference
   })
  });

  const rawStatus = (data?.Status || data?.status || '').toLowerCase();
  const isPaid = rawStatus === 'success';

  // Normalize channel: mtn-gh, telecel-gh, tigo-gh, mobilemoney -> mobile_money
  const rawChannel = (data?.PaymentDetails?.Channel || data?.PaymentType || data?.channel || 'mobile_money').toLowerCase();
  const channel = rawChannel.includes('card') || rawChannel.includes('visa') || rawChannel.includes('mastercard')
   ? 'card'
   : rawChannel.includes('qr')
   ? 'qr'
   : 'mobile_money';

  const amountGhs = Number(data?.Amount || data?.amount || data?.AmountCharged || 0);
  const amountMinor = Math.round(amountGhs * 100);
  const transactionId = data?.TransactionId || data?.ExternalTransactionId || data?.transactionId || reference;

  return {
   reference: data?.ClientReference || reference,
   status: isPaid ? 'success' : rawStatus || 'pending',
   amountMinor,
   currency: 'GHS',
   channel,
   eventId: `hubtel-transaction:${transactionId}`,
   environment: production ? 'live' : 'test'
  };
 }

 return {
  name: 'hubtel',
  payerFields: [],
  commissionIntentId(record){const ref=typeof record==='string'?record:record?.reference||'';const m=/^escomm_([0-9a-f]{32})$/.exec(ref);if(!m)return null;const h=m[1];return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');},
  methods,
  allowedCheckoutHosts: ['checkout.hubtel.com', 'payproxyapi.hubtel.com'],

  async createCheckout({reference, amountMinor, currency, method, email}) {
   check(methods.includes(method), 503, 'Payment method not enabled on Hubtel');
   check(currency === 'GHS' && Number.isSafeInteger(amountMinor) && amountMinor > 0, 400, 'Invalid GHS checkout amount');
   check(/^[A-Za-z0-9._=-]{8,90}$/.test(reference), 400, 'Invalid checkout reference');

   const amountGhs = Number((amountMinor / 100).toFixed(2));
   check(safeCallbackBase && safeReturnBase, 500, 'Hubtel checkout requires callback and return URLs');
   const callbackUrl = `${safeCallbackBase}/api/v1/payments/webhook`;
   const returnUrl = `${safeReturnBase}/checkout/complete?ref=${encodeURIComponent(reference)}`;
   const cancellationUrl = `${safeCancelBase || safeReturnBase}/checkout/cancelled?ref=${encodeURIComponent(reference)}`;

   const payload = {
    totalAmount: amountGhs,
    description: `ELESEND Delivery Booking ${reference}`,
    callbackUrl,
    returnUrl,
    merchantAccountNumber: String(merchantAccountNumber),
    cancellationUrl,
    clientReference: reference
   };

   const data = await remote('/items/initiate', {
    method: 'POST',
    body: JSON.stringify(payload)
   });

   const rawUrl = data?.CheckoutUrl || data?.checkoutUrl;
   check(typeof rawUrl === 'string', 502, 'Hubtel did not return checkout URL');

   return {
    checkoutUrl: validatedCheckoutUrl(rawUrl, {allowedHosts: ['checkout.hubtel.com', 'payproxyapi.hubtel.com']}),
    reference
   };
  },

  verifyPayment,

  async createPayment({intentId, amountMinor, currency, email}) {
   check(/^[0-9a-f-]{36}$/.test(intentId), 400, 'Invalid commission intent');
   check(currency === 'GHS' && Number.isSafeInteger(amountMinor) && amountMinor > 0, 400, 'Invalid GHS amount');

   const reference = 'escomm_' + intentId.replaceAll('-', '');
   const amountGhs = Number((amountMinor / 100).toFixed(2));
   check(safeCallbackBase && safeReturnBase, 500, 'Hubtel settlement requires callback and return URLs');
   const callbackUrl = `${safeCallbackBase}/api/v1/payments/webhook`;

   const payload = {
    totalAmount: amountGhs,
    description: `ELESEND Commission Settlement ${reference}`,
    callbackUrl,
    returnUrl: `${safeReturnBase}/settlement/complete?ref=${encodeURIComponent(reference)}`,
    merchantAccountNumber: String(merchantAccountNumber),
    cancellationUrl: `${safeCancelBase || safeReturnBase}/settlement/cancelled?ref=${encodeURIComponent(reference)}`,
    clientReference: reference
   };

   const data = await remote('/items/initiate', {
    method: 'POST',
    body: JSON.stringify(payload)
   });

   const rawUrl = data?.CheckoutUrl || data?.checkoutUrl;
   check(typeof rawUrl === 'string', 502, 'Hubtel did not return settlement checkout URL');

   return {
    checkoutUrl: validatedCheckoutUrl(rawUrl, {allowedHosts: ['checkout.hubtel.com', 'payproxyapi.hubtel.com']}),
    reference
   };
  },

  async verifyEvent({rawBody, headers}) {
   const v = await this.parseVerifiedWebhook(rawBody, headers);
   // Channel admissibility is a business policy enforced by the finance service, not the adapter.
   check(v?.status === 'success' && ['mobile_money', 'card'].includes(v.channel), 409, 'Commission settlement not verified');
   const m = /^escomm_([0-9a-f]{32})$/.exec(v.reference);
   check(m, 403, 'Not a commission repayment event');
   const h = m[1];
   const intentId = [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-');
   return {
    verified: true,
    providerName: this.name,
    eventId: v.eventId,
    intentId,
    amountMinor: v.amountMinor,
    currency: v.currency,
    channel: v.channel
   };
  },

  async parseVerifiedWebhook(rawBody, headers) {
   if(rawBody&&typeof rawBody==='object'&&!Buffer.isBuffer(rawBody)&&!(rawBody instanceof Uint8Array)&&('rawBody' in rawBody||'headers' in rawBody)){headers=rawBody.headers;rawBody=rawBody.rawBody;}
   let incoming;
   try {
    incoming = JSON.parse(rawBody.toString('utf8'));
   } catch {
    check(false, 400, 'Invalid JSON in Hubtel webhook');
   }

   // Extract reference from Hubtel callback structure
   const ref = incoming?.Data?.ClientReference || incoming?.ClientReference || incoming?.Data?.clientReference;
   check(typeof ref === 'string' && /^[A-Za-z0-9._=-]{8,90}$/.test(ref), 400, 'Invalid reference in Hubtel webhook payload');

   // Security Rule: Never trust webhook payload alone; verify out-of-band with Hubtel Status API
   const verified = await verifyPayment(ref);
   if (production) check(verified.environment === 'live', 409, 'Production Hubtel transaction is not live');
   return verified;
  }
 };
}
