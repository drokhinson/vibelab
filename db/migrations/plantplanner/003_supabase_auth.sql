-- ─────────────────────────────────────────────────────────────────────────────
-- plantplanner — switch user identity to Supabase Auth.
--
-- Drops the legacy plantplanner_users table (custom JWT + bcrypt) and every
-- user-FK'd table CASCADE, then recreates them pointing at
-- public.plantplanner_profiles (PK = auth.users.id).
--
-- Plant catalog (plantplanner_plants, plantplanner_renders) is preserved —
-- those tables have no user FK.
--
-- WIPES all user-owned gardens. Production has not deployed users yet.
-- Run after 001_baseline.sql + 002_seed.sql.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DROP TABLE IF EXISTS public.plantplanner_garden_plants CASCADE;
DROP TABLE IF EXISTS public.plantplanner_gardens       CASCADE;
DROP TABLE IF EXISTS public.plantplanner_users         CASCADE;


-- ── Profiles (Supabase Auth-backed) ──────────────────────────────────────────
CREATE TABLE public.plantplanner_profiles (
  id           UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT        NOT NULL,
  avatar_url   TEXT,
  is_admin     BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.plantplanner_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.plantplanner_profiles TO plantplanner_role;


-- ── Saved gardens (per-user) ─────────────────────────────────────────────────
CREATE TABLE public.plantplanner_gardens (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES public.plantplanner_profiles(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL DEFAULT 'My Garden',
  grid_width      INT         NOT NULL DEFAULT 4,
  grid_height     INT         NOT NULL DEFAULT 4,
  garden_type     TEXT        NOT NULL DEFAULT 'garden_bed',  -- garden_bed | planter
  shade_level     TEXT        NOT NULL DEFAULT 'full_sun',    -- full_sun | partial | shade
  planting_season TEXT        NOT NULL DEFAULT 'spring',      -- spring | summer | fall | winter
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_plantplanner_gardens_user
  ON public.plantplanner_gardens(user_id);
ALTER TABLE public.plantplanner_gardens ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.plantplanner_gardens TO plantplanner_role;


-- ── Plants placed in a garden ────────────────────────────────────────────────
CREATE TABLE public.plantplanner_garden_plants (
  id        UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  garden_id UUID    NOT NULL REFERENCES public.plantplanner_gardens(id) ON DELETE CASCADE,
  plant_id  UUID    NOT NULL REFERENCES public.plantplanner_plants(id),
  grid_x    INT     NOT NULL,
  grid_y    INT     NOT NULL,
  UNIQUE(garden_id, grid_x, grid_y)
);
CREATE INDEX idx_plantplanner_garden_plants_garden
  ON public.plantplanner_garden_plants(garden_id);
ALTER TABLE public.plantplanner_garden_plants ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.plantplanner_garden_plants TO plantplanner_role;

COMMIT;
