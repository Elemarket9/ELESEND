import {check,phone as canonicalGhanaPhone} from '../../../shared/security.mjs';
import {validatedCheckoutUrl} from '../checkout-policy.mjs';
const STATUS_HOST='https://api-txnstatus.hubtel.com';
const REFUND_HOST='https://refund-api.hubtel.com';
const PAYOUT_HOST='https://smp.hubtel.com';
const PAYOUT_STATUS_HOST='https://smrsc.hubtel.com';
const CHANNELS={MTN:'mtn-gh',TELECEL:'vodafone-gh',AT:'tigo-gh'};
/** Whole pesewas from a cedis amount, without binary floating point. */
function pesewas(value){
 const m=/^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(value??'').trim());
 return m?Number(m[1])*100+Number((m[2]??'').padEnd(2,'0')):NaN;
}
function cedisAmount(minor){
 check(Number.isSafeInteger(minor)&&minor>0,400,'Invalid amount');
 return JSON.parse(`${Math.floor(minor/100)}.${String(minor%100).padStart(2,'0')}`);
}
const localMsisdn=value=>{try{return canonicalGhanaPhone(value).slice(1);}catch{return null;}};

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
 disbursementAccountNumber,
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
 check(merchantAccountNumber != null && String(merchantAccountNumber).trim().length > 0, 503, 'Collection account number required');
 check(disbursementAccountNumber != null && String(disbursementAccountNumber).trim().length > 0, 503, 'Disbursement account number required');
 const collectionAccount=String(merchantAccountNumber).trim();
 const disbursementAccount=String(disbursementAccountNumber).trim();
 const base=new URL(endpoint);
 check(base.protocol==='https:'&&base.hostname===allowedHost&&!base.username&&!base.password&&!base.search&&!base.hash&&!base.port,500,'Unapproved payment API endpoint');
 endpoint=base.toString().replace(/\/$/,'');

 const basicAuth = Buffer.from(`${clientId.trim()}:${clientSecret.trim()}`).toString('base64');
 const methods = allowedMethods.filter(v => ['MOMO', 'CARD', 'QR'].includes(v));
 // Online Checkout's initiate body has no channel field. The page offers mobile money, card, and QR.
 const collectableChannels = ['mobile_money', 'card', 'qr'];
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

 async function ask(url, options={}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
   const response = await fetchImpl(url, {
    ...options,
    headers: {Authorization: `Basic ${basicAuth}`, Accept: 'application/json', 'Content-Type': 'application/json', ...options.headers},
    signal: controller.signal,
    redirect: 'error'
   });
   let raw = null;
   try { raw = await response.json(); } catch { raw = null; }
   return {ok: response.ok, status: response.status, raw};
  } finally { clearTimeout(timer); }
 }
 function channelOf(data) {
  const rawChannel = String(data?.paymentMethod || data?.PaymentDetails?.Channel || data?.PaymentType || data?.channel || data?.Channel || '').toLowerCase();
  if (rawChannel.includes('card') || rawChannel.includes('visa') || rawChannel.includes('mastercard')) return 'card';
  if (rawChannel.includes('qr')) return 'qr';
  return 'mobile_money';
 }
 async function collectionStatus(reference) {
  const url = `${STATUS_HOST}/transactions/${encodeURIComponent(collectionAccount)}/status?clientReference=${encodeURIComponent(reference)}`;
  const {ok, status, raw} = await ask(url, {method: 'GET'});
  if (status === 404) return {state: 'not_found'};
  check(ok && raw && typeof raw === 'object', 502, 'Payment status lookup failed');
  const data = raw.data || raw.Data;
  if (!data || typeof data !== 'object') return {state: 'pending'};
  const returned = data.clientReference ?? data.ClientReference;
  check(returned === reference, 409, 'Provider returned a different payment reference');
  const amountMinor = pesewas(data.amount ?? data.Amount);
  const statusName = String(data.status ?? data.Status ?? '').toLowerCase();
  const state = statusName === 'paid' ? 'success' : statusName === 'refunded' ? 'refunded' : 'pending';
  if (state === 'success' || state === 'refunded') check(Number.isSafeInteger(amountMinor), 502, 'Provider amount is not an integer minor unit');
  const statedCurrency = data.currencyCode || data.CurrencyCode;
  if (statedCurrency) check(statedCurrency === 'GHS', 409, 'Provider currency is not GHS');
  return {state, amountMinor, currency: 'GHS', transactionId: String(data.transactionId || data.TransactionId || ''), channel: channelOf(data), environment: production ? 'live' : 'test'};
 }
 async function verifyPayment(reference) {
  check(typeof reference === 'string' && /^[A-Za-z0-9._=-]{8,90}$/.test(reference), 400, 'Invalid payment reference');
  const found = await collectionStatus(reference);
  if (found.state === 'not_found') return {reference, status: 'pending', currency: 'GHS', channel: 'mobile_money', amountMinor: 0, eventId: '', environment: production ? 'live' : 'test'};
  return {reference, status: found.state === 'refunded' ? 'refunded' : found.state, amountMinor: found.amountMinor, currency: 'GHS', channel: found.channel, transactionId: found.transactionId, eventId: found.transactionId ? `hubtel-transaction:${found.transactionId}` : '', environment: found.environment};
 }

 const payoutReference = requestId => requestId.replaceAll('-', '');
 const parseRecipient = value => {
  const m = /^hubtel:(mtn-gh|vodafone-gh|tigo-gh):(233\d{9})$/.exec(String(value ?? ''));
  return m && {channel: m[1], msisdn: m[2]};
 };
 async function payoutStatus(reference) {
  const url = `${PAYOUT_STATUS_HOST}/api/merchants/${encodeURIComponent(disbursementAccount)}/transactions/status?clientReference=${encodeURIComponent(reference)}`;
  const {ok, status, raw} = await ask(url, {method: 'GET'});
  if (status === 404) return {state: 'not_found'};
  check(ok && raw && typeof raw === 'object', 502, 'Payout status lookup failed');
  const data = raw.Data || raw.data;
  if (!data || typeof data !== 'object') return {state: 'pending'};
  check((data.ClientReference ?? data.clientReference) === reference, 409, 'Provider returned a different payment reference');
  const amountMinor = pesewas(data.Amount ?? data.amount);
  const statusName = String(data.transactionStatus ?? data.TransactionStatus ?? '').toLowerCase();
  const state = statusName === 'success' ? 'success' : ['failed', 'rejected'].includes(statusName) ? 'failed' : 'pending';
  if (state === 'success') check(Number.isSafeInteger(amountMinor), 502, 'Provider amount is not an integer minor unit');
  return {state, amountMinor, transactionId: String(data.TransactionId || data.transactionId || '')};
 }

 return {
  name: 'hubtel',
  payerFields: [],
  secretsConfigured: true,
  integerMinorAmounts: true,
  confirmsByReference: true,
  webhookSignatureEnforced: false,
  callbackAuthenticatedByStatusQuery: true,
  hostedCheckoutChannelRestricted: false,
  collectableChannels,
  commissionIntentId(record){const ref=typeof record==='string'?record:record?.reference||'';const m=/^escomm_([0-9a-f]{32})$/.exec(ref);if(!m)return null;const h=m[1];return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');},
  methods,
  allowedCheckoutHosts: ['checkout.hubtel.com', 'payproxyapi.hubtel.com'],

  async createCheckout({reference, amountMinor, currency, method, email}) {
   check(methods.includes(method), 503, 'Payment method not enabled on Hubtel');
   check(currency === 'GHS' && Number.isSafeInteger(amountMinor) && amountMinor > 0, 400, 'Invalid GHS checkout amount');
   check(/^[A-Za-z0-9._=-]{8,90}$/.test(reference), 400, 'Invalid checkout reference');

   const amountGhs = cedisAmount(amountMinor);
   check(safeCallbackBase && safeReturnBase, 500, 'Hubtel checkout requires callback and return URLs');
   const callbackUrl = `${safeCallbackBase}/api/v1/payments/webhook`;
   const returnUrl = `${safeReturnBase}/checkout/complete?ref=${encodeURIComponent(reference)}`;
   const cancellationUrl = `${safeCancelBase || safeReturnBase}/checkout/cancelled?ref=${encodeURIComponent(reference)}`;

   // The selected method is checked above. It is not sent: Hubtel's initiate contract has no channel field.
   const payload = {
    totalAmount: amountGhs,
    description: `ELESEND Delivery Booking ${reference}`,
    callbackUrl,
    returnUrl,
    merchantAccountNumber: collectionAccount,
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

  async createPayment({intentId, amountMinor, currency, email, allowedChannels}) {
   check(/^[0-9a-f-]{36}$/.test(intentId), 400, 'Invalid commission intent');
   check(currency === 'GHS' && Number.isSafeInteger(amountMinor) && amountMinor > 0, 400, 'Invalid GHS amount');
   if (allowedChannels !== undefined) check(Array.isArray(allowedChannels), 400, 'Invalid repayment channels');
   // allowedChannels is the wallet policy. Initiate cannot apply it, so confirmation keeps any collected page tender.

   const reference = 'escomm_' + intentId.replaceAll('-', '');
   const amountGhs = cedisAmount(amountMinor);
   check(safeCallbackBase && safeReturnBase, 500, 'Hubtel settlement requires callback and return URLs');
   const callbackUrl = `${safeCallbackBase}/api/v1/payments/webhook`;

   const payload = {
    totalAmount: amountGhs,
    description: `ELESEND Commission Settlement ${reference}`,
    callbackUrl,
    returnUrl: `${safeReturnBase}/settlement/complete?ref=${encodeURIComponent(reference)}`,
    merchantAccountNumber: collectionAccount,
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
   check(v?.status === 'success' && collectableChannels.includes(v.channel), 409, 'Commission settlement not verified');
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
    check(false, 400, 'Invalid JSON in payment callback');
   }
   // The published callback contract has no signature. Amount and status in this body are ignored.
   // Only a checkout reference is taken, and the payment is read back by that reference.
   const ref = incoming?.Data?.ClientReference || incoming?.data?.clientReference || incoming?.ClientReference;
   if (typeof ref !== 'string' || !/^es(?:comm)?_[A-Za-z0-9._=-]{8,80}$/.test(ref)) return null;
   const verified = await verifyPayment(ref);
   if (production) check(verified.environment === 'live', 409, 'Production payment is not live');
   return verified.status === 'success' ? verified : null;
  },
  async createBeneficiary({phone, network}) {
   const channel = CHANNELS[network];
   const msisdn = localMsisdn(phone);
   check(channel, 400, 'Unsupported mobile money network');
   check(msisdn, 400, 'Valid mobile money number required');
   return {recipientReference: `hubtel:${channel}:${msisdn}`};
  },
  async verifyBeneficiary({beneficiaryId, recipientReference, verifiedPhone}) {
   const recipient = parseRecipient(recipientReference);
   const phone = localMsisdn(verifiedPhone);
   return {verified: Boolean(recipient && phone && recipient.msisdn === phone), beneficiaryId, recipientReference};
  },
  async createPayout({requestId, recipientReference, amountMinor, currency}) {
   check(safeCallbackBase, 500, 'Payout requires a callback URL');
   check(/^[0-9a-f-]{36}$/.test(requestId), 400, 'Invalid payout request');
   check(currency === 'GHS' && Number.isSafeInteger(amountMinor) && amountMinor > 0, 400, 'Invalid payout amount');
   const recipient = parseRecipient(recipientReference);
   check(recipient, 400, 'Invalid payout recipient');
   const reference = payoutReference(requestId);
   const url = `${PAYOUT_HOST}/api/merchants/${encodeURIComponent(disbursementAccount)}/send/mobilemoney`;
   const {ok, raw} = await ask(url, {method: 'POST', body: JSON.stringify({
    RecipientName: 'ELESEND payout', RecipientMsisdn: recipient.msisdn, Channel: recipient.channel,
    Amount: cedisAmount(amountMinor), Description: 'ELESEND payout', ClientReference: reference,
    PrimaryCallbackURL: `${safeCallbackBase}/api/v1/payments/webhook`
   })});
   check(ok && raw?.ResponseCode === '0001', 502, 'Payout was not accepted');
   check(raw?.Data?.ClientReference === reference, 409, 'Provider returned a different payment reference');
   return {providerId: raw.Data?.TransactionId ?? null};
  },
  async verifyPayout({requestId, recipientReference, amountMinor, currency}) {
   check(/^[0-9a-f-]{36}$/.test(requestId), 400, 'Invalid payout request');
   const reference = payoutReference(requestId);
   const out = await payoutStatus(reference);
   if (out.state === 'not_found') return {verified: false, type: 'payout', provider: 'hubtel', status: 'not_found', requestId};
   if (out.state === 'success') check(out.amountMinor === amountMinor && currency === 'GHS', 409, 'Payout amount mismatch');
   return {verified: true, type: 'payout', provider: 'hubtel', status: out.state === 'success' ? 'paid' : out.state, reversed: false, requestId, recipientReference,
    providerId: out.transactionId || null, amountMinor, currency, eventId: out.transactionId ? `transfer:${out.transactionId}${out.state === 'failed' ? ':failed' : ''}` : '',
    ...(out.state === 'failed' ? {failureReason: 'Provider reported the transfer failed'} : {})};
  },
  async createRefund({requestId, reference, amountMinor, currency}) {
   check(/^[0-9a-f-]{36}$/.test(requestId), 400, 'Invalid refund request');
   check(currency === 'GHS' && Number.isSafeInteger(amountMinor) && amountMinor > 0, 400, 'Invalid refund amount');
   const paid = await verifyPayment(reference);
   check(paid.status === 'success' && paid.transactionId, 409, 'Refund needs a confirmed payment');
   check(paid.amountMinor === amountMinor, 409, 'Refund amount must match the confirmed payment');
   const url = `${REFUND_HOST}/refund/${encodeURIComponent(collectionAccount)}/order/${encodeURIComponent(paid.transactionId)}`;
   const {ok, status, raw} = await ask(url, {method: 'POST', body: JSON.stringify({callbackUrl: `${safeCallbackBase}/api/v1/payments/webhook`})});
   if (status === 423 || raw?.responseCode === '4515') return {providerId: paid.transactionId};
   check(ok && raw?.responseCode === '0001', 502, 'Refund was not accepted');
   return {providerId: raw.data?.orderId || paid.transactionId};
  },
  async verifyRefund({requestId, reference, amountMinor, currency}) {
   check(/^[0-9a-f-]{36}$/.test(requestId), 400, 'Invalid refund request');
   const found = await collectionStatus(reference);
   if (found.state !== 'refunded') return {verified: true, type: 'refund', provider: 'hubtel', status: 'pending', requestId, reference};
   check(found.amountMinor === amountMinor && currency === 'GHS', 409, 'Refund amount mismatch');
   return {verified: true, type: 'refund', provider: 'hubtel', status: 'refunded', requestId, reference, providerId: found.transactionId, amountMinor, currency, eventId: found.transactionId ? `refund:${found.transactionId}` : ''};
  }
 };
}
