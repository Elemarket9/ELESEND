import {database} from '../services/api/db.mjs';
import {migrate} from './migrate.mjs';
import {simulationTarget} from './local-simulation-support.mjs';
import {importToDb} from './import_mapped_restaurants.mjs';
process.env.NODE_ENV ||= 'test';
const target=simulationTarget();
const db=database(target.toString());
try{await migrate(db);}finally{await db.close();}
await importToDb(target.toString(),'dedicated local test database');
