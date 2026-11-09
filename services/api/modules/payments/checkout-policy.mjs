// A country/market may later override these methods in its own registry.
// DIGITAL is legacy only: never offer it in new bookings.
export const CHECKOUT_METHODS=Object.freeze(['CASH','MOMO','CARD','QR']);
export const DIGITAL_METHODS=Object.freeze(['MOMO','CARD','QR']);
export function isCheckoutMethod(value){return CHECKOUT_METHODS.includes(value);}
export function checkoutDisplay(method){return ({CASH:'Cash to rider',MOMO:'Mobile money',CARD:'Card',QR:'Scan-to-pay checkout QR'})[method]??'Unsupported';}
/** The fee added so that, after the provider takes its percentage of the total, the full price remains. */
export function processingFeeMinor(baseMinor,feeBps){
 if(!Number.isInteger(feeBps)||feeBps<=0)return 0;
 return Math.ceil(baseMinor*10000/(10000-feeBps))-baseMinor;
}
const METHOD_CHANNELS={MOMO:['mobile_money'],CARD:['card'],QR:['mobile_money','card','qr']};
export function channelsForCheckoutMethods(methods){
 return [...new Set((Array.isArray(methods)?methods:[]).flatMap(method=>METHOD_CHANNELS[method]??[]))];
}
export function validateVerifiedPayment(record,{reference,amountMinor,currency,method,acceptedChannels}){
 if(!record||record.status!=='success'||record.reference!==reference||record.currency!==currency||!Number.isSafeInteger(record.amountMinor)||record.amountMinor!==amountMinor||typeof record.eventId!=='string'||record.eventId.length<4)throw Object.assign(Error('Payment verification evidence mismatch'),{status:409});
 // QR is a checkout-link QR; payer completes transaction using a supported
 // provider channel. It is NOT a bank-standard/GHQR payment code.
 // acceptedChannels widens this only when the hosted page cannot be limited to the booked method.
 const accepted=Array.isArray(acceptedChannels)?acceptedChannels:METHOD_CHANNELS[method];
 if(!accepted?.includes(record.channel))throw Object.assign(Error('Unexpected payment channel'),{status:409});
 return true;
}
/** A commission repayment is allowed when the wallet policy lists it. A hosted page that cannot be limited to that list also keeps a confirmed collection whose tender the page itself offers. */
export function confirmedRepaymentChannelAllowed(channel,{policyChannels=[],provider}={}){
 if(Array.isArray(policyChannels)&&policyChannels.includes(channel))return true;
 return provider?.hostedCheckoutChannelRestricted===false&&Array.isArray(provider.collectableChannels)&&provider.collectableChannels.includes(channel);
}
export function validatedCheckoutUrl(value,{allowedHosts=[]}={}){
 if(typeof value!=='string'||value.length>2048)throw Object.assign(Error('Invalid checkout URL'),{status:502});
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port||!allowedHosts.includes(url.hostname))throw Object.assign(Error('Untrusted checkout destination'),{status:502});
 return url.toString();
}
