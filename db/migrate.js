const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { Pool } = require('pg');

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('missing DATABASE_URL');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(482519371)');
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.schema_migrations (
          version text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      const versions = ['001_initial', '002_customer_signup'];
      let changed = false;
      for (const version of versions) {
        const applied = await client.query('SELECT 1 FROM public.schema_migrations WHERE version = $1', [version]);
        if (!applied.rowCount) {
          changed = true;
          const sql = await readFile(join(__dirname, 'migrations', version + '.sql'), 'utf8');
          await client.query(sql);
          await client.query('INSERT INTO public.schema_migrations (version) VALUES ($1)', [version]);
      }
        }
      const expected = ['users', 'sessions', 'driver_profiles', 'vehicles', 'rides', 'ride_status_history', 'schema_migrations'];
      const tables = await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY tablename",
        [expected],
      );
      if (tables.rowCount !== expected.length) throw new Error('missing expected tables');
      await client.query('COMMIT');
      console.log(changed ? 'Migration applied.' : 'Migrations already applied.');
      console.log(tables.rows.map(({ tablename }) => tablename).join(', '));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

migrate().catch((error) => {
  const code = /^[A-Z0-9]{5}$/.test(error.code ?? '') ? ` (${error.code})` : '';
  console.error(`Migration failed${code}.`);
  process.exitCode = 1;
});
