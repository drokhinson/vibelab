-- ─────────────────────────────────────────────────────────────────────────────
-- SauceBoss — current schema snapshot
-- Last updated: post-consolidation (matches db/migrations/sauceboss/001_baseline.sql)
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────

-- Unified selector table. Type rows have parent_id IS NULL; Variant rows
-- (e.g. basmati rice as a prep variant of rice) point at their Type via
-- parent_id. Replaces the legacy sauceboss_carbs / sauceboss_addons /
-- sauceboss_salad_bases / sauceboss_carb_preparations tables.
CREATE TABLE IF NOT EXISTS public.sauceboss_items (
  id                 TEXT PRIMARY KEY,
  category           TEXT NOT NULL CHECK (category IN ('carb', 'protein', 'salad')),
  parent_id          TEXT REFERENCES public.sauceboss_items(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  emoji              TEXT NOT NULL DEFAULT '',
  description        TEXT NOT NULL DEFAULT '',
  sort_order         INT  NOT NULL DEFAULT 0,
  cook_time_minutes  INT,                    -- NULL when item is raw (e.g. romaine)
  instructions       TEXT,                   -- prep / cook text
  water_ratio        TEXT,                   -- carb-prep specific
  portion_per_person REAL NOT NULL,
  portion_unit       TEXT NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
ALTER TABLE public.sauceboss_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.sauceboss_sauces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  cuisine       TEXT NOT NULL,
  cuisine_emoji TEXT NOT NULL,
  color         TEXT NOT NULL,
  description   TEXT NOT NULL,
  source_url    TEXT,                    -- optional URL the sauce was imported from (migration 066)
  sauce_type    TEXT NOT NULL DEFAULT 'sauce' CHECK (sauce_type IN ('sauce', 'dressing', 'marinade'))
);
ALTER TABLE public.sauceboss_sauces ENABLE ROW LEVEL SECURITY;

-- Unified sauce↔item junction. Replaces sauceboss_sauce_carbs /
-- sauceboss_sauce_proteins / sauceboss_sauce_salad_bases. A trigger enforces
-- sauce_type ↔ item.category alignment and rejects links to Variant rows.
CREATE TABLE IF NOT EXISTS public.sauceboss_sauce_items (
  sauce_id TEXT NOT NULL REFERENCES public.sauceboss_sauces(id) ON DELETE CASCADE,
  item_id  TEXT NOT NULL REFERENCES public.sauceboss_items(id)  ON DELETE CASCADE,
  PRIMARY KEY (sauce_id, item_id)
);
ALTER TABLE public.sauceboss_sauce_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.sauceboss_sauce_steps (
  id              BIGSERIAL PRIMARY KEY,
  sauce_id        TEXT    NOT NULL REFERENCES public.sauceboss_sauces(id) ON DELETE CASCADE,
  step_order      INTEGER NOT NULL,
  title           TEXT    NOT NULL,
  input_from_step INT     DEFAULT NULL,
  estimated_time  INT                   -- minutes, nullable
);
ALTER TABLE public.sauceboss_sauce_steps ENABLE ROW LEVEL SECURITY;

-- Mealie-inspired unit registry. Single source of truth for unit names,
-- abbreviations, plurals, dimension (volume / mass / count) and conversion
-- factors. The backend Python module routes/sauceboss/units.py mirrors this
-- table for in-process parsing; both sides MUST stay in sync — update the
-- table via migration whenever units.py changes.
CREATE TABLE IF NOT EXISTS public.sauceboss_units (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  plural              TEXT NOT NULL,
  abbreviation        TEXT NOT NULL,
  plural_abbreviation TEXT NOT NULL,
  dimension           TEXT NOT NULL CHECK (dimension IN ('volume', 'mass', 'count')),
  ml_per_unit         DOUBLE PRECISION,         -- canonical mL per 1 of this unit (volume only)
  g_per_unit          DOUBLE PRECISION,         -- canonical g per 1 of this unit (mass only)
  aliases             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
);
ALTER TABLE public.sauceboss_units ENABLE ROW LEVEL SECURITY;

-- Mealie-inspired foods table. One row per distinct ingredient food, keyed
-- by lower(trim(name)). Auto-populated by create_sauceboss_sauce on insert.
-- TODO: add density_g_per_ml column when a curated density map is added —
-- this unlocks volume↔mass conversion. See routes/sauceboss/units.py
-- DENSITY_TODO.
CREATE TABLE IF NOT EXISTS public.sauceboss_foods (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  plural          TEXT,
  name_normalized TEXT NOT NULL UNIQUE,
  aliases         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.sauceboss_foods ENABLE ROW LEVEL SECURITY;

-- Per-step ingredient row. Mealie's RecipeIngredientModel-inspired shape:
-- food_id + unit_id + quantity + original_text + canonical mL/g. The legacy
-- name/amount/unit columns were dropped by migration 063; foods/units are
-- looked up via FKs and joined for display. quantity_canonical_ml or
-- quantity_canonical_g is set based on the unit's dimension; the other side
-- is null until a curated density map is added (volume↔mass cross-conversion).
CREATE TABLE IF NOT EXISTS public.sauceboss_step_ingredients (
  id                    BIGSERIAL PRIMARY KEY,
  step_id               BIGINT NOT NULL REFERENCES public.sauceboss_sauce_steps(id) ON DELETE CASCADE,
  food_id               TEXT REFERENCES public.sauceboss_foods(id) ON DELETE SET NULL,
  unit_id               TEXT REFERENCES public.sauceboss_units(id) ON DELETE SET NULL,
  original_text         TEXT,
  quantity              NUMERIC(12, 4),
  quantity_canonical_ml DOUBLE PRECISION,
  quantity_canonical_g  DOUBLE PRECISION
);
ALTER TABLE public.sauceboss_step_ingredients ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.sauceboss_ingredient_categories (
  ingredient_name TEXT PRIMARY KEY,
  category        TEXT NOT NULL
);
ALTER TABLE public.sauceboss_ingredient_categories ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.sauceboss_ingredient_substitutions (
  id              SERIAL PRIMARY KEY,
  ingredient_name TEXT NOT NULL,
  substitute_name TEXT NOT NULL,
  notes           TEXT,
  UNIQUE(ingredient_name, substitute_name)
);
ALTER TABLE public.sauceboss_ingredient_substitutions ENABLE ROW LEVEL SECURITY;

-- ── Combined-load RPCs (migration 054) ──────────────────────────────────────
-- Two unified RPCs replace the four legacy category-specific load RPCs:
--   get_sauceboss_initial_load()         → { carbs, proteins, saladBases }
--   get_sauceboss_item_load(p_item_id)   → { item, variants, sauces, ingredients }
--
-- ── Recipe import (migration 063) ──────────────────────────────────────────
-- create_sauceboss_sauce now accepts:
--   { id, name, cuisine, cuisineEmoji, color, description, sourceUrl,
--     sauceType, itemIds: [...],
--     steps: [
--       { stepOrder, title, inputFromStep,
--         ingredients: [{ name, amount, unit, unitId, originalText,
--                         canonicalMl, canonicalG }] }
--     ] }
-- The backend resolves unitId + canonical fields from the unit registry; the
-- RPC upserts foods by lower(trim(name)) and writes the normalized row.
-- amount=0 + unit_id='to_taste' represents a qualitative ingredient.
--
-- ── Ingredient admin RPCs (migration 067) ───────────────────────────────────
--   list_sauceboss_foods_with_usage()         → foods with recipe usage counts
--   merge_sauceboss_foods(keep, merge_ids[])  → atomic merge + repoint
--   delete_sauceboss_food_safe(id)            → returns usage count, refuses if >0
