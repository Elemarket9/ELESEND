import {check} from './security.mjs';
/** One check for administrator permissions. */
export async function requirePermission(c,actor,permission,message='Permission required'){
 check(actor?.kind==='admin',403,message);
 check((await c.query('SELECT 1 FROM permissions WHERE user_id=$1 AND permission=$2',[actor.id,permission])).rowCount,403,message);
}
