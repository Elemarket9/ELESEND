import pg from 'pg';
import fs from 'node:fs';

export function resolvePostgresSsl(url, options = {}) {
  if (options.enabled !== undefined) {
    let caVal = options.ca;
    if (caVal && typeof caVal === 'string' && !caVal.includes('-----BEGIN CERTIFICATE-----')) {
      try {
        if (fs.existsSync(caVal)) caVal = fs.readFileSync(caVal, 'utf8');
      } catch {}
    }
    return options.enabled ? { rejectUnauthorized: options.rejectUnauthorized !== false, ...(caVal ? { ca: caVal } : {}) } : false;
  }
  if (options.ssl === false) return false;
  if (options.ssl && typeof options.ssl === 'object') return options.ssl;

  const envSsl = (process.env.DATABASE_SSL || '').trim().toLowerCase();
  const urlLower = (url || '').toLowerCase();
  const urlRequestsSsl = urlLower.includes('sslmode=require') ||
                         urlLower.includes('sslmode=verify-full') ||
                         urlLower.includes('sslmode=verify-ca') ||
                         urlLower.includes('ssl=true');

  const isExplicitlyEnabled = options.ssl === true || envSsl === 'true' || envSsl === '1' || envSsl === 'require';
  const isExplicitlyDisabled = envSsl === 'false' || envSsl === '0' || envSsl === 'disable';

  if (isExplicitlyDisabled) return undefined;
  if (!isExplicitlyEnabled && !urlRequestsSsl) return undefined;

  const rejectUnauthorized = options.sslRejectUnauthorized !== undefined
    ? Boolean(options.sslRejectUnauthorized)
    : process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false';

  if (process.env.NODE_ENV === 'production' && !rejectUnauthorized) {
    process.stderr.write('[SECURITY HAZARD] DATABASE_SSL_REJECT_UNAUTHORIZED is false in production. Database TLS certificate verification is disabled, exposing traffic to MITM attacks. Use custom trusted certificates via DATABASE_SSL_CA instead.\n');
  }

  const sslConfig = { rejectUnauthorized };
  let ca = options.sslCa || process.env.DATABASE_SSL_CA;
  if (ca) {
    if (typeof ca === 'string' && !ca.includes('-----BEGIN CERTIFICATE-----')) {
      try {
        if (fs.existsSync(ca)) ca = fs.readFileSync(ca, 'utf8');
      } catch {}
    }
    sslConfig.ca = ca;
  }

  return sslConfig;
}

export function database(url = process.env.DATABASE_URL, options = {}) {
  if (!url) throw Error('DATABASE_URL required: use a dedicated ELESEND database');

  const poolMax = options.max ?? (process.env.DATABASE_POOL_MAX ? parseInt(process.env.DATABASE_POOL_MAX, 10) : 10);
  const idleTimeout = options.idleTimeoutMillis ?? (process.env.DATABASE_IDLE_TIMEOUT_MS ? parseInt(process.env.DATABASE_IDLE_TIMEOUT_MS, 10) : 30000);
  const connTimeout = options.connectionTimeoutMillis ?? (process.env.DATABASE_CONNECTION_TIMEOUT_MS ? parseInt(process.env.DATABASE_CONNECTION_TIMEOUT_MS, 10) : 5000);
  const statementTimeout = options.statementTimeoutMillis ?? (process.env.DATABASE_STATEMENT_TIMEOUT_MS ? parseInt(process.env.DATABASE_STATEMENT_TIMEOUT_MS, 10) : 15000);

  const poolConfig = {
    connectionString: url,
    max: Number.isInteger(poolMax) && poolMax > 0 ? poolMax : 10,
    idleTimeoutMillis: idleTimeout,
    connectionTimeoutMillis: connTimeout,
    statement_timeout: statementTimeout
  };

  const ssl = resolvePostgresSsl(url, options);
  if (ssl !== undefined) {
    poolConfig.ssl = ssl;
    const parsed=new URL(url);
    for(const key of ['sslmode','ssl','sslcert','sslkey','sslrootcert'])parsed.searchParams.delete(key);
    poolConfig.connectionString=parsed.toString();
  }

  const pool = new pg.Pool(poolConfig);
  const activeClients = new Set();
  pool.on('connect', client => {
    activeClients.add(client);
    client.once('end', () => activeClients.delete(client));
  });
  pool.on('error', () => {});
  return {
    query: (...args) => pool.query(...args),
    close: async () => {
      const closing = [...activeClients].map(client => new Promise(resolve => client.once('end', resolve)));
      await pool.end();
      await Promise.allSettled(closing);
    },
    pool,
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const result = await fn(c);
        await c.query('COMMIT');
        return result;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    }
  };
}
