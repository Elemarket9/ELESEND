// CI only: the API must work fully under the limited database login, and the startup check must accept that login
// and refuse the owner.
import {database} from '../../services/api/db.mjs';
import {simulateOneDelivery} from '../prelaunch-simulation.mjs';
import {warnIfOwnerDatabaseLogin} from '../../services/api/startup-guards.mjs';
const app=database(process.env.APP_DATABASE_URL),owner=database(process.env.OWNER_DATABASE_URL);
try{
 if(await warnIfOwnerDatabaseLogin(app,{production:true,log:()=>{}})!==null)throw Error('limited login was flagged');
 console.log('LIMITED PASS: no warning for the limited login');
 if(await warnIfOwnerDatabaseLogin(owner,{production:true,log:()=>{}})!=='owner_login')throw Error('owner login was not flagged');
 console.log('LIMITED PASS: the owner login is flagged with a warning (the server still starts)');
 const result=await simulateOneDelivery(app);
 if(!result.paid||result.riderOffers<1)throw Error('delivery did not complete: '+JSON.stringify(result));
 console.log('LIMITED PASS: a full delivery runs under the limited login '+JSON.stringify(result));
 await app.query('ALTER TABLE finance_lines DISABLE TRIGGER USER').then(()=>{throw Error('limited login could switch off ledger protection');},e=>{if(!/owner|permission/i.test(e.message))throw e;});
 console.log('LIMITED PASS: the limited login cannot switch off ledger protection');
}finally{await app.close();await owner.close();}
