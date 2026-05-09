-- ─────────────────────────────────────────────────────────────────────────────
-- 011_plant_cache_and_shortlist.sql
-- Phase-1 plant-first refactor.
--
-- New table `plantplanner_plant_cache` holds normalized plant records sourced
-- from external APIs (Trefle primary, Perenual fallback for hardiness zones).
-- This table is the source of truth for the new shopping flow — the UI
-- queries it directly so users can browse plants without any third-party
-- API round-trip on the read path.
--
-- Image URLs are mirrored to Supabase Storage (bucket: plantplanner-plants)
-- in three sizes (thumbnail, medium, regular). The `*_url` columns store the
-- original CDN URL (provenance + re-mirror), the `*_path` columns store the
-- Supabase Storage object key (what the UI loads). All six are nullable —
-- they populate as data becomes available from each API source.
--
-- `plantplanner_gardens.shortlist_plant_cache_ids` persists the user's
-- shopping-step shortlist between session reloads and as the source for the
-- builder's "your shortlist" sidebar.
--
-- `plantplanner_garden_plants.plant_cache_id` is added so new placements can
-- reference cache rows. The legacy `plant_id` column stays for the existing
-- ~40 seed-table planters; new placements use one or the other (XOR).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Plant cache table (the new catalog).
CREATE TABLE IF NOT EXISTS public.plantplanner_plant_cache (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source                TEXT        NOT NULL CHECK (source IN ('trefle', 'perenual', 'merged')),
  source_id             TEXT        NOT NULL,                       -- the external API's record id
  scientific_name       TEXT        NOT NULL UNIQUE,                -- natural key across sources
  common_name           TEXT,
  family                TEXT,
  emoji                 TEXT,                                       -- fallback display character

  -- Conditions (the wizard filters on these)
  hardiness_min         INT,                                        -- USDA zone number, nullable
  hardiness_max         INT,
  sunlight              TEXT,                                       -- full_sun | part_shade | full_shade
  watering              TEXT,                                       -- frequent | average | minimum | none
  cycle                 TEXT,                                       -- annual | perennial | biennial
  indoor                BOOLEAN,                                    -- can grow indoors

  -- Specifications
  height_min_cm         INT,
  height_max_cm         INT,
  spread_cm             INT,
  days_to_harvest       INT,
  edible                BOOLEAN,
  vegetable             BOOLEAN,
  toxicity              TEXT,                                       -- none | low | medium | high
  growth_rate           TEXT,                                       -- slow | moderate | rapid
  ph_min                REAL,
  ph_max                REAL,
  sowing                TEXT,
  nitrogen_fixation     BOOLEAN,
  tags                  TEXT[]      NOT NULL DEFAULT '{}',

  -- Image cache: URL = original CDN, path = Supabase Storage key (what UI loads).
  -- All nullable; populate as available from each API source.
  image_thumbnail_url   TEXT,
  image_thumbnail_path  TEXT,
  image_medium_url      TEXT,
  image_medium_path     TEXT,
  image_regular_url     TEXT,
  image_regular_path    TEXT,
  last_image_synced_at  TIMESTAMPTZ,

  -- Forward-compat: keep the raw API responses we merged.
  raw_trefle_json       JSONB,
  raw_perenual_json     JSONB,

  last_synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plantplanner_plant_cache_common_name_idx
  ON public.plantplanner_plant_cache (lower(common_name));
CREATE INDEX IF NOT EXISTS plantplanner_plant_cache_scientific_idx
  ON public.plantplanner_plant_cache (lower(scientific_name));
CREATE INDEX IF NOT EXISTS plantplanner_plant_cache_sunlight_idx
  ON public.plantplanner_plant_cache (sunlight);
CREATE INDEX IF NOT EXISTS plantplanner_plant_cache_cycle_idx
  ON public.plantplanner_plant_cache (cycle);
CREATE INDEX IF NOT EXISTS plantplanner_plant_cache_hardiness_idx
  ON public.plantplanner_plant_cache (hardiness_min, hardiness_max);
CREATE INDEX IF NOT EXISTS plantplanner_plant_cache_edible_idx
  ON public.plantplanner_plant_cache (edible);
CREATE INDEX IF NOT EXISTS plantplanner_plant_cache_indoor_idx
  ON public.plantplanner_plant_cache (indoor);

ALTER TABLE public.plantplanner_plant_cache ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.plantplanner_plant_cache TO plantplanner_role;


-- 2. Shortlist column on gardens.
ALTER TABLE public.plantplanner_gardens
  ADD COLUMN IF NOT EXISTS shortlist_plant_cache_ids UUID[] NOT NULL DEFAULT '{}'::uuid[];


-- 3. Add plant_cache_id to garden_plants. Existing placements stay on plant_id;
--    new shopping-flow placements use plant_cache_id. Exactly one must be set.
ALTER TABLE public.plantplanner_garden_plants
  ALTER COLUMN plant_id DROP NOT NULL;

ALTER TABLE public.plantplanner_garden_plants
  ADD COLUMN IF NOT EXISTS plant_cache_id UUID REFERENCES public.plantplanner_plant_cache(id);

ALTER TABLE public.plantplanner_garden_plants
  ADD CONSTRAINT plantplanner_garden_plants_one_plant_ref CHECK (
    (plant_id IS NOT NULL AND plant_cache_id IS NULL) OR
    (plant_id IS NULL AND plant_cache_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_plantplanner_garden_plants_cache
  ON public.plantplanner_garden_plants(plant_cache_id);


-- 4. Re-grant on changed tables for the project role.
GRANT SELECT ON public.plantplanner_gardens          TO plantplanner_role;
GRANT SELECT ON public.plantplanner_garden_plants    TO plantplanner_role;
