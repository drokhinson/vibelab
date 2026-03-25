-- ─────────────────────────────────────────────────────────────────────────────
-- SauceBoss — current schema snapshot
-- Last updated: migration 036
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sauceboss_carbs (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  emoji              TEXT NOT NULL,
  description        TEXT NOT NULL,
  portion_per_person REAL NOT NULL DEFAULT 100,
  portion_unit       TEXT NOT NULL DEFAULT 'g',
  cook_time_minutes  INT,
  cook_time_label    TEXT
);
ALTER TABLE public.sauceboss_carbs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.sauceboss_sauces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  cuisine       TEXT NOT NULL,
  cuisine_emoji TEXT NOT NULL,
  color         TEXT NOT NULL,
  description   TEXT NOT NULL,
  sauce_type    TEXT NOT NULL DEFAULT 'sauce' CHECK (sauce_type IN ('sauce', 'dressing', 'marinade')),
  servings      INT,
  yield_quantity REAL,
  yield_unit    TEXT,
  source_url    TEXT,
  source_name   TEXT
);
ALTER TABLE public.sauceboss_sauces ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.sauceboss_sauce_carbs (
  sauce_id TEXT NOT NULL REFERENCES public.sauceboss_sauces(id) ON DELETE CASCADE,
  carb_id  TEXT NOT NULL REFERENCES public.sauceboss_carbs(id)  ON DELETE CASCADE,
  PRIMARY KEY (sauce_id, carb_id)
);
ALTER TABLE public.sauceboss_sauce_carbs ENABLE ROW LEVEL SECURITY;

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
  id            BIGSERIAL PRIMARY KEY,
  step_id       BIGINT NOT NULL REFERENCES public.sauceboss_sauce_steps(id) ON DELETE CASCADE,
  name          TEXT   NOT NULL,
  amount        REAL   NOT NULL,
  unit          TEXT   NOT NULL,
  unit_type     TEXT   NOT NULL DEFAULT 'volume' CHECK (unit_type IN ('volume', 'weight', 'count')),
  original_text TEXT
);

CREATE TABLE IF NOT EXISTS public.sauceboss_units (
  abbreviation  TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  unit_type     TEXT NOT NULL CHECK (unit_type IN ('volume', 'weight', 'count')),
  standard_unit TEXT NOT NULL,
  to_ml         REAL,
  to_g          REAL
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

CREATE TABLE IF NOT EXISTS public.sauceboss_carb_preparations (
  id               TEXT PRIMARY KEY,
  carb_id          TEXT NOT NULL REFERENCES public.sauceboss_carbs(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  emoji            TEXT,
  water_ratio      TEXT,
  cook_time        TEXT,
  instructions     TEXT,
  sort_order       INT  DEFAULT 0,
  cook_time_minutes INT
);
ALTER TABLE public.sauceboss_carb_preparations ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.sauceboss_addons (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('protein', 'veggie')),
  name           TEXT NOT NULL,
  emoji          TEXT NOT NULL,
  description    TEXT NOT NULL,
  instructions   TEXT NOT NULL,
  estimated_time INT  NOT NULL,
  sort_order     INT  DEFAULT 0
);
ALTER TABLE public.sauceboss_addons ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.sauceboss_salad_bases (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  description TEXT
);
ALTER TABLE public.sauceboss_salad_bases ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.sauceboss_sauce_salad_bases (
  sauce_id TEXT REFERENCES public.sauceboss_sauces(id)       ON DELETE CASCADE,
  base_id  TEXT REFERENCES public.sauceboss_salad_bases(id)  ON DELETE CASCADE,
  PRIMARY KEY (sauce_id, base_id)
);
ALTER TABLE public.sauceboss_sauce_salad_bases ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.sauceboss_sauce_proteins (
  sauce_id TEXT REFERENCES public.sauceboss_sauces(id) ON DELETE CASCADE,
  addon_id TEXT REFERENCES public.sauceboss_addons(id) ON DELETE CASCADE,
  PRIMARY KEY (sauce_id, addon_id)
);
ALTER TABLE public.sauceboss_sauce_proteins ENABLE ROW LEVEL SECURITY;
