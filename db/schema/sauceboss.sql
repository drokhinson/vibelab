-- ─────────────────────────────────────────────────────────────────────────────
-- SauceBoss — current schema snapshot
-- Last updated: post-consolidation (matches db/migrations/sauceboss/001_baseline.sql)
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────

-- Unified selector table. Type rows have parent_id IS NULL; Variant rows
-- (e.g. basmati rice as a prep variant of rice) point at their Type via
-- parent_id. Replaces the legacy sauceboss_carbs / sauceboss_addons /
-- sauceboss_salad_bases / sauceboss_carb_preparations tables.
-- 3-level dish hierarchy (migration 007): category → dish → subtype.
-- dish_level='dish' rows have parent_id IS NULL (e.g. Rice, Bread, Chicken,
-- Romaine). dish_level='subtype' rows point at a 'dish' parent (e.g. Basmati
-- under Rice, Pretzel under Bread). The sauceboss_items_dish_level_check
-- trigger enforces this two-tier shape.
CREATE TABLE IF NOT EXISTS public.sauceboss_items (
  id                 TEXT PRIMARY KEY,
  category           TEXT NOT NULL CHECK (category IN ('carb', 'protein', 'salad')),
  parent_id          TEXT REFERENCES public.sauceboss_items(id) ON DELETE CASCADE,
  dish_level         TEXT NOT NULL DEFAULT 'dish' CHECK (dish_level IN ('dish', 'subtype')),  -- migration 007
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
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  cuisine         TEXT NOT NULL,
  cuisine_emoji   TEXT NOT NULL,
  color           TEXT NOT NULL,
  description     TEXT NOT NULL,
  source_url      TEXT,                    -- optional URL the sauce was imported from (migration 066)
  sauce_type      TEXT NOT NULL DEFAULT 'sauce' CHECK (sauce_type IN ('sauce', 'dressing', 'marinade', 'dip')),  -- migration 009 added 'dip'
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,           -- migration 003: author of user-submitted sauces
  parent_sauce_id TEXT REFERENCES public.sauceboss_sauces(id) ON DELETE SET NULL,  -- migration 005: variant link (one level deep, enforced by trigger)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- migration 010: latest-first sort key for Browse
  CONSTRAINT sauceboss_sauces_parent_self_chk CHECK (parent_sauce_id IS NULL OR parent_sauce_id <> id)
);
ALTER TABLE public.sauceboss_sauces ENABLE ROW LEVEL SECURITY;

-- Legacy junction (migration 051). DEPRECATED as of migration 008 — replaced
-- by sauceboss_sauce_attachments below. Kept for one release as a read-only
-- mirror so the Native app keeps working; the writers in
-- create_sauceboss_sauce / update_sauceboss_sauce / fork_sauceboss_sauce
-- dual-write dish-level attachments into this table. The legacy
-- sauceboss_sauce_items_check trigger was dropped in migration 009.
CREATE TABLE IF NOT EXISTS public.sauceboss_sauce_items (
  sauce_id TEXT NOT NULL REFERENCES public.sauceboss_sauces(id) ON DELETE CASCADE,
  item_id  TEXT NOT NULL REFERENCES public.sauceboss_items(id)  ON DELETE CASCADE,
  PRIMARY KEY (sauce_id, item_id)
);
ALTER TABLE public.sauceboss_sauce_items ENABLE ROW LEVEL SECURITY;

