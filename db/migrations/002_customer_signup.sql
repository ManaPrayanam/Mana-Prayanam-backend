ALTER TABLE public.users
  ALTER COLUMN password_hash DROP NOT NULL,
  ADD COLUMN gender text CHECK (gender IN ('woman', 'man', 'non_binary', 'prefer_not_to_say')),
  ADD COLUMN mobile text UNIQUE CHECK (mobile ~ '^[6-9][0-9]{9}$'),
  ADD COLUMN mobile_verified_at timestamptz,
  ADD CONSTRAINT users_credentials_check CHECK (
    password_hash IS NOT NULL OR (
      role = 'rider' AND gender IS NOT NULL AND mobile IS NOT NULL AND mobile_verified_at IS NOT NULL
    )
  );
