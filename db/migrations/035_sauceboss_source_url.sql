-- Migration 035: Add source URL tracking to sauceboss_sauces
-- Records where imported sauces originated. Required for URL import feature.

ALTER TABLE public.sauceboss_sauces
  ADD COLUMN IF NOT EXISTS source_url  TEXT,
  ADD COLUMN IF NOT EXISTS source_name TEXT;
