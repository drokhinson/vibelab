-- ─────────────────────────────────────────────────────────────────────────────
-- PlantPlanner — current schema snapshot
-- Last updated: migration 034 (Supabase Auth migration)
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per Supabase auth.users id. Stores app-specific display name.
CREATE TABLE IF NOT EXISTS public.plantplanner_profiles (
  id            UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  TEXT        NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.plantplanner_profiles ENABLE ROW LEVEL SECURITY;

-- Reusable 3D render templates keyed by human-readable string
CREATE TABLE IF NOT EXISTS public.plantplanner_renders (
  key        TEXT        PRIMARY KEY,
  label      TEXT        NOT NULL DEFAULT '',
  params     JSONB       NOT NULL DEFAULT '{}',   -- geometry: stem, foliage, accents (no colors)
  colors     JSONB       NOT NULL DEFAULT '{}',   -- color map: { stem, foliage: [...], accents: [...] }
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.plantplanner_renders ENABLE ROW LEVEL SECURITY;

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

CREATE TABLE IF NOT EXISTS public.plantplanner_gardens (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES public.plantplanner_profiles(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL DEFAULT 'My Garden',
  grid_width      INT         NOT NULL DEFAULT 4,
  grid_height     INT         NOT NULL DEFAULT 4,
  garden_type     TEXT        NOT NULL DEFAULT 'garden_bed',  -- garden_bed | planter
  shade_level     TEXT        NOT NULL DEFAULT 'full_sun',    -- full_sun | partial | shade
  planting_season TEXT        NOT NULL DEFAULT 'spring',      -- spring | summer | fall | winter
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
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
