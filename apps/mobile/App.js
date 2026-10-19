import React,{useEffect,useState,useRef} from 'react';
import {View,Text,TextInput,Pressable,ScrollView,StyleSheet,Alert,ActivityIndicator,AppState,Platform,Linking} from 'react-native';
import MapView,{Marker,MAP_RENDERER} from './src/maps/map-adapter';
import QRCode from 'react-native-qrcode-svg';
import * as Location from 'expo-location';
import * as Crypto from 'expo-crypto';
import {call,loadToken,saveToken,clearToken,ghc} from './src/api';
import {sample,startShiftTracking,stopShiftTracking} from './src/tracking';
import {cacheJobs,readCachedJobs,clearCachedJobs} from './src/offline';
const colors={bg:'#0c1324',panel:'#172239',line:'#30415f',light:'#eef5ff',muted:'#a5b6d0',accent:'#3fd6b3',warn:'#ffb356'};
const smallButton=(label,onPress,disabled=false)=> <Pressable onPress={onPress} disabled={disabled} style={[styles.btn,disabled&&{opacity:.45}]}><Text style={styles.btnText}>{label}</Text></Pressable>;
const field=(placeholder,value,onChange,opts={})=><TextInput accessibilityLabel={placeholder} placeholder={placeholder} placeholderTextColor={colors.muted} style={styles.field} value={String(value??'')} onChangeText={onChange} {...opts}/>;
const heading=title=><Text style={styles.heading}>{title}</Text>;
const label=v=><Text style={styles.text}>{v}</Text>;
const note=v=><Text style={styles.note}>{v}</Text>;
const parseGhs=v=>{const m=/^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(v.trim());if(!m)throw Error('Enter Ghana cedis as 30 or 30.00');return Number(m[1])*100+Number((m[2]||'').padEnd(2,'0'));};
const safe=async(fn,setError)=>{try{setError('');return await fn();}catch(e){setError(e.message);return null;}};
const initial={phone:'',password:'',totpCode:'',kind:'customer',vehicle:'motorcycle',maxWeightG:'20000',plateNumber:'',make:'',model:'',color:''};
const isStationary=speed=>speed===null||speed<2.5;
function Card({children}){return <View style={styles.card}>{children}</View>;}
export default function App(){
 const [auth,setAuth]=useState(null),[credentials,setCredentials]=useState(initial),[isSignup,setIsSignup]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[tab,setTab]=useState('Home');
 const [offers,setOffers]=useState([]),[manifest,setManifest]=useState(null),[shifts,setShifts]=useState(null),[vehicle,setVehicle]=useState(null),[online,setOnline]=useState(false),[speed,setSpeed]=useState(null),[trackingSeconds,setTrackingSeconds]=useState(15);
 const [quoted,setQuoted]=useState(null),[step,setStep]=useState(0),[myShipments,setMyShipments]=useState([]),[booking,setBooking]=useState({pickup:null,destination:null,vehicle:'motorcycle',recipientPhone:'',weightG:'1500',description:'Parcel',parcelCategory:'general',parcelSize:'small',paymentMethod:'CASH',cashPayer:'recipient'});
 const [review,setReview]=useState(null),[fleet,setFleet]=useState(null),[inviteId,setInviteId]=useState(''),[inviteToken,setInviteToken]=useState(null),[dispatchPolicy,setDispatchPolicy]=useState(null);
 const [offlineCopy,setOfflineCopy]=useState(null),[algorithmFeatures,setAlgorithmFeatures]=useState([]),[maxParcelsInput,setMaxParcelsInput]=useState('2'),[markets,setMarkets]=useState([]),[newCountry,setNewCountry]=useState(''),[newCurrency,setNewCurrency]=useState(''),[riskSignals,setRiskSignals]=useState([]),[riskReason,setRiskReason]=useState('');
 const [finance,setFinance]=useState(null),[payAmount,setPayAmount]=useState(''),[cashAmount,setCashAmount]=useState(''),[reportedCash,setReportedCash]=useState({}),[adminFinances,setAdminFinances]=useState(null),[adjustments,setAdjustments]=useState([]),[adminRider,setAdminRider]=useState(''),[adminLimit,setAdminLimit]=useState('40.00'),[adminDueDays,setAdminDueDays]=useState('7'),[adminMaxJobs,setAdminMaxJobs]=useState('20'),[correctionAmount,setCorrectionAmount]=useState(''),[correctionReason,setCorrectionReason]=useState('');
 const [phoneChallenge,setPhoneChallenge]=useState(null),[phoneCode,setPhoneCode]=useState(''),[phoneStatus,setPhoneStatus]=useState(null);
 const [ghanaAddress,setGhanaAddress]=useState(''),[ghanaAddressLookup,setGhanaAddressLookup]=useState(false);const addressLookupEpoch=useRef(0),mapRef=useRef(null);
 const [paymentMethods,setPaymentMethods]=useState([{method:'CASH',enabled:true}]),[paymentEmail,setPaymentEmail]=useState(''),[checkoutSession,setCheckoutSession]=useState(null),[adminPaymentMethods,setAdminPaymentMethods]=useState([]);
 const [activeParcel,setActiveParcel]=useState(null),[challenge,setChallenge]=useState(null),[otp,setOtp]=useState(''),[reason,setReason]=useState('Unable to complete pickup');const watch=useRef(null);
 const edit=(key,value)=>setCredentials(v=>({...v,[key]:value}));const update=(key,value)=>{if(key==='pickup'||key==='destination')addressLookupEpoch.current++;setBooking(v=>({...v,[key]:value}));setQuoted(null);};
 const execute=async task=>{if(busy)return;setBusy(true);await safe(task,setError);setBusy(false);};
 useEffect(()=>{(async()=>{const token=await loadToken();if(token){try{setAuth(await call('GET','/api/v1/me'));}catch{await clearToken();}}
  setLoading(false);})().catch(()=>setLoading(false));},[]);
 useEffect(()=>{if(!auth)return;call('GET','/api/v1/payments/methods').then(setPaymentMethods).catch(()=>setPaymentMethods([{method:'CASH',enabled:true}]));},[auth]);
 useEffect(()=>{let cancelled=false;addressLookupEpoch.current++;setGhanaAddressLookup(false);setGhanaAddress('');if(auth)call('GET','/api/v1/maps/config').then(v=>{if(!cancelled)setGhanaAddressLookup(v.ghanaPostGpsLookup===true);}).catch(()=>{});return()=>{cancelled=true;};},[auth]);
 useEffect(()=>{if(!auth||auth.kind!=='rider')return;let cancelled=false;
  const get=async()=>{if(cancelled)return;try{const [m,o,v]=await Promise.all([call('GET','/api/v1/rider/manifest'),call('GET','/api/v1/rider/offers').catch(()=>[]),call('GET','/api/v1/rider/vehicle')]);if(!cancelled){setManifest(m);setOffers(o);setVehicle(v);setOnline(v.online);setOfflineCopy(null);cacheJobs(auth.id,m).catch(()=>{});}}catch(e){if(!cancelled)setError(e.message);}};
  readCachedJobs(auth.id).then(x=>{if(x&&!cancelled)setOfflineCopy(x);}).catch(()=>{});
  get();const timer=setInterval(()=>{if(AppState.currentState==='active')get();},10000);
  return()=>{cancelled=true;clearInterval(timer);};
 },[auth]);
 useEffect(()=>{if(!auth||auth.kind!=='rider'||!online)return;
  let mounted=true;(async()=>{try{const allowed=await Location.requestForegroundPermissionsAsync();if(allowed.status!=='granted'){setError('GPS permission is needed for online dispatch');return;}
   watch.current=await Location.watchPositionAsync({accuracy:Location.Accuracy.Balanced,timeInterval:trackingSeconds*1000,distanceInterval:35},async position=>{
    if(!mounted)return;setSpeed(position.coords.speed>=0?position.coords.speed:null);
    const v=sample(position);if(v&&!shifts?.background)try{await call('POST','/api/v1/rider/location',v);}catch(e){if(mounted)setError(e.message);}
   });}catch(e){setError(e.message);}})();return()=>{mounted=false;watch.current?.remove();watch.current=null;};
 },[auth,online,shifts?.background,trackingSeconds]);
 async function loadReview(){setReview(await call('GET','/api/v1/admin/review'));const p=await call('GET','/api/v1/admin/dispatch-policy');setDispatchPolicy(p);setMaxParcelsInput(String(p.max_active_parcels));setAlgorithmFeatures(await call('GET','/api/v1/admin/algorithm-features'));setMarkets(await call('GET','/api/v1/admin/markets'));}
 async function toggleMultiStop(enabled){const p=dispatchPolicy||await call('GET','/api/v1/admin/dispatch-policy');
   await call('POST','/api/v1/admin/dispatch-policy',{searchRadiiM:p.search_radii_m,candidateLimit:p.candidate_limit,freshSeconds:p.fresh_seconds,maxSampleAgeSeconds:p.max_sample_age_seconds,maxAccuracyM:p.max_accuracy_m,maxSpeedMps:p.max_speed_mps,offerSeconds:p.offer_seconds,retrySeconds:p.retry_seconds,maxAttempts:p.max_attempts,sampleRetentionHours:p.sample_retention_hours,movingUploadSeconds:p.moving_upload_seconds,idleUploadSeconds:p.idle_upload_seconds,multiStopEnabled:enabled,maxActiveParcels:Number(maxParcelsInput),maxDetourSeconds:p.max_detour_seconds,deliverySlackSeconds:p.delivery_slack_seconds,maxPickupEtaSeconds:p.max_pickup_eta_seconds,maxOfferMovementM:p.max_offer_movement_m});await loadReview();}
 async function signIn(){const data=await call('POST','/api/v1/auth/login',{phone:credentials.phone,password:credentials.password,...(credentials.totpCode?{totpCode:credentials.totpCode}:{})});await saveToken(data.token);setAuth(data.user);setCredentials(c=>({...c,password:'',totpCode:''}));}
 async function signUp(){const body={phone:credentials.phone,password:credentials.password,kind:credentials.kind};if(credentials.kind==='company')body.name=credentials.name||'My logistics company';
  if(credentials.kind==='rider'){body.vehicle=credentials.vehicle;body.maxWeightG=Number(credentials.maxWeightG);if(credentials.vehicle==='car')body.car={plateNumber:credentials.plateNumber,make:credentials.make,model:credentials.model,color:credentials.color};}
  await call('POST','/api/v1/auth/register',body);setIsSignup(false);setError('Account submitted. Sign in; rider/car approval is required before receiving offers.');}
 async function logout(){if(auth?.kind==='rider'){try{await call('POST','/api/v1/rider/availability',{online:false});}catch{}try{await stopShiftTracking();}catch{}}
  try{await call('POST','/api/v1/auth/logout');}catch{/* Revocation may fail offline. The server token expires independently. */}
  finally{await clearCachedJobs();await clearToken();setAuth(null);setOnline(false);setManifest(null);setOffers([]);setTab('Home');}}
 async function toggleOnline(){if(online){await call('POST','/api/v1/rider/availability',{online:false});await stopShiftTracking();setOnline(false);return;}
  const allowed=await Location.requestForegroundPermissionsAsync();if(allowed.status!=='granted')throw Error('GPS access required before going online');
  // Do not go online without one successfully authenticated current position.
  const settings=await call('GET','/api/v1/rider/dispatch-settings');setTrackingSeconds(settings.movingUploadSeconds);
  await call('POST','/api/v1/rider/availability',{online:true});
  try{const loc=await Location.getCurrentPositionAsync({accuracy:Location.Accuracy.Balanced});await call('POST','/api/v1/rider/location',sample(loc));
   setOnline(true);try{setShifts(await startShiftTracking(settings));}catch(e){setShifts({background:false,reason:e.message});}
  }catch(e){await call('POST','/api/v1/rider/availability',{online:false}).catch(()=>{});throw e;}
 }
 async function refreshJobs(){try{const jobs=await call('GET','/api/v1/shipments');setMyShipments(jobs);if(auth.kind==='rider'&&manifest)await cacheJobs(auth.id,{shipments:jobs,stops:manifest.stops});setOfflineCopy(null);}
  catch(e){const cached=auth.kind==='rider'?await readCachedJobs(auth.id):null;if(!cached)throw e;setMyShipments(cached.shipments);setOfflineCopy(cached);setError('Offline: displaying previously synchronized jobs. Cash reports, OTP and financial actions require the server.');}}

 async function acceptOffer(o){if(!isStationary(speed))throw Error('Stop safely before accepting');await call('POST',`/api/v1/shipments/${o.id}/accept`,{offerId:o.offerId});setOffers(v=>v.filter(x=>x.offerId!==o.offerId));setTab('Jobs');}
 async function verifyStop(s,kind){if(!isStationary(speed))throw Error('Stop safely before verification');const c=await call('POST',`/api/v1/shipments/${s.id}/${kind}-challenge`,{});setActiveParcel({...s,kind});setChallenge(c);setOtp('');}
 async function completeOtp(){await call('POST',`/api/v1/shipments/${activeParcel.id}/verify`,{challengeId:challenge.challengeId,code:otp});setChallenge(null);setActiveParcel(null);setOtp('');}
 async function price(){const b=booking;const input={pickup:b.pickup,destination:b.destination,vehicle:b.vehicle,recipientPhone:b.recipientPhone,weightG:Number(b.weightG),description:b.description,parcelCategory:b.parcelCategory,parcelSize:b.parcelSize,paymentMethod:b.paymentMethod,cashPayer:b.cashPayer};setQuoted(await call('POST','/api/v1/quotes',input));}
 async function findGhanaPostGpsAddress(){const epoch=++addressLookupEpoch.current;const result=await call('POST','/api/v1/maps/ghana-address',{address:ghanaAddress});if(epoch!==addressLookupEpoch.current)return;
  if(!result.found)throw Error('GhanaPostGPS could not find that address');const target=booking.pickup?'destination':'pickup',pin={latitude:result.latitude,longitude:result.longitude,address:`${result.address}${result.label?` • ${result.label}`:''}`};update(target,pin);mapRef.current?.animateToRegion({latitude:pin.latitude,longitude:pin.longitude,latitudeDelta:.012,longitudeDelta:.012},500);setError('Review and adjust the map pin to the exact entrance before booking.');}
 async function startCheckout(shipment){
  let existing=null;try{existing=await call('GET',`/api/v1/shipments/${shipment.id}/checkout`);}catch{}
  const res=existing&&['pending','confirmed','initiating'].includes(existing.status)?existing:await call('POST',`/api/v1/shipments/${shipment.id}/checkout`,{idempotencyKey:Crypto.randomUUID(),...(paymentEmail?{email:paymentEmail.trim()}: {})});
  setCheckoutSession(res);
  if(res.status!=='confirmed'&&res.checkoutUrl&&shipment.payment_method!=='QR')await Linking.openURL(res.checkoutUrl);
  return res;
 }
 async function book(){const idempotencyKey=Crypto.randomUUID();const r=await call('POST','/api/v1/shipments',{quoteId:quoted.id},{idempotencyKey});setStep(0);setQuoted(null);setTab('Jobs');await refreshJobs();
  if(r.payment_method==='CASH'){setError(`Cash booking ${r.id.slice(0,8)} saved. Rider acceptance is not guaranteed.`);return;}
  try{const x=await startCheckout(r);setError(`Payment ${x.status}. Only verified confirmation dispatches the delivery.`);}
  catch(e){setError(`Booking ${r.id.slice(0,8)} awaits payment. ${e.message}. Re-open this order to retry or check status.`);}
 }

 function selectOnMap(position){if(step!==0)return;const center={latitude:position.nativeEvent.coordinate.latitude,longitude:position.nativeEvent.coordinate.longitude};update(booking.pickup?'destination':'pickup',{address:`Map pin ${center.latitude.toFixed(5)}, ${center.longitude.toFixed(5)}`,...center});}
 if(loading)return <View style={styles.screen}><ActivityIndicator color={colors.accent}/></View>;
 return <View style={styles.screen}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
  <Text style={styles.brand}>ELESEND</Text>{note('Independent Ghana logistics • native Android/iOS pilot')}
  {!!error&&<Pressable onPress={()=>setError('')} style={styles.warning}><Text style={styles.warnText}>{error}  ×</Text></Pressable>}
  {!auth?<Card>{heading(isSignup?'Create your ELESEND account':'Secure sign in')}{field('Ghana phone number',credentials.phone,v=>edit('phone',v),{keyboardType:'phone-pad'})}{field('Password (min 12)',credentials.password,v=>edit('password',v),{secureTextEntry:true})}{!isSignup&&field('Admin authenticator code (admins only)',credentials.totpCode,v=>edit('totpCode',v),{keyboardType:'number-pad',maxLength:6,secureTextEntry:true})}
   {isSignup&&<>{heading('Account category')}<View style={styles.row}>{['customer','business','rider','company'].map(k=><Pressable key={k} onPress={()=>edit('kind',k)} style={[styles.choice,credentials.kind===k&&styles.selected]}><Text style={styles.text}>{k}</Text></Pressable>)}</View>
    {credentials.kind==='company'&&field('Company name',credentials.name,v=>edit('name',v))}
    {credentials.kind==='rider'&&<>{heading('Delivery vehicle')}<View style={styles.row}>{['motorcycle','car','tricycle','pickup','van','bicycle','truck'].map(k=><Pressable key={k} onPress={()=>edit('vehicle',k)} style={[styles.choice,credentials.vehicle===k&&styles.selected]}><Text style={styles.text}>{k}</Text></Pressable>)}</View>
    {field('Vehicle cargo capacity (grams)',credentials.maxWeightG,v=>edit('maxWeightG',v),{keyboardType:'numeric'})}
    {credentials.vehicle==='car'&&<>{note('Cars are welcome. Your car must pass manual verification before dispatch.')}{field('Vehicle registration plate',credentials.plateNumber,v=>edit('plateNumber',v))}{field('Car make',credentials.make,v=>edit('make',v))}{field('Car model',credentials.model,v=>edit('model',v))}{field('Car color',credentials.color,v=>edit('color',v))}</>}</>}
   </>}
   {smallButton(busy?'Processing...':isSignup?'Submit registration':'Sign in',()=>execute(isSignup?signUp:signIn),busy)}
   {smallButton(isSignup?'Already registered? Sign in':'New here? Create account',()=>setIsSignup(!isSignup))}</Card>:
  <><View style={styles.row}>{(auth.kind==='rider'?['Home','Jobs','Finance','Account']:['Home','Jobs','Account']).map(t=><Pressable key={t} onPress={()=>{setTab(t);if(t==='Jobs')execute(refreshJobs);}} style={[styles.choice,tab===t&&styles.selected]}><Text style={styles.text}>{t}</Text></Pressable>)}</View>
  {tab==='Account'&&<Card>{heading('Registered phone verification')}
   {smallButton('Check phone verification',()=>execute(async()=>setPhoneStatus(await call('GET','/api/v1/me/phone'))))}
   {phoneStatus&&label(`${phoneStatus.phone} • ${phoneStatus.verified?'VERIFIED':'UNVERIFIED'}`)}
   {!phoneStatus?.verified&&<>{smallButton('Send phone verification SMS',()=>execute(async()=>{setPhoneChallenge(await call('POST','/api/v1/me/phone-challenge',{}));setPhoneCode('');}))}
    {phoneChallenge&&<>{field('SMS verification code',phoneCode,setPhoneCode,{keyboardType:'number-pad',maxLength:6})}
     {smallButton('Verify registered phone',()=>execute(async()=>{await call('POST','/api/v1/me/phone-verify',{challengeId:phoneChallenge.challengeId,code:phoneCode});setPhoneStatus(await call('GET','/api/v1/me/phone'));setPhoneChallenge(null);setPhoneCode('');}))}</>}
   </>}{note('Production orders and rider shifts require ownership verification of your registered phone.')}
  </Card>}
  {tab==='Finance'&&auth.kind==='rider'&&<Card>{heading('Cash and ELESEND commissions')}
    {smallButton('Refresh finance history',()=>execute(async()=>setFinance(await call('GET','/api/v1/rider/finance'))),busy)}
    {finance&&<>{label(`Cash reported collected: ${ghc(finance.cashReportedMinor)}`)}
      {label(`ELESEND commissions outstanding: ${ghc(finance.dueMinor)}`)}
      {label(`Prepaid commission credits: ${ghc(finance.creditMinor)}`)}{label(`Provider funds pending reconciliation: ${ghc(finance.unappliedProviderMinor)}`)}{label(`Unsettled jobs: ${finance.unpaidJobs}`)}{note(finance.nextDueAt?`Next commission due: ${new Date(finance.nextDueAt).toLocaleDateString()}`:'No unsettled commission due')}
      {note(`Postpaid limit: ${ghc(finance.maxOutstandingMinor)} • Settlement policy: ${finance.dueDays} days • Grace: ${finance.graceDays??0} days`)}
      {note('Outstanding commission is money owed, NOT money collected by ELESEND. Cash values are rider-reported. Prepaid credits require a legally approved payment arrangement.')}
      {heading('Repay commission via authorized MoMo provider')}
      {field('Payment receipt email',paymentEmail,setPaymentEmail,{keyboardType:'email-address',autoCapitalize:'none'})}
      {field('Amount GH₵ (e.g. 10.00)',payAmount,setPayAmount,{keyboardType:'decimal-pad'})}
      {smallButton('Pay ELESEND commission',()=>execute(async()=>{const result=await call('POST','/api/v1/rider/finance/settle',{kind:'commission_repayment',amountMinor:parseGhs(payAmount),idempotencyKey:Crypto.randomUUID(),...(paymentEmail?{email:paymentEmail.trim()}: {})});if(result.paymentInstructions?.checkoutUrl)await Linking.openURL(result.paymentInstructions.checkoutUrl);setError(`Payment initiated: ${result.status}. Do not consider paid until verified by the provider.`);}),busy)}
      {heading('Recent immutable ledger entries')}
      {finance.lines.slice(0,30).map((row,i)=><Text key={`${row.id}-${i}`} style={styles.note}>{row.kind} • {row.ledger_code} {row.side} • {ghc(row.amount_minor)}</Text>)}
    </>}
   </Card>}
  {tab==='Account'&&<Card>{heading('Account and settings')}{label(`Role: ${auth.kind}`)}{auth.kind==='rider'&&<>{note(`Vehicle: ${vehicle?.vehicle||'loading'} • approval: ${vehicle?.verification_status||vehicle?.rider_status||'pending'}`)}
    {smallButton('Change or register a car',()=>setTab('Vehicle'))}
    {field('Company invitation token (optional)',inviteId,setInviteId)}
    {smallButton('Accept company invitation',()=>execute(async()=>{await call('POST','/api/v1/rider/invitations/accept',{token:inviteId});setInviteId('');setError('Company invitation accepted. Dispatch continues under verified company approval.');}))}</>}{smallButton('Log out and stop shift',()=>execute(logout))}</Card>}
  {tab==='Vehicle'&&<Card>{heading('Register car for deliveries')}{note('Changing vehicle will turn you offline and require fresh rider and vehicle verification.')}{field('Registration plate',credentials.plateNumber,v=>edit('plateNumber',v))}{field('Make',credentials.make,v=>edit('make',v))}{field('Model',credentials.model,v=>edit('model',v))}{field('Color',credentials.color,v=>edit('color',v))}{field('Cargo capacity (grams)',credentials.maxWeightG,v=>edit('maxWeightG',v),{keyboardType:'numeric'})}
   {smallButton('Submit car for review',()=>execute(async()=>{await call('POST','/api/v1/rider/vehicle',{vehicle:'car',maxWeightG:Number(credentials.maxWeightG),car:{plateNumber:credentials.plateNumber,make:credentials.make,model:credentials.model,color:credentials.color}});setOnline(false);await stopShiftTracking();setTab('Account');setError('Car submitted for review. Remain offline until approved.');}))}</Card>}
  {tab==='Home'&&auth.kind==='rider'&&<><Card>{heading('Rider shift')}{label(online?'● Online and looking for deliveries':'○ Offline')}{smallButton(online?'Go offline':'Go online',()=>execute(toggleOnline),busy)}
   {shifts&&!shifts.background&&note(shifts.reason||'Foreground GPS is available, but background GPS is not running.')}
   {note('Stop safely to accept jobs or verify handovers. The app does not verify GPS integrity on its own.')}
   {smallButton(manifest?.optedIn?'Multi-parcel enabled for my account':'Opt in to multi-parcel',()=>execute(async()=>{const opt=!manifest?.optedIn;await call('POST','/api/v1/rider/multi-stop',{enabled:opt});setManifest(m=>({...m,optedIn:opt}));}))}</Card>
   <Card>{heading(`New offers (${offers.length})`)}{offers.length===0&&note('No pending offers. Refreshes approximately every 10 seconds while app is open.')}
   {offers.map(o=><View key={o.offerId} style={styles.item}>{label(`${o.pickup?.address||'Pickup'} → ${o.destination?.address||'Dropoff'}`)}{label(`Road pickup ETA: ${Math.ceil(o.pickupEtaSeconds/60)} min • ${Math.ceil(o.pickupRoadMeters/100)/10} km`)}{label(`Charge ${ghc(o.amount_minor)} • Fee ${ghc(o.commission_minor)} • Your earnings ${ghc(o.entitlement_minor)}`)}{note(`${o.payment_method==='CASH'?'CUSTOMER CASH • '+(o.cash_payer||'recipient')+' pays':`${o.payment_method} • PROVIDER VERIFIED`} • ${o.existingParcels} other active parcels • expires ${new Date(o.expiresAt).toLocaleTimeString()}`)}{smallButton('Accept delivery',()=>execute(()=>acceptOffer(o)),busy||!isStationary(speed)||!!offlineCopy)}{smallButton('Decline',()=>execute(async()=>{await call('POST','/api/v1/rider/offers/decline',{shipmentId:o.id,offerId:o.offerId});setOffers(v=>v.filter(x=>x.offerId!==o.offerId));}))}</View>)}</Card></>}
  {tab==='Jobs'&&checkoutSession&&<Card>{heading('Secure payment checkout')}
    {label(`Order ${checkoutSession.shipmentId.slice(0,8)} • ${checkoutSession.method} • ${checkoutSession.status}`)}
    {checkoutSession.method==='QR'&&checkoutSession.checkoutUrl&&<>{note('Another device can scan this QR code to open authorized hosted checkout. This is NOT an interoperable national GhQR code.')}<View style={{alignItems:'center',padding:16,backgroundColor:'#fff',borderRadius:12,alignSelf:'center'}}><QRCode value={checkoutSession.checkoutUrl} size={210}/></View></>}
    {checkoutSession.checkoutUrl&&smallButton('Open secure payment checkout',()=>execute(()=>Linking.openURL(checkoutSession.checkoutUrl)))}
    {smallButton('Refresh verified payment status',()=>execute(async()=>{const x=await call('GET',`/api/v1/shipments/${checkoutSession.shipmentId}/checkout`);setCheckoutSession(x);if(x.status==='confirmed')await refreshJobs();setError(`Payment status: ${x.status}. This is not self-reported by the app.`);}))}
   </Card>}
  {tab==='Jobs'&&<Card>{heading('My deliveries')}{offlineCopy&&note(`OFFLINE READ ONLY • cached ${offlineCopy.cachedAt}. Actual assignment may have changed; reconnect before any handover.`)}{smallButton('Refresh deliveries',()=>execute(refreshJobs),busy)}
   {auth.kind==='rider'&&manifest?.stops?.length>0&&<>{heading('Optimized route sequence')}{manifest.stops.map((s,i)=><Text key={`${i}-${s.shipmentId}-${s.kind}`} style={styles.text}>{i+1}. {s.kind.toUpperCase()} • {s.shipmentId.slice(0,8)}</Text>)}</>}
   {myShipments.map(s=><View key={s.id} style={styles.item}>{label(`${s.id.slice(0,8)} · ${s.state}`)}{label(`Fee ${ghc(s.commission_minor)} | Rider net ${ghc(s.amount_minor-s.commission_minor)}`)}{label(s.payment_method==='CASH'?`CASH • ${s.cash_payer} pays ${ghc(s.amount_minor)}`:`${s.payment_method} • provider payment`)}
    {auth.kind==='rider'&&<>{s.state==='RIDER_ASSIGNED'&&smallButton('Verify pickup OTP',()=>execute(()=>verifyStop(s,'pickup')),busy||!isStationary(speed)||!!offlineCopy)}
     {s.state==='PICKUP_VERIFIED'&&smallButton('Start transport',()=>execute(async()=>{await call('POST',`/api/v1/shipments/${s.id}/transition`,{action:'start'});await refreshJobs();}),busy||!isStationary(speed)||!!offlineCopy)}
     {s.payment_method==='CASH'&&(s.cash_payer==='sender'?s.state==='RIDER_ASSIGNED':['IN_TRANSIT','AWAITING_DELIVERY_OTP'].includes(s.state))&&<>
      {note('At handover: report actual delivery cash received. Cash remains in the rider’s physical possession. Never report merchandise COD here.')}
      {field(`Cash collected GH₵ for ${s.id.slice(0,8)}`,cashAmount,v=>setCashAmount(v),{keyboardType:'decimal-pad'})}
      {smallButton('Record cash reported (cannot edit)',()=>execute(async()=>{const result=await call('POST','/api/v1/rider/cash-report',{shipmentId:s.id,reportedMinor:parseGhs(cashAmount),cashPayer:s.cash_payer,idempotencyKey:Crypto.randomUUID()});setReportedCash(v=>({...v,[s.id]:result}));setCashAmount('');}),busy||!isStationary(speed)||!!reportedCash[s.id])}
      {reportedCash[s.id]&&note(`Rider reported: ${ghc(reportedCash[s.id].reportedMinor)} (${reportedCash[s.id].status}). OTP still required.`)}
     </>}
     {s.state==='IN_TRANSIT'&&smallButton('Send recipient OTP at handover',()=>execute(()=>verifyStop(s,'delivery')),busy||!isStationary(speed)||!!offlineCopy)}
     {s.state==='RIDER_ASSIGNED'&&smallButton('Release before pickup',()=>execute(async()=>{await call('POST','/api/v1/rider/assignments/release',{shipmentId:s.id,reason});await refreshJobs();}))}
    </>}
    {auth.kind!=='rider'&&note(s.payment_method==='CASH'?'Cash due to the designated payer at handover; not prepaid, not guaranteed assigned.':s.paid?'Provider-verified digital payment':`${s.payment_method} payment pending provider verification`)}
    {['customer','business'].includes(auth.kind)&&s.payment_method!=='CASH'&&!s.paid&&s.state==='AWAITING_PAYMENT'&&smallButton('Open payment / check status',()=>execute(async()=>{const x=await startCheckout(s);if(x.status==='confirmed')await refreshJobs();setError(`Provider payment status: ${x.status}. No delivery will be dispatched until verified.`);}),busy)}
   </View>)}
   {challenge&&<View style={styles.item}>{heading(`Verify ${activeParcel.kind} for ${activeParcel.id.slice(0,8)}`)}{note('Never share the OTP over messages. Customer/recipient reads it to assigned driver in person.')}{field('Six-digit OTP',otp,setOtp,{keyboardType:'numeric',maxLength:6})}{smallButton('Confirm secure handover',()=>execute(async()=>{await completeOtp();await refreshJobs();}),busy||otp.length!==6||!isStationary(speed)||!!offlineCopy)}</View>}
  </Card>}
  {tab==='Home'&&['customer','business'].includes(auth.kind)&&<Card>{heading(['Pickup & destination','Parcel & recipient','Check availability & price'][step])}
   {step===0&&<>{note('Tap the map first for pickup, then tap again for the delivery destination. This is a native map—not a website.')}
    {ghanaAddressLookup&&<>{field('GhanaPostGPS address (e.g. AK-484-9321)',ghanaAddress,value=>{addressLookupEpoch.current++;setGhanaAddress(value);},{autoCapitalize:'characters'})}{smallButton(booking.pickup?'Find address and set destination':'Find address and set pickup',()=>execute(findGhanaPostGpsAddress),busy||!ghanaAddress.trim())}{note('The returned address center is approximate. Review the pin and move it to the exact entrance before booking.')}</>}
    <MapView ref={mapRef} provider={MAP_RENDERER} style={{height:290,borderRadius:15}} initialRegion={{latitude:5.6037,longitude:-0.187,latitudeDelta:.14,longitudeDelta:.14}} onPress={selectOnMap}>
     {booking.pickup&&<Marker coordinate={booking.pickup} title="Pickup" pinColor="green"/>}{booking.destination&&<Marker coordinate={booking.destination} title="Drop-off"/>}
    </MapView>{note(`Pickup: ${booking.pickup?.address||'Tap map'}`)}{note(`Destination: ${booking.destination?.address||'Tap map'}`)}
    {smallButton('Reset map locations',()=>{update('pickup',null);update('destination',null);})}{smallButton('Next: parcel details',()=>setStep(1),!booking.pickup||!booking.destination)}</>}
   {step===1&&<>{heading('Choose your vehicle')}<View style={styles.row}>{[['motorcycle','Motorbike'],['car','Car'],['van','Van']].map(([value,title])=><Pressable key={value} accessibilityRole="radio" accessibilityState={{checked:booking.vehicle===value}} onPress={()=>update('vehicle',value)} style={[styles.choice,booking.vehicle===value&&styles.selected]}><Text style={styles.text}>{title}</Text></Pressable>)}</View>{note('Rates and suitable road routing must be configured for your selected vehicle. Rider acceptance is not guaranteed.')}{field('Recipient Ghana phone',booking.recipientPhone,v=>update('recipientPhone',v),{keyboardType:'phone-pad'})}{field('Weight in grams',booking.weightG,v=>update('weightG',v),{keyboardType:'numeric'})}{field('Parcel description',booking.description,v=>update('description',v))}
    <View style={styles.row}>{['small','medium','large'].map(size=><Pressable key={size} onPress={()=>update('parcelSize',size)} style={[styles.choice,booking.parcelSize===size&&styles.selected]}><Text style={styles.text}>{size}</Text></Pressable>)}</View>
    {smallButton('Next: estimate cost',()=>setStep(2),!booking.recipientPhone||!Number(booking.weightG))}{smallButton('Back',()=>setStep(0))}</>}
   {step===2&&<>{heading('How will you pay the delivery charge?')}
    <View style={styles.row}>{paymentMethods.filter(x=>x.enabled).map(x=>x.method).map(k=><Pressable key={k} onPress={()=>update('paymentMethod',k)} style={[styles.choice,booking.paymentMethod===k&&styles.selected]}><Text style={styles.text}>{k}</Text></Pressable>)}</View>
    {booking.paymentMethod!=='CASH'&&<>{note('Checkout is completed using an authorized payment provider. ELESEND never receives card details. QR scans to a secure PSP checkout link (not national GhQR).')}
     {field('Payment receipt email (required by some providers)',paymentEmail,setPaymentEmail,{keyboardType:'email-address',autoCapitalize:'none'})}</>}
    {booking.paymentMethod==='CASH'&&<>{note('Cash is paid directly to the rider. ELESEND commission is accounted for separately.')}
     <View style={styles.row}>{['recipient','sender'].map(k=><Pressable key={k} onPress={()=>update('cashPayer',k)} style={[styles.choice,booking.cashPayer===k&&styles.selected]}><Text style={styles.text}>{k} pays</Text></Pressable>)}</View></>}
    {smallButton('Calculate road quote and nearby capacity',()=>execute(price))}{quoted&&<>{label(`All-in charge ${ghc(quoted.amount_minor)}`)}{note(`Availability: ${quoted.availability?.status||'unknown'} (not guaranteed)`)}{note(`Road distance: ${(quoted.distanceMeters/1000).toFixed(1)} km. GPS and traffic conditions may vary.`)}
     {note(booking.paymentMethod==='CASH'?'Pay physical cash at handover • No advance card required':'Payment is confirmed only after authoritative provider verification; scanning QR or opening checkout is not payment.')}{smallButton('Confirm delivery booking',()=>execute(book),busy||quoted.availability?.status==='none_identified')}</>}{note('Cash orders can be matched before collecting the delivery fee. Digital orders require a verified payment provider. A potential rider is not an accepted rider.')}{smallButton('Back',()=>setStep(1))}</>}
  </Card>}
  {tab==='Home'&&auth.kind==='company'&&<Card>{heading('Logistics company fleet')}{note('Company riders receive jobs in this same native app under their own verified accounts.')}
    {smallButton('Refresh verified fleet',()=>execute(async()=>setFleet(await call('GET','/api/v1/company/riders'))))}
    {fleet?.map(row=><View key={row.id} style={styles.item}>{label(`${row.vehicle} • ${row.id.slice(0,8)} • ${row.status}`)}{note(row.online?'Online':'Offline')}{smallButton('Remove rider from company',()=>Alert.alert('Remove rider?','Only riders without unfinished custody can be removed.',[{text:'Cancel'}, {text:'Remove',style:'destructive',onPress:()=>execute(async()=>{await call('POST',`/api/v1/company/riders/${row.id}/remove`,{});setFleet(await call('GET','/api/v1/company/riders'));})}]))}</View>)}
    {field('Approved independent rider UUID',inviteId,setInviteId)}{smallButton('Invite approved rider',()=>execute(async()=>{const r=await call('POST','/api/v1/company/invitations',{riderId:inviteId});setInviteToken(r.token);}))}
    {inviteToken&&note(`Single-display secure invitation token: ${inviteToken}. Share directly with intended rider through a trusted channel.`)}
   </Card>}
  {tab==='Home'&&auth.kind==='admin'&&<Card>{heading('Verified operations')}
    {heading('Payment acceptance activation')}{note('CASH stays active. Enable MoMo, card or QR only after configuring authorized PSP credentials, webhooks and reconciliation. Disabled channels cannot accept bookings.')}
    {smallButton('Refresh payment method controls',()=>execute(async()=>setAdminPaymentMethods(await call('GET','/api/v1/admin/payments/methods'))))}
    {smallButton('Review verified payments requiring refunds',()=>execute(async()=>{const issues=await call('GET','/api/v1/admin/payments/exceptions');Alert.alert('Pending payment review',`${issues.length} provider-verified exceptions detected. No refund can be marked paid without independent PSP confirmation.`);} ))}
    {adminPaymentMethods.filter(m=>m.method!=='CASH').map(m=><View key={m.method} style={styles.item}>{label(`${m.method}: ${m.enabled?'ON':'OFF'} • adapter ${m.configured?'READY FOR CONFIG':'NOT CONFIGURED'}`)}
      {smallButton(m.adminEnabled?'Disable method':'Enable method',()=>Alert.alert('Change payment channel?',`Set ${m.method} ${m.adminEnabled?'OFF':'ON'}? This cannot bypass independent PSP settlement verification.`,[{text:'Cancel'},{text:'Confirm',onPress:()=>execute(async()=>{await call('POST','/api/v1/admin/payments/methods',{method:m.method,enabled:!m.adminEnabled});setAdminPaymentMethods(await call('GET','/api/v1/admin/payments/methods'));setPaymentMethods(await call('GET','/api/v1/payments/methods'));})}]))}</View>)}
    {smallButton('Inspect rider commission receivables',()=>execute(async()=>setAdminFinances(await call('GET','/api/v1/admin/finance/aging'))))}
    {heading('Finance policy (admin permission required)')}
    {field('Verified rider UUID',adminRider,setAdminRider)}
    {field('Outstanding commission limit GH₵',adminLimit,setAdminLimit,{keyboardType:'decimal-pad'})}
    {field('Maximum unpaid jobs',adminMaxJobs,setAdminMaxJobs,{keyboardType:'numeric'})}
    {field('Due days',adminDueDays,setAdminDueDays,{keyboardType:'numeric'})}
    {smallButton('Apply rider postpaid policy',()=>Alert.alert('Change rider commission policy?','This is a sensitive operational action and is audited.',[{text:'Cancel'},{text:'Apply',onPress:()=>execute(async()=>{await call('POST',`/api/v1/admin/finance/riders/${adminRider}/policy`,{postpaidEnabled:true,maxOutstandingMinor:parseGhs(adminLimit),maxUnpaidJobs:Number(adminMaxJobs),dueDays:Number(adminDueDays),blocked:false});setError('Policy saved with audit record.');})}]))}
    {heading('Two-person audited financial adjustment')}
    {field('Adjustment amount GH₵',correctionAmount,setCorrectionAmount,{keyboardType:'decimal-pad'})}
    {field('Evidence and reason (12+ characters)',correctionReason,setCorrectionReason)}
    {smallButton('Request waiver (another administrator must approve)',()=>execute(async()=>{const r=await call('POST','/api/v1/admin/finance/adjustments',{riderId:adminRider,direction:'waive',amountMinor:parseGhs(correctionAmount),reason:correctionReason});setError(`Adjustment ${r.id} requested; not posted until independently approved.`);}))}
    {smallButton('Review adjustment queue',()=>execute(async()=>setAdjustments(await call('GET','/api/v1/admin/finance/adjustments'))))}
    {adjustments.filter(a=>a.status==='pending').map(a=><View key={a.id} style={styles.item}>{note(`${a.id.slice(0,8)} • ${a.direction} ${ghc(a.amount_minor)} • ${a.reason}`)}{smallButton('Approve after independent evidence review',()=>Alert.alert('Independent approval required','You must not be the requesting administrator. Review attached evidence outside this interface.',[{text:'Cancel'},{text:'Approve',onPress:()=>execute(async()=>{await call('POST',`/api/v1/admin/finance/adjustments/${a.id}/approve`,{});setAdjustments(await call('GET','/api/v1/admin/finance/adjustments'));})}]))}</View>)}
    {adminFinances?.slice(0,20).map(r=><Text key={r.rider_id} style={styles.note}>{r.rider_id.slice(0,8)} • outstanding {ghc(r.outstanding_minor)} • limit {ghc(r.max_outstanding_minor)} • {r.blocked?'BLOCKED':'active'}</Text>)}{note('Identity and vehicle approvals require human evidence checks. Never approve a plate solely from typed data.')}
    {smallButton('Load verification queue and multi-parcel policy',()=>execute(loadReview))}
    {heading('Fraud and cash/OTP risk review')}
    {smallButton('Load risk events',()=>execute(async()=>setRiskSignals(await call('GET','/api/v1/admin/risk-signals'))))}
    {riskSignals.length>0&&field('Review note (12+ characters)',riskReason,setRiskReason)}
    {riskSignals.map(x=><View key={x.id} style={styles.item}>{label(`${x.signal_code} • ${x.severity} • parcel ${x.shipment_id?.slice(0,8)||'n/a'}`)}
     {smallButton('Mark reviewed after investigation',()=>Alert.alert('Complete manual risk review?',`Review event ${x.id}; do not punish drivers based only on risk signals.`,[{text:'Cancel'},{text:'Confirm',onPress:()=>execute(async()=>{await call('POST','/api/v1/admin/risk-signals/review',{signalId:x.id,decision:'reviewed',reason:riskReason});setRiskSignals(await call('GET','/api/v1/admin/risk-signals'));})}]))}</View>)}
    {heading('Country rollout • controlled activation')}
    {note('Ghana is the only implemented financial and identity market. Countries can be staged for later verification; switching on unverified foreign markets is correctly blocked.')}
    {field('Country ISO code (e.g. NG)',newCountry,setNewCountry,{autoCapitalize:'characters'})}
    {field('Currency ISO code (e.g. NGN)',newCurrency,setNewCurrency,{autoCapitalize:'characters'})}
    {smallButton('Stage country',()=>execute(async()=>{await call('POST','/api/v1/admin/markets/stage',{countryCode:newCountry.trim().toUpperCase(),isoCurrency:newCurrency.trim().toUpperCase()});setMarkets(await call('GET','/api/v1/admin/markets'));}))}
    {markets.map(m=><View key={m.country_code} style={styles.item}>{label(`${m.country_code} • ${m.iso_currency} • ${m.service_enabled?'SERVICE ACTIVE':'NOT ACTIVE'}`)}
     {smallButton(m.service_enabled?'Pause bookings':'Request activation',()=>Alert.alert('Market readiness check',m.country_code==='GH'?'Pause or restore Ghana new bookings?':'Other markets require validated currency, local providers, regulations, phone and address support; activation will be blocked until implemented.',[{text:'Cancel'},{text:'Proceed',onPress:()=>execute(async()=>{await call('POST','/api/v1/admin/markets/activate',{countryCode:m.country_code,enabled:!m.service_enabled});setMarkets(await call('GET','/api/v1/admin/markets'));})}]))}</View>)}
    {heading('Bounded batch fleet recommendation (advisory only)')}
    {smallButton('Preview four next jobs without assigning',()=>execute(async()=>{const result=await call('GET','/api/v1/admin/fleet-batch-preview');Alert.alert('Fleet preview',`${result.ordersConsidered} jobs and ${result.driversConsidered} candidate riders. ${result.suggestions.length} possible matches. No rider has been assigned.`);}))}
    {heading('Dispatch algorithms • authorized activation')}
    {note('Experimental features remain off until validated. Core security, commission and road safety checks cannot be bypassed.')}
    {smallButton('Refresh algorithm switches',()=>execute(async()=>setAlgorithmFeatures(await call('GET','/api/v1/admin/algorithm-features'))))}
    {algorithmFeatures.map(f=><View key={f.feature_key} style={styles.item}>{label(`${f.feature_key.replaceAll('_',' ')} • ${f.enabled?'ENABLED':'DISABLED'}`)}
     {smallButton(f.enabled?'Turn off feature':'Activate feature',()=>Alert.alert('Change dispatch behavior?',`Switch ${f.feature_key} ${f.enabled?'OFF':'ON'}? Verify tests and operational requirements before rollout.`,[{text:'Cancel'},{text:'Confirm',onPress:()=>execute(async()=>{await call('POST','/api/v1/admin/algorithm-features',{featureKey:f.feature_key,enabled:!f.enabled});setAlgorithmFeatures(await call('GET','/api/v1/admin/algorithm-features'));setMarkets(await call('GET','/api/v1/admin/markets'));})}]))}</View>)}
    {dispatchPolicy&&<>{label(`Multi-parcel availability: ${dispatchPolicy.multi_stop_enabled?'ENABLED':'DISABLED'} • max ${dispatchPolicy.max_active_parcels} parcels`) }
     {field('Maximum concurrent parcels (1–10)',maxParcelsInput,setMaxParcelsInput,{keyboardType:'number-pad'})}
     {smallButton('Disable new multi-parcel assignments',()=>execute(()=>toggleMultiStop(false)),busy||!dispatchPolicy.multi_stop_enabled)}
     {smallButton('Enable validated multi-parcel pilot',()=>Alert.alert('Activate route pooling?','Only activate after PostgreSQL concurrency, routing and custody tests on staging. The system enables required route-insertion algorithms at the same time.',[{text:'Cancel'}, {text:'Enable pilot',onPress:()=>execute(()=>toggleMultiStop(true))}]),busy||dispatchPolicy.multi_stop_enabled)}</>}
    {review?.riders.filter(v=>v.status==='pending').map(v=><View key={v.id} style={styles.item}>{label(`Rider ${v.id.slice(0,8)} • ${v.vehicle} • ${v.max_weight_g}g`) }
     {smallButton('Approve rider after verification',()=>Alert.alert('Confirm rider documents?','A manually completed identity and vehicle safety review is mandatory.',[{text:'Cancel'}, {text:'Approve',onPress:()=>execute(async()=>{await call('POST',`/api/v1/admin/riders/${v.id}`,{status:'approved'});await loadReview();})}]))}</View>)}
    {review?.vehicles.filter(v=>v.verification_status==='pending').map(v=><View key={v.rider_id} style={styles.item}>{label(`${v.vehicle.toUpperCase()} • ${v.registration_plate||'Plate not required'}`)}{label(`${v.make||''} ${v.model||''} ${v.color||''}`)}
     {smallButton('Approve vehicle after physical inspection',()=>Alert.alert('Manual verification needed','Did a trusted reviewer verify vehicle registration, identity and suitability independently?',[{text:'Cancel'}, {text:'Approved',onPress:()=>execute(async()=>{await call('POST',`/api/v1/admin/vehicles/${v.rider_id}/review`,{status:'approved'});await loadReview();})}]))}
     {smallButton('Reject vehicle',()=>execute(async()=>{await call('POST',`/api/v1/admin/vehicles/${v.rider_id}/review`,{status:'rejected'});await loadReview();}))}</View>)}
   </Card>}
  </>}
  <Text style={styles.footer}>ELESEND • parcel-by-parcel verification • ride safely</Text>
 </ScrollView></View>;
}
const styles=StyleSheet.create({screen:{flex:1,backgroundColor:colors.bg},content:{padding:20,paddingTop:56,paddingBottom:60},brand:{color:colors.accent,fontWeight:'900',fontSize:32,letterSpacing:2},heading:{color:colors.light,fontSize:21,fontWeight:'800',marginVertical:10},text:{color:colors.light,fontSize:15,lineHeight:22},note:{color:colors.muted,fontSize:13,marginVertical:7,lineHeight:19},card:{backgroundColor:colors.panel,padding:16,borderRadius:20,marginTop:14,borderColor:colors.line,borderWidth:1},field:{color:colors.light,borderColor:colors.line,borderWidth:1,borderRadius:12,padding:13,marginVertical:6,fontSize:15},btn:{backgroundColor:colors.accent,borderRadius:12,padding:13,marginVertical:7,alignItems:'center'},btnText:{color:'#071b28',fontWeight:'800',fontSize:15},warning:{backgroundColor:'#69402b',padding:12,borderRadius:12,marginVertical:10},warnText:{color:'#ffedda'},choice:{paddingHorizontal:10,paddingVertical:8,borderRadius:10,borderWidth:1,borderColor:colors.line,margin:3},selected:{borderColor:colors.accent,backgroundColor:'#214a55'},row:{flexDirection:'row',flexWrap:'wrap',marginVertical:8},item:{borderColor:colors.line,borderTopWidth:1,paddingTop:12,marginTop:10},footer:{color:colors.muted,marginTop:35,textAlign:'center'}});
