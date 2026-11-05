import {osrmRouting} from '../../services/api/dispatch-routing.mjs';
import {calculateQuote} from '../../services/api/pricing.mjs';
import {getSurgeMultiplier} from '../../services/api/pricing-surge.mjs';
import {baselineFactorFor,etaBaselineFactors,quotedEtaMinutes} from '../../services/api/eta/baseline-factors.mjs';
import {cityBucket} from '../../services/api/eta/stage-eta.mjs';
const routing=osrmRouting({vehicleRoutes:{car:{endpoint:'http://127.0.0.1:5000',profile:'driving'},motorcycle:{endpoint:'http://127.0.0.1:5001',profile:'motorcycle'}}});
const tariffs={motorcycle:{base_minor:1200,per_km_minor:320,per_minute_minor:25,minimum_minor:2000,commission_bps:1300},car:null};
const to={latitude:5.5731408,longitude:-0.2152024};
const from={'Kasoa old police station':{latitude:5.5344155,longitude:-0.4252737},'Kasoa New Market Police Station':{latitude:5.5547244,longitude:-0.4341409},'Kasoa Downtown Police Station':{latitude:5.5499891,longitude:-0.4450398}};
const periods=[['morning_peak',8],['midday',12],['evening_peak',17],['off_peak',21]];
for(const [name,a] of Object.entries(from)){
 const r=await routing.route(a,to,{vehicle:'motorcycle',billing:true});
 console.log('ROUTE',name,'km',(r.distanceMeters/1000).toFixed(2),'roadMin',(r.durationSeconds/60).toFixed(1));
 for(const [period,hour] of periods){
  const rush=getSurgeMultiplier(a.latitude,a.longitude,hour)>1?14000:10000;
  const q=calculateQuote(tariffs.motorcycle,r.distanceMeters,{durationSeconds:r.durationSeconds,surgeBps:rush});
  const f=baselineFactorFor(etaBaselineFactors({}),'motorcycle',period,cityBucket(a));
  const trip=quotedEtaMinutes(r.durationSeconds,f),whole=quotedEtaMinutes(r.durationSeconds,f,{riderSeconds:600});
  console.log(' ',period,'hour',hour,'rush',rush/10000,'price',(q.amountMinor/100).toFixed(2),'commission',(q.commissionMinor/100).toFixed(2),'rider',(q.riderEarningsMinor/100).toFixed(2),'factor',f,'trip',trip.low+'-'+trip.high,'withRider10min',whole.low+'-'+whole.high);
 }
}
