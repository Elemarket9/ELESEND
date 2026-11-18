// ELESEND's operating market. Phone rules, map bounds and existing financial records are also specific to Ghana,
// so changing these values alone does not make the platform ready for another country.
export const MARKET_CURRENCY='GHS';
export const MARKET_TIME_ZONE='Africa/Accra';
// Where ELESEND accepts pickup, drop-off and shared pins: Ghana with a small margin.
export const MARKET_ENVELOPE=Object.freeze({minLatitude:4.7,maxLatitude:11.2,minLongitude:-3.3,maxLongitude:1.2});
export const insideMarketEnvelope=(lat,lng)=>Number.isFinite(lat)&&Number.isFinite(lng)&&lat>=MARKET_ENVELOPE.minLatitude&&lat<=MARKET_ENVELOPE.maxLatitude&&lng>=MARKET_ENVELOPE.minLongitude&&lng<=MARKET_ENVELOPE.maxLongitude;
