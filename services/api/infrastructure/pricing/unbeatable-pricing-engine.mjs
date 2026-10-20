import {calculateQuote} from '../../pricing.mjs';
import {check} from '../../security.mjs';

/** Weight and parcel size surcharges (integer pesewas) */
export function calculateCargoSurcharge({weightG=1000,parcelSize='small'}={}){
 const w=Number(weightG)||0;
 let sizeFee=0;
 if(parcelSize==='medium')sizeFee=400; // GH₵4.00
 else if(parcelSize==='large')sizeFee=800; // GH₵8.00

 // Weight tiering: free up to 3kg; 100 pesewas (GH₵1.00) per additional kg above 3kg
 const excessKg=Math.max(0,Math.ceil((w-3000)/1000));
 const weightFee=excessKg*100;

 return sizeFee+weightFee;
}

/** Long-pickup allowance: compensates courier when travel to pickup exceeds 2.5km.
 * 100% of this fee goes directly to the courier to prevent order rejections.
 */
export function calculateLongPickupAllowance({pickupDistanceMeters=0,vehicle='motorcycle'}={}){
 const dist=Number(pickupDistanceMeters)||0;
 const thresholdMeters=2500;
 if(dist<=thresholdMeters)return 0;

 const extraKm=Math.ceil((dist-thresholdMeters)/1000);
 // GH₵2.00 per extra km for motorcycle, GH₵3.00 for car/van
 const ratePerKm=vehicle==='motorcycle'?200:300;
 return Math.min(1500,extraKm*ratePerKm); // capped at GH₵15.00
}

/** Smooth continuous rush-hour multiplier without abrupt step cliffs.
 * Accra/Kumasi rush peaks: 07:00-09:00 and 16:30-19:00.
 */
export function smoothRushHourMultiplier(date=new Date()){
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Accra',hour:'2-digit',hourCycle:'h23'}).format(date));
 const minute=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Accra',minute:'2-digit'}).format(date));
 const time=hour+minute/60;

 // Morning Peak: 06:45 - 09:15, peaking around 07:45 - 08:15 (1.4x)
 if(time>=6.75&&time<=9.25){
  const center=8.0;
  const dist=Math.abs(time-center);
  const factor=Math.max(0,1-(dist/1.25));
  return Math.round(10000+4000*factor); // 10000 to 14000 bps
 }

 // Evening Peak: 16:15 - 19:30, peaking around 17:30 - 18:00 (1.4x)
 if(time>=16.25&&time<=19.5){
  const center=17.75;
  const dist=Math.abs(time-center);
  const factor=Math.max(0,1-(dist/1.75));
  return Math.round(10000+4000*factor); // 10000 to 14000 bps
 }

 return 10000;
}

/** Dynamic pricing engine designed to outperform Bolt and Yango in driver retention & customer price.
 * - Driver commission: 13% default (ELESEND) vs 20% (Bolt) / 18% (Yango).
 * - Transparent itemization: base, distance, duration, cargo size, deadhead pickup bonus, surge.
 */
export function calculateDynamicDeliveryQuote({
 policy,
 distanceMeters,
 durationSeconds=0,
 vehicle='motorcycle',
 weightG=1500,
 parcelSize='small',
 pickupDistanceMeters=0,
 supplyDemandSurgeBps=10000,
 isRaining=false,
 now=new Date()
}){
 check(policy&&typeof policy==='object',500,'Pricing policy required');
 check(Number.isFinite(distanceMeters)&&distanceMeters>=0,400,'Valid distance required');

 const cargoSurcharge=calculateCargoSurcharge({weightG,parcelSize});
 const longPickupAllowance=calculateLongPickupAllowance({pickupDistanceMeters,vehicle});
 const rainSurcharge=isRaining?500:0; // GH₵5.00 rain compensation during downpours

 const totalSurcharge=cargoSurcharge+longPickupAllowance+rainSurcharge;

 const rushBps=policy.rush_hour_enabled?smoothRushHourMultiplier(now):10000;
 const surgeBps=Math.max(rushBps,supplyDemandSurgeBps);

 const quote=calculateQuote(policy,Math.round(distanceMeters),{
  durationSeconds:Math.round(durationSeconds),
  surchargeMinor:totalSurcharge,
  surgeBps
 });

 // Unbeatable economics: calculate what this exact trip yields on Bolt (20% fee) and Yango (18% fee)
 const totalGhs=quote.amountMinor/100;
 const elesendDriverGhs=quote.riderEarningsMinor/100;
 const elesendPlatformGhs=quote.commissionMinor/100;
 const configuredRatePercent=Number(policy.commission_bps??1300)/100;

 const boltDriverNet=Math.round(totalGhs*0.80*100)/100;
 const yangoDriverNet=Math.round(totalGhs*0.82*100)/100;
 const driverAdvantageGhs=Math.round((elesendDriverGhs-boltDriverNet)*100)/100;

 return {
  amountMinor:quote.amountMinor,
  commissionMinor:quote.commissionMinor,
  riderEarningsMinor:quote.riderEarningsMinor,
  totalGhs,
  driverEarningsGhs:elesendDriverGhs,
  platformCommissionGhs:elesendPlatformGhs,
  commissionRatePercent:configuredRatePercent,
  breakdown:{
   baseGhs:Number(policy.base_minor)/100,
   distanceGhs:Number((BigInt(Math.round(distanceMeters))*BigInt(policy.per_km_minor??0)+999n)/1000n)/100,
   durationGhs:Number((BigInt(Math.round(durationSeconds))*BigInt(policy.per_minute_minor??0)+59n)/60n)/100,
   cargoSurchargeGhs:cargoSurcharge/100,
   longPickupAllowanceGhs:longPickupAllowance/100,
   rainSurchargeGhs:rainSurcharge/100,
   surgeMultiplier:surgeBps/10000,
   surgeReason:isRaining?'adverse_weather':surgeBps>10000?'high_demand_rush_hour':'standard'
  },
  competitiveComparison:{
   competitorTakeRatePercent:20.0,
   boltEstimatedDriverEarningsGhs:boltDriverNet,
   yangoEstimatedDriverEarningsGhs:yangoDriverNet,
   elesendDriverAdvantageGhs:driverAdvantageGhs,
   narrative:`On ELESEND (${configuredRatePercent.toFixed(1)}% fee), driver earns GH₵${elesendDriverGhs.toFixed(2)} vs GH₵${boltDriverNet.toFixed(2)} on Bolt (20% fee) — keeping +GH₵${driverAdvantageGhs.toFixed(2)} more cash in pocket.`
  }
 };
}