-- Sauce attachment table (migration 008). Source of truth for sauce↔dish
-- targeting. A sauce can attach at category level (applies to every dish +
-- subtype in that category), at dish level (the dish + its subtypes), or at
-- subtype level (one specific subtype). The
-- sauceboss_sauce_attachments_check trigger validates that:
--   * category targets are one of carb/protein/salad and match the sauce's
--     type-category map (sauce + dip → carb, marinade → protein,
--     dressing → salad — see sauceboss_type_to_category()).
--   * dish/subtype targets resolve to an item with the matching dish_level
--     and a category matching the type-category map.
CREATE TABLE IF NOT EXISTS public.sauceboss_sauce_attachments (
  sauce_id     TEXT NOT NULL REFERENCES public.sauceboss_sauces(id) ON DELETE CASCADE,
  target_kind  TEXT NOT NULL CHECK (target_kind IN ('category','dish','subtype')),
  target_value TEXT NOT NULL,
  PRIMARY KEY (sauce_id, target_kind, target_value)
);
ALTER TABLE public.sauceboss_sauce_attachments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.sauceboss_sauce_steps (
  id              BIGSERIAL PRIMARY KEY,
  sauce_id        TEXT    NOT NULL REFERENCES public.sauceboss_sauces(id) ON DELETE CASCADE,
  step_order      INTEGER NOT NULL,
  title           TEXT    NOT NULL,
  instructions    TEXT,                 -- optional paragraph (migration 004)
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

-- ── User accounts (migration 003) ───────────────────────────────────────────
-- Supabase-Auth-backed profiles, per-user favorites, and sauce ownership.
-- Mirrors the boardgamebuddy_profiles pattern; a single global ADMIN_API_KEY
-- promotes a profile to admin via POST /api/v1/sauceboss/profile/become-admin.
CREATE TABLE IF NOT EXISTS public.sauceboss_profiles (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_url   TEXT,
  is_admin     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.sauceboss_profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.sauceboss_favorites (
  user_id    UUID NOT NULL REFERENCES public.sauceboss_profiles(id) ON DELETE CASCADE,
  sauce_id   TEXT NOT NULL REFERENCES public.sauceboss_sauces(id)   ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sauce_id)
);
ALTER TABLE public.sauceboss_favorites ENABLE ROW LEVEL SECURITY;

-- ── Sauce edit RPC (migration 003) ──────────────────────────────────────────
--   update_sauceboss_sauce(p_data)  → atomic full-replace of scalar fields,
--                                     item links, steps, and step ingredients
--                                     (preserves created_by). Authorization
--                                     (owner or admin) enforced upstream.
-- Read RPCs (get_sauceboss_sauces_for_item, get_sauceboss_all_sauces,
-- get_sauceboss_all_sauces_full) now emit `createdBy` in their JSON output.

-- ── Recipe variants (migration 005) ─────────────────────────────────────────
-- sauceboss_sauces.parent_sauce_id links a variant to its family root. NULL
-- means standalone or root. ON DELETE SET NULL preserves authored variants
-- when a parent is removed. The sauceboss_sauces_variant_check trigger
-- enforces one level of depth (a variant cannot itself be a parent),
-- mirroring the parent_id pattern on sauceboss_items. Read RPCs
-- (get_sauceboss_sauces_for_item, get_sauceboss_all_sauces,
-- get_sauceboss_all_sauces_full) emit `parentSauceId` so frontends can
-- group sauces into families.


-- ── Saucebook + Pantry (migration 010) ──────────────────────────────────────
-- Per-user library (references, not copies). Editing a non-owned sauce
-- triggers fork_sauceboss_sauce(), which creates a new variant under the
-- family root, owned by the editing user, and repoints the user's
-- sauceboss_saucebook row to the new variant.
CREATE TABLE IF NOT EXISTS public.sauceboss_saucebook (
  user_id  UUID NOT NULL REFERENCES public.sauceboss_profiles(id) ON DELETE CASCADE,
  sauce_id TEXT NOT NULL REFERENCES public.sauceboss_sauces(id)   ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, sauce_id)
);
ALTER TABLE public.sauceboss_saucebook ENABLE ROW LEVEL SECURITY;

-- Negative pantry list. A row means the user is OUT of that food. Default
-- (empty) = "have everything". Keyed by food_id so merge_sauceboss_foods
-- keeps the pantry consistent.
CREATE TABLE IF NOT EXISTS public.sauceboss_pantry_missing (
  user_id UUID NOT NULL REFERENCES public.sauceboss_profiles(id) ON DELETE CASCADE,
  food_id TEXT NOT NULL REFERENCES public.sauceboss_foods(id)    ON DELETE CASCADE,
  PRIMARY KEY (user_id, food_id)
);
ALTER TABLE public.sauceboss_pantry_missing ENABLE ROW LEVEL SECURITY;


-- ── Resolver / library RPCs (migrations 008 + 010) ─────────────────────────
--   get_sauceboss_sauces_for_target(p_category, p_dish_id, p_subtype_id)
--     → union of sauces attached at category, dish, subtype, and the
--       subtype's parent dish. Used by the meal-builder flow.
--   get_sauceboss_saucebook(p_user_id) → the user's library, full envelopes.
--   get_sauceboss_browse(p_user_id, p_q, p_cuisines, p_types, p_author,
--                        p_limit, p_offset)
--     → paginated lightweight rows + variant count + inSaucebook flag.
--     Sorted by created_at DESC, family roots only.
--   get_sauceboss_browse_authors(p_q) → author autocomplete.
--   get_sauceboss_pantry_for_user(p_user_id) → ingredients in saucebook +
--     missing flag from sauceboss_pantry_missing.
--   set_sauceboss_pantry_missing(p_user_id, p_food_ids[]) → replace user's
--     missing set in one round-trip.
--   fork_sauceboss_sauce(p_source_id, p_user, p_data) → atomic copy +
--     parent_sauce_id wire-up + saucebook repoint.
