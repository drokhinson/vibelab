-- Migration 036: Add original_text to sauceboss_step_ingredients
-- Preserves the raw scraped ingredient string alongside parsed fields.
-- Shown as a hint in the builder UI so users can verify URL import parsing.

ALTER TABLE public.sauceboss_step_ingredients
  ADD COLUMN IF NOT EXISTS original_text TEXT;
