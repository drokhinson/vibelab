-- ─────────────────────────────────────────────────────────────────────────────
-- 032 — PlantPlanner: migrate from custom auth to Supabase Auth
--
-- Drops the old plantplanner_users table (with password_hash) and replaces it
-- with plantplanner_profiles linked to auth.users via ON DELETE CASCADE.
-- Garden/plant data tables are rebuilt with FKs pointing to profiles.
-- Plant catalog (plantplanner_plants, plantplanner_renders) is untouched.
--
-- WARNING: This migration deletes all existing user + garden data.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Drop user-owned tables (cascade removes garden_plants via FK)
DROP TABLE IF EXISTS public.plantplanner_garden_plants CASCADE;
DROP TABLE IF EXISTS public.plantplanner_gardens CASCADE;
DROP TABLE IF EXISTS public.plantplanner_users CASCADE;

-- 2. Create profile table linked to Supabase Auth
CREATE TABLE public.plantplanner_profiles (
  id            UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username      TEXT        UNIQUE NOT NULL,
  display_name  TEXT        NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.plantplanner_profiles ENABLE ROW LEVEL SECURITY;

-- 3. Recreate gardens referencing profiles
CREATE TABLE public.plantplanner_gardens (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES public.plantplanner_profiles(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL DEFAULT 'My Garden',
  grid_width      INT         NOT NULL DEFAULT 4,
  grid_height     INT         NOT NULL DEFAULT 4,
  garden_type     TEXT        NOT NULL DEFAULT 'garden_bed',
  shade_level     TEXT        NOT NULL DEFAULT 'full_sun',
  planting_season TEXT        NOT NULL DEFAULT 'spring',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.plantplanner_gardens ENABLE ROW LEVEL SECURITY;

-- 4. Recreate garden plants (same schema, FK to gardens)
CREATE TABLE public.plantplanner_garden_plants (
  id        UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  garden_id UUID    NOT NULL REFERENCES public.plantplanner_gardens(id) ON DELETE CASCADE,
  plant_id  UUID    NOT NULL REFERENCES public.plantplanner_plants(id),
  grid_x    INT     NOT NULL,
  grid_y    INT     NOT NULL,
  UNIQUE(garden_id, grid_x, grid_y)
);
ALTER TABLE public.plantplanner_garden_plants ENABLE ROW LEVEL SECURITY;
