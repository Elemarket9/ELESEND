import {check} from './security.mjs';
/** One check for administrator permissions. */
export async function requirePermission(c,actor,permission,message='Permission required'){
 check(actor?.kind==='admin',403,message);
 check((await c.query('SELECT 1 FROM permissions WHERE user_id=$1 AND permission=$2',[actor.id,permission])).rowCount,403,message);
}
/** Passes if the administrator holds any one of the listed permissions. */
export async function requireAnyPermission(c,actor,permissions,message){
 check(actor?.kind==='admin',403,'Administrator access required');
 const list=Array.isArray(permissions)?permissions:[permissions];
 check((await c.query('SELECT 1 FROM permissions WHERE user_id = $1 AND permission = ANY($2::text[])',[actor.id,list])).rowCount,403,message);
}
