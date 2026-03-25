-- Migration 034: Add servings and yield fields to sauceboss_sauces
-- Supports recipe scaling and imported recipe metadata.

ALTER TABLE public.sauceboss_sauces
  ADD COLUMN IF NOT EXISTS servings       INT,
  ADD COLUMN IF NOT EXISTS yield_quantity REAL,
  ADD COLUMN IF NOT EXISTS yield_unit     TEXT;
