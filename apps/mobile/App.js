import React,{useEffect,useState,useRef} from 'react';
import {View,Text,TextInput,Pressable,ScrollView,StyleSheet,Alert,ActivityIndicator,AppState,Platform,Linking,StatusBar,TouchableOpacity} from 'react-native';
import MapView,{Marker,RiderMarker,Polyline,MAP_RENDERER,openTurnByTurnNavigation} from './src/maps/map-adapter';
import QRCode from 'react-native-qrcode-svg';
import * as Location from 'expo-location';
import * as Crypto from 'expo-crypto';
import {call,loadToken,saveToken,clearToken,ghc,BASE} from './src/api';
import {sample,startShiftTracking,stopShiftTracking} from './src/tracking';
import {cacheJobs,readCachedJobs,clearCachedJobs} from './src/offline';

// Official ELESEND Brand Identity Tokens
const colors={
 bg:'#101827',         // Midnight Navy
 surface:'#1A2438',    // Surface Navy
 card:'#1F2C44',       // Content Card
 cardBorder:'#2C3E5E', // Card Border
 primary:'#18C6A5',    // Electric Teal
 primaryDark:'#087F69',// Deep Teal
 accent:'#18C6A5',     // Teal Accent
 warn:'#FFB547',       // Warm Amber
 text:'#FFFFFF',       // Pure White
 textMuted:'#526174',  // Slate
 light:'#F5F7FB',      // Cloud White
 line:'#283750',
 danger:'#D92D40',     // Danger Red
 info:'#38BDF8'
};

const parseGhs=v=>{const m=/^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(v.trim());if(!m)throw Error('Enter Ghana cedis as 30 or 30.00');return Number(m[1])*100+Number((m[2]||'').padEnd(2,'0'));};
const safe=async(fn,setError)=>{try{setError('');return await fn();}catch(e){setError(e.message);return null;}};
const initialCreds={phone:'',password:'',totpCode:'',kind:'customer',name:'',vehicle:'motorcycle',maxWeightG:'20000',plateNumber:'',make:'',model:'',color:''};
const isStationary=speed=>speed===null||speed<2.5;

