-- ─────────────────────────────────────────────────────────────────────────────
-- PlantPlanner — current schema snapshot
-- Last updated: post-005_seed_enriched (catalog enriched with native / USDA-zone /
-- bloom-month / pollinator / water-need / care-summary fields; gardens gained a
-- per-garden usda_zone column).
-- Migrations applied: 001_baseline, 002_seed, 003_supabase_auth,
--                     004_enrich_plants, 005_seed_enriched.
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────

-- Supabase Auth-backed profiles. id == auth.users.id.
CREATE TABLE IF NOT EXISTS public.plantplanner_profiles (
  id           UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT        NOT NULL,
  avatar_url   TEXT,
  is_admin     BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
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
  id                  UUID       PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT       NOT NULL,
  category            TEXT       NOT NULL DEFAULT 'other',       -- vegetable | herb | flower | fruit | other
  height_inches       INT        NOT NULL DEFAULT 12,
  spread_inches       INT        NOT NULL DEFAULT 12,
  sunlight            TEXT       NOT NULL DEFAULT 'full_sun',    -- full_sun | partial | shade
  bloom_season        TEXT[]     NOT NULL DEFAULT '{}',          -- spring | summer | fall | winter
  bloom_months        INT[]      NOT NULL DEFAULT '{}',          -- months 1–12; empty for foliage-only
  native              BOOLEAN    NOT NULL DEFAULT false,         -- North American native
  usda_zones          INT4RANGE,                                 -- e.g. '[3,9]'::int4range
  pollinator_attracts TEXT[]     NOT NULL DEFAULT '{}',          -- bees | butterflies | hummingbirds | moths | beneficial_insects
  water_need          TEXT       NOT NULL DEFAULT 'medium' CHECK (water_need IN ('low','medium','high')),
  care_summary        TEXT,                                      -- one short plain-language sentence
  description         TEXT,
  render_key          TEXT       REFERENCES public.plantplanner_renders(key),
  sort_order          INT        NOT NULL DEFAULT 0
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
  usda_zone       TEXT,                                        -- per-garden USDA hardiness zone (e.g. "6b")
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
CREATE INDEX IF NOT EXISTS idx_plantplanner_garden_plants_garden
  ON public.plantplanner_garden_plants(garden_id);
ALTER TABLE public.plantplanner_garden_plants ENABLE ROW LEVEL SECURITY;
