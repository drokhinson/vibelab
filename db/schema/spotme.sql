-- ─────────────────────────────────────────────────────────────────────────────
-- SpotMe — current schema snapshot
-- Last updated: migration 026
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────

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
ALTER TABLE public.spotme_users ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.spotme_hobby_categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  icon       TEXT,
  sort_order INT  DEFAULT 0
);
ALTER TABLE public.spotme_hobby_categories ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.spotme_hobbies (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID        NOT NULL REFERENCES public.spotme_hobby_categories(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  slug        TEXT        UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.spotme_hobbies ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.spotme_user_hobbies (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES public.spotme_users(id)  ON DELETE CASCADE,
  hobby_id    UUID        NOT NULL REFERENCES public.spotme_hobbies(id) ON DELETE CASCADE,
  proficiency TEXT        NOT NULL CHECK (proficiency IN ('want_to_learn', 'beginner', 'intermediate', 'advanced', 'expert')),
  notes       TEXT,
  is_active   BOOLEAN     DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, hobby_id)
);
ALTER TABLE public.spotme_user_hobbies ENABLE ROW LEVEL SECURITY;

-- hobby_id IS NULL = default fallback levels (apply to all hobbies without custom levels)
CREATE TABLE IF NOT EXISTS public.spotme_hobby_levels (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hobby_id   UUID REFERENCES public.spotme_hobbies(id) ON DELETE CASCADE,
  sort_order INT  NOT NULL DEFAULT 0,
  value      TEXT NOT NULL,
  label      TEXT NOT NULL,
  UNIQUE (hobby_id, value)
);
ALTER TABLE public.spotme_hobby_levels ENABLE ROW LEVEL SECURITY;
