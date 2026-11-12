const { Pool } = require('pg');
const { createApp } = require('./app');

const { DATABASE_URL, PORT = '3000', ENABLE_DB_CHECK } = process.env;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const port = Number(PORT);
if (!/^\d+$/.test(PORT) || port < 1 || port > 65535) {
  console.error('PORT must be an integer from 1 to 65535.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
  statement_timeout: 5000,
});
pool.on('error', () => console.error('An idle database connection failed.'));

const app = createApp({
  pool,
  enableDbCheck: ENABLE_DB_CHECK === 'true' && process.env.NODE_ENV !== 'production',
});
const server = app.listen(port, () => console.log(`Listening on port ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(async () => {
      await pool.end();
    });
  });
}
