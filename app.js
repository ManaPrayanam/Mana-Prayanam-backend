const express = require('express');
const { createApi } = require('./routes/api');

function createApp({ pool, enableDbCheck = false }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
    });
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  if (!enableDbCheck) {
    app.get('/api/db-check', (_req, res) => res.sendStatus(404));
  } else {
    app.get('/api/db-check', async (_req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok' });
      } catch {
        res.status(503).json({ status: 'unavailable' });
      }
    });
  }

  app.use('/api', createApi(pool));
  return app;
}

module.exports = { createApp };
