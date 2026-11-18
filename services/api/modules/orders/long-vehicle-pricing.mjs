/** Heavy freight pricing is deliberately separate from the parcel start/km/minute fare. */
export function calculateLongVehicleQuote(policy,distanceMeters,{weightG,helpers=0,pickupFloors=0,dropoffFloors=0,extraStops=0,tollMinor=0}={}){
 const integer=(value,name)=>{if(value===null||value===undefined||value===''||!Number.isSafeInteger(Number(value))||Number(value)<0)throw Error('Invalid '+name);return BigInt(value);};
 if(policy?.is_placeholder||!policy)throw Error('Long-vehicle pricing is not configured');
 const base=integer(policy.base_minor,'base'),kmRate=integer(policy.per_km_minor,'kilometre rate'),tonneKmRate=integer(policy.per_tonne_km_minor,'tonne-kilometre rate');
 const minimum=integer(policy.minimum_minor,'minimum'),commissionBps=integer(policy.commission_bps,'commission rate'),returnBps=integer(policy.return_leg_bps,'return-leg rate');
 if(commissionBps>10000n||returnBps>10000n)throw Error('Long-vehicle pricing rate exceeds its limit');
 const meters=integer(distanceMeters,'road distance'),grams=integer(weightG,'load weight');
 const billedMeters=(meters*(10000n+returnBps)+9999n)/10000n;
 const distance=(billedMeters*kmRate+999n)/1000n;
 // The load travels one way; the return-leg factor prices empty truck repositioning only.
 const tonneKm=(grams*meters*tonneKmRate+999999999n)/1000000000n;
 const helperCount=integer(helpers,'helpers'),helperUnit=integer(policy.per_helper_minor,'helper rate'),helperCharge=helperCount*helperUnit;
 const pickup=integer(pickupFloors,'pickup floors'),dropoff=integer(dropoffFloors,'drop-off floors'),floorUnit=integer(policy.per_floor_minor,'floor rate');
 const floorCharge=(pickup+dropoff)*floorUnit,stops=integer(extraStops,'extra stops'),stopUnit=integer(policy.per_extra_stop_minor,'extra-stop rate'),stopCharge=stops*stopUnit;
 const tolls=integer(tollMinor,'tolls'),unlimited=base+distance+tonneKm+helperCharge+floorCharge+stopCharge;
 const fare=unlimited<minimum?minimum:unlimited;
 const commission=(fare*commissionBps+5000n)/10000n;
 const bookingBps=integer(policy.booking_fee_bps,'booking-fee rate');if(bookingBps>3000n)throw Error('Long-vehicle booking fee exceeds its limit');
 const booking=(fare*bookingBps+5000n)/10000n,total=fare+booking+tolls,platform=commission+booking;
 if(total<=0n||total>2147483647n||platform>total)throw Error('Long-vehicle quote exceeds invoice bounds');
 return {amountMinor:Number(total),commissionMinor:Number(platform),riderEarningsMinor:Number(total-platform),breakdown:{fareMinor:Number(fare),baseMinor:Number(base),distanceMinor:Number(distance),distanceMeters:Number(billedMeters),loadedRoadDistanceMeters:Number(meters),returnLegBps:Number(returnBps),perKmMinor:Number(kmRate),tonneKmMinor:Number(tonneKm),perTonneKmMinor:Number(tonneKmRate),weightG:Number(grams),helpers:Number(helperCount),helperUnitMinor:Number(helperUnit),helperMinor:Number(helperCharge),pickupFloors:Number(pickup),dropoffFloors:Number(dropoff),floorUnitMinor:Number(floorUnit),pickupFloorMinor:Number(pickup*floorUnit),dropoffFloorMinor:Number(dropoff*floorUnit),floorMinor:Number(floorCharge),extraStops:Number(stops),extraStopsMinor:Number(stopCharge),timeMinor:0,waitingMinor:0,minimumMinor:Number(minimum),minimumApplied:unlimited<minimum,commissionMinor:Number(commission),bookingFeeMinor:Number(booking),tollMinor:Number(tolls)}};
}
