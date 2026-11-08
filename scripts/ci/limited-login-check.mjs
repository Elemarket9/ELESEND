// CI only: the API must work fully under the limited database login, and the startup check must accept that login
// and refuse the owner.
import {database} from '../../services/api/db.mjs';
import {simulateOneDelivery} from '../prelaunch-simulation.mjs';
import {assertLimitedDatabaseLogin} from '../../services/api/startup-guards.mjs';
const app=database(process.env.APP_DATABASE_URL),owner=database(process.env.OWNER_DATABASE_URL);
try{
 await assertLimitedDatabaseLogin(app,{production:true,env:{}});
 console.log('LIMITED PASS: startup check accepts the limited login');
 await assertLimitedDatabaseLogin(owner,{production:true,env:{}}).then(()=>{throw Error('owner login was accepted');},e=>{if(e.status!==503)throw e;});
 console.log('LIMITED PASS: startup check refuses the owner login');
 const result=await simulateOneDelivery(app);
 if(!result.paid||result.riderOffers<1)throw Error('delivery did not complete: '+JSON.stringify(result));
 console.log('LIMITED PASS: a full delivery runs under the limited login '+JSON.stringify(result));
 await app.query('ALTER TABLE finance_lines DISABLE TRIGGER USER').then(()=>{throw Error('limited login could switch off ledger protection');},e=>{if(!/owner|permission/i.test(e.message))throw e;});
 console.log('LIMITED PASS: the limited login cannot switch off ledger protection');
}finally{await app.close();await owner.close();}
