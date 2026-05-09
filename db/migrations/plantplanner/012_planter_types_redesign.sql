-- ─────────────────────────────────────────────────────────────────────────────
-- 012_planter_types_redesign.sql
-- Expand garden_type from 5 → 7 values to match the new two-column wizard
-- step 1:
--   Indoor : indoor_pot · indoor_planter_box · greenhouse
--   Outdoor: outdoor_pot · outdoor_planter_box · garden_bed · raised_bed
--
-- Storage invariant for grid_width / grid_height:
--   • garden_type IN (indoor_pot, indoor_planter_box, outdoor_pot,
--     outdoor_planter_box) → values are INCHES
--   • everything else (greenhouse, garden_bed, raised_bed) → values are FEET
--   • pos_x, pos_y, radius_feet on plantplanner_garden_plants are ALWAYS feet,
--     regardless of garden_type. Backend converts grid dims to feet before
--     bounds-checking placements.
--
-- Existing rows are migrated:
--   • 'indoor'   → 'indoor_pot'   (matches the 010-era comment that the legacy
--                                  'planter' meant an indoor pot)
--   • 'outdoor'  → 'outdoor_pot'  (the old 'outdoor' option in the wizard was
--                                  described as "Container outside (deck,
--                                  balcony, patio)")
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Drop the old CHECK constraint FIRST. Otherwise the UPDATE in step 2
--    would set values the old constraint forbids and Postgres rejects the
--    statement (Failed: 23514 on 'indoor_pot' violating the legacy 5-value
--    constraint).
ALTER TABLE public.plantplanner_gardens
  DROP CONSTRAINT IF EXISTS plantplanner_gardens_type_check;

-- 2. Migrate legacy values now that nothing's blocking the new strings.
UPDATE public.plantplanner_gardens
   SET garden_type = 'indoor_pot'
 WHERE garden_type = 'indoor';

UPDATE public.plantplanner_gardens
   SET garden_type = 'outdoor_pot'
 WHERE garden_type = 'outdoor';

-- 3. Add the new 7-value CHECK constraint. Re-runnable: step 1 dropped any
--    prior version (whether the old 5-value or a previous attempt of this
--    one), so this ADD won't collide.
ALTER TABLE public.plantplanner_gardens
  ADD CONSTRAINT plantplanner_gardens_type_check
    CHECK (garden_type IN (
      'indoor_pot',
      'indoor_planter_box',
      'greenhouse',
      'outdoor_pot',
      'outdoor_planter_box',
      'garden_bed',
      'raised_bed'
    ));

-- 4. Re-grant on the changed table for the project read-only role.
GRANT SELECT ON public.plantplanner_gardens TO plantplanner_role;
