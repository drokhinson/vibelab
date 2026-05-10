-- ─────────────────────────────────────────────────────────────────────────────
-- 015_align_perenual_options.sql
-- Realign the wizard's stored enum values to match Perenual's v2/species-list
-- filter parameters 1:1, eliminating the runtime mapping layer:
--
--   shade_level : 'partial' | 'shade'         → 'part_shade' | 'full_shade'
--                 (also adds new value 'sun-part_shade')
--   water_plan  : 'regular' | 'occasional'    → 'average'    | 'minimum'
--                 'rain_only'                 → 'none'
--                 (also adds new value 'frequent')
--   usda_zone   : '6b' / '5a'                 → '6' / '5'
--                 (drops the a/b suffix; constrained to integer zones 1-13)
--
-- Idempotent: each step is gated so re-running on already-migrated data is safe.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) shade_level: rename old values, lock the column down with a CHECK.
UPDATE public.plantplanner_gardens SET shade_level = 'part_shade' WHERE shade_level = 'partial';
UPDATE public.plantplanner_gardens SET shade_level = 'full_shade' WHERE shade_level = 'shade';

ALTER TABLE public.plantplanner_gardens
  DROP CONSTRAINT IF EXISTS plantplanner_gardens_shade_level_check;
ALTER TABLE public.plantplanner_gardens
  ADD CONSTRAINT plantplanner_gardens_shade_level_check
  CHECK (shade_level IN ('full_sun', 'sun-part_shade', 'part_shade', 'full_shade'));

-- 2) water_plan: rename old values, replace CHECK + default with the
-- Perenual-aligned set ('frequent','average','minimum','none').
UPDATE public.plantplanner_gardens SET water_plan = 'average' WHERE water_plan = 'regular';
UPDATE public.plantplanner_gardens SET water_plan = 'minimum' WHERE water_plan = 'occasional';
UPDATE public.plantplanner_gardens SET water_plan = 'none'    WHERE water_plan = 'rain_only';

ALTER TABLE public.plantplanner_gardens
  DROP CONSTRAINT IF EXISTS plantplanner_gardens_water_plan_check;
ALTER TABLE public.plantplanner_gardens
  ADD CONSTRAINT plantplanner_gardens_water_plan_check
  CHECK (water_plan IN ('frequent', 'average', 'minimum', 'none'));
ALTER TABLE public.plantplanner_gardens
  ALTER COLUMN water_plan SET DEFAULT 'average';

-- 3) usda_zone: strip the a/b half-zone suffix so values are 1-13 strings.
-- Stays TEXT to keep the column nullable and to avoid a destructive type change.
UPDATE public.plantplanner_gardens
  SET usda_zone = regexp_replace(usda_zone, '[ab]$', '')
  WHERE usda_zone ~ '[ab]$';

ALTER TABLE public.plantplanner_gardens
  DROP CONSTRAINT IF EXISTS plantplanner_gardens_usda_zone_check;
ALTER TABLE public.plantplanner_gardens
  ADD CONSTRAINT plantplanner_gardens_usda_zone_check
  CHECK (usda_zone IS NULL OR usda_zone ~ '^([1-9]|1[0-3])$');
