-- ─────────────────────────────────────────────────────────────────────────────
-- plantplanner — consolidated baseline
-- Replaces legacy db/migrations/{019,021,022,023,024,025,029}_plantplanner_*.sql
-- (data-only migrations 020 and 030 are folded into 002_seed.sql).
-- FRESH-DB ONLY. Production is already at this state. Do not run on existing DB.
--
-- The legacy migrations 024 + 025 added/seeded a `plantplanner_plants.render_params`
-- JSONB column that was dropped (along with `emoji`) by old migrations 026 + 029.
-- The live 3D rendering pipeline now reads from `plantplanner_renders` (added in
-- 029) joined via `plantplanner_plants.render_key`.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Project role ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plantplanner_role') THEN
    CREATE ROLE plantplanner_role LOGIN PASSWORD 'change-me-via-shared-003' NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO plantplanner_role;


-- ── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plantplanner_users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT        UNIQUE NOT NULL,
  display_name  TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.plantplanner_users ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.plantplanner_users TO plantplanner_role;


-- ── Render templates (declared before plants because plants.render_key FK's it) ─
-- params = geometry (shapes, positions, scales — no colors)
-- colors = color mapping: { stem, foliage: [...], accents: [...] }
CREATE TABLE IF NOT EXISTS public.plantplanner_renders (
  key        TEXT        PRIMARY KEY,
  label      TEXT        NOT NULL DEFAULT '',
  params     JSONB       NOT NULL DEFAULT '{}',
  colors     JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.plantplanner_renders ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.plantplanner_renders TO plantplanner_role;


-- ── Plant catalog ────────────────────────────────────────────────────────────
-- emoji + render_params columns from earlier migrations were dropped before
-- consolidation; only the surviving columns are declared here.
CREATE TABLE IF NOT EXISTS public.plantplanner_plants (
  id            UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT     NOT NULL,
  height_inches INT      NOT NULL DEFAULT 12,
  sunlight      TEXT     NOT NULL DEFAULT 'full_sun',  -- full_sun | partial | shade
  bloom_season  TEXT[]   NOT NULL DEFAULT '{}',         -- spring | summer | fall | winter
  spread_inches INT      NOT NULL DEFAULT 12,
  description   TEXT,
  sort_order    INT      NOT NULL DEFAULT 0,
  category      TEXT     NOT NULL DEFAULT 'other',      -- vegetable | herb | flower | fruit | other
  render_key    TEXT     REFERENCES public.plantplanner_renders(key)
);
ALTER TABLE public.plantplanner_plants ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.plantplanner_plants TO plantplanner_role;


-- ── Saved gardens (per-user) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plantplanner_gardens (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES public.plantplanner_users(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL DEFAULT 'My Garden',
  grid_width      INT         NOT NULL DEFAULT 4,
  grid_height     INT         NOT NULL DEFAULT 4,
  garden_type     TEXT        NOT NULL DEFAULT 'garden_bed',  -- garden_bed | planter
  shade_level     TEXT        NOT NULL DEFAULT 'full_sun',    -- full_sun | partial | shade
  planting_season TEXT        NOT NULL DEFAULT 'spring',      -- spring | summer | fall | winter
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plantplanner_gardens_user
  ON public.plantplanner_gardens(user_id);
ALTER TABLE public.plantplanner_gardens ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.plantplanner_gardens TO plantplanner_role;


-- ── Plants placed in a garden ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plantplanner_garden_plants (
  id        UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  garden_id UUID    NOT NULL REFERENCES public.plantplanner_gardens(id) ON DELETE CASCADE,
  plant_id  UUID    NOT NULL REFERENCES public.plantplanner_plants(id),
  grid_x    INT     NOT NULL,
  grid_y    INT     NOT NULL,
  UNIQUE(garden_id, grid_x, grid_y)
);
CREATE INDEX IF NOT EXISTS idx_plantplanner_garden_plants_garden
  ON public.plantplanner_garden_plants(garden_id);
ALTER TABLE public.plantplanner_garden_plants ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.plantplanner_garden_plants TO plantplanner_role;
