import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import {call,loadToken} from './api.js';

export const TASK='elesend-verified-rider-gps';
export const OFFER_ALERT_CHANNEL='elesend-rider-offers';

const offerAlertListeners=new Set();
const notifiedOfferIds=new Set();

try{
 if(Notifications&&typeof Notifications.setNotificationHandler==='function'){
  Notifications.setNotificationHandler({
   handleNotification:async ()=>({
    shouldShowAlert:true,
    shouldPlaySound:true,
    shouldSetBadge:true
   })
  });
 }
}catch{}

export async function acquireDevicePushToken({
 appScope='rider',
 platform='android',
 channelId=OFFER_ALERT_CHANNEL,
 deviceId=null,
 projectId=null,
 notificationsModule=undefined
}={}){
 const scope=['rider','customer','restaurant'].includes(appScope)?appScope:'rider';
 const resolvedDeviceId=typeof deviceId==='string'&&deviceId.trim().length>0?deviceId.trim():null;
 const notif=notificationsModule!==undefined?notificationsModule:Notifications;

 const hasPermissionApi=Boolean(notif&&(typeof notif.getPermissionsAsync==='function'||typeof notif.requestPermissionsAsync==='function'));
 const hasTokenApi=Boolean(notif&&(typeof notif.getDevicePushTokenAsync==='function'||typeof notif.getExpoPushTokenAsync==='function'));
 if(!hasPermissionApi||!hasTokenApi){
  return {
   ok:false,
   available:false,
   status:'unavailable',
   pushToken:null,
   deviceId:resolvedDeviceId,
   platform:null,
   appScope:scope,
   channelId,
   permissionStatus:'unavailable',
   reason:'notifications_provider_unavailable'
  };
 }

 try{
  if(typeof notif.setNotificationChannelAsync==='function'){
   await notif.setNotificationChannelAsync(channelId,{
    name:'ELESEND Dispatch Offers',
    importance:notif.AndroidImportance?.MAX??5,
    bypassDnd:true,
    lockscreenVisibility:notif.AndroidNotificationVisibility?.PUBLIC??1,
    enableVibrate:true,
    vibrationPattern:[0,500,200,500,200,600]
   });
  }

  let permissionStatus=null;
  if(typeof notif.getPermissionsAsync==='function'){
   const perm=await notif.getPermissionsAsync();
   if(typeof perm?.status==='string')permissionStatus=perm.status;
   else if(perm?.granted===true)permissionStatus='granted';
  }
  if(permissionStatus!=='granted'&&typeof notif.requestPermissionsAsync==='function'){
   const req=await notif.requestPermissionsAsync();
   if(typeof req?.status==='string')permissionStatus=req.status;
   else if(req?.granted===true)permissionStatus='granted';
  }
  if(permissionStatus!=='granted'){
   return {
    ok:false,
    available:false,
    status:'unavailable',
    pushToken:null,
    deviceId:resolvedDeviceId,
    platform:null,
    appScope:scope,
    channelId,
    permissionStatus:permissionStatus||'unavailable',
    reason:permissionStatus==='denied'?'permission_denied':'permission_not_granted'
   };
  }

  let acquiredToken=null;
  let resolvedPlatform=platform;

  if(typeof notif.getDevicePushTokenAsync==='function'){
   const deviceTokenRes=await notif.getDevicePushTokenAsync();
   const raw=typeof deviceTokenRes==='string'?deviceTokenRes:deviceTokenRes?.data;
   if(typeof raw==='string'&&raw.trim().length>=8){
    acquiredToken=raw.trim();
    if(deviceTokenRes?.type==='ios'||deviceTokenRes?.type==='apns')resolvedPlatform='apns';
    else if(deviceTokenRes?.type==='android'||deviceTokenRes?.type==='fcm')resolvedPlatform='fcm';
   }
  }

  if(!acquiredToken&&typeof notif.getExpoPushTokenAsync==='function'){
   const expoTokenRes=await notif.getExpoPushTokenAsync(projectId?{projectId}:undefined);
   const raw=typeof expoTokenRes==='string'?expoTokenRes:expoTokenRes?.data;
   if(typeof raw==='string'&&raw.trim().length>=8){
    acquiredToken=raw.trim();
    resolvedPlatform='expo';
   }
  }

  if(!acquiredToken){
   return {
    ok:false,
    available:false,
    status:'unavailable',
    pushToken:null,
    deviceId:resolvedDeviceId,
    platform:null,
    appScope:scope,
    channelId,
    permissionStatus:'granted',
    reason:'provider_token_unavailable'
   };
  }

  return {
   ok:true,
   available:true,
   status:'available',
   pushToken:acquiredToken,
   deviceId:resolvedDeviceId,
   platform:resolvedPlatform,
   appScope:scope,
   channelId,
   permissionStatus:'granted'
  };
 }catch{
  return {
   ok:false,
   available:false,
   status:'unavailable',
   pushToken:null,
   deviceId:resolvedDeviceId,
   platform:null,
   appScope:scope,
   channelId,
   permissionStatus:'unavailable',
   reason:'provider_error'
  };
 }
}

