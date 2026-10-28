import {check} from './security.mjs';

export const REQUIRED_MIGRATION='047_order_scoped_realtime_messaging.sql';

export async function assertRequiredSchema(db){
 const result=await db.query('SELECT 1 FROM schema_migrations WHERE name=$1',[REQUIRED_MIGRATION]);
 check(result.rowCount>0,503,`Apply migrations through ${REQUIRED_MIGRATION} before starting ELESEND`);
}

export function assertPaymentOperations(provider,{production=false}={}){
 if(!production||!provider)return;
 const required=['createCheckout','verifyPayment','createRefund','verifyRefund','verifyBeneficiary','createPayout','verifyPayout'];
 const missing=required.filter(name=>typeof provider[name]!=='function');
 check(!missing.length,503,`Payment adapter ${provider.name} lacks required operations: ${missing.join(', ')}. Configure a complete payment gateway adapter before production startup.`);
}
