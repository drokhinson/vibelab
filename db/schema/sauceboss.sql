-- ─────────────────────────────────────────────────────────────────────────────
-- SauceBoss — current schema snapshot
-- Last updated: post-rename consolidation (matches db/migrations/sauceboss/
-- 001_baseline.sql + 013_table_rename_consolidation.sql)
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────


-- 3-level dish hierarchy: category → dish → subtype. dish_level='dish' rows
-- have parent_id IS NULL (e.g. Rice, Bread, Chicken, Romaine). dish_level=
-- 'subtype' rows point at a 'dish' parent (e.g. Basmati under Rice, Pretzel
-- under Bread). The sauceboss_dish_level_check trigger enforces this two-tier
-- shape. Replaces the legacy sauceboss_carbs / sauceboss_addons /
-- sauceboss_salad_bases / sauceboss_carb_preparations tables.
CREATE TABLE IF NOT EXISTS public.sauceboss_dish (
  id                 TEXT PRIMARY KEY,
  category           TEXT NOT NULL CHECK (category IN ('carb', 'protein', 'salad')),
  parent_id          TEXT REFERENCES public.sauceboss_dish(id) ON DELETE CASCADE,
  dish_level         TEXT NOT NULL DEFAULT 'dish' CHECK (dish_level IN ('dish', 'subtype')),
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
ALTER TABLE public.sauceboss_dish ENABLE ROW LEVEL SECURITY;


-- Cuisine display info. cuisine_emoji previously lived denormalized on every
-- sauce row; now a sauce just stores the cuisine name and the emoji + image
-- are looked up here. Auto-upserted by create_sauceboss_sauce / update_sauceboss_sauce
-- whenever a sauce is saved with a non-empty emoji.
CREATE TABLE IF NOT EXISTS public.sauceboss_cuisine_info (
  cuisine           TEXT PRIMARY KEY,
  cuisine_emoji     TEXT NOT NULL,
  cuisine_image_url TEXT NULL                -- optional image URL for cuisine
);
ALTER TABLE public.sauceboss_cuisine_info ENABLE ROW LEVEL SECURITY;


-- Mealie-inspired unit registry. Single source of truth for unit names,
-- abbreviations, plurals, dimension (volume / mass / count) and conversion
-- factors. The backend Python module routes/sauceboss/units.py loads this
-- table into an in-memory cache at startup — the DB table is the single
-- source of truth. Add new units via migration only.
CREATE TABLE IF NOT EXISTS public.sauceboss_unit (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  plural              TEXT NOT NULL,
  abbreviation        TEXT NOT NULL,
  plural_abbreviation TEXT NOT NULL,
  dimension           TEXT NOT NULL CHECK (dimension IN ('volume', 'mass', 'count')),
  ml_per_unit         DOUBLE PRECISION,         -- canonical mL per 1 of this unit (volume only)
  g_per_unit          DOUBLE PRECISION,         -- canonical g per 1 of this unit (mass only)
  aliases             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  quantifiable        BOOLEAN NOT NULL DEFAULT TRUE  -- FALSE = no numeric qty (e.g. to_taste, splash)
);
ALTER TABLE public.sauceboss_unit ENABLE ROW LEVEL SECURITY;


-- Ingredient registry. One row per distinct ingredient food, keyed by
-- lower(trim(name)). Auto-populated by create_sauceboss_sauce on insert.
-- `category` (was its own lookup table) drives the pantry filter panel.
-- `substitutions` (was its own lookup table) is shown when an ingredient is
-- marked unavailable.
-- TODO: add density_g_per_ml column when a curated density map is added —
-- this unlocks volume↔mass conversion. See routes/sauceboss/units.py
-- DENSITY_TODO.
CREATE TABLE IF NOT EXISTS public.sauceboss_ingredient (
  id              TEXT PRIMARY KEY,
  category        TEXT NOT NULL DEFAULT 'uncategorized',
  name            TEXT NOT NULL,
  plural          TEXT,
  name_normalized TEXT NOT NULL UNIQUE,
  aliases         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  substitutions   TEXT[],                                 -- nullable: NULL = no substitutes recorded
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.sauceboss_ingredient ENABLE ROW LEVEL SECURITY;


-- All recipes: sauces, dressings, marinades, dips, full_recipes. cuisine_emoji
-- lives on sauceboss_cuisine_info (joined at read time). sauce_type is
-- intentionally unconstrained — values are governed by the backend Pydantic
-- enum (SauceType) instead of a DB CHECK so new types ship with a code change
-- alone. parent_sauce_id makes a row a variant of another sauce; one level
-- deep, enforced by sauceboss_sauce_variant_check.
CREATE TABLE IF NOT EXISTS public.sauceboss_sauce (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  cuisine         TEXT NOT NULL,
  color           TEXT NOT NULL,
  description     TEXT NOT NULL,
  source_url      TEXT,                       -- optional URL the sauce was imported from
  sauce_type      TEXT NOT NULL,              -- no constraints; see SauceType enum in backend
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  parent_sauce_id TEXT REFERENCES public.sauceboss_sauce(id) ON DELETE SET NULL,
  default_servings SMALLINT NOT NULL DEFAULT 2,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- latest-first sort key for Browse
  CONSTRAINT sauceboss_sauce_parent_self_chk CHECK (parent_sauce_id IS NULL OR parent_sauce_id <> id),
  CONSTRAINT sauceboss_sauce_default_servings_range CHECK (default_servings BETWEEN 1 AND 12)
);
ALTER TABLE public.sauceboss_sauce ENABLE ROW LEVEL SECURITY;


-- Ordered cooking steps per recipe.
CREATE TABLE IF NOT EXISTS public.sauceboss_sauce_step (
  id              BIGSERIAL PRIMARY KEY,
  sauce_id        TEXT    NOT NULL REFERENCES public.sauceboss_sauce(id) ON DELETE CASCADE,
  step_order      INTEGER NOT NULL,
  title           TEXT    NOT NULL,
  instructions    TEXT,                                  -- optional paragraph
  input_from_step INT     DEFAULT NULL,                  -- compat: first element of input_from_steps
  input_from_steps INT[]  NOT NULL DEFAULT '{}',         -- prior steps that feed into this one
  estimated_time  INT                                    -- minutes, nullable
);
ALTER TABLE public.sauceboss_sauce_step ENABLE ROW LEVEL SECURITY;


-- Per-step ingredient row. Mealie's RecipeIngredientModel-inspired shape:
-- ingredient_id + unit_id + quantity + original_text + canonical mL/g.
-- quantity_canonical_ml or quantity_canonical_g is set based on the unit's
-- dimension; the other side is null until a curated density map is added
-- (volume↔mass cross-conversion).
CREATE TABLE IF NOT EXISTS public.sauceboss_sauce_step_ingredient (
  id                    BIGSERIAL PRIMARY KEY,
  step_id               BIGINT NOT NULL REFERENCES public.sauceboss_sauce_step(id) ON DELETE CASCADE,
  ingredient_id         TEXT REFERENCES public.sauceboss_ingredient(id) ON DELETE SET NULL,
  unit_id               TEXT REFERENCES public.sauceboss_unit(id) ON DELETE SET NULL,
  original_text         TEXT,
  quantity              NUMERIC(12, 4),
  quantity_canonical_ml DOUBLE PRECISION,
  quantity_canonical_g  DOUBLE PRECISION
);
ALTER TABLE public.sauceboss_sauce_step_ingredient ENABLE ROW LEVEL SECURITY;


-- Source of truth for sauce ↔ dish targeting. A sauce can attach at category
-- level (applies to every dish + subtype in that category), at dish level
-- (the dish + its subtypes), or at subtype level (one specific subtype). The
-- sauceboss_sauce_to_dish_check trigger validates that:
--   * category targets are one of carb/protein/salad and match the sauce's
--     type-category map (sauce + dip → carb, marinade → protein,
--     dressing → salad — see sauceboss_type_to_category()).
--   * dish/subtype targets resolve to a dish row with the matching dish_level
--     and a category matching the type-category map.
--   * full_recipe sauces cannot have any attachments.
CREATE TABLE IF NOT EXISTS public.sauceboss_sauce_to_dish (
  sauce_id     TEXT NOT NULL REFERENCES public.sauceboss_sauce(id) ON DELETE CASCADE,
  target_kind  TEXT NOT NULL CHECK (target_kind IN ('category','dish','subtype')),
  target_value TEXT NOT NULL,
  PRIMARY KEY (sauce_id, target_kind, target_value)
);
ALTER TABLE public.sauceboss_sauce_to_dish ENABLE ROW LEVEL SECURITY;


-- Supabase-Auth-backed user profiles. A single global ADMIN_API_KEY promotes
-- a profile to admin via POST /api/v1/sauceboss/profile/become-admin.
CREATE TABLE IF NOT EXISTS public.sauceboss_user_profiles (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_url   TEXT,
  is_admin     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.sauceboss_user_profiles ENABLE ROW LEVEL SECURITY;


-- Per-user library (references, not copies). Editing a non-owned sauce
-- triggers fork_sauceboss_sauce(), which creates a new variant under the
-- family root, owned by the editing user, and repoints the user's
-- sauceboss_user_saucebook row to the new variant.
CREATE TABLE IF NOT EXISTS public.sauceboss_user_saucebook (
  user_id  UUID NOT NULL REFERENCES public.sauceboss_user_profiles(id) ON DELETE CASCADE,
  sauce_id TEXT NOT NULL REFERENCES public.sauceboss_sauce(id)         ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, sauce_id)
);
ALTER TABLE public.sauceboss_user_saucebook ENABLE ROW LEVEL SECURITY;


-- Negative pantry list. A row means the user is OUT of that ingredient.
-- Default (empty) = "have everything". Keyed by ingredient_id so
-- merge_sauceboss_ingredients keeps the pantry consistent.
CREATE TABLE IF NOT EXISTS public.sauceboss_user_pantry_missing (
  user_id       UUID NOT NULL REFERENCES public.sauceboss_user_profiles(id) ON DELETE CASCADE,
  ingredient_id TEXT NOT NULL REFERENCES public.sauceboss_ingredient(id)    ON DELETE CASCADE,
  PRIMARY KEY (user_id, ingredient_id)
);
ALTER TABLE public.sauceboss_user_pantry_missing ENABLE ROW LEVEL SECURITY;


-- ── RPCs (returns shape only — see migration 013 for bodies) ────────────────
--   get_sauceboss_initial_load()                       → { carbs, proteins, saladBases }
--   get_sauceboss_items_by_category(p_category)        → dishes for one category, with subtypes nested
--   get_sauceboss_variants_for_item(p_item_id)         → subtype rows for a dish
--   get_sauceboss_sauces_for_item(p_item_id)           → fully assembled sauces linked to a dish/subtype
--   get_sauceboss_sauces_for_target(cat, dish, sub)    → resolver used by the meal-builder flow (union of
--                                                        category / dish / subtype / parent-dish matches)
--   get_sauceboss_ingredients_for_item(p_item_id)      → distinct ingredient names for a dish/subtype
--   get_sauceboss_item_load(p_item_id)                 → { item, variants, sauces, ingredients }
--   get_sauceboss_all_sauces() / _full()               → admin/import lists; _full includes steps + ingredients
--   create_sauceboss_sauce(p_data) / update_… / fork_… → atomic write paths; auto-upsert cuisine_info
--   get_sauceboss_saucebook(p_user_id)                 → user library, slim envelopes (Browse-shaped + addedAt + ingredientNames TEXT[])
--   get_sauceboss_browse(p_user_id, p_q, p_cuisines, p_types, p_author, p_limit, p_offset)
--                                                       → paginated lightweight rows + variant count + inSaucebook flag.
--                                                         Sorted by created_at DESC, family roots only.
--   get_sauceboss_browse_authors(p_q)                  → author autocomplete for the Browse filter
--   get_sauceboss_pantry_for_user(p_user_id)           → ingredients in saucebook with `category`
--                                                         (sauceboss_ingredient.category, NULL when uncategorized)
--                                                         + missing flag — one round-trip; eliminates the
--                                                         standalone /ingredient-categories call on the pantry path (migration 015).
--   set_sauceboss_pantry_missing(p_user_id, p_ingredient_ids[]) → replace user's missing set in one round-trip
--   list_sauceboss_ingredients_with_usage()            → ingredients with recipe usage counts
--   merge_sauceboss_ingredients(keep, merge_ids[])     → atomic merge + repoint
--   delete_sauceboss_ingredient_safe(id)               → returns usage count; refuses if >0
--
-- JSON contract: every sauce envelope emits cuisineEmoji (joined from
-- sauceboss_cuisine_info), attachments[], and ingredient rows with
-- ingredientId (was foodId before migration 013). compatibleItems[] is no
-- longer emitted — frontends now read attachments directly.
--
-- ── release/sauceboss-1.0 compat layer (migration 014) ─────────────────────
-- The release-branch web/native (commit 13d7461 on origin/release/sauceboss-1.0)
-- predates 013 and reads legacy field names. Migration 014 makes every read
-- RPC dual-emit:
--   * each ingredient row carries BOTH `foodId` and `ingredientId` (same value);
--   * each sauce envelope emits a `compatibleItems[]` array synthesized from
--     sauceboss_sauce_to_dish where target_kind='dish';
--   * `cuisineEmoji` continues to come from the sauceboss_cuisine_info JOIN.
-- 014 also re-adds `get_sauceboss_ingredient_categories` /
-- `get_sauceboss_substitutions` / `upsert_sauceboss_ingredient_category` —
-- all reading from `sauceboss_ingredient.{category, substitutions[]}`.
--
-- HTTP-side compat (shared-backend/routes/sauceboss/):
--   * /api/v1/sauceboss/foods, /foods-with-usage, /admin/foods/*  — aliases
--     that wrap the post-013 /ingredients endpoints with the legacy
--     `{foods: [...]}` envelope.
--   * /api/v1/sauceboss/favorites GET/PUT/DELETE — backed by
--     sauceboss_user_saucebook (favorites table is NOT resurrected).
--   * POST /api/v1/sauceboss/ingredient-categories — writes through to
--     `sauceboss_ingredient.category` via the upsert RPC.
--   * PUT /pantry accepts BOTH `missingFoodIds` and `missingIngredientIds`;
--     PantryEntry rows expose both `foodId` and `ingredientId`.
--
-- Drop the compat layer in a follow-up migration once release/sauceboss-1.0
-- is retired (delete the dual-emit fields, the lookup-table RPCs, and the
-- shim HTTP routes — schema itself is unchanged).