export function subscribeBackgroundOfferAlerts(listener){
 if(typeof listener!=='function')return ()=>{};
 offerAlertListeners.add(listener);
 return ()=>offerAlertListeners.delete(listener);
}

export function notifyBackgroundOfferListeners(offers=[],meta={}){
 if(!Array.isArray(offers))return {alerted:false,newOfferIds:[]};
 const currentIds=offers.map(o=>o?.offerId||o?.id).filter(Boolean);
 const newOfferIds=currentIds.filter(id=>!notifiedOfferIds.has(id));
 for(const id of newOfferIds)notifiedOfferIds.add(id);
 for(const id of [...notifiedOfferIds]){
  if(!currentIds.includes(id))notifiedOfferIds.delete(id);
 }
 const payload={
  offers,
  newOfferIds,
  hasNewOffer:newOfferIds.length>0,
  channelId:OFFER_ALERT_CHANNEL,
  vibrationPattern:[0,500,200,500,200,600],
  observedAt:new Date().toISOString(),
  ...meta
 };
 for(const fn of offerAlertListeners){
  try{fn(payload);}catch{}
 }
 return {alerted:payload.hasNewOffer,newOfferIds,offers};
}

export function sample(location){const p=location?.coords;
 if(!p||!Number.isFinite(p.latitude)||!Number.isFinite(p.longitude)||location?.mocked===true||p?.isMocked===true)return null;
 return {latitude:p.latitude,longitude:p.longitude,accuracyMeters:Math.min(Math.max(p.accuracy??999,0),1000),observedAt:new Date(location.timestamp??Date.now()).toISOString(),...(p.heading>=0?{headingDegrees:p.heading}:{}),...(p.speed>=0?{speedMps:p.speed}:{})};
}

export async function runBackgroundLocationTask({data,error}={},deps={}){
 if(error||!data?.locations?.length)return {uploaded:false,reason:'no_locations'};
 const resolveToken=deps.loadToken||loadToken;
 const apiCall=deps.call||call;
 const token=await resolveToken();
 if(!token)return {uploaded:false,reason:'unauthenticated'};
 // Stale queued positions are deliberately discarded; the server also rejects old GPS data.
 const loc=data.locations[data.locations.length-1];
 if(Date.now()-loc.timestamp>90000)return {uploaded:false,reason:'stale_location'};
 const input=sample(loc);
 if(!input)return {uploaded:false,reason:'invalid_sample'};
 try{
  const res=await apiCall('POST','/api/v1/rider/location',input,{token});
  let pendingOffers=Array.isArray(res?.pendingOffers)?res.pendingOffers:null;
  if(!pendingOffers){
   try{
    pendingOffers=await apiCall('GET','/api/v1/rider/offers',undefined,{token});
   }catch{
    pendingOffers=[];
   }
  }
  const alertResult=notifyBackgroundOfferListeners(pendingOffers,{source:'background_gps_task',appState:deps.appState||'background',batterySaverEnabled:Boolean(deps.batterySaverEnabled)});
  return {uploaded:true,pendingOffers,alerted:alertResult.alerted,newOfferIds:alertResult.newOfferIds};
 }catch{
  /* Next OS update retries a fresh position. Never fabricate location. */
  return {uploaded:false,reason:'network_error'};
 }
}

