/** Contract definitions; adapters are not implemented or certified by these interfaces. */
export interface Money {currency:'GHS';amountMinor:number}
export interface ConfirmedPayment {provider:string;eventId:string;shipmentId:string;amountMinor:number;currency:'GHS'}
export interface PaymentAdapter {
  initialize(shipmentId:string,total:Money,idempotencyKey:string):Promise<{reference:string;checkoutUrl:string}>;
  /** Must verify raw bytes and signature, query provider status, bind merchant,
   * environment, reference, currency and exact amount before returning. */
  verifyAndReconcile(rawBody:Uint8Array,headers:Record<string,string>):Promise<ConfirmedPayment>;
  refund(reference:string,total:Money,idempotencyKey:string):Promise<{reference:string;status:'pending'|'confirmed'}>;
}
export interface SmsAdapter {send(message:{phone:string;code:string;purpose:'pickup'|'delivery';challengeId:string}):Promise<void>}
export interface GeoPoint {latitude:number;longitude:number}
export interface RoadEstimate {distanceMeters:number;durationSeconds:number;source:'routing-provider'|'fixture';trafficAware:boolean;geometry?:{type:'LineString';coordinates:number[][]}}
export interface RoutingAdapter {
 route(origin:GeoPoint,destination:GeoPoint,options:{vehicle:string}):Promise<RoadEstimate>;
 matrix(origins:GeoPoint[],destination:GeoPoint,options:{vehicle:string}):Promise<Array<RoadEstimate|null>>;
 capabilities:{roadNetwork:boolean|'simulated';traffic:boolean;mapMatching:boolean};
}
export interface GeocodingAdapter {geocode(address:string):Promise<Array<GeoPoint&{label:string}>>;reverseGeocode(position:GeoPoint):Promise<{label:string}|null>}
export interface MapMatchingAdapter {match(points:GeoPoint[],options:{vehicle:string}):Promise<GeoPoint[]>}
