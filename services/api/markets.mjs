import {z} from 'zod';
import {check} from './security.mjs';
const country=z.string().regex(/^[A-Z]{2}$/);
const isoCurrency=z.string().regex(/^[A-Z]{3}$/);
/** Country-specific rollout registry. Deliberately NOT a shortcut around payments, tax or licensing. */
export function marketService(db){
 async function allowed(actor){check(actor?.kind==='admin',403,'Administrator only');check((await db.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission='dispatch:configure'",[actor.id])).rowCount,403,'Market operations permission required');}
 return {
  async list(actor){await allowed(actor);return (await db.query('SELECT country_code,iso_currency,service_enabled,cash_enabled,mo_mo_enabled,regulatory_verified_at,updated_at FROM service_markets ORDER BY country_code')).rows;},
  async stage(actor,input){await allowed(actor);const v=z.object({countryCode:country,isoCurrency:isoCurrency}).strict().parse(input);
   check(v.countryCode!=='GH'||v.isoCurrency==='GHS',400,'Ghana currency mismatch');
   return db.tx(async c=>{await c.query(`INSERT INTO service_markets(country_code,iso_currency) VALUES($1,$2)
    ON CONFLICT(country_code) DO NOTHING`,[v.countryCode,v.isoCurrency]);await c.query('INSERT INTO audit_logs(actor_id,action) VALUES($1,$2)',[actor.id,'market.staged.'+v.countryCode]);return {staged:true,countryCode:v.countryCode,serviceEnabled:false};});
  },
  async activate(actor,input){await allowed(actor);const v=z.object({countryCode:country,enabled:z.boolean()}).strict().parse(input);
   // This release's identity/address, OTP, provider settlement and ledger rail are Ghana-only.
   // Refuse unsafe activation rather than presenting a deceptive global expansion switch.
   if(v.enabled&&v.countryCode!=='GH')check(false,409,'International activation requires tested currency, phone, provider, territory and compliance integrations');
   return db.tx(async c=>{const prior=(await c.query('SELECT * FROM service_markets WHERE country_code=$1 FOR UPDATE',[v.countryCode])).rows[0];check(prior,404);
    if(v.enabled)check(prior.iso_currency==='GHS'&&prior.cash_enabled,409,'Ghana activation prerequisites missing');
    await c.query('UPDATE service_markets SET service_enabled=$2,updated_at=now() WHERE country_code=$1',[v.countryCode,v.enabled]);
    await c.query('INSERT INTO audit_logs(actor_id,action) VALUES($1,$2)',[actor.id,`market.${v.enabled?'activated':'deactivated'}.${v.countryCode}`]);
    return {countryCode:v.countryCode,serviceEnabled:v.enabled};});
  },
  async assertGhanaOperating(){const r=(await db.query("SELECT service_enabled FROM service_markets WHERE country_code='GH'")).rows[0];check(r?.service_enabled===true,503,'Ghana bookings administratively paused');}
 };
}
