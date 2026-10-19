// A country/market may later override these methods in its own registry.
// DIGITAL is legacy only: never offer it in new bookings.
export const CHECKOUT_METHODS=Object.freeze(['CASH','MOMO','CARD','QR']);
export const DIGITAL_METHODS=Object.freeze(['MOMO','CARD','QR']);
export function isCheckoutMethod(value){return CHECKOUT_METHODS.includes(value);}
export function checkoutDisplay(method){return ({CASH:'Cash to rider',MOMO:'Mobile money',CARD:'Card',QR:'Scan-to-pay checkout QR'})[method]??'Unsupported';}
export function validateVerifiedPayment(record,{reference,amountMinor,currency,method}){
 if(!record||record.status!=='success'||record.reference!==reference||record.currency!==currency||!Number.isSafeInteger(record.amountMinor)||record.amountMinor!==amountMinor||typeof record.eventId!=='string'||record.eventId.length<4)throw Object.assign(Error('Payment verification evidence mismatch'),{status:409});
 // QR is a checkout-link QR; payer completes transaction using a supported
 // provider channel. It is NOT a bank-standard/GHQR payment code.
 const accepted={MOMO:['mobile_money'],CARD:['card'],QR:['mobile_money','card','qr']}[method];
 if(!accepted?.includes(record.channel))throw Object.assign(Error('Unexpected payment channel'),{status:409});
 return true;
}
export function validatedCheckoutUrl(value,{allowedHosts=[]}={}){
 if(typeof value!=='string'||value.length>2048)throw Object.assign(Error('Invalid checkout URL'),{status:502});
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port||!allowedHosts.includes(url.hostname))throw Object.assign(Error('Untrusted checkout destination'),{status:502});
 return url.toString();
}
