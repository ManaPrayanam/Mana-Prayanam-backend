const express = require('express');
const { addCustomerAuth } = require('./customer-auth');
const { createHash, randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');

const derive = promisify(scrypt);
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 &&
  value.trim().length <= max && !value.includes('\0');
const uuid = (value) => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

function createApi(pool) {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

  addCustomerAuth(router, pool);

  router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!text(email, 254) || typeof password !== 'string' || password.length > 128) {
      return res.status(400).json({ error: 'Provide an email and password.' });
    }
    const { rows: [user] } = await pool.query(
      'SELECT id, name, email, role, password_hash FROM public.users WHERE email = $1',
      [email.trim().toLowerCase()],
    );
    const [salt, expected] = user?.password_hash?.split(':') ?? ['0'.repeat(32), '0'.repeat(128)];
    const actual = await derive(password, salt, 64);
    if (!timingSafeEqual(actual, Buffer.from(expected, 'hex')) || !user?.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const token = randomBytes(32).toString('hex');
    await pool.query(`
      INSERT INTO public.sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')
    `, [hashToken(token), user.id]);
    res.set('Cache-Control', 'no-store');
    res.json({ token, expiresIn: 86400, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  });

  router.use(async (req, res, next) => {
    const token = /^Bearer ([a-f0-9]{64})$/i.exec(req.get('authorization') ?? '')?.[1];
    if (!token) return res.status(401).json({ error: 'Sign in first.' });
    const tokenHash = hashToken(token);
    const { rows: [user] } = await pool.query(`
      SELECT u.id, u.name, u.email, u.gender, u.mobile, u.role FROM public.sessions s
      JOIN public.users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()
    `, [tokenHash]);
    if (!user) return res.status(401).json({ error: 'Session expired or invalid.' });
    res.set('Cache-Control', 'no-store');
    req.user = user;
    req.tokenHash = tokenHash;
    next();
  });

  function role(required) {
    return (req, res, next) => req.user.role === required
      ? next()
      : res.status(403).json({ error: 'This action is unavailable for your role.' });
  }

  router.get('/auth/me', (req, res) => res.json(req.user));
  router.post('/auth/logout', async (req, res) => {
    await pool.query('DELETE FROM public.sessions WHERE token_hash = $1', [req.tokenHash]);
    res.sendStatus(204);
  });

  router.patch('/drivers/me', role('driver'), async (req, res) => {
    const { phone } = req.body ?? {};
    if (!text(phone, 30)) return res.status(400).json({ error: 'Provide a phone number.' });
    const { rows } = await pool.query(
      'UPDATE public.driver_profiles SET phone = $1 WHERE user_id = $2 RETURNING *',
      [phone.trim(), req.user.id],
    );
    res.json(rows[0]);
  });

  router.get('/vehicles', role('driver'), async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM public.vehicles WHERE driver_id = $1 ORDER BY registration', [req.user.id]);
    res.json(rows);
  });

  router.post('/vehicles', role('driver'), async (req, res) => {
    const { registration, make, model, seats } = req.body ?? {};
    if (!text(registration, 32) || !text(make, 80) || !text(model, 80) ||
        !Number.isInteger(seats) || seats < 1 || seats > 20) {
      return res.status(400).json({ error: 'Provide registration, make, model, and 1–20 seats.' });
    }
    const { rows } = await pool.query(`
      INSERT INTO public.vehicles (driver_id, registration, make, model, seats)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT (registration) DO NOTHING RETURNING *
    `, [req.user.id, registration.trim().toUpperCase(), make.trim(), model.trim(), seats]);
    if (!rows.length) return res.status(409).json({ error: 'Vehicle registration already exists.' });
    res.status(201).json(rows[0]);
  });

  const FARE_RATES = {
    bike: { base: 20, perKm: 8, minimum: 20, etaMinutesPerKm: 3.2 },
    auto: { base: 30, perKm: 12, minimum: 30, etaMinutesPerKm: 3.8 },
  };

  function haversineKm(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function fareFor(vehicle, distanceKm) {
    const rate = FARE_RATES[vehicle];
    const raw = rate.base + distanceKm * rate.perKm;
    const fareInr = Math.round(Math.max(rate.minimum, raw));
    const durationMin = Math.max(2, Math.round(distanceKm * rate.etaMinutesPerKm));
    return { vehicle, fareInr, durationMin, distanceKm: Math.round(distanceKm * 10) / 10 };
  }

  function isCoord(value) {
    return value && Number.isFinite(value.lat) && Number.isFinite(value.lng)
      && value.lat >= -90 && value.lat <= 90 && value.lng >= -180 && value.lng <= 180;
  }

  /** Dummy quote: road distance via OSRM (fallback haversine×1.3), then fare formula. */
  router.post('/rides/quote', role('rider'), async (req, res) => {
    const { pickup, drop } = req.body ?? {};
    if (!isCoord(pickup) || !isCoord(drop)) {
      return res.status(400).json({ error: 'Provide pickup and drop coordinates.' });
    }
    const from = { lat: Number(pickup.lat), lng: Number(pickup.lng) };
    const to = { lat: Number(drop.lat), lng: Number(drop.lng) };

    let distanceKm = Math.max(0.3, haversineKm(from, to) * 1.3);
    let durationSec = Math.round(distanceKm * 180);
    let geometry = {
      type: 'LineString',
      coordinates: [[from.lng, from.lat], [to.lng, to.lat]],
    };

    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const upstream = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': 'ManaPrayanam/1.0' },
          signal: controller.signal,
        });
        if (upstream.ok) {
          const data = await upstream.json();
          const route = data?.routes?.[0];
          if (route?.distance > 0) {
            distanceKm = Math.max(0.3, route.distance / 1000);
            durationSec = Math.round(route.duration || durationSec);
            if (route.geometry?.coordinates?.length) geometry = route.geometry;
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Keep haversine fallback — still a valid dummy quote.
    }

    // Dummy nearby fleet around the pickup pin (Rapido-style scatter).
    const nearbyOffsets = [
      { dLat: 0.0007, dLng: 0.00015 },
      { dLat: 0.00035, dLng: 0.00075 },
      { dLat: -0.0002, dLng: 0.00085 },
      { dLat: -0.00065, dLng: 0.0003 },
      { dLat: -0.00045, dLng: -0.00055 },
      { dLat: 0.00025, dLng: -0.0007 },
    ];
    const nearbyVehicles = nearbyOffsets.map((o, i) => ({
      id: `near-${i + 1}`,
      lat: from.lat + o.dLat,
      lng: from.lng + o.dLng,
    }));

    res.json({
      pickup: from,
      drop: to,
      distanceKm: Math.round(distanceKm * 10) / 10,
      durationMin: Math.max(2, Math.round(durationSec / 60)),
      geometry,
      nearbyVehicles,
      // keep old key for a release — same pickup-cluster points
      nearbyBikes: nearbyVehicles,
      quotes: {
        bike: fareFor('bike', distanceKm),
        auto: fareFor('auto', distanceKm),
      },
    });
  });

  router.post('/rides', role('rider'), async (req, res) => {
    const { pickup, destination } = req.body ?? {};
    if (!text(pickup, 300) || !text(destination, 300)) {
      return res.status(400).json({ error: 'Provide pickup and destination.' });
    }
    const { rows } = await pool.query(`
      WITH ride AS (
        INSERT INTO public.rides (rider_id, pickup, destination) VALUES ($1, $2, $3) RETURNING *
      ), event AS (
        INSERT INTO public.ride_status_history (ride_id, actor_id, status) SELECT id, $1, status FROM ride
      )
      SELECT * FROM ride
    `, [req.user.id, pickup.trim(), destination.trim()]);
    res.status(201).json(rows[0]);
  });

  router.get('/rides', async (req, res) => {
    const { rows } = await pool.query(`
      SELECT * FROM public.rides WHERE rider_id = $1 OR driver_id = $1 ORDER BY created_at DESC, id DESC
    `, [req.user.id]);
    res.json(rows);
  });

  router.get('/rides/available', role('driver'), async (_req, res) => {
    const { rows } = await pool.query(`
      SELECT id, pickup, destination, created_at FROM public.rides
      WHERE status = 'requested' ORDER BY created_at, id LIMIT 100
    `);
    res.json(rows);
  });

  router.get('/rides/:id/history', async (req, res) => {
    if (!uuid(req.params.id)) return res.status(400).json({ error: 'Invalid ride ID.' });
    const { rows } = await pool.query(`
      SELECT h.status, h.actor_id, h.created_at FROM public.ride_status_history h
      JOIN public.rides r ON r.id = h.ride_id
      WHERE r.id = $1 AND (r.rider_id = $2 OR r.driver_id = $2) ORDER BY h.id
    `, [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Ride not found.' });
    res.json(rows);
  });

  router.post('/rides/:id/accept', role('driver'), async (req, res) => {
    const { vehicleId } = req.body ?? {};
    if (!uuid(req.params.id) || !uuid(vehicleId)) {
      return res.status(400).json({ error: 'Provide valid ride and vehicle IDs.' });
    }
    const { rows } = await pool.query(`
      WITH ride AS (
        UPDATE public.rides SET driver_id = $2, vehicle_id = $3, status = 'accepted', updated_at = now()
        WHERE id = $1 AND status = 'requested'
          AND EXISTS (SELECT 1 FROM public.vehicles WHERE id = $3 AND driver_id = $2)
        RETURNING *
      ), event AS (
        INSERT INTO public.ride_status_history (ride_id, actor_id, status) SELECT id, $2, status FROM ride
      )
      SELECT * FROM ride
    `, [req.params.id, req.user.id, vehicleId]);
    if (!rows.length) return res.status(409).json({ error: 'Ride or vehicle unavailable.' });
    res.json(rows[0]);
  });

  router.patch('/rides/:id/status', async (req, res) => {
    const { status } = req.body ?? {};
    if (!uuid(req.params.id) || !['in_progress', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Provide a valid ride ID and status.' });
    }
    const { rows } = await pool.query(`
      WITH ride AS (
        UPDATE public.rides SET status = $3, updated_at = now()
        WHERE id = $1 AND (
          (driver_id = $2 AND status = 'accepted' AND $3 = 'in_progress') OR
          (driver_id = $2 AND status = 'in_progress' AND $3 = 'completed') OR
          ((rider_id = $2 OR driver_id = $2) AND status IN ('requested', 'accepted') AND $3 = 'cancelled')
        ) RETURNING *
      ), event AS (
        INSERT INTO public.ride_status_history (ride_id, actor_id, status) SELECT id, $2, status FROM ride
      )
      SELECT * FROM ride
    `, [req.params.id, req.user.id, status]);
    if (!rows.length) return res.status(409).json({ error: 'Ride unavailable for this status change.' });
    res.json(rows[0]);
  });

  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
    res.status(500).json({ error: 'Request failed.' });
  });
  return router;
}

module.exports = { createApi };
