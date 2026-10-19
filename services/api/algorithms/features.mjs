import {z} from 'zod';
import {check} from '../security.mjs';
import {ALGORITHM_KEYS} from './registry.mjs';
const schema=z.object({featureKey:z.enum(ALGORITHM_KEYS),enabled:z.boolean()}).strict();
export function featureService(db){
 async function authorize(actor){check(actor?.kind==='admin',403,'Administrator required');check((await db.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission='dispatch:configure'",[actor.id])).rowCount,403,'Dispatch configuration permission required');}
 return {
  async enabled(featureKey){check(ALGORITHM_KEYS.includes(featureKey),400,'Unrecognized feature');return (await db.query('SELECT enabled FROM dispatch_algorithm_features WHERE feature_key=$1',[featureKey])).rows[0]?.enabled===true;},
  async list(actor){await authorize(actor);return (await db.query('SELECT feature_key,enabled,updated_at FROM dispatch_algorithm_features ORDER BY feature_key')).rows;},
  async set(actor,input){await authorize(actor);const v=schema.parse(input);
   return db.tx(async c=>{
    const current=(await c.query('SELECT enabled FROM dispatch_algorithm_features WHERE feature_key=$1 FOR UPDATE',[v.featureKey])).rows[0];check(current,404);
    // These features alter who can receive money/custody and cannot be disabled while in flight.
    if(!v.enabled&&['geospatial_discovery','road_network_routing','eta_dispatch_ranking','cost_based_pricing','commission_exposure','financial_reconciliation'].includes(v.featureKey))check(false,409,'Financial and road safety controls cannot be disabled');
    await c.query('UPDATE dispatch_algorithm_features SET enabled=$2,updated_by=$3,updated_at=now() WHERE feature_key=$1',[v.featureKey,v.enabled,actor.id]);
    await c.query('INSERT INTO audit_logs(actor_id,action) VALUES($1,$2)',[actor.id,`dispatch.feature.${v.featureKey}.${v.enabled?'enabled':'disabled'}`]);
    return {featureKey:v.featureKey,enabled:v.enabled};
   });
  }
 };
}
