const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { createApp } = require('../app');

async function request(t, options, path) {
  const server = createApp(options).listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  return fetch(`http://127.0.0.1:${server.address().port}${path}`);
}

test('health works without a database connection', async (t) => {
  const res = await request(t, {}, '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('database check is disabled by default', async (t) => {
  const res = await request(t, {}, '/api/db-check');
  assert.equal(res.status, 404);
  await res.text();
});

test('database check queries the pool when enabled', async (t) => {
  const pool = { query: t.mock.fn(async () => {}) };
  const res = await request(t, { pool, enableDbCheck: true }, '/api/db-check');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { status: 'ok' });
  assert.equal(pool.query.mock.callCount(), 1);
  assert.deepEqual(pool.query.mock.calls[0].arguments, ['SELECT 1']);
});

test('database check hides connection error details', async (t) => {
  const pool = { async query() { throw new Error('private connection details'); } };
  const res = await request(t, { pool, enableDbCheck: true }, '/api/db-check');
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { status: 'unavailable' });
});
