-- ─────────────────────────────────────────────────────────────────────────────
-- PlantPlanner — current schema snapshot
-- Last updated: post-012_planter_types_redesign (garden_type expanded from
-- 5 to 7 values; existing 'indoor' / 'outdoor' rows migrated to '*_pot').
-- Migrations applied: 001_baseline, 002_seed, 003_supabase_auth,
--                     004_enrich_plants, 005_seed_enriched, 006_companions,
--                     007_companions_seed, 008_real_radius_placement,
--                     009_growth_lifecycle, 010_garden_conditions,
--                     011_plant_cache_and_shortlist, 012_planter_types_redesign.
-- FOR REFERENCE ONLY — apply changes via db/migrations/
--
-- Storage invariant: grid_width / grid_height store INCHES when garden_type
-- is one of {indoor_pot, indoor_planter_box, outdoor_pot, outdoor_planter_box}
-- and FEET otherwise. pos_x / pos_y / radius_feet are ALWAYS feet.
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
  lifecycle           TEXT       NOT NULL DEFAULT 'perennial' CHECK (lifecycle IN ('annual','biennial','perennial')),
  years_to_maturity   INT        NOT NULL DEFAULT 3 CHECK (years_to_maturity BETWEEN 1 AND 5),
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
  garden_type     TEXT        NOT NULL DEFAULT 'garden_bed'
                  CHECK (garden_type IN (
                    'indoor_pot', 'indoor_planter_box', 'greenhouse',
                    'outdoor_pot', 'outdoor_planter_box', 'garden_bed', 'raised_bed'
                  )),
  shade_level     TEXT        NOT NULL DEFAULT 'full_sun',    -- full_sun | partial | shade
  planting_season TEXT        NOT NULL DEFAULT 'spring',      -- spring | summer | fall | winter
  water_plan      TEXT        NOT NULL DEFAULT 'regular'
                  CHECK (water_plan IN ('regular', 'occasional', 'rain_only')),
  usda_zone       TEXT,                                        -- per-garden USDA hardiness zone (e.g. "6b")
  location_label  TEXT,                                        -- display label for the conditions strip (e.g. "Boston, MA" or "02139")
  settings_json   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  shortlist_plant_cache_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],  -- plant cache rows the user shortlisted in the shopping step
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.plantplanner_gardens ENABLE ROW LEVEL SECURITY;

-- Companion-planting relationships (ordered pairs: plant_a_id < plant_b_id; clients expand bidirectionally)
CREATE TABLE IF NOT EXISTS public.plantplanner_companions (
  id           BIGSERIAL  PRIMARY KEY,
  plant_a_id   UUID       NOT NULL REFERENCES public.plantplanner_plants(id) ON DELETE CASCADE,
  plant_b_id   UUID       NOT NULL REFERENCES public.plantplanner_plants(id) ON DELETE CASCADE,
  relationship TEXT       NOT NULL CHECK (relationship IN ('good','bad','neutral')),
  reason       TEXT       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT plantplanner_companions_ordered CHECK (plant_a_id < plant_b_id),
  CONSTRAINT plantplanner_companions_unique  UNIQUE (plant_a_id, plant_b_id)
);
CREATE INDEX IF NOT EXISTS plantplanner_companions_a_idx ON public.plantplanner_companions(plant_a_id);
CREATE INDEX IF NOT EXISTS plantplanner_companions_b_idx ON public.plantplanner_companions(plant_b_id);
ALTER TABLE public.plantplanner_companions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.plantplanner_garden_plants (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  garden_id       UUID    NOT NULL REFERENCES public.plantplanner_gardens(id) ON DELETE CASCADE,
  plant_id        UUID    REFERENCES public.plantplanner_plants(id),                        -- legacy seed-table reference (nullable)
  plant_cache_id  UUID    REFERENCES public.plantplanner_plant_cache(id),                   -- new API-backed reference (nullable)
  pos_x           REAL    NOT NULL,
  pos_y           REAL    NOT NULL,
  radius_feet     REAL    NOT NULL DEFAULT 0.5,
  CHECK (pos_x >= 0 AND pos_y >= 0),
  CHECK (radius_feet > 0),
  CONSTRAINT plantplanner_garden_plants_one_plant_ref CHECK (
    (plant_id IS NOT NULL AND plant_cache_id IS NULL) OR
    (plant_id IS NULL AND plant_cache_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_plantplanner_garden_plants_garden
  ON public.plantplanner_garden_plants(garden_id);
CREATE INDEX IF NOT EXISTS idx_plantplanner_garden_plants_cache
  ON public.plantplanner_garden_plants(plant_cache_id);
ALTER TABLE public.plantplanner_garden_plants ENABLE ROW LEVEL SECURITY;

-- API-backed plant cache (Phase 1, post-011). Source-of-truth for the new
-- shopping flow. Three image sizes mirrored to Supabase Storage so the UI
-- never round-trips to third-party CDNs at read time.
CREATE TABLE IF NOT EXISTS public.plantplanner_plant_cache (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source                TEXT        NOT NULL CHECK (source IN ('trefle', 'perenual', 'merged')),
  source_id             TEXT        NOT NULL,
  scientific_name       TEXT        NOT NULL UNIQUE,
  common_name           TEXT,
  family                TEXT,
  emoji                 TEXT,
  hardiness_min         INT,
  hardiness_max         INT,
  sunlight              TEXT,                                       -- full_sun | part_shade | full_shade
  watering              TEXT,                                       -- frequent | average | minimum | none
  cycle                 TEXT,                                       -- annual | perennial | biennial
  indoor                BOOLEAN,
  height_min_cm         INT,
  height_max_cm         INT,
  spread_cm             INT,
  days_to_harvest       INT,
  edible                BOOLEAN,
  vegetable             BOOLEAN,
  toxicity              TEXT,
  growth_rate           TEXT,
  ph_min                REAL,
  ph_max                REAL,
  sowing                TEXT,
  nitrogen_fixation     BOOLEAN,
  tags                  TEXT[]      NOT NULL DEFAULT '{}',
  image_thumbnail_url   TEXT,
  image_thumbnail_path  TEXT,
  image_medium_url      TEXT,
  image_medium_path     TEXT,
  image_regular_url     TEXT,
  image_regular_path    TEXT,
  last_image_synced_at  TIMESTAMPTZ,
  raw_trefle_json       JSONB,
  raw_perenual_json     JSONB,
  last_synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.plantplanner_plant_cache ENABLE ROW LEVEL SECURITY;
