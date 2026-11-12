CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('rider', 'driver')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON public.sessions(user_id);

CREATE TABLE public.driver_profiles (
  user_id uuid PRIMARY KEY REFERENCES public.users(id),
  phone text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.driver_profiles(user_id),
  registration text NOT NULL UNIQUE,
  make text NOT NULL,
  model text NOT NULL,
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 20),
  UNIQUE (id, driver_id)
);

CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id uuid NOT NULL REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(user_id),
  vehicle_id uuid,
  pickup text NOT NULL,
  destination text NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'accepted', 'in_progress', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vehicle_id, driver_id) REFERENCES public.vehicles(id, driver_id),
  CHECK ((driver_id IS NULL) = (vehicle_id IS NULL)),
  CHECK (status NOT IN ('accepted', 'in_progress', 'completed') OR driver_id IS NOT NULL)
);
CREATE INDEX rides_rider_idx ON public.rides(rider_id, created_at DESC);
CREATE INDEX rides_driver_idx ON public.rides(driver_id, created_at DESC);
CREATE INDEX rides_requested_idx ON public.rides(created_at) WHERE status = 'requested';

CREATE TABLE public.ride_status_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  actor_id uuid NOT NULL REFERENCES public.users(id),
  status text NOT NULL CHECK (status IN ('requested', 'accepted', 'in_progress', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ride_status_history_ride_idx ON public.ride_status_history(ride_id, id);
