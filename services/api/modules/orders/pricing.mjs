/** Deterministic pricing in integer pesewas. Never use floating point for money. */
export function calculateQuote(policy,distanceMeters,extras={}){
 const positive=(x,name)=>{if(!Number.isSafeInteger(x)||x<0)throw Error('Invalid '+name);return BigInt(x);};
 const meters=positive(distanceMeters,'distance');
 const base=positive(policy.base_minor,'base'), perKm=positive(policy.per_km_minor,'per-km rate');
 const bps=positive(policy.commission_bps,'commission basis points');if(bps>10000n)throw Error('Commission basis points exceed 100% limit');
 const duration=positive(extras.durationSeconds??0,'route time');
 const waiting=positive(extras.waitingSeconds??0,'waiting time');
 const stops=positive(extras.extraStops??0,'extra stops');
 const surcharge=positive(extras.surchargeMinor??0,'surcharge');
 const discount=positive(extras.discountMinor??0,'discount');
 const timePerMin=positive(policy.per_minute_minor??0,'per-minute rate');
 const waitPerMin=positive(policy.wait_per_minute_minor??0,'waiting-minute rate');
 const stopPrice=positive(policy.per_extra_stop_minor??0,'extra stop price');
 const helpers=positive(extras.helpers??0,'helpers'),helperPrice=positive(policy.per_helper_minor??0,'helper price');
 const pickupFloors=positive(extras.pickupFloors??extras.floors??0,'pickup floors'),dropoffFloors=positive(extras.dropoffFloors??0,'drop-off floors'),floors=pickupFloors+dropoffFloors,floorPrice=positive(policy.per_floor_minor??0,'floor price');
 const distance=(meters*perKm+999n)/1000n,time=(duration*timePerMin+59n)/60n;
 const wait=(waiting*waitPerMin+59n)/60n,helperCharge=helpers*helperPrice,floorCharge=floors*floorPrice,extraStopCharge=stops*stopPrice;
 const subtotal=base+distance+time+wait+helperCharge+floorCharge+extraStopCharge+surcharge;
 if(discount>=subtotal)throw Error('Discount would remove the entire delivery fare');
 const surgeBps=positive(extras.surgeBps??10000,'surge basis points');
 if(surgeBps<10000n||surgeBps>20000n)throw Error('Surge multiplier outside policy bounds');
 const minimum=positive(policy.minimum_minor??0,'minimum fare');
 const surged=((subtotal-discount)*surgeBps+5000n)/10000n;
 const charge=surged<minimum?minimum:surged;
 if(charge<=0n||charge>2147483647n)throw Error('Charge exceeds invoice bounds');
 const rate=bps===0n?0n:(charge*bps+5000n)/10000n;
 const mode=policy.commission_mode||'percentage';
 const fixed=positive(policy.commission_fixed_minor??0,'fixed fee');
 let commission=mode==='percentage'?rate:mode==='fixed'?fixed:mode==='hybrid'?rate+fixed:null;
 if(commission===null)throw Error('Unknown commission mode');
 if(policy.commission_cap_minor!==null&&policy.commission_cap_minor!==undefined){
  const cap=positive(policy.commission_cap_minor,'commission cap');if(commission>cap)commission=cap;
 }
 if(commission>charge)commission=charge;
 // The booking fee is ELESEND's. Tolls pass through to the rider who pays them, free of commission and multipliers.
 const bookingBps=positive(policy.booking_fee_bps??0,'booking fee');if(bookingBps>3000n)throw Error('Booking fee exceeds limit');
 const booking=(charge*bookingBps+5000n)/10000n;
 const tolls=positive(extras.tollMinor??0,'toll');
 const total=charge+booking+tolls;
 if(total>2147483647n)throw Error('Charge exceeds invoice bounds');
 const platform=commission+booking;
 return {amountMinor:Number(total),commissionMinor:Number(platform),riderEarningsMinor:Number(total-platform),
  breakdown:{fareMinor:Number(charge),baseMinor:Number(base),distanceMinor:Number(distance),timeMinor:Number(time),waitingMinor:Number(wait),helpers:Number(helpers),helperUnitMinor:Number(helperPrice),helperMinor:Number(helperCharge),floors:Number(floors),pickupFloors:Number(pickupFloors),dropoffFloors:Number(dropoffFloors),floorUnitMinor:Number(floorPrice),floorMinor:Number(floorCharge),pickupFloorMinor:Number(pickupFloors*floorPrice),dropoffFloorMinor:Number(dropoffFloors*floorPrice),extraStops:Number(stops),extraStopsMinor:Number(extraStopCharge),surchargeMinor:Number(surcharge),discountMinor:Number(discount),salesCommissionMinor:Number(commission),bookingFeeMinor:Number(booking),tollMinor:Number(tolls),minimumApplied:surged<minimum}};
}

/** Fee after the free minutes, per started minute, up to the limit. */
export function waitingFeeMinor(waitedSeconds,perMinuteMinor,{freeMinutes=5,maxMinor=1500}={}){
 const over=waitedSeconds-freeMinutes*60;
 if(!(over>0)||!(perMinuteMinor>0))return 0;
 return Math.min(maxMinor,Math.ceil(over/60)*perMinuteMinor);
}