export default function App(){
 const [auth,setAuth]=useState(null),[credentials,setCredentials]=useState(initialCreds),[isSignup,setIsSignup]=useState(false),[requiresTotp,setRequiresTotp]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[tab,setTab]=useState('Send');
 const [offers,setOffers]=useState([]),[manifest,setManifest]=useState(null),[shifts,setShifts]=useState(null),[vehicle,setVehicle]=useState(null),[online,setOnline]=useState(false),[speed,setSpeed]=useState(null),[trackingSeconds,setTrackingSeconds]=useState(15);
 const [quoted,setQuoted]=useState(null),[step,setStep]=useState(0),[myShipments,setMyShipments]=useState([]),[booking,setBooking]=useState({pickup:null,destination:null,vehicle:'motorcycle',recipientPhone:'',weightG:'1500',description:'Package',parcelCategory:'general',parcelSize:'small',paymentMethod:'CASH',cashPayer:'recipient'});
 const [review,setReview]=useState(null),[fleet,setFleet]=useState([]),[inviteId,setInviteId]=useState(''),[inviteToken,setInviteToken]=useState(null),[joinToken,setJoinToken]=useState(''),[dispatchPolicy,setDispatchPolicy]=useState(null);
 const [apiKeys,setApiKeys]=useState([]),[newKeyName,setNewKeyName]=useState('Store Checkout'),[newKeyCreated,setNewKeyCreated]=useState(null);
 const [offlineCopy,setOfflineCopy]=useState(null),[algorithmFeatures,setAlgorithmFeatures]=useState([]),[maxParcelsInput,setMaxParcelsInput]=useState('2'),[markets,setMarkets]=useState([]),[newCountry,setNewCountry]=useState(''),[newCurrency,setNewCurrency]=useState(''),[riskSignals,setRiskSignals]=useState([]),[riskReason,setRiskReason]=useState('');
 const [finance,setFinance]=useState(null),[payAmount,setPayAmount]=useState(''),[cashAmount,setCashAmount]=useState(''),[reportedCash,setReportedCash]=useState({}),[adminFinances,setAdminFinances]=useState(null),[adjustments,setAdjustments]=useState([]),[adminRider,setAdminRider]=useState(''),[adminLimit,setAdminLimit]=useState('40.00'),[adminDueDays,setAdminDueDays]=useState('7'),[adminMaxJobs,setAdminMaxJobs]=useState('20'),[correctionAmount,setCorrectionAmount]=useState(''),[correctionReason,setCorrectionReason]=useState('');
 const [phoneChallenge,setPhoneChallenge]=useState(null),[phoneCode,setPhoneCode]=useState(''),[phoneStatus,setPhoneStatus]=useState(null);
 const [ghanaAddress,setGhanaAddress]=useState(''),[ghanaAddressLookup,setGhanaAddressLookup]=useState(false);const addressLookupEpoch=useRef(0),mapRef=useRef(null);
 const [placeQuery,setPlaceQuery]=useState(''),[placesList,setPlacesList]=useState([]);
 const [paymentMethods,setPaymentMethods]=useState([{method:'CASH',enabled:true}]),[paymentEmail,setPaymentEmail]=useState(''),[checkoutSession,setCheckoutSession]=useState(null),[adminPaymentMethods,setAdminPaymentMethods]=useState([]);
 const [adminPricing,setAdminPricing]=useState([]),[commVehicle,setCommVehicle]=useState('all'),[commPercent,setCommPercent]=useState('3.0'),[commMode,setCommMode]=useState('percentage'),[commCapGhs,setCommCapGhs]=useState('');
 const [activeParcel,setActiveParcel]=useState(null),[challenge,setChallenge]=useState(null),[otp,setOtp]=useState(''),[disputeModal,setDisputeModal]=useState(null),[disputeCategory,setDisputeCategory]=useState('damage'),[disputeDetail,setDisputeDetail]=useState('');
 // Food Marketplace & Restaurant State
 const [foodRestaurants,setFoodRestaurants]=useState([]),[selectedRest,setSelectedRest]=useState(null),[restMenu,setRestMenu]=useState(null);
 const [selectedDish,setSelectedDish]=useState(null),[selectedOptions,setSelectedOptions]=useState([]),[dishModal,setDishModal]=useState(false);
 const [cartItems,setCartItems]=useState([]),[cartModal,setCartModal]=useState(false),[foodDeliveryAddress,setFoodDeliveryAddress]=useState('');
 const [foodRecipientPhone,setFoodRecipientPhone]=useState(''),[foodInstructions,setFoodInstructions]=useState('');
 const [foodQuote,setFoodQuote]=useState(null),[foodPaymentMethod,setFoodPaymentMethod]=useState('CASH');
 const [myFoodOrders,setMyFoodOrders]=useState([]),[activeFoodTracking,setActiveFoodTracking]=useState(null);
 const [kitchenOrders,setKitchenOrders]=useState([]),[businessRestaurant,setBusinessRestaurant]=useState(null);
 const [businessSettlements,setBusinessSettlements]=useState(null),[orderPrepMinutes,setOrderPrepMinutes]=useState('25');
 const [newRestName,setNewRestName]=useState(''),[newRestAddress,setNewRestAddress]=useState(''),[newRestCuisine,setNewRestCuisine]=useState('');
 const [newCatName,setNewCatName]=useState(''),[newItemName,setNewItemName]=useState(''),[newItemPrice,setNewItemPrice]=useState('');
 const watch=useRef(null);

 const edit=(k,v)=>setCredentials(c=>({...c,[k]:v}));
 const update=(k,v)=>{if(k==='pickup'||k==='destination')addressLookupEpoch.current++;setBooking(b=>({...b,[k]:v}));setQuoted(null);};
 const execute=async task=>{if(busy)return;setBusy(true);await safe(task,setError);setBusy(false);};

 useEffect(()=>{(async()=>{const token=await loadToken();if(token){try{const user=await call('GET','/api/v1/me');setAuth(user);setTab(user.kind==='rider'?'Driver':user.kind==='admin'?'Admin':['company','business'].includes(user.kind)?'Business':'Send');}catch{await clearToken();}}setLoading(false);})().catch(()=>setLoading(false));},[]);
 useEffect(()=>{if(!auth)return;call('GET','/api/v1/payments/methods').then(setPaymentMethods).catch(()=>setPaymentMethods([{method:'CASH',enabled:true}]));},[auth]);
 useEffect(()=>{let cancelled=false;addressLookupEpoch.current++;setGhanaAddressLookup(false);setGhanaAddress('');if(auth)call('GET','/api/v1/maps/config').then(v=>{if(!cancelled)setGhanaAddressLookup(v.ghanaPostGpsLookup===true);}).catch(()=>{});return()=>{cancelled=true;};},[auth]);

 useEffect(()=>{if(!auth||auth.kind!=='rider')return;let cancelled=false;
  const get=async()=>{if(cancelled)return;try{const [m,o,v]=await Promise.all([call('GET','/api/v1/rider/manifest').catch(()=>null),call('GET','/api/v1/rider/offers').catch(()=>[]),call('GET','/api/v1/rider/vehicle')]);if(!cancelled){setManifest(m);setOffers(o);setVehicle(v);setOnline(v.online);setOfflineCopy(null);if(m)cacheJobs(auth.id,m).catch(()=>{});}}catch(e){if(!cancelled)setError(e.message);}};
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

 async function loadBusinessData(){
  if(auth?.kind==='company'){const f=await call('GET','/api/v1/company/riders').catch(()=>[]);setFleet(f||[]);}
  if(auth?.kind==='business'){
   const orders=await call('GET','/api/v1/food-orders').catch(()=>[]);
   setKitchenOrders(orders||[]);
   const allRest=await call('GET','/api/v1/restaurants').catch(()=>[]);
   const mine=(allRest||[]).find(r=>r.owner_id===auth.id);
   if(mine){
    setBusinessRestaurant(mine);
    const s=await call('GET',`/api/v1/restaurants/${mine.id}/settlements`).catch(()=>null);
    setBusinessSettlements(s);
   }
  }
 }

 async function loadFoodData(){
  const list=await call('GET','/api/v1/restaurants?lat=5.6037&lon=-0.1870').catch(()=>[]);
  setFoodRestaurants(list||[]);
  const orders=await call('GET','/api/v1/food-orders').catch(()=>[]);
  setMyFoodOrders(orders||[]);
 }
 async function openRestaurantDetail(r){
  setSelectedRest(r);
  const menu=await call('GET',`/api/v1/restaurants/${r.id}/menu`).catch(()=>null);
  setRestMenu(menu);
 }
 function openDishCustomizer(dish){
  setSelectedDish(dish);
  const initialOpts=[];
  if(dish.modifiers){
   for(const m of dish.modifiers){
    if(m.is_required&&m.options&&m.options.length>0)initialOpts.push(m.options[0].id);
   }
  }
  setSelectedOptions(initialOpts);
  setDishModal(true);
 }
 function toggleOption(optId,modifier){
  if(modifier.max_selections===1){
   const otherIds=(modifier.options||[]).map(o=>o.id);
   setSelectedOptions(curr=>[...curr.filter(id=>!otherIds.includes(id)),optId]);
  }else{
   setSelectedOptions(curr=>curr.includes(optId)?curr.filter(id=>id!==optId):[...curr,optId]);
  }
 }
 function addDishToCart(){
  if(!selectedDish||!selectedRest)return;
  const itemWithOptions={
   restaurantId:selectedRest.id,
   restaurantName:selectedRest.name,
   itemId:selectedDish.id,
   name:selectedDish.name,
   priceMinor:selectedDish.price_minor,
   quantity:1,
   options:selectedOptions
  };
  setCartItems(curr=>[...curr,itemWithOptions]);
  setDishModal(false);
  setSelectedDish(null);
 }
 async function calculateFoodQuote(){
  if(cartItems.length===0||!foodDeliveryAddress.trim())throw Error('Enter delivery address');
  const body={
   restaurantId:selectedRest.id,
   items:cartItems.map(i=>({itemId:i.itemId,quantity:i.quantity,options:i.options})),
   deliveryAddress:foodDeliveryAddress.trim(),
   deliveryLatitude:5.6021,
   deliveryLongitude:-0.1834,
   customerPhone:foodRecipientPhone.trim()||auth.phone,
   specialInstructions:foodInstructions.trim()
  };
  const quote=await call('POST','/api/v1/food-orders/quote',body);
  setFoodQuote(quote);
 }
 async function placeFoodOrder(){
  if(!foodQuote)throw Error('Get a delivery quote first');
  const res=await call('POST','/api/v1/food-orders',{
   ...foodQuote,
   paymentMethod:foodPaymentMethod,
   specialInstructions:foodInstructions.trim()
  });
  setCartItems([]);
  setFoodQuote(null);
  setCartModal(false);
  setActiveFoodTracking(res);
  setTab('Activity');
  await refreshJobs();
  await loadFoodData();
 }
 async function acceptKitchenOrder(orderId){
  const min=Number(orderPrepMinutes)||25;
  await call('POST',`/api/v1/food-orders/${orderId}/accept`,{estimatedPrepMinutes:min});
  await loadBusinessData();
 }
 async function markKitchenPreparing(orderId){
  await call('POST',`/api/v1/food-orders/${orderId}/prepare`,{});
  await loadBusinessData();
 }
 async function markKitchenReady(orderId){
  await call('POST',`/api/v1/food-orders/${orderId}/ready`,{});
  await loadBusinessData();
 }

 async function signIn(){
  try{
   const data=await call('POST','/api/v1/auth/login',{phone:credentials.phone,password:credentials.password,...(credentials.totpCode?{totpCode:credentials.totpCode}:{})});
   await saveToken(data.token);setAuth(data.user);setCredentials(c=>({...c,password:'',totpCode:''}));setRequiresTotp(false);setTab(data.user.kind==='rider'?'Driver':data.user.kind==='admin'?'Admin':['company','business'].includes(data.user.kind)?'Business':'Send');
  }catch(e){
   if(e.message&&e.message.includes('Administrator authenticator code required')){
    setRequiresTotp(true);
    setError('Privileged account detected: Enter 6-digit Authenticator code.');
   }else{
    throw e;
   }
  }
 }
 async function signUp(){const body={phone:credentials.phone,password:credentials.password,kind:credentials.kind};
  if(['company','business'].includes(credentials.kind))body.name=credentials.name||'Elesend Partner';
  if(credentials.kind==='rider'){body.vehicle=credentials.vehicle;body.maxWeightG=Number(credentials.maxWeightG);if(credentials.vehicle==='car')body.car={plateNumber:credentials.plateNumber,make:credentials.make,model:credentials.model,color:credentials.color};}
  await call('POST','/api/v1/auth/register',body);setIsSignup(false);setError('Account registered successfully! Please sign in.');}
 async function logout(){if(auth?.kind==='rider'){try{await call('POST','/api/v1/rider/availability',{online:false});}catch{}try{await stopShiftTracking();}catch{}}
  try{await call('POST','/api/v1/auth/logout');}catch{}finally{await clearCachedJobs();await clearToken();setAuth(null);setOnline(false);setManifest(null);setOffers([]);setTab('Send');}}

 async function toggleOnline(){if(online){await call('POST','/api/v1/rider/availability',{online:false});await stopShiftTracking();setOnline(false);return;}
  const allowed=await Location.requestForegroundPermissionsAsync();if(allowed.status!=='granted')throw Error('GPS access required before going online');
  const settings=await call('GET','/api/v1/rider/dispatch-settings');setTrackingSeconds(settings.movingUploadSeconds);
  await call('POST','/api/v1/rider/availability',{online:true});
  try{const loc=await Location.getCurrentPositionAsync({accuracy:Location.Accuracy.Balanced});await call('POST','/api/v1/rider/location',sample(loc));
   setOnline(true);try{setShifts(await startShiftTracking(settings));}catch(e){setShifts({background:false,reason:e.message});}
  }catch(e){await call('POST','/api/v1/rider/availability',{online:false}).catch(()=>{});throw e;}
 }

 async function refreshJobs(){try{const jobs=await call('GET','/api/v1/shipments');setMyShipments(jobs);if(auth.kind==='rider'&&manifest)await cacheJobs(auth.id,{shipments:jobs,stops:manifest.stops});setOfflineCopy(null);}
  catch(e){const cached=auth.kind==='rider'?await readCachedJobs(auth.id):null;if(!cached)throw e;setMyShipments(cached.shipments);setOfflineCopy(cached);setError('Offline: displaying previously synchronized jobs.');}}

 async function acceptOffer(o){if(!isStationary(speed))throw Error('Stop safely before accepting');await call('POST',`/api/v1/shipments/${o.id}/accept`,{offerId:o.offerId});setOffers(v=>v.filter(x=>x.offerId!==o.offerId));setTab('Activity');await refreshJobs();}
 async function verifyStop(s,kind){if(!isStationary(speed))throw Error('Stop safely before verification');const c=await call('POST',`/api/v1/shipments/${s.id}/${kind}-challenge`,{});setActiveParcel({...s,kind});setChallenge(c);setOtp('');}
 async function completeOtp(){await call('POST',`/api/v1/shipments/${activeParcel.id}/verify`,{challengeId:challenge.challengeId,code:otp});setChallenge(null);setActiveParcel(null);setOtp('');}
 
 async function reportCashCollection(s){
  await call('POST','/api/v1/rider/cash-report',{shipmentId:s.id,reportedMinor:s.amount_minor,cashPayer:s.cash_payer||'recipient',idempotencyKey:Crypto.randomUUID()});
  setReportedCash(r=>({...r,[s.id]:true}));
  setError('Cash collection recorded successfully. You may now complete delivery verification.');
 }

 async function cancelShipment(s){
  Alert.alert('Cancel Delivery?','Are you sure you want to cancel this order?',[
   {text:'No'},
   {text:'Yes, Cancel',style:'destructive',onPress:()=>execute(async()=>{await call('POST',`/api/v1/shipments/${s.id}/transition`,{action:'cancel',reason:'Customer requested cancellation'});await refreshJobs();setError('Order cancelled successfully.');})}
  ]);
 }

 async function submitDispute(){
  if(!disputeModal)return;
  await call('POST',`/api/v1/shipments/${disputeModal.id}/disputes`,{category:disputeCategory,detail:disputeDetail||'Delivery issue reported by user'});
  setDisputeModal(null);setDisputeDetail('');setError('Support ticket opened. Operations team has been notified.');
 }

 async function price(){const b=booking;const input={pickup:b.pickup,destination:b.destination,vehicle:b.vehicle,recipientPhone:b.recipientPhone,weightG:Number(b.weightG),description:b.description,parcelCategory:b.parcelCategory,parcelSize:b.parcelSize,paymentMethod:b.paymentMethod,cashPayer:b.cashPayer};setQuoted(await call('POST','/api/v1/quotes',input));}
 async function findGhanaPostGpsAddress(){const epoch=++addressLookupEpoch.current;const result=await call('POST','/api/v1/maps/ghana-address',{address:ghanaAddress});if(epoch!==addressLookupEpoch.current)return;
  if(!result.found)throw Error('GhanaPostGPS could not find that address');const target=booking.pickup?'destination':'pickup',pin={latitude:result.latitude,longitude:result.longitude,address:`${result.address}${result.label?` • ${result.label}`:''}`};update(target,pin);mapRef.current?.animateToRegion({latitude:pin.latitude,longitude:pin.longitude,latitudeDelta:.012,longitudeDelta:.012},500);setError('Review and adjust the map pin to the exact entrance before booking.');}
 async function startCheckout(shipment){
  let existing=null;try{existing=await call('GET',`/api/v1/shipments/${shipment.id}/checkout`);}catch{}
  const res=existing&&['pending','confirmed','initiating'].includes(existing.status)?existing:await call('POST',`/api/v1/shipments/${shipment.id}/checkout`,{idempotencyKey:Crypto.randomUUID(),...(paymentEmail?{email:paymentEmail.trim()}:{})});
  setCheckoutSession(res);
  if(res.status!=='confirmed'&&res.checkoutUrl&&shipment.payment_method!=='QR')await Linking.openURL(res.checkoutUrl);
  return res;
 }
 async function book(){const idempotencyKey=Crypto.randomUUID();const r=await call('POST','/api/v1/shipments',{quoteId:quoted.id},{idempotencyKey});setStep(0);setQuoted(null);setTab('Activity');await refreshJobs();
  if(r.payment_method==='CASH'){setError(`Order #${r.id.slice(0,8)} booked with cash settlement at delivery.`);return;}
  try{const x=await startCheckout(r);setError(`Payment ${x.status}. Awaiting PSP settlement.`);}catch(e){setError(`Order placed. Complete checkout to dispatch courier.`);}
 }

 async function runPlaceSearch(){if(placeQuery.trim().length<2)return;const res=await call('GET',`/api/v1/maps/search?q=${encodeURIComponent(placeQuery.trim())}`);setPlacesList(res||[]);}
 function pickPlace(p){const target=booking.pickup?'destination':'pickup';const pin={latitude:p.latitude,longitude:p.longitude,address:`${p.name} • ${p.label}`};update(target,pin);mapRef.current?.animateToRegion({latitude:pin.latitude,longitude:pin.longitude,latitudeDelta:.012,longitudeDelta:.012},500);setPlacesList([]);setPlaceQuery('');}
 function selectOnMap(position){if(step!==0)return;const center={latitude:position.nativeEvent.coordinate.latitude,longitude:position.nativeEvent.coordinate.longitude};const target=booking.pickup?'destination':'pickup';update(target,{address:`Pin: ${center.latitude.toFixed(4)}, ${center.longitude.toFixed(4)}`,...center});
  call('GET',`/api/v1/maps/reverse?lat=${center.latitude}&lon=${center.longitude}`).then(res=>{if(res?.address)update(target,{address:res.address,...center});}).catch(()=>{});}

 if(loading)return (
   <View style={[styles.screen,styles.center]}>
    <StatusBar barStyle="light-content" backgroundColor={colors.bg}/>
    <View style={styles.brandLogoBox}><Text style={styles.brandLogoText}>E</Text></View>
    <Text style={[styles.brandTitle,{marginTop:16,fontSize:26}]}>ELESEND</Text>
    <Text style={[styles.brandTagline,{marginBottom:24}]}>GHANA DELIVERY PLATFORM</Text>
    <ActivityIndicator size="large" color={colors.primary}/>
   </View>
  );

 // =========================================================================
 // PUBLIC AUTH VIEW (BOLT / YANGO GRADE: SLEEK, CONSUMER/DRIVER ONLY, ZERO ADMIN NOISE)
 // =========================================================================
 if(!auth){
  return (
   <View style={styles.screen}>
    <StatusBar barStyle="light-content" backgroundColor={colors.bg}/>
    <ScrollView contentContainerStyle={styles.authScroll} keyboardShouldPersistTaps="handled">
     <View style={styles.authHeader}>
      <View style={styles.brandRow}>
       <View style={styles.brandLogoBox}><Text style={styles.brandLogoText}>E</Text></View>
       <View>
        <Text style={styles.brandTitle}>ELESEND</Text>
        <Text style={styles.brandTagline}>EXPRESS LOGISTICS & DELIVERY</Text>
       </View>
      </View>
      <Text style={styles.brandSubtitle}>Fastest doorstep package delivery across Accra, Kumasi, Tema & Takoradi with verified OTP handover and unbeatable fair platform fees.</Text>
     </View>

     {!!error&&<Pressable onPress={()=>setError('')} style={styles.errorBanner}><Text style={styles.errorText}>⚠️ {error}</Text></Pressable>}

     <View style={styles.authCard}>
      {/* Account Type Selector for Sign Up */}
      {isSignup&&(
       <View style={styles.signupTypeWrapper}>
        <Text style={styles.sectionLabel}>Select Account Role</Text>
        <View style={styles.segmentContainer}>
         <Pressable onPress={()=>edit('kind','customer')} style={[styles.segmentBtn,credentials.kind==='customer'&&styles.segmentBtnActive]}>
          <Text style={[styles.segmentText,credentials.kind==='customer'&&styles.segmentTextActive]}>📦 Sender</Text>
         </Pressable>
         <Pressable onPress={()=>edit('kind','rider')} style={[styles.segmentBtn,credentials.kind==='rider'&&styles.segmentBtnActive]}>
          <Text style={[styles.segmentText,credentials.kind==='rider'&&styles.segmentTextActive]}>🛵 Courier</Text>
         </Pressable>
         <Pressable onPress={()=>edit('kind','business')} style={[styles.segmentBtn,credentials.kind==='business'&&styles.segmentBtnActive]}>
          <Text style={[styles.segmentText,credentials.kind==='business'&&styles.segmentTextActive]}>🏢 Merchant</Text>
         </Pressable>
        </View>
       </View>
      )}

      <Text style={styles.authFormTitle}>{isSignup?(credentials.kind==='rider'?'Courier Driver Onboarding':credentials.kind==='business'?'Merchant & Restaurant Registration':'Create Senders Account'):'Welcome Back'}</Text>
      <Text style={styles.authFormSubtitle}>{isSignup?'Fill in your registration details to begin in minutes':'Sign in with your registered Ghana mobile phone'}</Text>

      {/* Business Name if signing up as Merchant */}
      {isSignup&&['company','business'].includes(credentials.kind)&&(
       <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Business / Store Name</Text>
        <TextInput placeholder="e.g. Accra Central Kitchen, TechMart GH" placeholderTextColor={colors.textMuted} style={styles.inputField} value={credentials.name} onChangeText={v=>edit('name',v)}/>
       </View>
      )}

      {/* Ghana Phone Number */}
      <View style={styles.inputGroup}>
       <Text style={styles.inputLabel}>Mobile Phone Number</Text>
       <View style={styles.phoneInputRow}>
        <View style={styles.countryCodeBadge}><Text style={styles.flag}>🇬🇭</Text><Text style={styles.countryCode}>+233</Text></View>
        <TextInput placeholder="024 123 4567" placeholderTextColor={colors.textMuted} keyboardType="phone-pad" style={styles.phoneInputField} value={credentials.phone} onChangeText={v=>edit('phone',v)}/>
       </View>
      </View>

      {/* Password */}
      <View style={styles.inputGroup}>
       <Text style={styles.inputLabel}>Password</Text>
       <TextInput placeholder="Minimum 12 characters" placeholderTextColor={colors.textMuted} secureTextEntry style={styles.inputField} value={credentials.password} onChangeText={v=>edit('password',v)}/>
      </View>

      {/* Two-Factor Authentication prompt - only shown if server enforces MFA */}
      {requiresTotp&&(
       <View style={styles.totpPromptBox}>
        <Text style={styles.totpPromptTitle}>🔐 Authenticator Verification Required</Text>
        <Text style={styles.totpPromptSubtitle}>Enter the 6-digit code from your authenticator application.</Text>
        <TextInput placeholder="000 000" placeholderTextColor={colors.textMuted} keyboardType="number-pad" maxLength={6} style={styles.inputField} value={credentials.totpCode} onChangeText={v=>edit('totpCode',v)}/>
       </View>
      )}

      {/* Driver/Courier specific fields during Signup */}
      {isSignup&&credentials.kind==='rider'&&(
       <View style={styles.driverSignupBox}>
        <Text style={styles.sectionLabel}>Select Your Delivery Vehicle Class</Text>
        <View style={styles.vehiclePillRow}>
         {[
          {id:'motorcycle',label:'🛵 Motorbike',cap:'20 kg',sub:'Fastest in traffic'},
          {id:'car',label:'🚗 Car',cap:'150 kg',sub:'All-weather'},
          {id:'van',label:'🚐 Van',cap:'800 kg',sub:'Bulk freight'}
         ].map(v=>(
          <Pressable key={v.id} onPress={()=>{edit('vehicle',v.id);edit('maxWeightG',v.id==='motorcycle'?'20000':v.id==='car'?'150000':'800000');}} style={[styles.vehicleChoiceCard,credentials.vehicle===v.id&&styles.vehicleChoiceCardActive]}>
           <Text style={styles.vehicleChoiceLabel}>{v.label}</Text>
           <Text style={styles.vehicleChoiceCap}>Max {v.cap}</Text>
           <Text style={styles.vehicleChoiceSub}>{v.sub}</Text>
          </Pressable>
         ))}
        </View>
        {credentials.vehicle==='car'&&(
         <View style={{marginTop:12}}>
          <TextInput placeholder="Vehicle registration plate (e.g. GR-2024-26)" placeholderTextColor={colors.textMuted} style={styles.inputField} value={credentials.plateNumber} onChangeText={v=>edit('plateNumber',v)}/>
          <View style={{flexDirection:'row',gap:8}}>
           <TextInput placeholder="Make (e.g. Toyota)" placeholderTextColor={colors.textMuted} style={[styles.inputField,{flex:1}]} value={credentials.make} onChangeText={v=>edit('make',v)}/>
           <TextInput placeholder="Model (e.g. Vitz)" placeholderTextColor={colors.textMuted} style={[styles.inputField,{flex:1}]} value={credentials.model} onChangeText={v=>edit('model',v)}/>
          </View>
         </View>
        )}
       </View>
      )}

      {/* Primary Action Button */}
      <TouchableOpacity activeOpacity={0.85} onPress={()=>execute(isSignup?signUp:signIn)} style={styles.primaryBtn} disabled={busy}>
       {busy?<ActivityIndicator color="#071B28"/>:<Text style={styles.primaryBtnText}>{isSignup?'Create Elesend Account':'Sign In'}</Text>}
      </TouchableOpacity>

      {/* Switch between sign-in and sign-up */}
      <TouchableOpacity activeOpacity={0.7} onPress={()=>{setIsSignup(!isSignup);setError('');setRequiresTotp(false);}} style={styles.secondaryLink}>
       <Text style={styles.secondaryLinkText}>{isSignup?'Already have an account? Sign In':'New to Elesend? Create Free Account'}</Text>
      </TouchableOpacity>
     </View>

     {/* Discrete Public Trust Badges (Bolt / Yango Style) */}
     <View style={styles.trustBadgesRow}>
      <View style={styles.trustBadge}><Text style={styles.trustBadgeText}>🛡️ 100% OTP Handover</Text></View>
      <View style={styles.trustBadge}><Text style={styles.trustBadgeText}>⚡ 13% Fair Platform Fee</Text></View>
      <View style={styles.trustBadge}><Text style={styles.trustBadgeText}>📍 Live GPS Routing</Text></View>
     </View>
    </ScrollView>
   </View>
  );
 }

 // =========================================================================
 // AUTHENTICATED APPLICATION
 // =========================================================================
 const isRider=auth.kind==='rider';
 const isAdmin=auth.kind==='admin';
 const isBusiness=['company','business'].includes(auth.kind);

 return (
  <View style={styles.screen}>
   <StatusBar barStyle="light-content" backgroundColor={colors.bg}/>
   
   {/* Header Bar */}
   <View style={styles.appHeader}>
    <View style={styles.appHeaderLeft}>
     <View style={styles.appHeaderBadge}><Text style={styles.appHeaderBadgeText}>E</Text></View>
     <View>
      <Text style={styles.appBrand}>ELESEND</Text>
      <Text style={styles.appUserBadge}>{auth.phone} • {auth.kind.toUpperCase()}</Text>
     </View>
    </View>
    <TouchableOpacity activeOpacity={0.7} onPress={()=>execute(logout)} style={styles.headerLogoutBtn}>
     <Text style={styles.headerLogoutText}>Log out</Text>
    </TouchableOpacity>
   </View>

   {!!error&&<Pressable onPress={()=>setError('')} style={styles.errorBanner}><Text style={styles.errorText}>⚠️ {error}</Text></Pressable>}

   {/* Main Tab View */}
   <ScrollView contentContainerStyle={styles.mainScroll} keyboardShouldPersistTaps="handled">
    
    {/* TAB 1: SEND A PARCEL (BOLT/YANGO STYLE CONSUMER EXPERIENCE) */}
    {tab==='Send'&&(
     <View>
      {/* Driver quick switch banner */}
      {isRider&&(
       <View style={styles.roleBanner}>
        <Text style={styles.roleBannerText}>🛵 You are signed in as a Courier Rider.</Text>
        <TouchableOpacity onPress={()=>setTab('Driver')} style={styles.roleBannerBtn}><Text style={styles.roleBannerBtnText}>Open Driver Mode</Text></TouchableOpacity>
       </View>
      )}

      {/* Step Indicator */}
      <View style={styles.stepIndicatorRow}>
       {['1. Location & Route','2. Package & Vehicle','3. Quote & Checkout'].map((st,idx)=>(
        <View key={st} style={[styles.stepPill,step===idx&&styles.stepPillActive,step>idx&&styles.stepPillComplete]}>
         <Text style={[styles.stepPillText,step===idx&&styles.stepPillTextActive]}>{st}</Text>
        </View>
       ))}
      </View>

      {/* STEP 0: LOCATIONS & MAP */}
      {step===0&&(
       <View style={styles.sectionCard}>
        <Text style={styles.cardTitle}>Set Delivery Points</Text>
        <Text style={styles.cardSubtitle}>Search places across Ghana or tap directly on the map to place pickup and delivery pins.</Text>

        {/* Place Search */}
        <View style={styles.searchRow}>
         <TextInput placeholder="Search place (e.g. Accra Mall, Kejetia, Airport)" placeholderTextColor={colors.textMuted} style={[styles.inputField,{flex:1}]} value={placeQuery} onChangeText={v=>{setPlaceQuery(v);if(v.trim().length<2)setPlacesList([]);}} returnKeyType="search" onSubmitEditing={()=>execute(runPlaceSearch)}/>
         <TouchableOpacity onPress={()=>execute(runPlaceSearch)} style={styles.searchBtn}><Text style={styles.searchBtnText}>Search</Text></TouchableOpacity>
        </View>

        {/* Place suggestions */}
        {placesList.length>0&&(
         <View style={styles.placesDropdown}>
          {placesList.map((item,i)=>(
           <TouchableOpacity key={i} onPress={()=>pickPlace(item)} style={styles.placeItem}>
            <Text style={styles.placeName}>📍 {item.name}</Text>
            <Text style={styles.placeLabel}>{item.label}</Text>
           </TouchableOpacity>
          ))}
         </View>
        )}

        {/* Popular Ghana Location Chips */}
        <View style={styles.chipsRow}>
         {[
          {name:'Accra Mall',latitude:5.6214,longitude:-0.1741,label:'Tetteh Quarshie Interchange'},
          {name:'Kotoka Airport (ACC)',latitude:5.6052,longitude:-0.1717,label:'Airport Residential Area'},
          {name:'Kejetia Market',latitude:6.6961,longitude:-1.6244,label:'Central Kumasi'},
          {name:'Tema Harbour',latitude:5.6322,longitude:0.0076,label:'Harbour Commercial Hub'}
         ].map(chip=>(
          <TouchableOpacity key={chip.name} onPress={()=>pickPlace(chip)} style={styles.quickChip}>
           <Text style={styles.quickChipText}>📍 {chip.name}</Text>
          </TouchableOpacity>
         ))}
        </View>

        {/* GhanaPostGPS integration */}
        {ghanaAddressLookup&&(
         <View style={styles.ghanaPostBox}>
          <Text style={styles.ghanaPostLabel}>🇬🇭 GhanaPostGPS Digital Address</Text>
          <View style={{flexDirection:'row',gap:8}}>
           <TextInput placeholder="e.g. AK-484-9321" placeholderTextColor={colors.textMuted} autoCapitalize="characters" style={[styles.inputField,{flex:1}]} value={ghanaAddress} onChangeText={v=>{addressLookupEpoch.current++;setGhanaAddress(v);}}/>
           <TouchableOpacity onPress={()=>execute(findGhanaPostGpsAddress)} style={styles.ghanaPostBtn} disabled={!ghanaAddress.trim()}><Text style={styles.ghanaPostBtnText}>Lookup</Text></TouchableOpacity>
          </View>
         </View>
        )}

        {/* Interactive Map */}
        <View style={styles.mapContainer}>
         <MapView ref={mapRef} provider={MAP_RENDERER} style={styles.map} initialRegion={{latitude:5.6037,longitude:-0.187,latitudeDelta:.14,longitudeDelta:.14}} onPress={selectOnMap}>
          {booking.pickup&&<Marker coordinate={booking.pickup} title="Pickup Point" pinColor="#18C6A5"/>}
          {booking.destination&&<Marker coordinate={booking.destination} title="Drop-off Point" pinColor="#D92D40"/>}
         </MapView>
        </View>

        {/* Selected Locations Summary */}
        <View style={styles.locationSummaryBox}>
         <View style={styles.locationItem}>
          <View style={[styles.locDot,{backgroundColor:colors.primary}]}/>
          <View style={{flex:1}}>
           <Text style={styles.locItemTitle}>PICKUP LOCATION</Text>
           <Text style={styles.locItemValue}>{booking.pickup?.address||'Tap on the map or search above'}</Text>
          </View>
         </View>
         <View style={styles.locDivider}/>
         <View style={styles.locationItem}>
          <View style={[styles.locDot,{backgroundColor:colors.danger}]}/>
          <View style={{flex:1}}>
           <Text style={styles.locItemTitle}>DELIVERY DESTINATION</Text>
           <Text style={styles.locItemValue}>{booking.destination?.address||'Tap on the map or search above'}</Text>
          </View>
         </View>
        </View>

        <View style={styles.buttonRow}>
         {(booking.pickup||booking.destination)&&(
          <TouchableOpacity onPress={()=>{update('pickup',null);update('destination',null);setPlacesList([]);}} style={styles.resetBtn}>
           <Text style={styles.resetBtnText}>Clear Pins</Text>
          </TouchableOpacity>
         )}
         <TouchableOpacity onPress={()=>setStep(1)} style={[styles.primaryBtn,{flex:1}]} disabled={!booking.pickup||!booking.destination}>
          <Text style={styles.primaryBtnText}>Next: Package & Vehicle →</Text>
         </TouchableOpacity>
        </View>
       </View>
      )}

      {/* STEP 1: PARCEL & VEHICLE SELECTION (BOLT/YANGO STYLE) */}
      {step===1&&(
       <View style={styles.sectionCard}>
        <Text style={styles.cardTitle}>Select Delivery Vehicle</Text>
        <Text style={styles.cardSubtitle}>Choose the optimal vehicle class for your shipment speed and weight.</Text>

        {/* Vehicle Selection Cards */}
        <View style={styles.vehicleGrid}>
         {[
          {id:'motorcycle',icon:'🛵',title:'Express Bike',desc:'Fastest through city traffic. Ideal for food, docs, small boxes.',time:'15-25 min',tag:'RECOMMENDED'},
          {id:'car',icon:'🚗',title:'Standard Car',desc:'Weather-protected, safe for delicate items and medium cartons.',time:'25-45 min'},
          {id:'van',icon:'🚐',title:'Cargo Van',desc:'High capacity for heavy crates, wholesale goods, and appliances.',time:'40-60 min'}
         ].map(v=>(
          <TouchableOpacity key={v.id} activeOpacity={0.8} onPress={()=>update('vehicle',v.id)} style={[styles.vehicleSelectCard,booking.vehicle===v.id&&styles.vehicleSelectCardActive]}>
           <Text style={styles.vehicleSelectIcon}>{v.icon}</Text>
           <View style={{flex:1}}>
            <View style={{flexDirection:'row',alignItems:'center',gap:6}}>
             <Text style={styles.vehicleSelectTitle}>{v.title}</Text>
             {v.tag&&<View style={styles.tagBadge}><Text style={styles.tagBadgeText}>{v.tag}</Text></View>}
            </View>
            <Text style={styles.vehicleSelectDesc}>{v.desc}</Text>
            <Text style={styles.vehicleSelectTime}>⏱️ Approx {v.time}</Text>
           </View>
           <View style={[styles.radioCircle,booking.vehicle===v.id&&styles.radioCircleActive]}>
            {booking.vehicle===v.id&&<View style={styles.radioInner}/>}
           </View>
          </TouchableOpacity>
         ))}
        </View>

        {/* Package Specifications */}
        <Text style={[styles.cardTitle,{marginTop:24}]}>Consignment Specifications</Text>
        <View style={styles.inputGroup}>
         <Text style={styles.inputLabel}>Recipient Ghana Mobile Phone</Text>
         <TextInput placeholder="e.g. 0244123456" placeholderTextColor={colors.textMuted} keyboardType="phone-pad" style={styles.inputField} value={booking.recipientPhone} onChangeText={v=>update('recipientPhone',v)}/>
        </View>

        <View style={styles.inputGroup}>
         <Text style={styles.inputLabel}>Parcel Weight in Grams</Text>
         <TextInput placeholder="e.g. 1500 (1.5 kg)" placeholderTextColor={colors.textMuted} keyboardType="numeric" style={styles.inputField} value={booking.weightG} onChangeText={v=>update('weightG',v)}/>
        </View>

        <View style={styles.inputGroup}>
         <Text style={styles.inputLabel}>Contents Description</Text>
         <TextInput placeholder="e.g. Documents, mobile phone, clothing, food parcel" placeholderTextColor={colors.textMuted} style={styles.inputField} value={booking.description} onChangeText={v=>update('description',v)}/>
        </View>

        {/* Package Category */}
        <Text style={styles.inputLabel}>Category</Text>
        <View style={styles.sizePillRow}>
         {['general','documents','fragile','food'].map(cat=>(
          <TouchableOpacity key={cat} onPress={()=>update('parcelCategory',cat)} style={[styles.sizePill,booking.parcelCategory===cat&&styles.sizePillActive]}>
           <Text style={[styles.sizePillText,booking.parcelCategory===cat&&styles.sizePillTextActive]}>{cat.toUpperCase()}</Text>
          </TouchableOpacity>
         ))}
        </View>

        {/* Size Pills */}
        <Text style={[styles.inputLabel,{marginTop:12}]}>Size Tier</Text>
        <View style={styles.sizePillRow}>
         {['small','medium','large'].map(sz=>(
          <TouchableOpacity key={sz} onPress={()=>update('parcelSize',sz)} style={[styles.sizePill,booking.parcelSize===sz&&styles.sizePillActive]}>
           <Text style={[styles.sizePillText,booking.parcelSize===sz&&styles.sizePillTextActive]}>{sz.toUpperCase()}</Text>
          </TouchableOpacity>
         ))}
        </View>

        <View style={styles.buttonRow}>
         <TouchableOpacity onPress={()=>setStep(0)} style={styles.backBtn}><Text style={styles.backBtnText}>← Back</Text></TouchableOpacity>
         <TouchableOpacity onPress={()=>setStep(2)} style={[styles.primaryBtn,{flex:1}]} disabled={!booking.recipientPhone||!Number(booking.weightG)}>
          <Text style={styles.primaryBtnText}>Review Fare & Pay →</Text>
         </TouchableOpacity>
        </View>
       </View>
      )}

      {/* STEP 2: FARE ESTIMATE & CHECKOUT */}
      {step===2&&(
       <View style={styles.sectionCard}>
        <Text style={styles.cardTitle}>Payment Method</Text>
        <Text style={styles.cardSubtitle}>Select how the delivery fare will be settled.</Text>

        <View style={styles.paymentMethodRow}>
         {paymentMethods.filter(x=>x.enabled).map(x=>x.method).map(m=>(
          <TouchableOpacity key={m} onPress={()=>update('paymentMethod',m)} style={[styles.paymentMethodCard,booking.paymentMethod===m&&styles.paymentMethodCardActive]}>
           <Text style={styles.paymentMethodIcon}>{m==='CASH'?'💵':m==='MOMO'?'📱':m==='CARD'?'💳':'📲'}</Text>
           <Text style={[styles.paymentMethodText,booking.paymentMethod===m&&styles.paymentMethodTextActive]}>{m}</Text>
          </TouchableOpacity>
         ))}
        </View>

        {booking.paymentMethod==='CASH'&&(
         <View style={styles.cashPayerBox}>
          <Text style={styles.cashPayerLabel}>Who pays cash to the courier?</Text>
          <View style={{flexDirection:'row',gap:10,marginTop:8}}>
           {['recipient','sender'].map(k=>(
            <TouchableOpacity key={k} onPress={()=>update('cashPayer',k)} style={[styles.cashPayerBtn,booking.cashPayer===k&&styles.cashPayerBtnActive]}>
             <Text style={[styles.cashPayerBtnText,booking.cashPayer===k&&styles.cashPayerBtnTextActive]}>{k==='recipient'?'Recipient pays on arrival':'Sender pays at pickup'}</Text>
            </TouchableOpacity>
           ))}
          </View>
         </View>
        )}

        {booking.paymentMethod!=='CASH'&&(
         <View style={styles.digitalPayBox}>
          <Text style={styles.digitalPayNote}>🔒 Protected checkout via licensed PSP. Senders never transmit sensitive banking credentials to Elesend.</Text>
          <TextInput placeholder="Payment receipt email (e.g. sender@example.com)" placeholderTextColor={colors.textMuted} keyboardType="email-address" autoCapitalize="none" style={styles.inputField} value={paymentEmail} onChangeText={setPaymentEmail}/>
         </View>
        )}

        {/* Fare Quote Calculation */}
        <TouchableOpacity activeOpacity={0.8} onPress={()=>execute(price)} style={styles.calculateFareBtn} disabled={busy}>
         <Text style={styles.calculateFareBtnText}>{busy?'Calculating road quotation...':'⚡ Get Guaranteed Fare Quotation'}</Text>
        </TouchableOpacity>

        {quoted&&(
         <View style={styles.quotedFareCard}>
          <View style={styles.quotePriceHeader}>
           <View>
            <Text style={styles.quotedAmountLabel}>TOTAL GUARANTEED FARE</Text>
            <Text style={styles.quotedAmountValue}>{ghc(quoted.amount_minor)}</Text>
           </View>
           <View style={styles.savingsPill}>
            <Text style={styles.savingsPillText}>Fair Platform Fee Included</Text>
           </View>
          </View>

          <View style={styles.quoteDetailsRow}>
           <Text style={styles.quoteDetailText}>🛣️ Road Distance: {(quoted.distanceMeters/1000).toFixed(1)} km</Text>
           <Text style={styles.quoteDetailText}>📡 Dispatch: {quoted.availability?.status==='active'?'Couriers Active':'Standby'}</Text>
          </View>

          <TouchableOpacity activeOpacity={0.85} onPress={()=>execute(book)} style={styles.bookFinalBtn} disabled={busy||quoted.availability?.status==='none_identified'}>
           {busy?<ActivityIndicator color="#071B28"/>:<Text style={styles.bookFinalBtnText}>🚀 Confirm Delivery Booking</Text>}
          </TouchableOpacity>
         </View>
        )}

        <View style={styles.buttonRow}>
         <TouchableOpacity onPress={()=>setStep(1)} style={styles.backBtn}><Text style={styles.backBtnText}>← Back</Text></TouchableOpacity>
        </View>
       </View>
      )}
     </View>
    )}

    {/* TAB: FOOD & RESTAURANT MARKETPLACE */}
    {tab==='Food'&&(
     <View>
      {!selectedRest?(
       <View style={styles.sectionCard}>
        <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
         <View>
          <Text style={styles.cardTitle}>🍔 Food & Kitchen Marketplace</Text>
          <Text style={styles.cardSubtitle}>Fresh Ghanaian dishes & fast food delivered to your door.</Text>
         </View>
         <TouchableOpacity onPress={()=>execute(loadFoodData)} style={styles.refreshBadge}>
          <Text style={styles.refreshBadgeText}>🔄 Refresh</Text>
         </TouchableOpacity>
        </View>

        {foodRestaurants.length===0?(
         <View style={styles.emptyBox}>
          <Text style={styles.emptyIcon}>🍲</Text>
          <Text style={styles.emptyText}>Discovering approved kitchens in your area...</Text>
         </View>
        ):(
         foodRestaurants.map(r=>(
          <TouchableOpacity key={r.id} activeOpacity={0.85} onPress={()=>execute(()=>openRestaurantDetail(r))} style={styles.restaurantCard}>
           <View style={styles.restHeaderRow}>
            <View style={{flex:1}}>
             <Text style={styles.restName}>{r.name}</Text>
             <Text style={styles.restCuisine}>🍽️ {r.cuisine||'Local & Continental'}</Text>
             <Text style={styles.restAddress}>📍 {r.address}</Text>
            </View>
            <View style={{alignItems:'flex-end'}}>
             <View style={[styles.restStatusPill,r.is_open&&!r.is_paused?{backgroundColor:'rgba(24,198,165,0.15)'}:{backgroundColor:'rgba(217,45,64,0.15)'}]}>
              <Text style={[styles.restStatusText,r.is_open&&!r.is_paused?{color:colors.primary}:{color:colors.danger}]}>
               {r.is_open&&!r.is_paused?'OPEN':'BUSY'}
              </Text>
             </View>
             <Text style={styles.restPrepTime}>⏱️ ~{r.prep_time_minutes} min</Text>
            </View>
           </View>
           <View style={styles.restFooterRow}>
            <Text style={styles.restDistance}>🚴 Radius: {Math.round(r.delivery_radius_m/1000)} km</Text>
            <Text style={styles.viewMenuText}>View Menu →</Text>
           </View>
          </TouchableOpacity>
         ))
        )}
       </View>
      ):(
       <View>
        {/* Restaurant Detail View */}
        <View style={styles.sectionCard}>
         <TouchableOpacity onPress={()=>{setSelectedRest(null);setRestMenu(null);}} style={styles.backBtnInline}>
          <Text style={styles.backBtnText}>← Back to Kitchens</Text>
         </TouchableOpacity>

         <Text style={[styles.cardTitle,{fontSize:22,marginTop:8}]}>{selectedRest.name}</Text>
         <Text style={styles.restCuisine}>🍽️ {selectedRest.cuisine||'Local Specialities'} • 📍 {selectedRest.address}</Text>
         <Text style={styles.restPrepNotice}>⚡ Kitchen estimated cooking time: {selectedRest.prep_time_minutes} minutes</Text>

         {/* Menu Sections */}
         {restMenu?.categories?.map(cat=>(
          <View key={cat.id} style={{marginTop:16}}>
           <Text style={styles.menuCategoryTitle}>{cat.name}</Text>
           {cat.items?.map(item=>(
            <View key={item.id} style={styles.dishCard}>
             <View style={{flex:1}}>
              <Text style={styles.dishTitle}>{item.name}</Text>
              {item.description&&<Text style={styles.dishDesc}>{item.description}</Text>}
              <View style={{flexDirection:'row',alignItems:'center',gap:10,marginTop:6}}>
               <Text style={styles.dishPrice}>{ghc(item.price_minor)}</Text>
               {item.prep_time_minutes&&<Text style={styles.dishPrepBadge}>⏱️ {item.prep_time_minutes}m prep</Text>}
              </View>
             </View>
             <TouchableOpacity onPress={()=>openDishCustomizer(item)} style={styles.addDishBtn} disabled={!item.is_available}>
              <Text style={styles.addDishBtnText}>{item.is_available?'+ Add':'Sold Out'}</Text>
             </TouchableOpacity>
            </View>
           ))}
          </View>
         ))}
        </View>
       </View>
      )}

      {/* Floating Cart Button */}
      {cartItems.length>0&&(
       <View style={styles.floatingCartBar}>
        <View>
         <Text style={styles.floatingCartCount}>{cartItems.length} {cartItems.length===1?'item':'items'} selected</Text>
         <Text style={styles.floatingCartTotal}>{ghc(cartItems.reduce((acc,x)=>acc+(x.priceMinor||0),0))}</Text>
        </View>
        <TouchableOpacity onPress={()=>setCartModal(true)} style={styles.floatingCartActionBtn}>
         <Text style={styles.floatingCartActionText}>View Cart & Checkout →</Text>
        </TouchableOpacity>
       </View>
      )}

      {/* Dish Customizer Modal */}
      {dishModal&&selectedDish&&(
       <View style={styles.modalOverlay}>
        <View style={styles.modalContentCard}>
         <Text style={styles.modalTitle}>Customize {selectedDish.name}</Text>
         <Text style={styles.dishDesc}>{selectedDish.description||'Select your preferred portions and add-ons.'}</Text>

         {selectedDish.modifiers?.map(mod=>(
          <View key={mod.id} style={styles.modBox}>
           <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
            <Text style={styles.modName}>{mod.name}</Text>
            {mod.is_required&&<Text style={styles.modRequiredBadge}>Required</Text>}
           </View>
           {mod.options?.map(opt=>{
            const isChecked=selectedOptions.includes(opt.id);
            return (
             <TouchableOpacity key={opt.id} onPress={()=>toggleOption(opt.id,mod)} style={[styles.modOptionRow,isChecked&&styles.modOptionRowActive]}>
              <Text style={[styles.modOptionText,isChecked&&{color:colors.primary,fontWeight:'700'}]}>
               {isChecked?'🔘 ':'⚪ '} {opt.name}
              </Text>
              <Text style={styles.modOptionPrice}>{opt.price_minor>0?`+${ghc(opt.price_minor)}`:'Free'}</Text>
             </TouchableOpacity>
            );
           })}
          </View>
         ))}

         <View style={{flexDirection:'row',gap:10,marginTop:16}}>
          <TouchableOpacity onPress={()=>setDishModal(false)} style={styles.backBtn}><Text style={styles.backBtnText}>Cancel</Text></TouchableOpacity>
          <TouchableOpacity onPress={addDishToCart} style={[styles.primaryBtn,{flex:2}]}>
           <Text style={styles.primaryBtnText}>Add to Order</Text>
          </TouchableOpacity>
         </View>
        </View>
       </View>
      )}

      {/* Food Checkout Modal */}
      {cartModal&&(
       <View style={styles.modalOverlay}>
        <View style={styles.modalContentCard}>
         <Text style={styles.modalTitle}>Checkout Food Order</Text>
         <Text style={styles.cardSubtitle}>Direct delivery from {selectedRest?.name}</Text>

         {/* Cart items summary */}
         <ScrollView style={{maxHeight:140,marginVertical:8}}>
          {cartItems.map((c,idx)=>(
           <View key={idx} style={styles.cartSummaryRow}>
            <Text style={styles.cartItemText}>1x {c.name}</Text>
            <Text style={styles.cartItemPrice}>{ghc(c.priceMinor)}</Text>
           </View>
          ))}
         </ScrollView>

         {/* Delivery Address */}
         <Text style={styles.inputLabel}>Delivery Address (Accra / Kumasi / Tema)</Text>
         <TextInput placeholder="e.g. Airport Residential, House 12, Accra" placeholderTextColor={colors.textMuted} style={styles.inputField} value={foodDeliveryAddress} onChangeText={setFoodDeliveryAddress}/>

         <View style={styles.chipsRow}>
          {['Airport Residential','Osu Oxford St','East Legon','Cantonments'].map(p=>(
           <TouchableOpacity key={p} onPress={()=>setFoodDeliveryAddress(p)} style={styles.quickChip}>
            <Text style={styles.quickChipText}>📍 {p}</Text>
           </TouchableOpacity>
          ))}
         </View>

         {/* Recipient Phone & Notes */}
         <Text style={[styles.inputLabel,{marginTop:6}]}>Contact Phone</Text>
         <TextInput placeholder="Recipient phone" placeholderTextColor={colors.textMuted} keyboardType="phone-pad" style={styles.inputField} value={foodRecipientPhone||auth.phone} onChangeText={setFoodRecipientPhone}/>

         <TextInput placeholder="Kitchen notes (e.g. Extra shito, no onions)" placeholderTextColor={colors.textMuted} style={styles.inputField} value={foodInstructions} onChangeText={setFoodInstructions}/>

         {/* Payment Method */}
         <Text style={styles.inputLabel}>Payment Method</Text>
         <View style={{flexDirection:'row',gap:10,marginBottom:12}}>
          {['CASH','MOMO'].map(m=>(
           <TouchableOpacity key={m} onPress={()=>setFoodPaymentMethod(m)} style={[styles.paymentMethodCard,foodPaymentMethod===m&&styles.paymentMethodCardActive]}>
            <Text style={styles.paymentMethodText}>{m==='CASH'?'💵 Cash on Delivery':'📱 Mobile Money'}</Text>
           </TouchableOpacity>
          ))}
         </View>

         {/* Quote Calculation */}
         {!foodQuote?(
          <TouchableOpacity onPress={()=>execute(calculateFoodQuote)} style={styles.calculateFareBtn}>
           <Text style={styles.calculateFareBtnText}>⚡ Calculate Live Delivery Fare</Text>
          </TouchableOpacity>
         ):(
          <View style={styles.quoteDetailsRow}>
           <View style={{flex:1}}>
            <Text style={styles.cartItemText}>Food Subtotal: {ghc(foodQuote.subtotalMinor)}</Text>
            <Text style={styles.cartItemText}>Courier Delivery: {ghc(foodQuote.deliveryFeeMinor)}</Text>
            <Text style={[styles.cartItemPrice,{fontSize:16,color:colors.primary,marginTop:4}]}>Total: {ghc(foodQuote.totalMinor)}</Text>
           </View>
           <TouchableOpacity onPress={()=>execute(placeFoodOrder)} style={[styles.primaryBtn,{flex:1.2}]}>
            <Text style={styles.primaryBtnText}>Confirm Order</Text>
           </TouchableOpacity>
          </View>
         )}

         <TouchableOpacity onPress={()=>setCartModal(false)} style={[styles.backBtnInline,{alignSelf:'center',marginTop:12}]}>
          <Text style={styles.backBtnText}>Close</Text>
         </TouchableOpacity>
        </View>
       </View>
      )}
     </View>
    )}

    {/* TAB 2: ACTIVITY / ORDERS */}
    {tab==='Activity'&&(
     <View style={styles.sectionCard}>
      <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
       <Text style={styles.cardTitle}>My Deliveries</Text>
       <TouchableOpacity onPress={()=>execute(refreshJobs)} style={styles.refreshBadge}><Text style={styles.refreshBadgeText}>🔄 Refresh</Text></TouchableOpacity>
      </View>

      {offlineCopy&&<Text style={styles.offlineNote}>📡 Displaying offline cached jobs ({offlineCopy.cachedAt}). Connect to network for verification.</Text>}

      {checkoutSession&&(
       <View style={styles.checkoutBox}>
        <Text style={styles.checkoutTitle}>Checkout Session</Text>
        <Text style={styles.checkoutSubtitle}>Order #{checkoutSession.shipmentId.slice(0,8)} • Status: {checkoutSession.status.toUpperCase()}</Text>
        {checkoutSession.method==='QR'&&checkoutSession.checkoutUrl&&(
         <View style={{alignItems:'center',marginVertical:12}}>
          <View style={{padding:12,backgroundColor:'#fff',borderRadius:12}}><QRCode value={checkoutSession.checkoutUrl} size={180}/></View>
         </View>
        )}
        {checkoutSession.checkoutUrl&&<TouchableOpacity onPress={()=>Linking.openURL(checkoutSession.checkoutUrl)} style={styles.openCheckoutBtn}><Text style={styles.openCheckoutBtnText}>Complete Payment via Browser</Text></TouchableOpacity>}
       </View>
      )}

      {myShipments.length===0?(
       <View style={styles.emptyBox}><Text style={styles.emptyIcon}>📦</Text><Text style={styles.emptyText}>No delivery orders yet. Send your first package in the Send tab!</Text></View>
      ):(
       myShipments.map(s=>(
        <View key={s.id} style={styles.orderCard}>
         <View style={styles.orderHeaderRow}>
          <Text style={styles.orderIdText}>#{s.id.slice(0,8)}</Text>
          <View style={[styles.orderStateBadge,s.state==='COMPLETED'&&{backgroundColor:colors.primary}]}>
           <Text style={styles.orderStateText}>{s.state.replaceAll('_',' ')}</Text>
          </View>
         </View>
         <Text style={styles.orderPriceText}>Fare: {ghc(s.amount_minor)} • {s.payment_method}</Text>
         
         {/* Rider specific operational action buttons */}
         {isRider&&(
          <View style={styles.riderActionGroup}>
           {s.state==='RIDER_ASSIGNED'&&<TouchableOpacity onPress={()=>execute(()=>verifyStop(s,'pickup'))} style={styles.actionBtn}><Text style={styles.actionBtnText}>Verify Sender Pickup OTP</Text></TouchableOpacity>}
           {s.state==='PICKUP_VERIFIED'&&<TouchableOpacity onPress={()=>execute(async()=>{await call('POST',`/api/v1/shipments/${s.id}/transition`,{action:'start'});await refreshJobs();})} style={styles.actionBtn}><Text style={styles.actionBtnText}>Start Transport</Text></TouchableOpacity>}
           {s.state==='IN_TRANSIT'&&s.payment_method==='CASH'&&!reportedCash[s.id]&&(
            <TouchableOpacity onPress={()=>execute(()=>reportCashCollection(s))} style={[styles.actionBtn,{backgroundColor:colors.warn}]}>
             <Text style={styles.actionBtnText}>💵 Confirm Cash Collected: {ghc(s.amount_minor)}</Text>
            </TouchableOpacity>
           )}
           {s.state==='IN_TRANSIT'&&(s.payment_method!=='CASH'||reportedCash[s.id])&&(
            <TouchableOpacity onPress={()=>execute(()=>verifyStop(s,'delivery'))} style={styles.actionBtn}>
             <Text style={styles.actionBtnText}>Send Recipient Handover OTP</Text>
            </TouchableOpacity>
           )}
           {s.pickup&&<TouchableOpacity onPress={()=>openTurnByTurnNavigation({latitude:s.pickup.latitude,longitude:s.pickup.longitude,label:`Pickup ${s.id.slice(0,8)}`})} style={styles.navBtn}><Text style={styles.navBtnText}>🗺️ Open Turn-by-Turn Navigation</Text></TouchableOpacity>}
          </View>
         )}

         {/* Customer tracking, cancellation and dispute buttons */}
         {!isRider&&(
          <View style={{marginTop:10}}>
           {['AWAITING_ASSIGNMENT','AWAITING_PAYMENT'].includes(s.state)&&(
            <TouchableOpacity onPress={()=>cancelShipment(s)} style={styles.cancelBtn}>
             <Text style={styles.cancelBtnText}>✕ Cancel Delivery Order</Text>
            </TouchableOpacity>
           )}
           {['RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP'].includes(s.state)&&(
            <View style={{flexDirection:'row',gap:8,marginTop:6}}>
             <TouchableOpacity onPress={()=>Linking.openURL(`https://wa.me/?text=${encodeURIComponent(`Track your delivery live on ELESEND: ${BASE||'http://localhost:3090'}/track/${s.id}`)}`)} style={styles.shareBtn}><Text style={styles.shareBtnText}>📲 Share Live Link</Text></TouchableOpacity>
             <TouchableOpacity onPress={()=>Linking.openURL(`${BASE||'http://localhost:3090'}/track/${s.id}`)} style={styles.viewMapBtn}><Text style={styles.viewMapBtnText}>🗺️ View Route</Text></TouchableOpacity>
            </View>
           )}
           <TouchableOpacity onPress={()=>setDisputeModal(s)} style={styles.disputeLink}>
            <Text style={styles.disputeLinkText}>Report Issue / Dispute</Text>
           </TouchableOpacity>
          </View>
         )}
        </View>
       ))
      )}

      {/* Handover OTP Verification Modal */}
      {challenge&&(
       <View style={styles.otpModal}>
        <Text style={styles.otpModalTitle}>Handover Verification Code</Text>
        <Text style={styles.otpModalDesc}>The party handing over the parcel reads the 6-digit code in person:</Text>
        <TextInput placeholder="Enter 6-digit OTP" placeholderTextColor={colors.textMuted} keyboardType="numeric" maxLength={6} style={styles.inputField} value={otp} onChangeText={setOtp}/>
        <TouchableOpacity onPress={()=>execute(async()=>{await completeOtp();await refreshJobs();})} style={styles.primaryBtn} disabled={otp.length!==6}>
         <Text style={styles.primaryBtnText}>Confirm Handover Verification</Text>
        </TouchableOpacity>
       </View>
      )}

      {/* Support / Dispute Modal */}
      {disputeModal&&(
       <View style={styles.otpModal}>
        <Text style={styles.otpModalTitle}>Report Issue for Order #{disputeModal.id.slice(0,8)}</Text>
        <Text style={styles.otpModalDesc}>Select category and provide details for platform operator investigation:</Text>
        <View style={styles.sizePillRow}>
         {['damage','lost','misconduct','payment'].map(cat=>(
          <TouchableOpacity key={cat} onPress={()=>setDisputeCategory(cat)} style={[styles.sizePill,disputeCategory===cat&&styles.sizePillActive]}>
           <Text style={[styles.sizePillText,disputeCategory===cat&&styles.sizePillTextActive]}>{cat.toUpperCase()}</Text>
          </TouchableOpacity>
         ))}
        </View>
        <TextInput placeholder="Describe the issue in detail..." placeholderTextColor={colors.textMuted} multiline numberOfLines={3} style={[styles.inputField,{height:70,marginTop:8}]} value={disputeDetail} onChangeText={setDisputeDetail}/>
        <View style={{flexDirection:'row',gap:8,marginTop:6}}>
         <TouchableOpacity onPress={()=>setDisputeModal(null)} style={styles.resetBtn}><Text style={styles.resetBtnText}>Close</Text></TouchableOpacity>
         <TouchableOpacity onPress={()=>execute(submitDispute)} style={[styles.primaryBtn,{flex:1}]}><Text style={styles.primaryBtnText}>Submit Dispute</Text></TouchableOpacity>
        </View>
       </View>
      )}
     </View>
    )}

    {/* TAB 3: DRIVER / COURIER DASHBOARD (ONLY VISIBLE TO RIDERS) */}
    {tab==='Driver'&&isRider&&(
     <View>
      {/* Online/Offline Status Header Card */}
      <View style={[styles.driverStatusCard,online&&styles.driverStatusCardOnline]}>
       <View style={{flexDirection:'row',alignItems:'center',gap:12}}>
        <View style={[styles.pulseCircle,online&&styles.pulseCircleOnline]}/>
        <View>
         <Text style={styles.driverStatusTitle}>{online?'YOU ARE ONLINE':'YOU ARE OFFLINE'}</Text>
         <Text style={styles.driverStatusSubtitle}>{online?'Receiving nearest road delivery offers':'Go online to receive delivery requests'}</Text>
        </View>
       </View>
       <TouchableOpacity activeOpacity={0.8} onPress={()=>execute(toggleOnline)} style={[styles.toggleOnlineBtn,online&&styles.toggleOnlineBtnActive]}>
        <Text style={styles.toggleOnlineBtnText}>{online?'Go Offline':'Go Online'}</Text>
       </TouchableOpacity>
      </View>

      {/* Multi-Parcel Active Trip Manifest */}
      {manifest?.stops?.length>0&&(
       <View style={styles.sectionCard}>
        <Text style={styles.cardTitle}>Multi-Stop Manifest ({manifest.stops.length} Stops)</Text>
        <Text style={styles.cardSubtitle}>Server-optimized route sequence preserving pickup before dropoff.</Text>
        {manifest.stops.map((stop,idx)=>(
         <View key={idx} style={styles.manifestStopCard}>
          <View style={styles.manifestStopBadge}><Text style={styles.manifestStopBadgeText}>STOP {idx+1}</Text></View>
          <View style={{flex:1}}>
           <Text style={styles.manifestStopType}>{stop.action==='pickup'?'📦 PICKUP PARCEL':'🏁 DELIVER TO RECIPIENT'}</Text>
           <Text style={styles.manifestStopAddress}>{stop.address||'Stop point'}</Text>
           <Text style={styles.manifestStopEta}>⏱️ Estimated Travel Time: {Math.ceil((stop.etaSeconds||300)/60)} min</Text>
          </View>
         </View>
        ))}
       </View>
      )}

      {/* New Incoming Offers */}
      <View style={styles.sectionCard}>
       <Text style={styles.cardTitle}>New Offers ({offers.length})</Text>
       {offers.length===0?<Text style={styles.noOffersText}>No pending delivery offers right now. Keep app open to receive nearest jobs.</Text>:offers.map(o=>(
        <View key={o.offerId} style={styles.offerItemCard}>
         <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}>
          <Text style={styles.offerRoadEta}>ETA {Math.ceil(o.pickupEtaSeconds/60)} min • {(o.pickupRoadMeters/1000).toFixed(1)} km</Text>
          <Text style={styles.offerEarningText}>+{ghc(o.entitlement_minor)}</Text>
         </View>
         <Text style={styles.offerAddress}>{o.pickup?.address||'Pickup'} → {o.destination?.address||'Dropoff'}</Text>
         <View style={{flexDirection:'row',gap:8,marginTop:12}}>
          <TouchableOpacity onPress={()=>execute(()=>acceptOffer(o))} style={[styles.primaryBtn,{flex:1}]}><Text style={styles.primaryBtnText}>Accept Offer</Text></TouchableOpacity>
          <TouchableOpacity onPress={()=>execute(async()=>{await call('POST','/api/v1/rider/offers/decline',{shipmentId:o.id,offerId:o.offerId});setOffers(v=>v.filter(x=>x.offerId!==o.offerId));})} style={styles.declineBtn}><Text style={styles.declineBtnText}>Decline</Text></TouchableOpacity>
         </View>
        </View>
       ))}
      </View>

      {/* Financials & Commission Balance */}
      <View style={styles.sectionCard}>
       <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
        <Text style={styles.cardTitle}>Earnings & Elesend Commission</Text>
        <TouchableOpacity onPress={()=>execute(async()=>setFinance(await call('GET','/api/v1/rider/finance')))} style={styles.refreshBadge}><Text style={styles.refreshBadgeText}>Refresh</Text></TouchableOpacity>
       </View>
       {finance?(
        <View>
         <View style={styles.financeStatGrid}>
          <View style={styles.financeStatBox}><Text style={styles.financeStatLabel}>CASH COLLECTED</Text><Text style={styles.financeStatValue}>{ghc(finance.cashReportedMinor)}</Text></View>
          <View style={styles.financeStatBox}><Text style={styles.financeStatLabel}>COMMISSION DUE</Text><Text style={[styles.financeStatValue,{color:colors.warn}]}>{ghc(finance.dueMinor)}</Text></View>
         </View>
         <Text style={styles.financeNote}>Settlement due in {finance.dueDays} days. Pay commission via Mobile Money to maintain active dispatch.</Text>
         <View style={{marginTop:12}}>
          <TextInput placeholder="Repayment amount GH₵ (e.g. 10.00)" placeholderTextColor={colors.textMuted} keyboardType="decimal-pad" style={styles.inputField} value={payAmount} onChangeText={setPayAmount}/>
          <TouchableOpacity onPress={()=>execute(async()=>{const result=await call('POST','/api/v1/rider/finance/settle',{kind:'commission_repayment',amountMinor:parseGhs(payAmount),idempotencyKey:Crypto.randomUUID(),...(paymentEmail?{email:paymentEmail.trim()}:{})});if(result.paymentInstructions?.checkoutUrl)await Linking.openURL(result.paymentInstructions.checkoutUrl);setError(`Repayment initiated: ${result.status}`);})} style={styles.primaryBtn}>
           <Text style={styles.primaryBtnText}>Pay Commission via MoMo</Text>
          </TouchableOpacity>
         </View>
        </View>
       ):<Text style={styles.noOffersText}>Tap Refresh to load your earnings ledger.</Text>}
      </View>

      {/* Company Fleet Affiliation */}
      <View style={styles.sectionCard}>
       <Text style={styles.cardTitle}>🏢 Logistics Company Affiliation</Text>
       <Text style={styles.cardSubtitle}>Join a registered commercial delivery fleet via invitation token.</Text>
       <TextInput placeholder="Enter 64-character invitation token" placeholderTextColor={colors.textMuted} style={styles.inputField} value={joinToken} onChangeText={setJoinToken}/>
       <TouchableOpacity onPress={()=>execute(async()=>{await call('POST','/api/v1/rider/invitations/accept',{token:joinToken.trim()});setJoinToken('');setError('Successfully affiliated with company fleet!');})} style={styles.secondaryBtn} disabled={joinToken.length!==64}>
        <Text style={styles.secondaryBtnText}>Accept Company Invitation</Text>
       </TouchableOpacity>
      </View>
     </View>
    )}

    {/* TAB 4: MERCHANT & RESTAURANT DASHBOARD */}
    {tab==='Business'&&isBusiness&&(
     <View style={styles.sectionCard}>
      <Text style={styles.cardTitle}>🏢 Merchant & Restaurant Operations</Text>
      <Text style={styles.cardSubtitle}>Manage company couriers, dispatch operations, and e-commerce integrations.</Text>

      {auth.kind==='company'&&(
       <View>
        <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
         <Text style={styles.cardTitle}>Connected Fleet Couriers ({fleet.length})</Text>
         <TouchableOpacity onPress={()=>execute(loadBusinessData)} style={styles.refreshBadge}><Text style={styles.refreshBadgeText}>Refresh</Text></TouchableOpacity>
        </View>
        {fleet.length===0?<Text style={styles.noOffersText}>No couriers currently in your fleet. Invite independent drivers below.</Text>:fleet.map(r=>(
         <View key={r.id} style={styles.algoRow}>
          <View>
           <Text style={styles.algoTitle}>Rider #{r.id.slice(0,8)} • {r.vehicle?.toUpperCase()}</Text>
           <Text style={{fontSize:11,color:r.online?colors.primary:colors.textMuted}}>{r.online?'● ONLINE':'○ OFFLINE'} • Max {r.max_weight_g/1000} kg</Text>
          </View>
          <TouchableOpacity onPress={()=>execute(async()=>{await call('POST',`/api/v1/company/riders/${r.id}/remove`);await loadBusinessData();setError(`Rider removed from company fleet.`);})} style={[styles.algoToggleBtn,{borderColor:colors.danger}]}>
           <Text style={{color:colors.danger,fontSize:11,fontWeight:'700'}}>Remove</Text>
          </TouchableOpacity>
         </View>
        ))}

        <Text style={[styles.cardTitle,{marginTop:20}]}>Invite Rider to Fleet</Text>
        <TextInput placeholder="Enter Rider UUID (36 chars)" placeholderTextColor={colors.textMuted} style={styles.inputField} value={inviteId} onChangeText={setInviteId}/>
        <TouchableOpacity onPress={()=>execute(async()=>{const res=await call('POST','/api/v1/company/invitations',{riderId:inviteId.trim()});setInviteToken(res.token);setError('Invitation created! Share the 64-char token with the rider.');})} style={styles.primaryBtn} disabled={inviteId.length<36}>
         <Text style={styles.primaryBtnText}>Generate Rider Invitation</Text>
        </TouchableOpacity>
        {inviteToken&&(
         <View style={styles.checkoutBox}>
          <Text style={styles.checkoutTitle}>Invitation Token (Valid 48h):</Text>
          <Text style={[styles.checkoutSubtitle,{color:colors.primary,fontFamily:Platform.OS==='ios'?'Courier':'monospace'}]}>{inviteToken}</Text>
         </View>
        )}
       </View>
      )}

      {auth.kind==='business'&&(
       <View>
        {/* Restaurant Profile & Operating Controls */}
        <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
         <View>
          <Text style={styles.cardTitle}>🍳 Restaurant & Kitchen Management</Text>
          <Text style={styles.cardSubtitle}>{businessRestaurant?`${businessRestaurant.name} • ${businessRestaurant.cuisine||'Kitchen'}`:'Setup your restaurant profile'}</Text>
         </View>
         <TouchableOpacity onPress={()=>execute(loadBusinessData)} style={styles.refreshBadge}>
          <Text style={styles.refreshBadgeText}>🔄 Refresh</Text>
         </TouchableOpacity>
        </View>

        {businessRestaurant?(
         <View style={{marginBottom:16}}>
          <View style={styles.financeStatGrid}>
           <View style={styles.financeStatBox}>
            <Text style={styles.financeStatLabel}>KITCHEN STATUS</Text>
            <Text style={[styles.financeStatValue,businessRestaurant.is_open&&!businessRestaurant.is_paused?{color:colors.primary}:{color:colors.danger}]}>
             {businessRestaurant.is_open&&!businessRestaurant.is_paused?'OPEN':'BUSY'}
            </Text>
           </View>
           <View style={styles.financeStatBox}>
            <Text style={styles.financeStatLabel}>DEFAULT PREP</Text>
            <Text style={styles.financeStatValue}>~{businessRestaurant.prep_time_minutes} min</Text>
           </View>
          </View>

          <View style={{flexDirection:'row',gap:8,marginTop:10}}>
           <TouchableOpacity onPress={()=>execute(async()=>{await call('POST',`/api/v1/restaurants/${businessRestaurant.id}`,{isOpen:!businessRestaurant.is_open});await loadBusinessData();})} style={[styles.algoToggleBtn,{borderColor:businessRestaurant.is_open?colors.danger:colors.primary,flex:1}]}>
            <Text style={{color:businessRestaurant.is_open?colors.danger:colors.primary,fontSize:12,fontWeight:'800',textAlign:'center'}}>
             {businessRestaurant.is_open?'🔴 Close Kitchen':'🟢 Open Kitchen'}
            </Text>
           </TouchableOpacity>
           <TouchableOpacity onPress={()=>execute(async()=>{await call('POST',`/api/v1/restaurants/${businessRestaurant.id}`,{isPaused:!businessRestaurant.is_paused});await loadBusinessData();})} style={[styles.algoToggleBtn,{borderColor:colors.warn,flex:1}]}>
            <Text style={{color:colors.warn,fontSize:12,fontWeight:'800',textAlign:'center'}}>
             {businessRestaurant.is_paused?'▶ Resume Orders':'⏸ Busy Mode'}
            </Text>
           </TouchableOpacity>
          </View>
         </View>
        ):(
         <View style={{marginBottom:16,padding:14,backgroundColor:colors.bg,borderRadius:12}}>
          <Text style={styles.cardSubtitle}>Register your restaurant to accept food delivery orders.</Text>
          <TextInput placeholder="Restaurant Name (e.g. Mama Osu Kitchen)" placeholderTextColor={colors.textMuted} style={styles.inputField} value={newRestName} onChangeText={setNewRestName}/>
          <TextInput placeholder="Address (e.g. 14 Oxford Street, Osu)" placeholderTextColor={colors.textMuted} style={styles.inputField} value={newRestAddress} onChangeText={setNewRestAddress}/>
          <TextInput placeholder="Cuisine (e.g. Ghanaian Jollof & Grills)" placeholderTextColor={colors.textMuted} style={styles.inputField} value={newRestCuisine} onChangeText={setNewRestCuisine}/>
          <TouchableOpacity onPress={()=>execute(async()=>{await call('POST','/api/v1/restaurants',{name:newRestName.trim(),phone:auth.phone,address:newRestAddress.trim(),latitude:5.5562,longitude:-0.1825,cuisine:newRestCuisine.trim(),prepTimeMinutes:25,deliveryRadiusM:12000});setNewRestName('');setNewRestAddress('');setNewRestCuisine('');await loadBusinessData();setError('Restaurant registered successfully!');})} style={styles.primaryBtn} disabled={!newRestName.trim()||!newRestAddress.trim()}>
           <Text style={styles.primaryBtnText}>Register Restaurant Profile</Text>
          </TouchableOpacity>
         </View>
        )}

        {/* Live Kitchen Orders Board */}
        <Text style={[styles.cardTitle,{fontSize:16,marginTop:8}]}>👨‍🍳 Live Kitchen Orders ({kitchenOrders.length})</Text>
        {kitchenOrders.length===0?<Text style={styles.noOffersText}>No pending food orders. Orders from customers will appear here in real time.</Text>:kitchenOrders.map(ko=>(
         <View key={ko.id} style={styles.orderCard}>
          <View style={styles.orderHeaderRow}>
           <Text style={styles.orderIdText}>Order #{ko.id.slice(0,8)}</Text>
           <View style={[styles.orderStateBadge,ko.state==='DELIVERED'&&{backgroundColor:colors.primary}]}>
            <Text style={styles.orderStateText}>{ko.state.replaceAll('_',' ')}</Text>
           </View>
          </View>
          <Text style={styles.orderDetailText}>📍 Deliver to: {ko.delivery_address}</Text>
          <Text style={styles.orderAmountText}>Food Subtotal: {ghc(ko.subtotal_minor)} • {ko.payment_method}</Text>
          {ko.special_instructions?<Text style={{color:colors.warn,fontSize:11,marginVertical:4}}>Note: "{ko.special_instructions}"</Text>:null}

          {/* Action buttons per order state */}
          {ko.state==='SUBMITTED'&&(
           <View style={{flexDirection:'row',gap:8,alignItems:'center',marginTop:10}}>
            <TextInput placeholder="Prep min" placeholderTextColor={colors.textMuted} keyboardType="number-pad" style={[styles.inputField,{width:80,marginBottom:0}]} value={orderPrepMinutes} onChangeText={setOrderPrepMinutes}/>
            <TouchableOpacity onPress={()=>execute(()=>acceptKitchenOrder(ko.id))} style={[styles.primaryBtn,{flex:1,marginTop:0}]}>
             <Text style={styles.primaryBtnText}>Accept Order & Start Timer</Text>
            </TouchableOpacity>
           </View>
          )}

          {ko.state==='ACCEPTED'&&(
           <TouchableOpacity onPress={()=>execute(()=>markKitchenPreparing(ko.id))} style={[styles.primaryBtn,{marginTop:8}]}>
            <Text style={styles.primaryBtnText}>Start Cooking (Mark Preparing)</Text>
           </TouchableOpacity>
          )}

          {ko.state==='PREPARING'&&(
           <TouchableOpacity onPress={()=>execute(()=>markKitchenReady(ko.id))} style={[styles.primaryBtn,{backgroundColor:colors.primaryDark,marginTop:8}]}>
            <Text style={[styles.primaryBtnText,{color:'#fff'}]}>Food Ready (Dispatch Rider Immediately)</Text>
           </TouchableOpacity>
          )}

          {ko.state==='READY_FOR_PICKUP'&&(
           <Text style={{color:colors.primary,fontSize:12,fontWeight:'700',marginTop:8}}>
            🛵 Rider dispatched. Verify pickup OTP upon courier handover.
           </Text>
          )}
         </View>
        ))}

        {/* Sales & Financial Settlements Ledger */}
        {businessSettlements&&(
         <View style={{marginTop:20}}>
          <Text style={[styles.cardTitle,{fontSize:16,marginBottom:8}]}>💰 Food Sales & Settlement Ledger</Text>
          <View style={styles.financeStatGrid}>
           <View style={styles.financeStatBox}>
            <Text style={styles.financeStatLabel}>GROSS FOOD SALES</Text>
            <Text style={styles.financeStatValue}>{ghc(businessSettlements.totals.grossSalesMinor)}</Text>
           </View>
           <View style={styles.financeStatBox}>
            <Text style={styles.financeStatLabel}>NET PAYABLE (90%)</Text>
            <Text style={[styles.financeStatValue,{color:colors.primary}]}>{ghc(businessSettlements.totals.netPayableMinor)}</Text>
           </View>
          </View>
          <Text style={styles.financeNote}>
           Platform fee: 10% ({ghc(businessSettlements.totals.commissionMinor)}). Settlements disbursed weekly to your registered Mobile Money number.
          </Text>
         </View>
        )}

        {/* API Credentials */}
        <Text style={[styles.cardTitle,{marginTop:24}]}>E-Commerce / Restaurant API Credentials</Text>
        <Text style={styles.cardSubtitle}>Generate scoped tokens (`es_live_*`) to automate checkout delivery quotes.</Text>
        <TextInput placeholder="Integration Name (e.g. Online Store Checkout)" placeholderTextColor={colors.textMuted} style={styles.inputField} value={newKeyName} onChangeText={setNewKeyName}/>
        <TouchableOpacity onPress={()=>execute(async()=>{const res=await call('POST','/api/v1/business/api-keys',{name:newKeyName.trim()||'Store',scopes:['quotes:write','shipments:write','shipments:read']});setNewKeyCreated(res);setError('New API key provisioned successfully.');})} style={styles.primaryBtn}>
         <Text style={styles.primaryBtnText}>Create Production API Key</Text>
        </TouchableOpacity>
        {newKeyCreated&&(
         <View style={styles.checkoutBox}>
          <Text style={styles.checkoutTitle}>Your Secret API Key (Store Securely):</Text>
          <Text style={[styles.checkoutSubtitle,{color:colors.primary,fontFamily:Platform.OS==='ios'?'Courier':'monospace',fontSize:11}]}>{newKeyCreated.key}</Text>
         </View>
        )}
       </View>
      )}
     </View>
    )}

    {/* TAB 5: PROFILE & PHONE VERIFICATION */}
    {tab==='Profile'&&(
     <View style={styles.sectionCard}>
      <Text style={styles.cardTitle}>My Profile</Text>
      <Text style={styles.cardSubtitle}>Manage account verification and settings.</Text>

      <View style={styles.profileInfoBox}>
       <Text style={styles.profilePhone}>{auth.phone}</Text>
       <Text style={styles.profileRole}>Role: {auth.kind.toUpperCase()}</Text>
      </View>

      {/* Phone verification */}
      <View style={styles.verificationCard}>
       <Text style={styles.sectionLabel}>Ghana Phone Ownership Verification</Text>
       <TouchableOpacity onPress={()=>execute(async()=>setPhoneStatus(await call('GET','/api/v1/me/phone')))} style={styles.secondaryBtn}>
        <Text style={styles.secondaryBtnText}>Check Verification Status</Text>
       </TouchableOpacity>
       {phoneStatus&&<Text style={[styles.phoneStatusText,phoneStatus.verified?{color:colors.primary}:{color:colors.warn}]}>{phoneStatus.phone} • {phoneStatus.verified?'VERIFIED (READY)':'UNVERIFIED'}</Text>}
       {!phoneStatus?.verified&&(
        <View style={{marginTop:8}}>
         <TouchableOpacity onPress={()=>execute(async()=>{setPhoneChallenge(await call('POST','/api/v1/me/phone-challenge',{}));setPhoneCode('');})} style={styles.actionBtn}>
          <Text style={styles.actionBtnText}>Send Verification SMS</Text>
         </TouchableOpacity>
         {phoneChallenge&&(
          <View style={{marginTop:8}}>
           <TextInput placeholder="Enter 6-digit SMS code" placeholderTextColor={colors.textMuted} keyboardType="number-pad" maxLength={6} style={styles.inputField} value={phoneCode} onChangeText={setPhoneCode}/>
           <TouchableOpacity onPress={()=>execute(async()=>{await call('POST','/api/v1/me/phone-verify',{challengeId:phoneChallenge.challengeId,code:phoneCode});setPhoneStatus(await call('GET','/api/v1/me/phone'));setPhoneChallenge(null);setPhoneCode('');})} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Confirm Phone Ownership</Text>
           </TouchableOpacity>
          </View>
         )}
        </View>
       )}
      </View>

      <TouchableOpacity onPress={()=>execute(logout)} style={styles.logoutBtn}>
       <Text style={styles.logoutBtnText}>Log Out</Text>
      </TouchableOpacity>
     </View>
    )}

    {/* TAB 6: PLATFORM ADMIN (STRICTLY RESTRICTED TO AUDITED OPERATORS) */}
    {tab==='Admin'&&isAdmin&&(
     <View style={styles.sectionCard}>
      <Text style={styles.cardTitle}>🛡️ Platform Operations & Tariffs</Text>
      <Text style={styles.cardSubtitle}>Internal operator controls for verified administrators.</Text>

      <View style={{marginBottom:16}}>
       <TouchableOpacity onPress={()=>Linking.openURL(`${BASE||'http://localhost:3090'}/admin`)} style={styles.primaryBtn}>
        <Text style={styles.primaryBtnText}>🖥️ Open Web Command Center</Text>
       </TouchableOpacity>
      </View>

      <TouchableOpacity onPress={()=>execute(async()=>setAlgorithmFeatures(await call('GET','/api/v1/admin/algorithm-features')))} style={styles.secondaryBtn}>
       <Text style={styles.secondaryBtnText}>Refresh Dispatch Algorithms</Text>
      </TouchableOpacity>
      {algorithmFeatures.map(f=>(
       <View key={f.feature_key} style={styles.algoRow}>
        <Text style={styles.algoTitle}>{f.feature_key.replaceAll('_',' ')} • {f.enabled?'ON':'OFF'}</Text>
        <TouchableOpacity onPress={()=>Alert.alert('Change dispatch feature?',`Switch ${f.feature_key}?`,[{text:'Cancel'},{text:'Confirm',onPress:()=>execute(async()=>{await call('POST','/api/v1/admin/algorithm-features',{featureKey:f.feature_key,enabled:!f.enabled});setAlgorithmFeatures(await call('GET','/api/v1/admin/algorithm-features'));})}])} style={[styles.algoToggleBtn,f.enabled&&styles.algoToggleBtnActive]}>
         <Text style={styles.algoToggleBtnText}>{f.enabled?'Disable':'Enable'}</Text>
        </TouchableOpacity>
       </View>
      ))}

      {/* Tariffs and take rate */}
      <Text style={[styles.cardTitle,{marginTop:20}]}>Tariffs & Commission Configuration</Text>
      <Text style={styles.cardSubtitle}>Elesend administrator delivery pricing & dynamic commission engine (0% to 100%, Default 13%).</Text>
      <TouchableOpacity onPress={()=>execute(async()=>setAdminPricing(await call('GET','/api/v1/admin/pricing')))} style={styles.secondaryBtn}>
       <Text style={styles.secondaryBtnText}>Load Platform Pricing Tariffs</Text>
      </TouchableOpacity>
      {adminPricing.map(p=>(
       <View key={p.id} style={styles.priceRow}>
        <Text style={styles.priceRowText}>{(p.vehicle||'GENERAL').toUpperCase()}: {(p.commission_bps/100).toFixed(1)}% ({p.commission_mode}) • Base: {ghc(p.base_minor)} • Per-km: {ghc(p.per_km_minor)}</Text>
       </View>
      ))}
      <TextInput placeholder="Commission % (0.0 - 100.0, e.g. 13.0)" placeholderTextColor={colors.textMuted} keyboardType="decimal-pad" style={styles.inputField} value={commPercent} onChangeText={setCommPercent}/>
      <TextInput placeholder="Mode (percentage / fixed / hybrid)" placeholderTextColor={colors.textMuted} style={styles.inputField} value={commMode} onChangeText={setCommMode}/>
      <TextInput placeholder="Commission cap GH₵ (optional)" placeholderTextColor={colors.textMuted} keyboardType="decimal-pad" style={styles.inputField} value={commCapGhs} onChangeText={setCommCapGhs}/>
      <View style={{flexDirection:'row',gap:6,marginVertical:8}}>
       {['all','motorcycle','car','van'].map(v=>(
        <TouchableOpacity key={v} onPress={()=>setCommVehicle(v)} style={[styles.vehiclePill,commVehicle===v&&styles.vehiclePillActive]}>
         <Text style={styles.vehiclePillText}>{v.toUpperCase()}</Text>
        </TouchableOpacity>
       ))}
      </View>
      <TouchableOpacity onPress={()=>Alert.alert('Apply Commission Policy?',`Set ${commVehicle.toUpperCase()} commission to ${commPercent}%?`,[{text:'Cancel'},{text:'Confirm',onPress:()=>execute(async()=>{
       const bps=Math.round(parseFloat(commPercent)*100);
       const capMinor=commCapGhs?parseGhs(commCapGhs):null;
       await call('POST','/api/v1/admin/pricing/commission',{vehicle:commVehicle==='all'?null:commVehicle,commissionBps:bps,commissionMode:commMode||'percentage',commissionCapMinor:capMinor});
       setAdminPricing(await call('GET','/api/v1/admin/pricing'));
       Alert.alert('Updated',`Commission set to ${commPercent}%`);
      })}])} style={styles.primaryBtn}>
       <Text style={styles.primaryBtnText}>Save Commission Policy</Text>
      </TouchableOpacity>
     </View>
    )}

   </ScrollView>

   {/* Modern Bottom Navigation Bar (Bolt / Yango Style) */}
   <View style={styles.bottomNav}>
    <TouchableOpacity onPress={()=>{setTab('Send');setStep(0);}} style={[styles.navTabBtn,tab==='Send'&&styles.navTabBtnActive]}>
     <Text style={styles.navTabIcon}>📦</Text>
     <Text style={[styles.navTabText,tab==='Send'&&styles.navTabTextActive]}>Send</Text>
    </TouchableOpacity>

    <TouchableOpacity onPress={()=>{setTab('Food');execute(loadFoodData);}} style={[styles.navTabBtn,tab==='Food'&&styles.navTabBtnActive]}>
     <Text style={styles.navTabIcon}>🍔</Text>
     <Text style={[styles.navTabText,tab==='Food'&&styles.navTabTextActive]}>Food</Text>
    </TouchableOpacity>

    <TouchableOpacity onPress={()=>{setTab('Activity');execute(async()=>{await refreshJobs();await loadFoodData();});}} style={[styles.navTabBtn,tab==='Activity'&&styles.navTabBtnActive]}>
     <Text style={styles.navTabIcon}>📋</Text>
     <Text style={[styles.navTabText,tab==='Activity'&&styles.navTabTextActive]}>Orders</Text>
    </TouchableOpacity>

    {isRider&&(
     <TouchableOpacity onPress={()=>setTab('Driver')} style={[styles.navTabBtn,tab==='Driver'&&styles.navTabBtnActive]}>
      <Text style={styles.navTabIcon}>🛵</Text>
      <Text style={[styles.navTabText,tab==='Driver'&&styles.navTabTextActive]}>Driver</Text>
     </TouchableOpacity>
    )}

    {isBusiness&&(
     <TouchableOpacity onPress={()=>{setTab('Business');execute(loadBusinessData);}} style={[styles.navTabBtn,tab==='Business'&&styles.navTabBtnActive]}>
      <Text style={styles.navTabIcon}>🏢</Text>
      <Text style={[styles.navTabText,tab==='Business'&&styles.navTabTextActive]}>Business</Text>
     </TouchableOpacity>
    )}

    {isAdmin&&(
     <TouchableOpacity onPress={()=>setTab('Admin')} style={[styles.navTabBtn,tab==='Admin'&&styles.navTabBtnActive]}>
      <Text style={styles.navTabIcon}>🛡️</Text>
      <Text style={[styles.navTabText,tab==='Admin'&&styles.navTabTextActive]}>Admin</Text>
     </TouchableOpacity>
    )}

    <TouchableOpacity onPress={()=>setTab('Profile')} style={[styles.navTabBtn,tab==='Profile'&&styles.navTabBtnActive]}>
     <Text style={styles.navTabIcon}>👤</Text>
     <Text style={[styles.navTabText,tab==='Profile'&&styles.navTabTextActive]}>Profile</Text>
    </TouchableOpacity>
   </View>
  </View>
 );
}

const styles=StyleSheet.create({
 screen:{flex:1,backgroundColor:colors.bg},
 center:{justifyContent:'center',alignItems:'center'},
 authScroll:{padding:24,paddingTop:50,paddingBottom:40},
 authHeader:{marginBottom:24},
 brandRow:{flexDirection:'row',alignItems:'center',gap:12,marginBottom:12},
 brandLogoBox:{width:44,height:44,borderRadius:12,backgroundColor:colors.primary,alignItems:'center',justifyContent:'center'},
 brandLogoText:{fontSize:22,fontWeight:'900',color:'#071B28'},
 brandTitle:{color:colors.text,fontSize:26,fontWeight:'900',letterSpacing:1},
 brandTagline:{color:colors.primary,fontSize:11,fontWeight:'800',letterSpacing:1.5},
 brandSubtitle:{color:colors.textMuted,fontSize:14,lineHeight:20,marginTop:6},
 authCard:{backgroundColor:colors.surface,borderRadius:24,borderColor:colors.cardBorder,borderWidth:1,padding:22,shadowColor:'#000',shadowOpacity:0.4,shadowRadius:12,elevation:8},
 authFormTitle:{color:colors.text,fontSize:20,fontWeight:'800',marginBottom:4},
 authFormSubtitle:{color:colors.textMuted,fontSize:13,marginBottom:20},
 signupTypeWrapper:{marginBottom:20},
 sectionLabel:{color:colors.textMuted,fontSize:12,fontWeight:'700',textTransform:'uppercase',letterSpacing:0.5,marginBottom:8},
 segmentContainer:{flexDirection:'row',backgroundColor:colors.bg,borderRadius:12,padding:4,gap:6},
 segmentBtn:{flex:1,paddingVertical:12,alignItems:'center',borderRadius:8},
 segmentBtnActive:{backgroundColor:colors.primary},
 segmentText:{color:colors.textMuted,fontSize:13,fontWeight:'700'},
 segmentTextActive:{color:'#071B28'},
 inputGroup:{marginBottom:16},
 inputLabel:{color:colors.textMuted,fontSize:12,fontWeight:'700',textTransform:'uppercase',letterSpacing:0.5,marginBottom:6},
 phoneInputRow:{flexDirection:'row',gap:8},
 countryCodeBadge:{flexDirection:'row',alignItems:'center',gap:6,backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,borderRadius:10,paddingHorizontal:12},
 flag:{fontSize:18},
 countryCode:{color:colors.text,fontWeight:'700',fontSize:14},
 phoneInputField:{flex:1,backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,borderRadius:10,paddingHorizontal:14,paddingVertical:12,color:colors.text,fontSize:15},
 inputField:{backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,borderRadius:10,paddingHorizontal:14,paddingVertical:12,color:colors.text,fontSize:15,marginBottom:10},
 totpPromptBox:{backgroundColor:colors.bg,borderColor:colors.primary,borderWidth:1,borderRadius:12,padding:14,marginBottom:16},
 totpPromptTitle:{color:colors.primary,fontSize:14,fontWeight:'800',marginBottom:4},
 totpPromptSubtitle:{color:colors.textMuted,fontSize:12,marginBottom:10},
 driverSignupBox:{marginVertical:12,padding:14,backgroundColor:colors.bg,borderRadius:14,borderColor:colors.cardBorder,borderWidth:1},
 vehiclePillRow:{flexDirection:'row',gap:8},
 vehicleChoiceCard:{flex:1,backgroundColor:colors.surface,borderColor:colors.cardBorder,borderWidth:1,borderRadius:10,padding:10,alignItems:'center'},
 vehicleChoiceCardActive:{borderColor:colors.primary,backgroundColor:'rgba(24,198,165,0.12)'},
 vehicleChoiceLabel:{fontSize:13,fontWeight:'700',color:colors.text,marginBottom:2},
 vehicleChoiceCap:{fontSize:11,color:colors.primary,fontWeight:'700'},
 vehicleChoiceSub:{fontSize:10,color:colors.textMuted,marginTop:2},
 primaryBtn:{backgroundColor:colors.primary,paddingVertical:14,paddingHorizontal:20,borderRadius:12,alignItems:'center',justifyContent:'center',marginTop:8},
 primaryBtnText:{color:'#071B28',fontSize:15,fontWeight:'800'},
 secondaryLink:{marginTop:16,alignItems:'center',paddingVertical:6},
 secondaryLinkText:{color:colors.primary,fontSize:14,fontWeight:'700'},
 trustBadgesRow:{flexDirection:'row',justifyContent:'center',gap:8,marginTop:24,flexWrap:'wrap'},
 trustBadge:{backgroundColor:'rgba(24,198,165,0.08)',borderColor:colors.cardBorder,borderWidth:1,paddingHorizontal:10,paddingVertical:6,borderRadius:8},
 trustBadgeText:{color:colors.textMuted,fontSize:11,fontWeight:'600'},
 
 // App Header
 appHeader:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingHorizontal:20,paddingTop:48,paddingBottom:14,backgroundColor:colors.surface,borderBottomWidth:1,borderBottomColor:colors.cardBorder},
 appHeaderLeft:{flexDirection:'row',alignItems:'center',gap:10},
 appHeaderBadge:{width:32,height:32,borderRadius:8,backgroundColor:colors.primary,alignItems:'center',justifyContent:'center'},
 appHeaderBadgeText:{fontWeight:'900',fontSize:16,color:'#071B28'},
 appBrand:{color:colors.text,fontSize:18,fontWeight:'900',letterSpacing:0.5},
 appUserBadge:{color:colors.primary,fontSize:11,fontWeight:'700'},
 headerLogoutBtn:{backgroundColor:colors.card,borderColor:colors.cardBorder,borderWidth:1,paddingHorizontal:12,paddingVertical:6,borderRadius:8},
 headerLogoutText:{color:colors.textMuted,fontSize:12,fontWeight:'700'},
 errorBanner:{backgroundColor:'rgba(217,45,64,0.15)',borderColor:colors.danger,borderWidth:1,padding:12,margin:16,borderRadius:10},
 errorText:{color:'#FF8B97',fontSize:13,fontWeight:'600'},
 
 // Main Scroll
 mainScroll:{padding:16,paddingBottom:90},
 roleBanner:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',backgroundColor:colors.surface,borderColor:colors.cardBorder,borderWidth:1,borderRadius:12,padding:12,marginBottom:16},
 roleBannerText:{color:colors.text,fontSize:12,fontWeight:'600'},
 roleBannerBtn:{backgroundColor:colors.primary,paddingHorizontal:10,paddingVertical:6,borderRadius:8},
 roleBannerBtnText:{color:'#071B28',fontSize:11,fontWeight:'800'},
 stepIndicatorRow:{flexDirection:'row',gap:6,marginBottom:16},
 stepPill:{flex:1,backgroundColor:colors.surface,borderColor:colors.cardBorder,borderWidth:1,paddingVertical:8,alignItems:'center',borderRadius:8},
 stepPillActive:{borderColor:colors.primary,backgroundColor:'rgba(24,198,165,0.15)'},
 stepPillComplete:{borderColor:colors.cardBorder,backgroundColor:colors.card},
 stepPillText:{color:colors.textMuted,fontSize:11,fontWeight:'700'},
 stepPillTextActive:{color:colors.primary},
 
 // Section Cards
 sectionCard:{backgroundColor:colors.surface,borderColor:colors.cardBorder,borderWidth:1,borderRadius:16,padding:16,marginBottom:16},
 cardTitle:{color:colors.text,fontSize:17,fontWeight:'800',marginBottom:4},
 cardSubtitle:{color:colors.textMuted,fontSize:13,lineHeight:18,marginBottom:16},
 searchRow:{flexDirection:'row',gap:8,marginBottom:10},
 searchBtn:{backgroundColor:colors.primary,paddingHorizontal:14,justifyContent:'center',borderRadius:10,height:48},
 searchBtnText:{color:'#071B28',fontWeight:'800',fontSize:13},
 placesDropdown:{backgroundColor:colors.card,borderColor:colors.cardBorder,borderWidth:1,borderRadius:10,marginBottom:12,overflow:'hidden'},
 placeItem:{padding:12,borderBottomWidth:1,borderBottomColor:colors.line},
 placeName:{color:colors.text,fontSize:14,fontWeight:'700'},
 placeLabel:{color:colors.textMuted,fontSize:11,marginTop:2},
 chipsRow:{flexDirection:'row',flexWrap:'wrap',gap:6,marginBottom:14},
 quickChip:{backgroundColor:colors.card,borderColor:colors.cardBorder,borderWidth:1,borderRadius:8,paddingHorizontal:10,paddingVertical:6},
 quickChipText:{color:colors.textMuted,fontSize:11,fontWeight:'600'},
 ghanaPostBox:{backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,borderRadius:12,padding:12,marginBottom:14},
 ghanaPostLabel:{color:colors.primary,fontSize:11,fontWeight:'700',textTransform:'uppercase',marginBottom:6},
 ghanaPostBtn:{backgroundColor:colors.card,borderColor:colors.cardBorder,borderWidth:1,justifyContent:'center',paddingHorizontal:14,borderRadius:10,height:48},
 ghanaPostBtnText:{color:colors.primary,fontWeight:'800',fontSize:12},
 mapContainer:{height:240,borderRadius:14,overflow:'hidden',marginBottom:14,borderWidth:1,borderColor:colors.cardBorder},
 map:{flex:1},
 locationSummaryBox:{backgroundColor:colors.bg,borderRadius:12,borderColor:colors.cardBorder,borderWidth:1,padding:12,marginBottom:14},
 locationItem:{flexDirection:'row',alignItems:'flex-start',gap:10},
 locDot:{width:12,height:12,borderRadius:6,marginTop:3},
 locItemTitle:{color:colors.textMuted,fontSize:10,fontWeight:'800',letterSpacing:0.5},
 locItemValue:{color:colors.text,fontSize:13,fontWeight:'600',marginTop:2},
 locDivider:{height:1,backgroundColor:colors.line,marginVertical:8,marginLeft:22},
 buttonRow:{flexDirection:'row',gap:10,marginTop:8},
 resetBtn:{backgroundColor:colors.card,borderColor:colors.cardBorder,borderWidth:1,paddingHorizontal:16,justifyContent:'center',borderRadius:12,height:50},
 resetBtnText:{color:colors.textMuted,fontWeight:'700',fontSize:13},
 backBtn:{backgroundColor:colors.card,borderColor:colors.cardBorder,borderWidth:1,paddingHorizontal:16,justifyContent:'center',borderRadius:12,height:50},
 backBtnText:{color:colors.textMuted,fontWeight:'700',fontSize:13},
 
 // Vehicle Selection
 vehicleGrid:{gap:10,marginBottom:16},
 vehicleSelectCard:{flexDirection:'row',alignItems:'center',gap:12,backgroundColor:colors.card,borderColor:colors.cardBorder,borderWidth:1,borderRadius:14,padding:14},
 vehicleSelectCardActive:{borderColor:colors.primary,backgroundColor:'rgba(24,198,165,0.1)'},
 vehicleSelectIcon:{fontSize:28},
 vehicleSelectTitle:{color:colors.text,fontSize:15,fontWeight:'800'},
 tagBadge:{backgroundColor:'rgba(24,198,165,0.15)',borderColor:colors.primary,borderWidth:1,paddingHorizontal:6,paddingVertical:2,borderRadius:4},
 tagBadgeText:{color:colors.primary,fontSize:9,fontWeight:'800'},
 vehicleSelectDesc:{color:colors.textMuted,fontSize:12,marginTop:2},
 vehicleSelectTime:{color:colors.accent,fontSize:11,fontWeight:'700',marginTop:4},
 radioCircle:{width:20,height:20,borderRadius:10,borderWidth:2,borderColor:colors.cardBorder,alignItems:'center',justifyContent:'center'},
 radioCircleActive:{borderColor:colors.primary},
 radioInner:{width:10,height:10,borderRadius:5,backgroundColor:colors.primary},
 sizePillRow:{flexDirection:'row',gap:8,marginBottom:12},
 sizePill:{flex:1,backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,borderRadius:8,paddingVertical:10,alignItems:'center'},
 sizePillActive:{borderColor:colors.primary,backgroundColor:'rgba(24,198,165,0.15)'},
 sizePillText:{color:colors.textMuted,fontSize:11,fontWeight:'700'},
 sizePillTextActive:{color:colors.primary},
 
 // Payment Methods
 paymentMethodRow:{flexDirection:'row',gap:8,marginBottom:14},
 paymentMethodCard:{flex:1,backgroundColor:colors.card,borderColor:colors.cardBorder,borderWidth:1,borderRadius:10,paddingVertical:12,alignItems:'center'},
 paymentMethodCardActive:{borderColor:colors.primary,backgroundColor:'rgba(24,198,165,0.15)'},
 paymentMethodIcon:{fontSize:20,marginBottom:4},
 paymentMethodText:{color:colors.textMuted,fontSize:11,fontWeight:'700'},
 paymentMethodTextActive:{color:colors.primary},
 cashPayerBox:{backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,borderRadius:12,padding:12,marginBottom:14},
 cashPayerLabel:{color:colors.textMuted,fontSize:12,fontWeight:'700'},
 cashPayerBtn:{flex:1,backgroundColor:colors.card,borderColor:colors.cardBorder,borderWidth:1,padding:10,borderRadius:8,alignItems:'center'},
 cashPayerBtnActive:{borderColor:colors.primary,backgroundColor:'rgba(24,198,165,0.15)'},
 cashPayerBtnText:{color:colors.textMuted,fontSize:11,fontWeight:'600'},
 cashPayerBtnTextActive:{color:colors.primary},
 digitalPayBox:{backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,borderRadius:12,padding:12,marginBottom:14},
 digitalPayNote:{color:colors.textMuted,fontSize:12,lineHeight:16,marginBottom:8},
 calculateFareBtn:{backgroundColor:colors.card,borderColor:colors.primary,borderWidth:1,borderRadius:12,paddingVertical:14,alignItems:'center',marginBottom:14},
 calculateFareBtnText:{color:colors.primary,fontSize:14,fontWeight:'800'},
 
 // Quoted Fare Card
 quotedFareCard:{backgroundColor:colors.card,borderColor:colors.primary,borderWidth:1,borderRadius:14,padding:16,marginBottom:14},
 quotePriceHeader:{flexDirection:'row',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12},
 quotedAmountLabel:{color:colors.textMuted,fontSize:10,fontWeight:'800',letterSpacing:0.5},
 quotedAmountValue:{color:colors.text,fontSize:26,fontWeight:'900'},
 savingsPill:{backgroundColor:'rgba(24,198,165,0.15)',borderColor:colors.primary,borderWidth:1,paddingHorizontal:8,paddingVertical:4,borderRadius:6},
 savingsPillText:{color:colors.primary,fontSize:11,fontWeight:'800'},
 quoteDetailsRow:{flexDirection:'row',justifyContent:'space-between',paddingTop:10,borderTopWidth:1,borderTopColor:colors.line,marginBottom:14},
 quoteDetailText:{color:colors.textMuted,fontSize:12,fontWeight:'600'},
 bookFinalBtn:{backgroundColor:colors.primary,paddingVertical:14,borderRadius:12,alignItems:'center'},
 bookFinalBtnText:{color:'#071B28',fontSize:15,fontWeight:'800'},
 
 // Orders Activity
 refreshBadge:{backgroundColor:colors.card,borderColor:colors.cardBorder,borderWidth:1,paddingHorizontal:10,paddingVertical:4,borderRadius:6},
 refreshBadgeText:{color:colors.primary,fontSize:12,fontWeight:'700'},
 offlineNote:{color:colors.warn,fontSize:12,marginBottom:10},
 checkoutBox:{backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,borderRadius:12,padding:14,marginBottom:14},
 checkoutTitle:{color:colors.text,fontSize:15,fontWeight:'800'},
 checkoutSubtitle:{color:colors.textMuted,fontSize:12,marginTop:2},
 openCheckoutBtn:{backgroundColor:colors.primary,paddingVertical:12,borderRadius:8,alignItems:'center',marginTop:10},
 openCheckoutBtnText:{color:'#071B28',fontSize:13,fontWeight:'800'},
 emptyBox:{alignItems:'center',paddingVertical:40},
 emptyIcon:{fontSize:36,marginBottom:10},
 emptyText:{color:colors.textMuted,fontSize:13,textAlign:'center'},
 orderCard:{backgroundColor:colors.card,borderColor:colors.cardBorder,borderWidth:1,borderRadius:12,padding:14,marginBottom:10},
 orderHeaderRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:4},
 orderIdText:{color:colors.text,fontSize:14,fontWeight:'800'},
 orderStateBadge:{backgroundColor:colors.surface,borderColor:colors.cardBorder,borderWidth:1,paddingHorizontal:8,paddingVertical:3,borderRadius:6},
 orderStateText:{color:colors.text,fontSize:11,fontWeight:'700'},
 orderPriceText:{color:colors.textMuted,fontSize:13,marginTop:2},
 riderActionGroup:{marginTop:10,gap:8},
 actionBtn:{backgroundColor:colors.primary,paddingVertical:10,borderRadius:8,alignItems:'center'},
 actionBtnText:{color:'#071B28',fontSize:12,fontWeight:'800'},
 navBtn:{backgroundColor:colors.surface,borderColor:colors.cardBorder,borderWidth:1,paddingVertical:10,borderRadius:8,alignItems:'center'},
 navBtnText:{color:colors.info,fontSize:12,fontWeight:'700'},
 shareBtn:{flex:1,backgroundColor:colors.surface,borderColor:colors.cardBorder,borderWidth:1,paddingVertical:8,borderRadius:8,alignItems:'center'},
 shareBtnText:{color:colors.primary,fontSize:12,fontWeight:'700'},
 viewMapBtn:{flex:1,backgroundColor:colors.surface,borderColor:colors.cardBorder,borderWidth:1,paddingVertical:8,borderRadius:8,alignItems:'center'},
 viewMapBtnText:{color:colors.text,fontSize:12,fontWeight:'700'},
 cancelBtn:{backgroundColor:colors.surface,borderColor:colors.danger,borderWidth:1,paddingVertical:8,borderRadius:8,alignItems:'center',marginTop:4},
 cancelBtnText:{color:colors.danger,fontSize:12,fontWeight:'700'},
 disputeLink:{alignItems:'center',paddingVertical:6,marginTop:4},
 disputeLinkText:{color:colors.textMuted,fontSize:11,textDecorationLine:'underline'},
 otpModal:{backgroundColor:colors.bg,borderColor:colors.primary,borderWidth:1,borderRadius:14,padding:16,marginTop:16},
 otpModalTitle:{color:colors.primary,fontSize:16,fontWeight:'800',marginBottom:4},
 otpModalDesc:{color:colors.textMuted,fontSize:13,marginBottom:12},
 
 // Driver Mode
 driverStatusCard:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',backgroundColor:colors.surface,borderColor:colors.cardBorder,borderWidth:1,borderRadius:16,padding:16,marginBottom:16},
 driverStatusCardOnline:{borderColor:colors.primary,backgroundColor:'rgba(24,198,165,0.08)'},
 pulseCircle:{width:12,height:12,borderRadius:6,backgroundColor:colors.textMuted},
 pulseCircleOnline:{backgroundColor:colors.primary},
 driverStatusTitle:{color:colors.text,fontSize:15,fontWeight:'900'},
 driverStatusSubtitle:{color:colors.textMuted,fontSize:11,marginTop:2},
 toggleOnlineBtn:{backgroundColor:colors.card,borderColor:colors.cardBorder,borderWidth:1,paddingHorizontal:16,paddingVertical:10,borderRadius:10},
 toggleOnlineBtnActive:{backgroundColor:colors.danger,borderColor:colors.danger},
 toggleOnlineBtnText:{color:colors.text,fontSize:13,fontWeight:'800'},
 noOffersText:{color:colors.textMuted,fontSize:13,fontStyle:'italic',paddingVertical:8},
 manifestStopCard:{flexDirection:'row',alignItems:'flex-start',gap:12,backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,borderRadius:10,padding:12,marginBottom:8},
 manifestStopBadge:{backgroundColor:colors.surface,borderColor:colors.primary,borderWidth:1,paddingHorizontal:8,paddingVertical:4,borderRadius:6},
 manifestStopBadgeText:{color:colors.primary,fontWeight:'900',fontSize:10},
 manifestStopType:{color:colors.text,fontWeight:'800',fontSize:13},
 manifestStopAddress:{color:colors.textMuted,fontSize:12,marginTop:2},
 manifestStopEta:{color:colors.accent,fontSize:11,fontWeight:'700',marginTop:4},
 offerItemCard:{backgroundColor:colors.card,borderColor:colors.cardBorder,borderWidth:1,borderRadius:12,padding:14,marginBottom:10},
 offerRoadEta:{color:colors.primary,fontSize:12,fontWeight:'700'},
 offerEarningText:{color:colors.text,fontSize:16,fontWeight:'900'},
 offerAddress:{color:colors.textMuted,fontSize:13,marginTop:4},
 declineBtn:{backgroundColor:colors.surface,borderColor:colors.danger,borderWidth:1,paddingHorizontal:14,justifyContent:'center',borderRadius:12},
 declineBtnText:{color:colors.danger,fontWeight:'700',fontSize:13},
 financeStatGrid:{flexDirection:'row',gap:10,marginBottom:10},
 financeStatBox:{flex:1,backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,borderRadius:10,padding:12},
 financeStatLabel:{color:colors.textMuted,fontSize:10,fontWeight:'700'},
 financeStatValue:{color:colors.text,fontSize:18,fontWeight:'900',marginTop:4},
 financeNote:{color:colors.textMuted,fontSize:12,lineHeight:16},
 
 // Profile
 profileInfoBox:{backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,borderRadius:12,padding:14,marginBottom:14},
 profilePhone:{color:colors.text,fontSize:16,fontWeight:'800'},
 profileRole:{color:colors.primary,fontSize:12,fontWeight:'700',marginTop:2},
 verificationCard:{backgroundColor:colors.card,borderColor:colors.cardBorder,borderWidth:1,borderRadius:12,padding:14,marginBottom:14},
 secondaryBtn:{backgroundColor:colors.surface,borderColor:colors.cardBorder,borderWidth:1,paddingVertical:10,borderRadius:8,alignItems:'center',marginBottom:8},
 secondaryBtnText:{color:colors.primary,fontSize:13,fontWeight:'700'},
 phoneStatusText:{fontSize:12,fontWeight:'700',marginTop:4},
 logoutBtn:{backgroundColor:colors.card,borderColor:colors.danger,borderWidth:1,paddingVertical:12,borderRadius:10,alignItems:'center',marginTop:10},
 logoutBtnText:{color:colors.danger,fontSize:14,fontWeight:'800'},
 
 // Admin View
 algoRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,borderRadius:8,padding:10,marginBottom:8},
 algoTitle:{color:colors.text,fontSize:12,fontWeight:'700'},
 algoToggleBtn:{backgroundColor:colors.surface,borderColor:colors.cardBorder,borderWidth:1,paddingHorizontal:10,paddingVertical:6,borderRadius:6},
 algoToggleBtnActive:{backgroundColor:'rgba(24,198,165,0.15)',borderColor:colors.primary},
 algoToggleBtnText:{color:colors.text,fontSize:11,fontWeight:'700'},
 priceRow:{backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,borderRadius:8,padding:10,marginBottom:8},
 priceRowText:{color:colors.text,fontSize:12},
 vehiclePill:{flex:1,backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,paddingVertical:8,alignItems:'center',borderRadius:6},
 vehiclePillActive:{borderColor:colors.primary,backgroundColor:'rgba(24,198,165,0.15)'},
 vehiclePillText:{color:colors.textMuted,fontSize:10,fontWeight:'700'},
 
 // Food Marketplace Styles
 restaurantCard:{backgroundColor:colors.card,borderColor:colors.cardBorder,borderWidth:1,borderRadius:14,padding:14,marginBottom:12},
 restHeaderRow:{flexDirection:'row',justifyContent:'space-between'},
 restName:{color:colors.text,fontSize:16,fontWeight:'800'},
 restCuisine:{color:colors.primary,fontSize:12,fontWeight:'600',marginTop:2},
 restAddress:{color:colors.textMuted,fontSize:11,marginTop:2},
 restStatusPill:{paddingHorizontal:8,paddingVertical:3,borderRadius:6,alignSelf:'flex-end'},
 restStatusText:{fontSize:10,fontWeight:'900'},
 restPrepTime:{color:colors.textMuted,fontSize:11,marginTop:4},
 restFooterRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginTop:10,borderTopWidth:1,borderTopColor:colors.cardBorder,paddingTop:8},
 restDistance:{color:colors.textMuted,fontSize:11},
 viewMenuText:{color:colors.primary,fontSize:12,fontWeight:'800'},
 backBtnInline:{paddingVertical:6},
 restPrepNotice:{color:colors.warn,fontSize:11,fontWeight:'600',marginVertical:4},
 menuCategoryTitle:{color:colors.text,fontSize:15,fontWeight:'800',marginBottom:8,letterSpacing:0.5},
 dishCard:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,borderRadius:12,padding:12,marginBottom:8},
 dishTitle:{color:colors.text,fontSize:14,fontWeight:'800'},
 dishDesc:{color:colors.textMuted,fontSize:12,marginTop:2},
 dishPrice:{color:colors.primary,fontSize:14,fontWeight:'900'},
 dishPrepBadge:{color:colors.textMuted,fontSize:11},
 addDishBtn:{backgroundColor:colors.surface,borderColor:colors.primary,borderWidth:1,paddingHorizontal:12,paddingVertical:8,borderRadius:8},
 addDishBtnText:{color:colors.primary,fontSize:12,fontWeight:'800'},
 floatingCartBar:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',backgroundColor:colors.surface,borderColor:colors.primary,borderWidth:1,borderRadius:14,padding:14,marginVertical:12},
 floatingCartCount:{color:colors.textMuted,fontSize:11,fontWeight:'700'},
 floatingCartTotal:{color:colors.text,fontSize:16,fontWeight:'900'},
 floatingCartActionBtn:{backgroundColor:colors.primary,paddingHorizontal:14,paddingVertical:10,borderRadius:10},
 floatingCartActionText:{color:'#071B28',fontSize:13,fontWeight:'800'},
 modalOverlay:{marginVertical:12,backgroundColor:colors.surface,borderColor:colors.cardBorder,borderWidth:1,borderRadius:16,padding:16},
 modalContentCard:{},
 modalTitle:{color:colors.text,fontSize:18,fontWeight:'900',marginBottom:4},
 modBox:{backgroundColor:colors.bg,borderColor:colors.cardBorder,borderWidth:1,borderRadius:10,padding:10,marginTop:10},
 modRequiredBadge:{backgroundColor:colors.danger,color:'#fff',fontSize:9,fontWeight:'800',paddingHorizontal:6,paddingVertical:2,borderRadius:4},
 modOptionRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingVertical:8,borderBottomWidth:1,borderBottomColor:colors.cardBorder},
 modOptionRowActive:{backgroundColor:'rgba(24,198,165,0.08)'},
 modOptionText:{color:colors.text,fontSize:13},
 modOptionPrice:{color:colors.textMuted,fontSize:12,fontWeight:'700'},
 cartSummaryRow:{flexDirection:'row',justifyContent:'space-between',paddingVertical:4},
 cartItemText:{color:colors.text,fontSize:13},
 cartItemPrice:{color:colors.primary,fontSize:13,fontWeight:'800'},

 // Bottom Nav
 bottomNav:{flexDirection:'row',backgroundColor:colors.surface,borderTopWidth:1,borderTopColor:colors.cardBorder,paddingVertical:10,paddingBottom:22,justifyContent:'space-around'},
 navTabBtn:{alignItems:'center',paddingHorizontal:14},
 navTabBtnActive:{},
 navTabIcon:{fontSize:18,marginBottom:2},
 navTabText:{color:colors.textMuted,fontSize:11,fontWeight:'600'},
 navTabTextActive:{color:colors.primary,fontWeight:'800'}
});
