/** Reads a Firebase service account. Returns null when none is set, because push is optional. */
export function parseFirebaseAccount(raw){
 if(!raw||!String(raw).trim())return null;
 const account=JSON.parse(raw);
 if(!account.project_id||!account.client_email||!account.private_key)throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON needs project_id, client_email and private_key');
 return account;
}
