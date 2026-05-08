-- ─────────────────────────────────────────────────────────────────────────────
-- plantplanner — enrich plant catalog with knowledge fields (iteration 1).
--
-- Adds 6 new knowledge columns to plantplanner_plants (bloom_months, native,
-- usda_zones, pollinator_attracts, water_need, care_summary) plus a usda_zone
-- column on plantplanner_gardens. Surfaces these in a plant detail panel and
-- replaces the 3-dropdown filter UI with chips+search.
--
-- DESTRUCTIVE: drops + recreates plantplanner_plants and plantplanner_garden_plants.
-- This is acceptable because:
--   • plantplanner_plants is reference data — fully reseeded by 005_seed_enriched.sql
--     (the catalog is owned by us, not user-generated).
--   • plantplanner_garden_plants is per-user placement data, but per product
--     decision existing user-placed plants are disposable for this iteration.
-- plantplanner_renders is preserved (untouched) so render_keys remain valid.
-- Run after 003_supabase_auth.sql; follow with 005_seed_enriched.sql.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DROP TABLE IF EXISTS public.plantplanner_garden_plants CASCADE;
DROP TABLE IF EXISTS public.plantplanner_plants        CASCADE;


-- ── Plant catalog (enriched) ─────────────────────────────────────────────────
CREATE TABLE public.plantplanner_plants (
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
GRANT SELECT ON public.plantplanner_plants TO plantplanner_role;


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


-- ── Gardens: USDA zone for the user's location ───────────────────────────────
ALTER TABLE public.plantplanner_gardens
  ADD COLUMN IF NOT EXISTS usda_zone TEXT;

COMMIT;
