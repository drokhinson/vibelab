-- ─────────────────────────────────────────────────────────────────────────────
-- SauceBoss — current schema snapshot
-- Last updated: migration 056 (unified items table)
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

CREATE TABLE IF NOT EXISTS public.sauceboss_step_ingredients (
  id      BIGSERIAL PRIMARY KEY,
  step_id BIGINT NOT NULL REFERENCES public.sauceboss_sauce_steps(id) ON DELETE CASCADE,
  name    TEXT   NOT NULL,
  amount  REAL   NOT NULL,
  unit    TEXT   NOT NULL
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
