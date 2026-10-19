import pg from 'pg';
export function database(url=process.env.DATABASE_URL){
 if(!url)throw Error('DATABASE_URL required: use a dedicated ELESEND database');
 const pool=new pg.Pool({connectionString:url,max:10,connectionTimeoutMillis:5000});
 return {query:(...args)=>pool.query(...args),close:()=>pool.end(),async tx(fn){
  const c=await pool.connect();
  try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }};
}
