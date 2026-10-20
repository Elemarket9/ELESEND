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
 const subtotal=base+(meters*perKm+999n)/1000n+(duration*timePerMin+59n)/60n+
   (waiting*waitPerMin+59n)/60n+stops*stopPrice+surcharge;
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
 return {amountMinor:Number(charge),commissionMinor:Number(commission),riderEarningsMinor:Number(charge-commission)};
}
