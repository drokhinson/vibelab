-- ─────────────────────────────────────────────────────────────────────────────
-- 034 — SpotMe: migrate from custom auth to Supabase Auth
--
-- Drops the old spotme_users table and replaces it with spotme_profiles
-- linked to auth.users via ON DELETE CASCADE.
-- Hobby catalog tables (categories, hobbies, hobby_levels) are untouched.
--
-- WARNING: This migration deletes all existing user + user_hobby data.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Drop user-owned tables
DROP TABLE IF EXISTS public.spotme_user_hobbies CASCADE;
DROP TABLE IF EXISTS public.spotme_users CASCADE;

-- 2. Create profile table linked to Supabase Auth
CREATE TABLE public.spotme_profiles (
  id                  UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username            TEXT        UNIQUE NOT NULL,
  display_name        TEXT        NOT NULL,
  email               TEXT,
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
ALTER TABLE public.spotme_profiles ENABLE ROW LEVEL SECURITY;

-- 3. Recreate user_hobbies with FK to profiles
CREATE TABLE public.spotme_user_hobbies (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES public.spotme_profiles(id)  ON DELETE CASCADE,
  hobby_id    UUID        NOT NULL REFERENCES public.spotme_hobbies(id) ON DELETE CASCADE,
  proficiency TEXT        NOT NULL CHECK (proficiency IN ('want_to_learn', 'beginner', 'intermediate', 'advanced', 'expert')),
  notes       TEXT,
  is_active   BOOLEAN     DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, hobby_id)
);
ALTER TABLE public.spotme_user_hobbies ENABLE ROW LEVEL SECURITY;
