import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import './load-dotenv.mjs';

const { Pool } = pg;

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('Missing env DATABASE_URL');
  process.exit(1);
}

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
const files = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b));

function normalizeDatabaseUrl(raw) {
  // Keep consistent with runtime DB client (see src/server/db.ts).
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

const pool = new Pool({ connectionString: normalizeDatabaseUrl(dbUrl), max: 1 });

const run = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'CREATE TABLE IF NOT EXISTS _migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );

    const applied = new Set(
      (await client.query('SELECT id FROM _migrations')).rows.map((r) => String(r.id))
    );

    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (id) VALUES ($1)', [f]);
      console.log('applied', f);
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

async function main() {
  try {
    await run();
  } catch (err) {
    // Retry once on common transient hosted-Postgres disconnects.
    const msg = err instanceof Error ? err.message : String(err);
    if (/Connection terminated unexpectedly|ECONNRESET|Connection terminated|server closed the connection/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 250));
      await run();
      return;
    }
    throw err;
  }
}

main()
  .then(async () => {
    await pool.end().catch(() => {});
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
