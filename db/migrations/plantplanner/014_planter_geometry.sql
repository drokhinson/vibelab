-- ─────────────────────────────────────────────────────────────────────────────
-- 014_planter_geometry.sql
-- New per-type geometry model. Existing schema stored only `grid_width` and
-- `grid_height`; that's a 2-axis footprint, which doesn't model real planter
-- shapes:
--
--   Pots                      → radius + height (cylinder)
--   Planter boxes (in/out)    → width + length + height (rectangular box)
--   Raised bed                → width + length + height (rectangular box)
--   Greenhouse                → width + length + height (rectangular structure)
--   Garden bed (in-ground)    → width + length only (flat plot)
--
-- We're reusing existing columns wherever possible:
--   • Pots                 — grid_width = RADIUS,  grid_height = HEIGHT
--   • Boxes / beds / GH    — grid_width = WIDTH,   grid_height = LENGTH,
--                            new dim_height column = vertical height
--   • Garden bed           — grid_width = WIDTH,   grid_height = LENGTH (flat)
--
-- Unit invariant from migration 012 holds: grid_* are inches for pots and
-- planter boxes, feet for greenhouse + beds. dim_height follows the same rule
-- (inches for indoor/outdoor planter boxes; feet for raised bed + greenhouse).
--
-- Existing pot rows had grid_width entered when the wizard input was labeled
-- "Width (in)" — effectively a diameter. Halve them to convert to radius.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. New vertical-dimension column. Nullable; only meaningful for the
--    box-shape types (boxes / raised bed / greenhouse). Stored in the same
--    unit as grid_*.
ALTER TABLE public.plantplanner_gardens
  ADD COLUMN IF NOT EXISTS dim_height REAL CHECK (dim_height IS NULL OR dim_height > 0);

-- 2. Migrate existing pot rows: previously interpreted as diameter, now
--    interpreted as radius. Halve, rounding up so tiny pots (e.g. 4-in
--    diameter) don't collapse to 2 in (which would be a 4-in pot — fine).
--    The user's example 12-in entry → 6-in radius (12-in diameter). GREATEST
--    keeps a floor of 1 to satisfy any future > 0 checks.
UPDATE public.plantplanner_gardens
   SET grid_width = GREATEST(1, CEIL(grid_width::numeric / 2)::int)
 WHERE garden_type IN ('indoor_pot', 'outdoor_pot');

-- 3. Seed sensible default dim_height on existing rows so they show
--    something reasonable when re-loaded into the wizard / preview.
UPDATE public.plantplanner_gardens
   SET dim_height = 12
 WHERE dim_height IS NULL
   AND garden_type IN ('indoor_planter_box', 'outdoor_planter_box');

UPDATE public.plantplanner_gardens
   SET dim_height = 1
 WHERE dim_height IS NULL
   AND garden_type = 'raised_bed';

UPDATE public.plantplanner_gardens
   SET dim_height = 8
 WHERE dim_height IS NULL
   AND garden_type = 'greenhouse';

-- 4. Re-grant on the changed table for the project read-only role.
GRANT SELECT ON public.plantplanner_gardens TO plantplanner_role;
