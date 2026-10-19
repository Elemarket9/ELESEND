import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check,hash,newToken} from './security.mjs';
const uuid=z.string().uuid();
const audit=(c,actor,action,target)=>c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,action,target]);
async function company(c,actor){const row=(await c.query("SELECT * FROM companies WHERE owner_id=$1 AND status='approved' FOR UPDATE",[actor.id])).rows[0];check(row,403,'Approved company owner required');return row;}
export function network(db){return {
 async fleet(actor){check(actor.kind==='company',403);return (await db.query('SELECT r.id,r.status,r.online,r.vehicle,r.max_weight_g FROM riders r JOIN companies c ON c.id=r.company_id WHERE c.owner_id=$1 ORDER BY r.id LIMIT 100',[actor.id])).rows;},
 async invite(actor,input){const v=z.object({riderId:uuid}).strict().parse(input);const token=newToken();return db.tx(async c=>{const co=await company(c,actor);const r=(await c.query("SELECT * FROM riders WHERE id=$1 AND status='approved' FOR UPDATE",[v.riderId])).rows[0];check(r&&!r.company_id,409,'Approved independent rider required');await c.query("UPDATE rider_invitations SET status='revoked' WHERE company_id=$1 AND rider_id=$2 AND status='pending' AND expires_at<=now()",[co.id,r.id]);const iid=randomUUID();await c.query("INSERT INTO rider_invitations(id,company_id,rider_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '48 hours')",[iid,co.id,r.id,hash(token)]);await audit(c,actor,'company.rider_invited',r.id);return {id:iid,token,expiresInHours:48};});},
 async acceptInvitation(actor,input){const v=z.object({token:z.string().length(64)}).strict().parse(input);check(actor.kind==='rider',403);return db.tx(async c=>{
  const invite=(await c.query("SELECT * FROM rider_invitations WHERE token_hash=$1 AND rider_id=$2 AND status='pending' AND expires_at>now()",[hash(v.token),actor.id])).rows[0];check(invite,409,'Invitation unavailable');
  check((await c.query("SELECT 1 FROM companies WHERE id=$1 AND status='approved' FOR UPDATE",[invite.company_id])).rowCount,403,'Company unavailable');
  const r=(await c.query("SELECT * FROM riders WHERE id=$1 AND status='approved' FOR UPDATE",[actor.id])).rows[0];check(r&&!r.company_id,409,'Rider already affiliated or inactive');
  check(!(await c.query("SELECT 1 FROM shipments WHERE rider_id=$1 AND state NOT IN ('COMPLETED','CANCELLED','RETURNED')",[actor.id])).rowCount,409,'Finish existing custody before joining');
  check((await c.query("UPDATE rider_invitations SET status='accepted' WHERE id=$1 AND status='pending' AND expires_at>now() RETURNING id",[invite.id])).rowCount,409,'Invitation consumed');
  await c.query('UPDATE riders SET company_id=$2,online=false WHERE id=$1',[actor.id,invite.company_id]);await audit(c,actor,'company.rider_joined',actor.id);return {companyId:invite.company_id};
 });},
 async removeRider(actor,riderId){uuid.parse(riderId);return db.tx(async c=>{const co=await company(c,actor);const r=(await c.query('SELECT * FROM riders WHERE id=$1 AND company_id=$2 FOR UPDATE',[riderId,co.id])).rows[0];check(r,404,'Company rider not found');check(!(await c.query("SELECT 1 FROM shipments WHERE rider_id=$1 AND state NOT IN ('COMPLETED','CANCELLED','RETURNED')",[r.id])).rowCount,409,'Rider retains unfinished custody');
  // Removal must never silently turn a company rider into an active independent rider.
  await c.query("UPDATE riders SET company_id=NULL,status='pending',online=false WHERE id=$1",[r.id]);await c.query("UPDATE rider_invitations SET status='revoked' WHERE rider_id=$1 AND status='pending'",[r.id]);await audit(c,actor,'company.rider_removed',r.id);return {status:'pending'};});},
 async createKey(actor,input){check(actor.kind==='business',403,'Business account required');const v=z.object({name:z.string().min(2).max(100),scopes:z.array(z.enum(['quotes:write','shipments:write','shipments:read'])).min(1).max(3)}).strict().parse(input);const key='es_live_'+newToken(),kid=randomUUID();await db.tx(async c=>{await c.query("INSERT INTO api_clients(id,owner_id,name,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '90 days')",[kid,actor.id,v.name,hash(key),[...new Set(v.scopes)]]);await audit(c,actor,'api_key.created',kid);});return {id:kid,key,expiresInDays:90};},
 async revokeKey(actor,kid){uuid.parse(kid);await db.tx(async c=>{check((await c.query('UPDATE api_clients SET revoked_at=now() WHERE id=$1 AND owner_id=$2 RETURNING id',[kid,actor.id])).rowCount,404);await audit(c,actor,'api_key.revoked',kid);});return {ok:true};},
 async authenticateKey(token){check(typeof token==='string'&&/^es_live_[a-f0-9]{64}$/.test(token),401,'Invalid API credential');const r=(await db.query("SELECT u.id,u.kind,a.scopes,a.id AS api_client_id FROM api_clients a JOIN users u ON u.id=a.owner_id WHERE a.token_hash=$1 AND a.revoked_at IS NULL AND a.expires_at>now() AND u.kind='business'",[hash(token)])).rows[0];check(r,401,'API credential unavailable');return r;},
 authorizeKey(actor,method,path){if(!actor.api_client_id)return;let scope;
  if(method==='POST'&&path==='/api/v1/quotes')scope='quotes:write';
  else if(method==='POST'&&path==='/api/v1/shipments')scope='shipments:write';
  else if(method==='GET'&&/^\/api\/v1\/shipments(?:\/[0-9a-f-]+(?:\/tracking)?)?$/.test(path))scope='shipments:read';
  check(scope&&actor.scopes.includes(scope),403,'API credential scope denied');
 }
};}