try{
 if(TaskManager&&typeof TaskManager.defineTask==='function'){
  TaskManager.defineTask(TASK,async taskEvent=>{
   await runBackgroundLocationTask(taskEvent);
  });
 }
}catch{}

export async function registerDevicePushChannel({
 token=null,
 pushToken=null,
 appScope='rider',
 platform='android',
 channelId=OFFER_ALERT_CHANNEL,
 deviceId=null,
 projectId=null,
 appState='active',
 batterySaverEnabled=false,
 backgroundLocationEnabled=true,
 notificationsModule=undefined,
 callImpl=call,
 loadTokenImpl=loadToken
}={}){
 const authToken=token||(await loadTokenImpl());
 if(!authToken)return {registered:false,available:false,reason:'unauthenticated'};
 let resolvedToken=typeof pushToken==='string'&&pushToken.trim().length>=8?pushToken.trim():null;
 let resolvedDeviceId=typeof deviceId==='string'&&deviceId.trim().length>0?deviceId.trim():null;
 let resolvedPlatform=platform;
 let permissionStatus='granted';
 if(!resolvedToken){
  const acquired=await acquireDevicePushToken({
   appScope,
   platform,
   channelId,
   deviceId:resolvedDeviceId,
   projectId,
   notificationsModule
  });
  if(!acquired.ok||!acquired.pushToken){
   return {
    registered:false,
    available:false,
    pushToken:null,
    deviceId:acquired.deviceId,
    permissionStatus:acquired.permissionStatus||'unavailable',
    reason:acquired.reason||'provider_token_unavailable'
   };
  }
  resolvedToken=acquired.pushToken;
  resolvedDeviceId=resolvedDeviceId||acquired.deviceId;
  resolvedPlatform=acquired.platform||platform;
  permissionStatus=acquired.permissionStatus;
 }
 const normalizedAppState=['active','background','inactive'].includes(appState)?appState:'active';
 const res=await callImpl('POST','/api/v1/me/push-token',{
  pushToken:resolvedToken,
  platform:resolvedPlatform,
  appScope:['rider','customer','restaurant'].includes(appScope)?appScope:'rider',
  channelId,
  ...(resolvedDeviceId?{deviceId:resolvedDeviceId}:{}),
  appState:normalizedAppState,
  batterySaverEnabled:Boolean(batterySaverEnabled),
  backgroundLocationEnabled:Boolean(backgroundLocationEnabled)
 },{token:authToken});
 return {
  registered:true,
  available:true,
  pushToken:resolvedToken,
  deviceId:resolvedDeviceId,
  platform:resolvedPlatform,
  permissionStatus,
  channelId,
  ...res
 };
}

export async function startShiftTracking(settings={},deps={}){
 const Loc=deps.Location||Location;
 const foreground=await Loc.requestForegroundPermissionsAsync();if(foreground.status!=='granted')throw Error('Location permission required for dispatch');
 const bg=await Loc.requestBackgroundPermissionsAsync();
 if(bg.status!=='granted')return {background:false,backgroundLocationEnabled:false,batteryWarning:true,reason:'Enable "Allow all the time" background location and disable battery optimization so offers alert you when the screen is off.'};
 if(!(await Loc.hasStartedLocationUpdatesAsync(TASK)))await Loc.startLocationUpdatesAsync(TASK,{
  accuracy:Loc.Accuracy?.Balanced??3,
  timeInterval:Math.max(5000,Number(settings.movingUploadSeconds||15)*1000),
  distanceInterval:0,
  deferredUpdatesInterval:5000,
  deferredUpdatesDistance:0,
  pausesUpdatesAutomatically:false,
  activityType:Loc.ActivityType?.AutomotiveNavigation??2,
  foregroundService:{
   notificationTitle:'ELESEND shift active — Listening for offers',
   notificationBody:'Background GPS & instant offer alerts active. Keep battery saver disabled during your shift.',
   killServiceOnDestroy:false
  },
  showsBackgroundLocationIndicator:true
 });
 return {background:true,backgroundLocationEnabled:true,batteryWarning:false,channelId:OFFER_ALERT_CHANNEL};
}

export async function stopShiftTracking(deps={}){
 const Loc=deps.Location||Location;
 if(await Loc.hasStartedLocationUpdatesAsync(TASK))await Loc.stopLocationUpdatesAsync(TASK);
}
