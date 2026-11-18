import {check} from '../../shared/security.mjs';

export const MAX_PICKUP_SCHEDULE_DAYS=14;
export const MAX_PICKUP_WINDOW_HOURS=4;
export const SCHEDULED_CARGO_VEHICLES=new Set(['box_truck','long_vehicle']);

export function validatePickupSchedule(pickupWindow,vehicle,now=new Date()){
 if(!pickupWindow){
  check(!SCHEDULED_CARGO_VEHICLES.has(vehicle),422,'Choose a pickup date and time for a box truck or long vehicle.');
  return null;
 }
 const start=new Date(pickupWindow.startAt),end=new Date(pickupWindow.endAt),clock=now.getTime();
 check(Number.isFinite(start.getTime())&&Number.isFinite(end.getTime()),400,'Enter a valid pickup date and time.');
 check(start.getTime()>clock,422,'Choose a pickup time in the future.');
 const latest=clock+MAX_PICKUP_SCHEDULE_DAYS*86400000;
 check(start.getTime()<=latest&&end.getTime()<=latest,422,'Pickup can be scheduled up to 14 days ahead.');
 check(end.getTime()>start.getTime()&&end.getTime()-start.getTime()<=MAX_PICKUP_WINDOW_HOURS*3600000,422,'Choose a pickup window no longer than four hours.');
 return {startAt:start.toISOString(),endAt:end.toISOString()};
}

export function scheduledPickupReminder(startAt,now=new Date()){
 const remaining=Math.floor((new Date(startAt).getTime()-now.getTime())/60000);
 if(remaining<=60&&remaining>15)return 60;
 if(remaining<=15&&remaining>0)return 15;
 return null;
}
