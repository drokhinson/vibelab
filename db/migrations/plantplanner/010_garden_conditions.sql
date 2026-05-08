-- ─────────────────────────────────────────────────────────────────────────────
-- 010_garden_conditions.sql
-- Capture planter-level conditions during garden creation so the catalog
-- can auto-filter to plants that fit the planter.
--
--  • garden_type expands from 'garden_bed' | 'planter' to a five-value set:
--    'indoor' | 'outdoor' | 'garden_bed' | 'raised_bed' | 'greenhouse'.
--    Existing 'planter' rows are migrated to 'indoor' (closest semantic
--    match — the old 'planter' option in the UI was an indoor pot).
--  • water_plan captures the user's irrigation reality:
--      'regular'    — irrigated / watered on a schedule (default)
--      'occasional' — watered sometimes, prefers drought-tolerant
--      'rain_only'  — relies entirely on rainfall (low-water plants only)
--  • location_label is the display string for the toolbar/conditions strip
--    ('Boston, MA' or '02139') so the UI shows more than the bare zone.
--
-- shade_level (already present) stays as the lighting field.
-- usda_zone   (already present) stays as the per-garden hardiness zone.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Migrate the legacy 'planter' value before adding the CHECK constraint.
UPDATE public.plantplanner_gardens
   SET garden_type = 'indoor'
 WHERE garden_type = 'planter';

-- 2. Constrain garden_type to the new five-value set.
ALTER TABLE public.plantplanner_gardens
  ADD CONSTRAINT plantplanner_gardens_type_check
    CHECK (garden_type IN ('indoor', 'outdoor', 'garden_bed', 'raised_bed', 'greenhouse'));

-- 3. New conditions columns.
ALTER TABLE public.plantplanner_gardens
  ADD COLUMN IF NOT EXISTS water_plan     TEXT NOT NULL DEFAULT 'regular'
    CHECK (water_plan IN ('regular', 'occasional', 'rain_only')),
  ADD COLUMN IF NOT EXISTS location_label TEXT;

-- 4. Make sure the project role can still see the table after the structural change.
GRANT SELECT ON public.plantplanner_gardens TO plantplanner_role;
