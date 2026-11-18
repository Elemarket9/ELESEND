import {requirePermission} from '../../shared/permissions.mjs';
import {z} from 'zod';
import {check} from '../../shared/security.mjs';
const uuid=z.string().uuid();
const vehicleEnum=z.enum(['bicycle','motorcycle','tricycle','car','pickup','van','truck']);
const carDetails=z.object({plateNumber:z.string().trim().min(4).max(20).regex(/^[A-Za-z0-9 -]+$/),make:z.string().trim().min(2).max(50),model:z.string().trim().min(1).max(60),color:z.string().trim().min(2).max(40)}).strict();
export const carRegistration=carDetails;
export async function registerVehicleInTx(c,riderId,{vehicle,maxWeightG,car}){
 const type=vehicleEnum.parse(vehicle),capacity=z.number().int().min(1).max(10000000).parse(maxWeightG);
 check(type!=='car'||car,400,'Car plate, make, model and color required');
 const v=type==='car'?carDetails.parse(car):null;
 await c.query('UPDATE riders SET vehicle=$2,max_weight_g=$3,online=false,status=\'pending\' WHERE id=$1',[riderId,type,capacity]);
 await c.query(`INSERT INTO rider_vehicle_registrations(rider_id,vehicle,registration_plate,make,model,color,verification_status)
 VALUES($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT(rider_id) DO UPDATE SET
 vehicle=$2,registration_plate=$3,make=$4,model=$5,color=$6,verification_status='pending',submitted_at=now(),reviewed_at=NULL,reviewer_id=NULL`,
 [riderId,type,v?.plateNumber.toUpperCase().replace(/\s+/g,' ').trim()??null,v?.make??null,v?.model??null,v?.color??null]);
}
const normalizePlate=plate=>plate.toUpperCase().replace(/\s+/g,' ').trim();
// Ghana plates mix letters and digits, like GR 1234-26 or M-22-GR 1234. Customers check it at the door.
export function validPlate(plate){const p=normalizePlate(String(plate??''));check(/^[A-Z0-9][A-Z0-9 -]{2,18}[A-Z0-9]$/.test(p)&&/[A-Z]/.test(p)&&/\d/.test(p),400,'Enter the number plate exactly as it appears on the vehicle');return p;}
export async function vehiclePlateFor(c,riderId){
 return (await c.query('SELECT registration_plate FROM rider_vehicle_registrations WHERE rider_id=$1',[riderId])).rows[0]?.registration_plate??null;
}
/** A changed plate needs a fresh review. */
export async function saveVehiclePlate(c,riderId,vehicle,plate){
 await c.query(`INSERT INTO rider_vehicle_registrations(rider_id,vehicle,registration_plate) VALUES($1,$2,$3)
   ON CONFLICT(rider_id) DO UPDATE SET verification_status=CASE WHEN rider_vehicle_registrations.registration_plate IS DISTINCT FROM excluded.registration_plate THEN 'pending' ELSE rider_vehicle_registrations.verification_status END,registration_plate=excluded.registration_plate`,[riderId,vehicle,validPlate(plate)]);
}
/** Approving a rider also approves their vehicle, so staff review once. */
export async function approveVehicleRecord(c,riderId,reviewerId){
 const rider=(await c.query('SELECT vehicle FROM riders WHERE id=$1',[riderId])).rows[0];
 const v=(await c.query('SELECT * FROM rider_vehicle_registrations WHERE rider_id=$1 FOR UPDATE',[riderId])).rows[0];
 if(rider?.vehicle==='car')check(v?.registration_plate&&v.make&&v.model&&v.color,409,'Car records incomplete');
 if(v)await c.query("UPDATE rider_vehicle_registrations SET verification_status='approved',reviewer_id=$2,reviewed_at=now() WHERE rider_id=$1",[riderId,reviewerId]);
}
export function vehicleService(db){return {
 async profile(actor){check(actor.kind==='rider',403,'Rider account required');const v=(await db.query(`SELECT r.vehicle,r.max_weight_g,r.status AS rider_status,r.online,vr.registration_plate,vr.make,vr.model,vr.color,vr.verification_status
 FROM riders r LEFT JOIN rider_vehicle_registrations vr ON vr.rider_id=r.id WHERE r.id=$1`,[actor.id])).rows[0];check(v,404);return v;},
 async submit(actor,input){check(actor.kind==='rider',403,'Rider account required');const v=z.object({vehicle:vehicleEnum,maxWeightG:z.number().int().positive().max(10000000),car:carDetails.optional()}).strict().parse(input);
  return db.tx(async c=>{await c.query('SELECT * FROM riders WHERE id=$1 FOR UPDATE',[actor.id]);
   check(!(await c.query("SELECT 1 FROM shipments WHERE rider_id=$1 AND state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED')",[actor.id])).rowCount,409,'Finish all active deliveries before changing vehicle');
   await registerVehicleInTx(c,actor.id,v);await c.query("UPDATE dispatch_offers SET status='invalidated' WHERE rider_id=$1 AND status='offered'",[actor.id]);
   await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'vehicle.submitted',$1)",[actor.id]);return {status:'pending',vehicle:v.vehicle};
  });
 },
 async review(actor,riderId,input){check(actor.kind==='admin',403);uuid.parse(riderId);const v=z.object({status:z.enum(['rejected','suspended'])}).strict().parse(input);
  return db.tx(async c=>{await requirePermission(c,actor,'verification:write','Verification permission required');
   const rider=(await c.query('SELECT * FROM riders WHERE id=$1 FOR UPDATE',[riderId])).rows[0];check(rider,404);
   const vr=(await c.query('SELECT * FROM rider_vehicle_registrations WHERE rider_id=$1 FOR UPDATE',[riderId])).rows[0];check(vr,404,'No submitted vehicle');
   await c.query('UPDATE rider_vehicle_registrations SET verification_status=$2,reviewer_id=$3,reviewed_at=now() WHERE rider_id=$1',[riderId,v.status,actor.id]);
   {await c.query('UPDATE riders SET online=false WHERE id=$1',[riderId]);await c.query("UPDATE dispatch_offers SET status='invalidated' WHERE rider_id=$1 AND status='offered'",[riderId]);}
   await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,'vehicle.'+v.status,riderId]);return {ok:true,status:v.status};
  });
 }
};}
