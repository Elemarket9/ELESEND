import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {database} from '../services/api/db.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {restaurantOrderService} from '../services/api/restaurant-orders.mjs';
import {checkoutService} from '../services/api/checkout.mjs';

test('concurrent food booking, payment callbacks and cancellation',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const configured=new URL(process.env.TEST_DATABASE_URL);
 assert.match(configured.pathname,/^\/elesend_test/);
 const db=database(configured.toString());
 try{
  await migrate(db);
  const customer=randomUUID(),owner=randomUUID(),restaurant=randomUUID(),item=randomUUID();
  for(const [id,kind] of [[customer,'customer'],[owner,'business']])await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'test-only',$3,now())",[id,'+2332'+randomInt(10000000,99999999),kind]);
  await db.query('UPDATE pricing_policies SET active=false');
  await db.query("INSERT INTO pricing_policies(id,base_minor,per_km_minor,commission_bps,vehicle) VALUES($1,1000,100,1300,'motorcycle')",[randomUUID()]);
  await db.query("INSERT INTO restaurants(id,owner_id,name,phone,address,latitude,longitude,status) VALUES($1,$2,'Race Kitchen','+233241234567','Kitchen address',5.60,-0.18,'approved')",[restaurant,owner]);
  await db.query("INSERT INTO menu_items(id,restaurant_id,name,price_minor) VALUES($1,$2,'Test food',5000)",[item,restaurant]);
  await db.query("UPDATE checkout_method_policies SET enabled=true WHERE method='MOMO'");
  const actor={id:customer,kind:'customer'};
  const input={restaurantId:restaurant,items:[{itemId:item,quantity:1,options:[]}],deliveryAddress:'Race destination',deliveryLatitude:5.61,deliveryLongitude:-0.19,customerPhone:'0241234567'};
  const food=restaurantOrderService(db,{routing:{route:async()=>({distanceMeters:2000,durationSeconds:300})}});
  const key=randomUUID();
  const bookings=await Promise.all([1,2,3].map(()=>food.createFoodOrder(actor,input,{paymentMethod:'MOMO',idempotencyKey:key})));
  assert.equal(new Set(bookings.map(x=>x.id)).size,1);
  const order=bookings[0];let evidence;
  const checkout=checkoutService(db,{provider:{name:'race',methods:['MOMO'],allowedCheckoutHosts:['checkout.test'],createCheckout:async x=>({reference:x.reference,checkoutUrl:'https://checkout.test/pay'}),verifyPayment:async()=>evidence,parseVerifiedWebhook:async()=>evidence}});
  const attempts=await Promise.allSettled([1,2].map(()=>checkout.initiate(actor,order.shipment_id,{idempotencyKey:randomUUID()})));
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(attempts.find(x=>x.status==='rejected').reason.status,409);
  const intent=attempts.find(x=>x.status==='fulfilled').value;
  evidence={reference:intent.reference,status:'success',amountMinor:Number(order.total_minor),currency:'GHS',channel:'mobile_money',eventId:'race_'+randomUUID()};
  const callbacks=await Promise.all([1,2,3].map(()=>checkout.webhook(Buffer.from('{}'),{})));
  assert.equal(callbacks.filter(x=>x.duplicate===false).length,1);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM checkout_confirmed_events WHERE shipment_id=$1',[order.shipment_id])).rows[0].count,1);
  await food.cancelOrder(actor,order.id);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM checkout_refund_requests WHERE shipment_id=$1',[order.shipment_id])).rows[0].count,1);
  for(let i=0;i<3;i++){
   const next=await food.createFoodOrder(actor,input,{paymentMethod:'MOMO',idempotencyKey:randomUUID()});
   const pending=await checkout.initiate(actor,next.shipment_id,{idempotencyKey:randomUUID()});
   evidence={...evidence,reference:pending.reference,eventId:'cancel_race_'+randomUUID()};
   await Promise.all([checkout.webhook(Buffer.from('{}'),{}),food.cancelOrder(actor,next.id)]);
   const shipment=(await db.query('SELECT * FROM shipments WHERE id=$1',[next.shipment_id])).rows[0];
   assert.equal(shipment.state,'CANCELLED');
   if(shipment.paid)assert.equal((await db.query('SELECT count(*)::int AS count FROM checkout_refund_requests WHERE shipment_id=$1',[next.shipment_id])).rows[0].count,1);
   else assert.equal((await db.query('SELECT count(*)::int AS count FROM checkout_unapplied_payments WHERE shipment_id=$1',[next.shipment_id])).rows[0].count,1);
  }
 }finally{
  await db.close();
 }
});
