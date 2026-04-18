-- ─────────────────────────────────────────────────────────────────────────────
-- PlantPlanner — switch from custom JWT auth to Supabase Auth
-- Drops the username/password user table and rebuilds gardens against
-- a profiles table keyed by auth.users(id). Plant catalog + render templates
-- are untouched.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.plantplanner_garden_plants CASCADE;
DROP TABLE IF EXISTS public.plantplanner_gardens CASCADE;
DROP TABLE IF EXISTS public.plantplanner_users CASCADE;

CREATE TABLE public.plantplanner_profiles (
  id            UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  TEXT        NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.plantplanner_profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.plantplanner_gardens (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES public.plantplanner_profiles(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL DEFAULT 'My Garden',
  grid_width      INT         NOT NULL DEFAULT 4,
  grid_height     INT         NOT NULL DEFAULT 4,
  garden_type     TEXT        NOT NULL DEFAULT 'garden_bed',
  shade_level     TEXT        NOT NULL DEFAULT 'full_sun',
  planting_season TEXT        NOT NULL DEFAULT 'spring',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.plantplanner_gardens ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.plantplanner_garden_plants (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  garden_id UUID NOT NULL REFERENCES public.plantplanner_gardens(id) ON DELETE CASCADE,
  plant_id  UUID NOT NULL REFERENCES public.plantplanner_plants(id),
  grid_x    INT  NOT NULL,
  grid_y    INT  NOT NULL,
  UNIQUE(garden_id, grid_x, grid_y)
);
ALTER TABLE public.plantplanner_garden_plants ENABLE ROW LEVEL SECURITY;
