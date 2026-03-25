-- Migration 033: Add unit_type to sauceboss_step_ingredients
-- Classifies each ingredient measurement as volume, weight, or count.
-- Enables correct metric conversion and future import validation.

ALTER TABLE public.sauceboss_step_ingredients
  ADD COLUMN IF NOT EXISTS unit_type TEXT NOT NULL DEFAULT 'volume'
  CHECK (unit_type IN ('volume', 'weight', 'count'));

-- Backfill from the units reference table
UPDATE public.sauceboss_step_ingredients si
SET unit_type = u.unit_type
FROM public.sauceboss_units u
WHERE si.unit = u.abbreviation;
