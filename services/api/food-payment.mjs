import {check} from './security.mjs';

export function restaurantOpenNow(restaurant,now=new Date()){
 if(!restaurant.is_open||restaurant.is_paused)return false;
 const entries=Object.entries(restaurant.operating_hours||{});
 if(!entries.length)return true;
 const hours=Object.fromEntries(entries.map(([k,v])=>[k.toLowerCase(),v]));
 const names=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
 const day=now.getUTCDay(),minute=now.getUTCHours()*60+now.getUTCMinutes();
 const get=d=>hours[names[d]]||hours[names[d].slice(0,3)]||hours[String(d===0?7:d)];
 const minutes=value=>{const [h,m]=String(value).split(':').map(Number);return h*60+m;};
 const today=get(day),yesterday=get((day+6)%7);
 if(today&&!today.closed){const start=minutes(today.open),end=minutes(today.close);if(start<end&&minute>=start&&minute<end||start>end&&minute>=start)return true;}
 return !!(yesterday&&!yesterday.closed&&minutes(yesterday.open)>minutes(yesterday.close)&&minute<minutes(yesterday.close));
}

export async function requireFoodPayment(c, order) {
 const shipment=(await c.query('SELECT * FROM shipments WHERE id=$1',[order.shipment_id])).rows[0];
 const receipt=(await c.query("SELECT 1 FROM shipment_checkout_intents WHERE shipment_id=$1 AND status='confirmed' AND amount_minor=$2",[order.shipment_id,order.total_minor])).rowCount;
 check(order.payment_method!=='CASH'&&order.payment_status==='PAID'&&shipment?.paid&&receipt,409,'Food and delivery must be paid upfront before kitchen acceptance');
 return shipment;
}

export async function foodDispatchAllowed(c, shipmentId) {
 const order=(await c.query('SELECT * FROM food_orders WHERE shipment_id=$1',[shipmentId])).rows[0];
 if(!order)return true;
 if(!['ACCEPTED','PREPARING','READY_FOR_PICKUP'].includes(order.state))return false;
 try{await requireFoodPayment(c,order);return true;}catch(e){if(e.status===409)return false;throw e;}
}

// Every food mutation locks shipment before order, matching payment confirmation.
export async function lockFoodOrder(c, orderId) {
 const ref=(await c.query('SELECT shipment_id FROM food_orders WHERE id=$1',[orderId])).rows[0];
 check(ref,404,'Food order not found');
 await c.query('SELECT id FROM shipments WHERE id=$1 FOR UPDATE',[ref.shipment_id]);
 const order=(await c.query('SELECT * FROM food_orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
 check(order,404,'Food order not found');
 return order;
}
