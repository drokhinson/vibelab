-- ─────────────────────────────────────────────────────────────────────────────
-- PlantPlanner — current schema snapshot
-- Last updated: migration 026
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.plantplanner_users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT        UNIQUE NOT NULL,
  display_name  TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.plantplanner_users ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.plantplanner_plants (
  id            UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT     NOT NULL,
  emoji         TEXT     NOT NULL DEFAULT '🌱',
  height_inches INT      NOT NULL DEFAULT 12,
  sunlight      TEXT     NOT NULL DEFAULT 'full_sun',  -- full_sun | partial | shade
  bloom_season  TEXT[]   NOT NULL DEFAULT '{}',         -- spring | summer | fall | winter
  spread_inches INT      NOT NULL DEFAULT 12,
  description   TEXT,
  sort_order    INT      NOT NULL DEFAULT 0,
  category      TEXT     NOT NULL DEFAULT 'other'       -- vegetable | herb | flower | fruit | other
  -- render_params (JSONB) dropped in migration 026: Three.js 3D feature never implemented
);
ALTER TABLE public.plantplanner_plants ENABLE ROW LEVEL SECURITY;

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
ALTER TABLE public.plantplanner_gardens ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.plantplanner_garden_plants (
  id        UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  garden_id UUID    NOT NULL REFERENCES public.plantplanner_gardens(id) ON DELETE CASCADE,
  plant_id  UUID    NOT NULL REFERENCES public.plantplanner_plants(id),
  grid_x    INT     NOT NULL,
  grid_y    INT     NOT NULL,
  UNIQUE(garden_id, grid_x, grid_y)
);
ALTER TABLE public.plantplanner_garden_plants ENABLE ROW LEVEL SECURITY;
