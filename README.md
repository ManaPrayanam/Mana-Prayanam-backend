# Mana-Prayanam-backend

## Local setup

1. Use Node.js 22 or newer and run `npm ci`.
2. Keep your Neon connection string in `.env` as `DATABASE_URL`. For a fresh checkout, copy `.env.example` to `.env` and use the pooled connection string from Neon, including its SSL parameters.
3. Run `npm run dev` for watch mode or `npm start` for a regular start. The default port is 3000.
4. Run `npm test` for the endpoint tests. They use a test pool and require no database credentials.

`GET /api/health` checks that Express is responding. To verify Neon locally, start the app with `ENABLE_DB_CHECK=true npm start` and open `http://localhost:3000/api/db-check`. A successful query returns HTTP 200. A database failure returns HTTP 503. The route is disabled by default and in production.

## Ride API

Run `npm run migrate` to apply and verify the Neon schema. The migration is tracked in
`public.schema_migrations` and can be run again safely.

Send JSON request bodies. After login, pass the returned token as
`Authorization: Bearer <token>` for authenticated routes. Sessions expire after 24 hours.

| Method and path | Access | JSON fields |
| --- | --- | --- |
| POST /api/auth/register | Public | name, email, password, role (rider or driver) |
| POST /api/auth/login | Public | email, password |
| GET /api/auth/me | Signed in | |
| POST /api/auth/logout | Signed in | |
| PATCH /api/drivers/me | Driver | phone |
| GET /api/vehicles | Driver | |
| POST /api/vehicles | Driver | registration, make, model, seats |
| POST /api/rides | Rider | pickup, destination |
| GET /api/rides | Signed in | |
| GET /api/rides/available | Driver | |
| POST /api/rides/:id/accept | Driver | vehicleId |
| PATCH /api/rides/:id/status | Ride participant | status |
| GET /api/rides/:id/history | Ride participant | |

The assigned driver can start and complete a ride. The rider or assigned driver
can cancel before a ride starts. Driver accounts are self-registered in this version.
