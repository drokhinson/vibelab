-- ─────────────────────────────────────────────────────────────────────────────
-- spotme — consolidated baseline
-- Replaces legacy db/migrations/{011,014,015}_spotme_*.sql.
-- FRESH-DB ONLY. Production is already at this state. Do not run on existing DB.
--
-- Run order: this file, then 002_seed.sql, then db/migrations/_shared/.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Project role (created here so baseline GRANTs resolve on a fresh DB; the
--    password is rotated by _shared/003_project_roles.sql). ────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spotme_role') THEN
    CREATE ROLE spotme_role LOGIN PASSWORD 'change-me-via-shared-003' NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO spotme_role;


-- ── Tables ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.spotme_users (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username            TEXT        UNIQUE NOT NULL,
  display_name        TEXT        NOT NULL,
  email               TEXT,
  password_hash       TEXT        NOT NULL,
  recovery_hash       TEXT,
  bio                 TEXT,
  avatar_url          TEXT,
  is_discoverable     BOOLEAN     DEFAULT false,
  home_lat            NUMERIC(10,7),
  home_lng            NUMERIC(10,7),
  home_label          TEXT,
  traveling_to_lat    NUMERIC(10,7),
  traveling_to_lng    NUMERIC(10,7),
  traveling_to_label  TEXT,
  traveling_from      TIMESTAMPTZ,
  traveling_until     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_spotme_users_discoverable
  ON public.spotme_users(home_lat, home_lng) WHERE is_discoverable = true;
ALTER TABLE public.spotme_users ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.spotme_users TO spotme_role;

CREATE TABLE IF NOT EXISTS public.spotme_hobby_categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  icon       TEXT,
  sort_order INT  DEFAULT 0
);
ALTER TABLE public.spotme_hobby_categories ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.spotme_hobby_categories TO spotme_role;

CREATE TABLE IF NOT EXISTS public.spotme_hobbies (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID        NOT NULL REFERENCES public.spotme_hobby_categories(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  slug        TEXT        UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_spotme_hobbies_category ON public.spotme_hobbies(category_id);
ALTER TABLE public.spotme_hobbies ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.spotme_hobbies TO spotme_role;

-- proficiency had a CHECK constraint in the original 011_spotme_schema.sql;
-- migration 014 dropped it so hobby-specific values (e.g. 'green_circle',
-- 'black_diamond') can be stored. Validation now happens in the application
-- against rows in spotme_hobby_levels.
CREATE TABLE IF NOT EXISTS public.spotme_user_hobbies (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES public.spotme_users(id)   ON DELETE CASCADE,
  hobby_id    UUID        NOT NULL REFERENCES public.spotme_hobbies(id) ON DELETE CASCADE,
  proficiency TEXT        NOT NULL,
  notes       TEXT,
  is_active   BOOLEAN     DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, hobby_id)
);
CREATE INDEX IF NOT EXISTS idx_spotme_user_hobbies_user  ON public.spotme_user_hobbies(user_id);
CREATE INDEX IF NOT EXISTS idx_spotme_user_hobbies_hobby ON public.spotme_user_hobbies(hobby_id);
ALTER TABLE public.spotme_user_hobbies ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.spotme_user_hobbies TO spotme_role;

-- hobby_id IS NULL = default fallback levels (apply to all hobbies without custom levels)
CREATE TABLE IF NOT EXISTS public.spotme_hobby_levels (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hobby_id   UUID REFERENCES public.spotme_hobbies(id) ON DELETE CASCADE,
  sort_order INT  NOT NULL DEFAULT 0,
  value      TEXT NOT NULL,
  label      TEXT NOT NULL,
  UNIQUE (hobby_id, value)
);
CREATE INDEX IF NOT EXISTS idx_spotme_hobby_levels_hobby ON public.spotme_hobby_levels(hobby_id);
ALTER TABLE public.spotme_hobby_levels ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.spotme_hobby_levels TO spotme_role;
