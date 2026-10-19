import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import {call,loadToken} from './api';
export const TASK='elesend-verified-rider-gps';
export function sample(location){const p=location?.coords;
 if(!p||!Number.isFinite(p.latitude)||!Number.isFinite(p.longitude))return null;
 return {latitude:p.latitude,longitude:p.longitude,accuracyMeters:Math.min(Math.max(p.accuracy??999,0),1000),observedAt:new Date(location.timestamp??Date.now()).toISOString(),...(p.heading>=0?{headingDegrees:p.heading}:{}),...(p.speed>=0?{speedMps:p.speed}:{})};
}
TaskManager.defineTask(TASK,async({data,error})=>{
 if(error||!data?.locations?.length)return;
 const token=await loadToken();if(!token)return;
 // Stale queued positions are deliberately discarded; the server also rejects old GPS data.
 const loc=data.locations[data.locations.length-1];if(Date.now()-loc.timestamp>90000)return;
 const input=sample(loc);if(!input)return;
 try{await call('POST','/api/v1/rider/location',input,{token});}catch{/* Next OS update retries a fresh position. Never fabricate location. */}
});
export async function startShiftTracking(settings={}){
 const foreground=await Location.requestForegroundPermissionsAsync();if(foreground.status!=='granted')throw Error('Location permission required for dispatch');
 const bg=await Location.requestBackgroundPermissionsAsync();
 if(bg.status!=='granted')return {background:false,reason:'Enable background permission for location updates when screen is off'};
 if(!(await Location.hasStartedLocationUpdatesAsync(TASK)))await Location.startLocationUpdatesAsync(TASK,{
  accuracy:Location.Accuracy.Balanced,timeInterval:Math.max(5000,Number(settings.movingUploadSeconds||15)*1000),distanceInterval:35,pausesUpdatesAutomatically:true,
  foregroundService:{notificationTitle:'ELESEND shift active',notificationBody:'GPS supports pickup offers. Go offline to stop tracking.'},
  showsBackgroundLocationIndicator:true
 });
 return {background:true};
}
export async function stopShiftTracking(){if(await Location.hasStartedLocationUpdatesAsync(TASK))await Location.stopLocationUpdatesAsync(TASK);}
