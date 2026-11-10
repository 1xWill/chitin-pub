import pg from 'pg';
import '@/server/dotenv';

const { Pool } = pg;

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error('Missing env ' + name);
  return v;
}

function normalizeDatabaseUrl(raw: string): string {
  // pg (via pg-connection-string) currently treats sslmode=require|prefer|verify-ca as aliases for verify-full,
  // but emits a warning because libpq semantics will differ in a future major version.
  // Normalize early so we keep today's security behavior and avoid noisy warnings.
  try {
    const u = new URL(raw);
    const sslmode = (u.searchParams.get('sslmode') ?? '').toLowerCase();
    const compat = (u.searchParams.get('uselibpqcompat') ?? '').toLowerCase();
    if (compat === 'true') return raw;
    if (sslmode === 'prefer' || sslmode === 'require' || sslmode === 'verify-ca') {
      u.searchParams.set('sslmode', 'verify-full');
      return u.toString();
    }
    return raw;
  } catch {
    return raw;
  }
}

declare global {
  var __chitinPool: pg.Pool | undefined;
}

export function getDbPool(): pg.Pool {
  if (globalThis.__chitinPool) return globalThis.__chitinPool;

  const connectionString = normalizeDatabaseUrl(requiredEnv('DATABASE_URL'));
  const pool = new Pool({
    connectionString,
    // serverless-friendly defaults
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });

  // Avoid crashing the entire process on transient upstream disconnects.
  // (pg emits 'error' events on idle clients if the server closes the connection.)
  pool.on('error', (err) => {
    console.error('pg pool error', err);
  });

  globalThis.__chitinPool = pool;
  return pool;
}

export async function dbQuery<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
  const runOnce = async () => {
    const pool = getDbPool();
    const res = await pool.query(text, params);
    return res.rows as T[];
  };

  try {
    return await runOnce();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Common transient failures on hosted Postgres / serverless environments.
    if (/Connection terminated unexpectedly|ECONNRESET|Connection terminated|server closed the connection/i.test(msg)) {
      // Drop the cached pool and retry once (queries are generally idempotent via ON CONFLICT in our write paths).
      globalThis.__chitinPool = undefined;
      return await runOnce();
    }
    throw e;
  }
}
