/** Tolls come from staff-entered rules with a source and dates. There are none until staff add them. */
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check} from '../../shared/security.mjs';
import {haversine} from '../../shared/dispatch-geometry.mjs';

const VEHICLES=['motorcycle','car','van'];
const MAX_SEGMENT_METERS=50;

/** True when the route line comes within the toll's radius, including between route points. */
export function routePasses(coordinates,point,radiusMeters){
 if(!Array.isArray(coordinates)||coordinates.length===0)return false;
 for(let i=0;i<coordinates.length;i++){
  const [lon,lat]=coordinates[i];
  if(haversine({latitude:lat,longitude:lon},point)<=radiusMeters)return true;
  const next=coordinates[i+1];
  if(!next)continue;
  const length=haversine({latitude:lat,longitude:lon},{latitude:next[1],longitude:next[0]});
  const steps=Math.min(200,Math.ceil(length/MAX_SEGMENT_METERS));
  for(let s=1;s<steps;s++){
   const t=s/steps;
   if(haversine({latitude:lat+(next[1]-lat)*t,longitude:lon+(next[0]-lon)*t},point)<=radiusMeters)return true;
  }
 }
 return false;
}

export function applicableTolls(rules,{geometry,vehicle,at=new Date()}){
 const when=new Date(at).getTime();
 return rules.filter(rule=>
  rule.vehicles.includes(vehicle)&&
  new Date(rule.effective_from).getTime()<=when&&
  (!rule.effective_to||new Date(rule.effective_to).getTime()>when)&&
  routePasses(geometry?.coordinates,{latitude:Number(rule.latitude),longitude:Number(rule.longitude)},Number(rule.radius_m))
 ).map(rule=>({id:rule.id,name:rule.name,amountMinor:Number(rule.amount_minor),source:rule.source}));
}

export const activeTollRules=async c=>(await c.query(`SELECT id,name,radius_m,vehicles,amount_minor,source,effective_from,effective_to,
  ST_Y(location::geometry) AS latitude,ST_X(location::geometry) AS longitude
  FROM toll_rules WHERE effective_from<=now() AND (effective_to IS NULL OR effective_to>now())`)).rows;

const ruleSchema=z.object({
 name:z.string().trim().min(2).max(120),latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180),
 radiusMeters:z.number().int().min(10).max(100),vehicles:z.array(z.enum(VEHICLES)).min(1),amountMinor:z.number().int().min(1).max(100000),
 source:z.string().trim().min(5).max(500),effectiveFrom:z.string().datetime().optional(),effectiveTo:z.string().datetime().optional()
}).strict();

export function tollRuleService(db,{requirePermission}){
 const audit=(c,actor,action,id)=>c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,action,id]);
 return {
  async list(actor){
   return db.tx(async c=>{await requirePermission(c,actor,'pricing:write');
    return (await c.query(`SELECT id,name,radius_m,vehicles,amount_minor,source,effective_from,effective_to,ST_Y(location::geometry) AS latitude,ST_X(location::geometry) AS longitude FROM toll_rules ORDER BY created_at DESC LIMIT 200`)).rows;});
  },
  async add(actor,input){
   const v=ruleSchema.parse(input);
   if(v.effectiveTo)check(new Date(v.effectiveTo)>new Date(v.effectiveFrom??Date.now()),400,'The end date must be after the start date');
   return db.tx(async c=>{await requirePermission(c,actor,'pricing:write');const id=randomUUID();
    await c.query(`INSERT INTO toll_rules(id,name,location,radius_m,vehicles,amount_minor,source,effective_from,effective_to,created_by)
      VALUES($1,$2,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,$5,$6,$7,$8,COALESCE($9::timestamptz,now()),$10::timestamptz,$11)`,
     [id,v.name,v.longitude,v.latitude,v.radiusMeters,v.vehicles,v.amountMinor,v.source,v.effectiveFrom??null,v.effectiveTo??null,actor.id]);
    await audit(c,actor,'pricing.toll_rule_created',id);return {id};});
  },
  async retire(actor,id){
   z.string().uuid().parse(id);
   return db.tx(async c=>{await requirePermission(c,actor,'pricing:write');
    const done=await c.query("UPDATE toll_rules SET effective_to=GREATEST(now(),effective_from+interval '1 second'),retired_by=$2 WHERE id=$1 AND (effective_to IS NULL OR effective_to>now())",[id,actor.id]);
    check(done.rowCount>0,404,'Active toll rule not found');await audit(c,actor,'pricing.toll_rule_retired',id);return {retired:true};});
  }
 };
}
