import {check} from '../security.mjs';

/**
 * Hubtel SMS Gateway Provider
 * Complies with official Hubtel SMS Messaging API v1:
 * Endpoint: https://api.hubtel.com/v1/messages/send
 * Authentication: HTTP Basic Auth (ClientId:ClientSecret)
 * Documentation: https://developers.hubtel.com/document/sms-api
 */
export function hubtelSmsGateway({
 clientId,
 clientSecret,
 senderId = 'ELESEND',
 endpoint = 'https://api.hubtel.com/v1/messages/send',
 fetchImpl = fetch,
 timeoutMs = 8000
} = {}) {
 check(typeof clientId === 'string' && clientId.trim().length > 0, 503, 'Hubtel ClientId required');
 check(typeof clientSecret === 'string' && clientSecret.trim().length > 0, 503, 'Hubtel ClientSecret required');
 check(typeof senderId === 'string' && senderId.length >= 1 && senderId.length <= 11, 400, 'SenderId must be 1-11 alphanumeric characters');

 let url;
 try {
  url = new URL(endpoint);
 } catch {
  check(false, 503, 'Invalid Hubtel SMS endpoint URL');
 }
 check(url.protocol === 'https:', 503, 'Hubtel SMS endpoint requires HTTPS');
 check(
  url.hostname === 'api.hubtel.com' || url.hostname === 'smsc.hubtel.com' || url.hostname === '127.0.0.1' || url.hostname === 'localhost',
  503,
  'Unapproved Hubtel SMS destination host'
 );
 check(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 30000, 500, 'Invalid SMS request timeout');

 const basicAuth = Buffer.from(`${clientId.trim()}:${clientSecret.trim()}`).toString('base64');

 function normalizeGhanaPhone(phone) {
  check(typeof phone === 'string', 400, 'Phone number required');
  let cleanPhone = phone.trim();
  if (cleanPhone.startsWith('0') && cleanPhone.length === 10) {
   cleanPhone = '233' + cleanPhone.slice(1);
  } else if (cleanPhone.startsWith('+')) {
   cleanPhone = cleanPhone.slice(1);
  }
  check(/^233[25]\d{8}$/.test(cleanPhone), 400, 'Invalid Ghana phone number for Hubtel dispatch');
  return cleanPhone;
 }

 async function dispatchHubtel({cleanPhone, messageContent, clientReference}) {
  const payload = {
   From: senderId,
   To: cleanPhone,
   Content: messageContent,
   RegisteredDelivery: true,
   ClientReference: String(clientReference).slice(0, 36)
  };

  let response;
  try {
   response = await fetchImpl(url.toString(), {
    method: 'POST',
    headers: {
     Authorization: `Basic ${basicAuth}`,
     'Content-Type': 'application/json',
     Accept: 'application/json'
    },
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
   });
  } catch {
   check(false, 503, 'Hubtel SMS gateway unreachable');
  }

  check(response.ok, 503, `Hubtel SMS request refused (HTTP ${response.status})`);

  let result;
  try {
   result = await response.json();
  } catch {
   check(false, 503, 'Invalid JSON response from Hubtel SMS gateway');
  }

  // Hubtel returns Code: "00" or "0000" on success, with MessageId in Data.MessageId
  const isSuccess = result?.Code === '00' || result?.Code === '0000' || result?.status === 0 || result?.Message === 'Success';
  const messageId = result?.Data?.MessageId || result?.MessageId || result?.messageId;

  check(isSuccess && typeof messageId === 'string' && messageId.length > 0, 503, result?.Message || 'Hubtel SMS acceptance not verified');

  return {
   accepted: true,
   messageId,
   provider: 'hubtel'
  };
 }

 return {
  name: 'hubtel',
  senderId,

  async send({phone, code, purpose, challengeId}) {
   const cleanPhone = normalizeGhanaPhone(phone);
   check(/^\d{6}$/.test(code), 400, 'Invalid 6-digit OTP code');
   check(['pickup', 'delivery', 'account', 'account_recovery'].includes(purpose), 400, 'Invalid OTP purpose');
   check(typeof challengeId === 'string' && challengeId.length > 0, 400, 'ChallengeId required');

   const messageContent = purpose === 'account'
    ? `ELESEND account phone verification: ${code}. Do not share this code with anyone.`
    : purpose === 'account_recovery'
    ? `ELESEND password recovery code: ${code}. Expires in 10 minutes. Do not share this code with anyone.`
    : purpose === 'pickup'
    ? `ELESEND parcel pickup verification: ${code}. Never share with anyone except your assigned rider at handover.`
    : `ELESEND parcel delivery verification: ${code}. Give this to your assigned rider only when receiving the parcel.`;

   return dispatchHubtel({cleanPhone, messageContent, clientReference: challengeId});
  },

  async sendNotification({phone, message, jobId, clientReference, kind = 'notification'} = {}) {
   const cleanPhone = normalizeGhanaPhone(phone);
   const text = typeof message === 'string' ? message.trim() : '';
   check(text.length >= 1 && text.length <= 480, 400, 'Invalid notification message text');
   const ref = String(clientReference || jobId || `${kind}:${cleanPhone}`).trim();
   check(ref.length > 0, 400, 'ClientReference or jobId required');
   return dispatchHubtel({cleanPhone, messageContent: text, clientReference: ref});
  }
 };
}
