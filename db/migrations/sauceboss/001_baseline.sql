-- ─────────────────────────────────────────────────────────────────────────────
-- sauceboss — consolidated baseline
-- Replaces legacy db/migrations/{001,002,004-008,013-016,021-023,049-054,
--   056,058-060,063,065-067}_sauceboss_*.sql
-- (data-only migrations 003 + 006 + 014 + 023 + 065 are folded into 002_seed.sql.)
-- FRESH-DB ONLY. Production is already at this state. Do not run on existing DB.
--
-- Folded-in changes from migrations 065-067 (post-063, on main):
--   * 065: broth ingredient categories — added to 002_seed.sql.
--   * 066: sauceboss_sauces.source_url column + sourceUrl field on the JSON
--     output of get_sauceboss_all_sauces_full / get_sauceboss_sauces_for_item
--     and on create_sauceboss_sauce input.
--   * 067: ingredient admin RPCs — list_sauceboss_foods_with_usage,
--     merge_sauceboss_foods, delete_sauceboss_food_safe.
--
-- Excluded from baseline because they were added and later dropped:
--   * sauceboss_carbs               — folded into sauceboss_items by 052,
--                                     dropped by 056.
--   * sauceboss_addons              — proteins folded into sauceboss_items by
--                                     052; veggies discarded; dropped by 056.
--   * sauceboss_salad_bases         — folded into sauceboss_items by 052,
--                                     dropped by 056.
--   * sauceboss_carb_preparations   — folded into sauceboss_items as Variant
--                                     rows by 052, dropped by 056.
--   * sauceboss_sauce_carbs         — replaced by sauceboss_sauce_items in
--                                     053, dropped by 056.
--   * sauceboss_sauce_proteins      — replaced by sauceboss_sauce_items in
--                                     053, dropped by 056.
--   * sauceboss_sauce_salad_bases   — replaced by sauceboss_sauce_items in
--                                     053, dropped by 056.
--   * sauceboss_step_ingredients.{name,amount,unit} — replaced by food_id /
--                                     unit_id / quantity / canonical fields
--                                     by 063 (Mealie-inspired normalization).
--   * sauceboss_carbs.cook_time_label — discarded by 052 (UI now formats
--                                     minutes directly).
--   * Veggie addon rows (mushrooms, fajita-veggies, roasted-broccoli,
--                                     sauteed-spinach) — not migrated to
--                                     sauceboss_items by 052; dropped with
--                                     sauceboss_addons by 056.
--
-- Superseded RPCs intentionally NOT carried forward (see 056 + 063):
--   get_sauceboss_carbs_with_count, get_sauceboss_proteins,
--   get_sauceboss_salad_bases_with_count, get_sauceboss_carb_preparations,
--   get_sauceboss_addons, get_sauceboss_carb_load, get_sauceboss_protein_load,
--   get_sauceboss_salad_base_load, get_sauceboss_sauces_for_carb,
--   get_sauceboss_marinades_for_protein, get_sauceboss_dressings_for_base,
--   get_sauceboss_ingredients_for_carb, get_sauceboss_ingredients_for_protein,
--   get_sauceboss_ingredients_for_base.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Project role ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sauceboss_role') THEN
    CREATE ROLE sauceboss_role LOGIN PASSWORD 'change-me-via-shared-003' NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO sauceboss_role;


-- ── Unit registry (migration 063, Mealie-inspired) ───────────────────────────
-- Single source of truth for unit names, abbreviations, plurals, dimension
-- (volume / mass / count) and canonical conversion factors. The backend
-- mirrors this table in routes/sauceboss/units.py — keep both sides in sync.
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
GRANT SELECT ON public.sauceboss_units TO sauceboss_role;


-- ── Foods registry (migration 063, Mealie-inspired) ──────────────────────────
-- One row per distinct ingredient food, keyed by lower(trim(name)).
-- Auto-populated by create_sauceboss_sauce on insert.
-- TODO(density): add density_g_per_ml column when a curated density map is
-- added — this unlocks volume↔mass conversion. See routes/sauceboss/units.py
-- DENSITY_TODO.
CREATE TABLE IF NOT EXISTS public.sauceboss_foods (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  plural          TEXT,
  name_normalized TEXT NOT NULL UNIQUE,
  aliases         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sauceboss_foods_name_normalized
  ON public.sauceboss_foods (name_normalized);
ALTER TABLE public.sauceboss_foods ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_foods TO sauceboss_role;


-- ── Unified items table (migration 050) ──────────────────────────────────────
-- Replaces the four legacy parallel selector tables (sauceboss_carbs /
-- sauceboss_addons / sauceboss_salad_bases / sauceboss_carb_preparations).
-- Type rows have parent_id IS NULL; Variant rows (e.g. basmati rice as a
-- prep variant of rice) point at their Type via parent_id.
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
CREATE INDEX IF NOT EXISTS sauceboss_items_type_by_category_idx
  ON public.sauceboss_items(category)
  WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS sauceboss_items_variants_by_parent_idx
  ON public.sauceboss_items(parent_id)
  WHERE parent_id IS NOT NULL;
ALTER TABLE public.sauceboss_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_items TO sauceboss_role;


-- ── Sauces (migration 001 + sauce_type column from 021) ──────────────────────
-- sauce_type values:
--   'sauce'    — pairs with carb items
--   'dressing' — pairs with salad items
--   'marinade' — pairs with protein items
-- Alignment is enforced at write time by the trigger on sauceboss_sauce_items.
CREATE TABLE IF NOT EXISTS public.sauceboss_sauces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  cuisine       TEXT NOT NULL,
  cuisine_emoji TEXT NOT NULL,
  color         TEXT NOT NULL,
  description   TEXT NOT NULL,
  source_url    TEXT,                                                          -- migration 066: optional URL the sauce was imported from
  sauce_type    TEXT NOT NULL DEFAULT 'sauce' CHECK (sauce_type IN ('sauce', 'dressing', 'marinade'))
);
CREATE INDEX IF NOT EXISTS idx_sauceboss_sauces_sauce_type
  ON public.sauceboss_sauces(sauce_type);
ALTER TABLE public.sauceboss_sauces ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_sauces TO sauceboss_role;


-- ── Sauce ↔ Item junction (migration 051) ────────────────────────────────────
-- Replaces the three legacy junctions (sauce_carbs / sauce_proteins /
-- sauce_salad_bases). Trigger below enforces:
--   • sauce.sauce_type matches item.category (sauce↔carb, marinade↔protein,
--     dressing↔salad)
--   • item.parent_id IS NULL — sauces link to Type rows, never Variant rows.
CREATE TABLE IF NOT EXISTS public.sauceboss_sauce_items (
  sauce_id TEXT NOT NULL REFERENCES public.sauceboss_sauces(id) ON DELETE CASCADE,
  item_id  TEXT NOT NULL REFERENCES public.sauceboss_items(id)  ON DELETE CASCADE,
  PRIMARY KEY (sauce_id, item_id)
);
CREATE INDEX IF NOT EXISTS sauceboss_sauce_items_by_item_idx
  ON public.sauceboss_sauce_items(item_id);
ALTER TABLE public.sauceboss_sauce_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_sauce_items TO sauceboss_role;


-- ── Sauce steps (migration 001 + input_from_step from 008 + estimated_time
-- from 013) ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sauceboss_sauce_steps (
  id              BIGSERIAL PRIMARY KEY,
  sauce_id        TEXT    NOT NULL REFERENCES public.sauceboss_sauces(id) ON DELETE CASCADE,
  step_order      INTEGER NOT NULL,
  title           TEXT    NOT NULL,
  input_from_step INT     DEFAULT NULL,
  estimated_time  INT                       -- minutes, nullable
);
CREATE INDEX IF NOT EXISTS idx_sauceboss_sauce_steps_sauce_id
  ON public.sauceboss_sauce_steps(sauce_id);
ALTER TABLE public.sauceboss_sauce_steps ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_sauce_steps TO sauceboss_role;


-- ── Step ingredients (post-063 normalized shape) ─────────────────────────────
-- Mealie's RecipeIngredientModel-inspired shape: food_id + unit_id + quantity
-- + original_text + canonical mL/g. The legacy name/amount/unit columns from
-- migration 001 were dropped by 063; foods/units are now looked up via FKs
-- and joined for display. quantity_canonical_ml or quantity_canonical_g is
-- set based on the unit's dimension; the other side is null until a curated
-- density map is added (volume↔mass cross-conversion).
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
CREATE INDEX IF NOT EXISTS idx_sauceboss_step_ing_step_id
  ON public.sauceboss_step_ingredients(step_id);
ALTER TABLE public.sauceboss_step_ingredients ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_step_ingredients TO sauceboss_role;


-- ── Ingredient categories (migration 004) ────────────────────────────────────
-- Lookup table mapping ingredient name → category (Produce, Dairy, etc.).
-- Used by the shopping-list grouping in the web prototype.
CREATE TABLE IF NOT EXISTS public.sauceboss_ingredient_categories (
  ingredient_name TEXT PRIMARY KEY,
  category        TEXT NOT NULL
);
ALTER TABLE public.sauceboss_ingredient_categories ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_ingredient_categories TO sauceboss_role;


-- ── Ingredient substitutions (migration 004) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sauceboss_ingredient_substitutions (
  id              SERIAL PRIMARY KEY,
  ingredient_name TEXT NOT NULL,
  substitute_name TEXT NOT NULL,
  notes           TEXT,
  UNIQUE(ingredient_name, substitute_name)
);
ALTER TABLE public.sauceboss_ingredient_substitutions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_ingredient_substitutions TO sauceboss_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Trigger functions
-- ─────────────────────────────────────────────────────────────────────────────

-- Integrity trigger for sauceboss_sauce_items (migration 051): keeps
-- sauce_type ↔ item.category aligned and rejects links to variant rows.
CREATE OR REPLACE FUNCTION public.sauceboss_sauce_items_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_type TEXT;
  v_category   TEXT;
  v_parent_id  TEXT;
BEGIN
  SELECT sauce_type INTO v_sauce_type
  FROM public.sauceboss_sauces
  WHERE id = NEW.sauce_id;

  SELECT category, parent_id INTO v_category, v_parent_id
  FROM public.sauceboss_items
  WHERE id = NEW.item_id;

  IF v_parent_id IS NOT NULL THEN
    RAISE EXCEPTION 'sauceboss_sauce_items: item % is a Variant (parent_id=%); sauces must link to Type rows only',
      NEW.item_id, v_parent_id;
  END IF;

  IF (v_sauce_type = 'sauce'    AND v_category <> 'carb')    OR
     (v_sauce_type = 'marinade' AND v_category <> 'protein') OR
     (v_sauce_type = 'dressing' AND v_category <> 'salad') THEN
    RAISE EXCEPTION 'sauceboss_sauce_items: sauce_type=% does not match item.category=% (sauce=%, item=%)',
      v_sauce_type, v_category, NEW.sauce_id, NEW.item_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sauceboss_sauce_items_check_trg ON public.sauceboss_sauce_items;
CREATE TRIGGER sauceboss_sauce_items_check_trg
  BEFORE INSERT OR UPDATE ON public.sauceboss_sauce_items
  FOR EACH ROW EXECUTE FUNCTION public.sauceboss_sauce_items_check();


-- ─────────────────────────────────────────────────────────────────────────────
-- RPCs (latest version of each carried forward; superseded versions excluded)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── get_sauceboss_items_by_category (latest from 059) ───────────────────────
-- Per-category type-row listing. Uniform field shape across categories.
CREATE OR REPLACE FUNCTION public.get_sauceboss_items_by_category(p_category TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."sortOrder", t.name), '[]'::json)
  FROM (
    SELECT
      i.id,
      i.category,
      i.name,
      i.emoji,
      i.description,
      i.instructions,
      i.water_ratio        AS "waterRatio",
      i.cook_time_minutes  AS "cookTimeMinutes",
      i.portion_per_person AS "portionPerPerson",
      i.portion_unit       AS "portionUnit",
      i.sort_order         AS "sortOrder",
      (SELECT COUNT(*)::int FROM public.sauceboss_sauce_items si WHERE si.item_id = i.id) AS "sauceCount"
    FROM public.sauceboss_items i
    WHERE i.category = p_category AND i.parent_id IS NULL
  ) t;
$$;


-- ── get_sauceboss_initial_load (latest from 059) ────────────────────────────
-- Home-screen load: carbs + proteins + salad bases in one round-trip.
CREATE OR REPLACE FUNCTION public.get_sauceboss_initial_load()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT json_build_object(
    'carbs',      public.get_sauceboss_items_by_category('carb'),
    'proteins',   public.get_sauceboss_items_by_category('protein'),
    'saladBases', public.get_sauceboss_items_by_category('salad')
  );
$$;


-- ── get_sauceboss_variants_for_item (from 054) ──────────────────────────────
-- Returns child rows (parent_id = p_item_id) ordered by sort_order.
CREATE OR REPLACE FUNCTION public.get_sauceboss_variants_for_item(p_item_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."sortOrder", t.name), '[]'::json)
  FROM (
    SELECT
      i.id,
      i.name,
      i.emoji,
      i.description,
      i.cook_time_minutes  AS "cookTimeMinutes",
      i.water_ratio        AS "waterRatio",
      i.instructions,
      i.sort_order         AS "sortOrder"
    FROM public.sauceboss_items i
    WHERE i.parent_id = p_item_id
  ) t;
$$;


-- ── get_sauceboss_sauces_for_item (latest from 063) ─────────────────────────
-- Returns fully assembled sauce objects linked to an item, with normalized
-- ingredient rows (food/unit FKs joined for display, plus canonical mL/g).
CREATE OR REPLACE FUNCTION public.get_sauceboss_sauces_for_item(p_item_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',              s.id,
      'name',            s.name,
      'cuisine',         s.cuisine,
      'cuisineEmoji',    s.cuisine_emoji,
      'color',           s.color,
      'description',     s.description,
      'sauceType',       s.sauce_type,
      'compatibleItems', (
        SELECT COALESCE(json_agg(si2.item_id), '[]'::json)
        FROM public.sauceboss_sauce_items si2
        WHERE si2.sauce_id = s.id
      ),
      'ingredients', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'name',         di.food_name,
            'amount',       di.quantity,
            'unit',         di.unit_abbr,
            'unitId',       di.unit_id,
            'foodId',       di.food_id,
            'originalText', di.original_text,
            'canonicalMl',  di.canonical_ml,
            'canonicalG',   di.canonical_g
          )
          ORDER BY di.step_order, di.id
        ), '[]'::json)
        FROM (
          SELECT DISTINCT ON (di_inner.food_name)
            di_inner.id, di_inner.food_name, di_inner.quantity, di_inner.unit_abbr,
            di_inner.unit_id, di_inner.food_id, di_inner.original_text,
            di_inner.canonical_ml, di_inner.canonical_g, di_inner.step_order
          FROM (
            SELECT
              si_inner.id,
              COALESCE(f.name, si_inner.original_text) AS food_name,
              si_inner.quantity::double precision AS quantity,
              COALESCE(u.abbreviation, '') AS unit_abbr,
              si_inner.unit_id,
              si_inner.food_id,
              si_inner.original_text,
              si_inner.quantity_canonical_ml AS canonical_ml,
              si_inner.quantity_canonical_g  AS canonical_g,
              ss_inner.step_order
            FROM public.sauceboss_sauce_steps ss_inner
            JOIN public.sauceboss_step_ingredients si_inner ON si_inner.step_id = ss_inner.id
            LEFT JOIN public.sauceboss_foods f ON f.id = si_inner.food_id
            LEFT JOIN public.sauceboss_units u ON u.id = si_inner.unit_id
            WHERE ss_inner.sauce_id = s.id
          ) di_inner
          ORDER BY di_inner.food_name, di_inner.step_order, di_inner.id
        ) di
      ),
      'steps', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'title',         ss.title,
            'estimatedTime', ss.estimated_time,
            'inputFromStep', ss.input_from_step,
            'ingredients', (
              SELECT COALESCE(json_agg(
                json_build_object(
                  'name',         COALESCE(f.name, si.original_text),
                  'amount',       si.quantity::double precision,
                  'unit',         COALESCE(u.abbreviation, ''),
                  'unitId',       si.unit_id,
                  'foodId',       si.food_id,
                  'originalText', si.original_text,
                  'canonicalMl',  si.quantity_canonical_ml,
                  'canonicalG',   si.quantity_canonical_g
                )
                ORDER BY si.id
              ), '[]'::json)
              FROM public.sauceboss_step_ingredients si
              LEFT JOIN public.sauceboss_foods f ON f.id = si.food_id
              LEFT JOIN public.sauceboss_units u ON u.id = si.unit_id
              WHERE si.step_id = ss.id
            )
          )
          ORDER BY ss.step_order
        ), '[]'::json)
        FROM public.sauceboss_sauce_steps ss
        WHERE ss.sauce_id = s.id
      )
    ) AS sauce_obj
    FROM public.sauceboss_sauces s
    JOIN public.sauceboss_sauce_items link
      ON link.sauce_id = s.id AND link.item_id = p_item_id
  ) sub;
$$;


-- ── get_sauceboss_ingredients_for_item (latest from 063) ────────────────────
-- Distinct ingredient names across all sauces linked to the item; reads from
-- the foods table with original_text fallback.
CREATE OR REPLACE FUNCTION public.get_sauceboss_ingredients_for_item(p_item_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(name ORDER BY name), '[]'::json)
  FROM (
    SELECT DISTINCT COALESCE(f.name, si.original_text) AS name
    FROM public.sauceboss_sauce_items link
    JOIN public.sauceboss_sauce_steps ss      ON ss.sauce_id = link.sauce_id
    JOIN public.sauceboss_step_ingredients si ON si.step_id = ss.id
    LEFT JOIN public.sauceboss_foods f        ON f.id = si.food_id
    WHERE link.item_id = p_item_id
      AND COALESCE(f.name, si.original_text) IS NOT NULL
  ) sub;
$$;


-- ── get_sauceboss_item_load (from 054) ──────────────────────────────────────
-- Combined per-item load: { item, variants, sauces, ingredients } — one
-- round-trip per user selection.
CREATE OR REPLACE FUNCTION public.get_sauceboss_item_load(p_item_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT json_build_object(
    'item', (
      SELECT json_build_object(
        'id',                i.id,
        'category',          i.category,
        'name',              i.name,
        'emoji',             i.emoji,
        'description',       i.description,
        'cookTimeMinutes',   i.cook_time_minutes,
        'instructions',      i.instructions,
        'waterRatio',        i.water_ratio,
        'portionPerPerson',  i.portion_per_person,
        'portionUnit',       i.portion_unit
      )
      FROM public.sauceboss_items i
      WHERE i.id = p_item_id AND i.parent_id IS NULL
    ),
    'variants',    public.get_sauceboss_variants_for_item(p_item_id),
    'sauces',      public.get_sauceboss_sauces_for_item(p_item_id),
    'ingredients', public.get_sauceboss_ingredients_for_item(p_item_id)
  );
$$;


-- ── get_sauceboss_all_sauces (latest from 059) ──────────────────────────────
-- Admin sauce listing — uniform compatibleItems regardless of sauce_type.
CREATE OR REPLACE FUNCTION public.get_sauceboss_all_sauces()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(
    json_build_object(
      'id',              s.id,
      'name',            s.name,
      'cuisine',         s.cuisine,
      'cuisineEmoji',    s.cuisine_emoji,
      'color',           s.color,
      'description',     s.description,
      'sauceType',       s.sauce_type,
      'compatibleItems', (
        SELECT COALESCE(json_agg(link.item_id ORDER BY link.item_id), '[]'::json)
        FROM public.sauceboss_sauce_items link
        WHERE link.sauce_id = s.id
      )
    )
    ORDER BY s.cuisine, s.name
  ), '[]'::json)
  FROM public.sauceboss_sauces s;
$$;


-- ── get_sauceboss_all_sauces_full (latest from 063) ─────────────────────────
-- Public guest sauce manager — full sauces grid with normalized ingredients.
CREATE OR REPLACE FUNCTION public.get_sauceboss_all_sauces_full()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'cuisine', sauce_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',              s.id,
      'name',            s.name,
      'cuisine',         s.cuisine,
      'cuisineEmoji',    s.cuisine_emoji,
      'color',           s.color,
      'description',     s.description,
      'sauceType',       s.sauce_type,
      'compatibleItems', (
        SELECT COALESCE(json_agg(link.item_id), '[]'::json)
        FROM public.sauceboss_sauce_items link
        WHERE link.sauce_id = s.id
      ),
      'ingredients', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'name',         di.food_name,
            'amount',       di.quantity,
            'unit',         di.unit_abbr,
            'unitId',       di.unit_id,
            'foodId',       di.food_id,
            'originalText', di.original_text,
            'canonicalMl',  di.canonical_ml,
            'canonicalG',   di.canonical_g
          )
          ORDER BY di.step_order, di.id
        ), '[]'::json)
        FROM (
          SELECT DISTINCT ON (di_inner.food_name)
            di_inner.id, di_inner.food_name, di_inner.quantity, di_inner.unit_abbr,
            di_inner.unit_id, di_inner.food_id, di_inner.original_text,
            di_inner.canonical_ml, di_inner.canonical_g, di_inner.step_order
          FROM (
            SELECT
              si_inner.id,
              COALESCE(f.name, si_inner.original_text) AS food_name,
              si_inner.quantity::double precision AS quantity,
              COALESCE(u.abbreviation, '') AS unit_abbr,
              si_inner.unit_id,
              si_inner.food_id,
              si_inner.original_text,
              si_inner.quantity_canonical_ml AS canonical_ml,
              si_inner.quantity_canonical_g  AS canonical_g,
              ss_inner.step_order
            FROM public.sauceboss_sauce_steps ss_inner
            JOIN public.sauceboss_step_ingredients si_inner ON si_inner.step_id = ss_inner.id
            LEFT JOIN public.sauceboss_foods f ON f.id = si_inner.food_id
            LEFT JOIN public.sauceboss_units u ON u.id = si_inner.unit_id
            WHERE ss_inner.sauce_id = s.id
          ) di_inner
          ORDER BY di_inner.food_name, di_inner.step_order, di_inner.id
        ) di
      ),
      'steps', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'title',         ss.title,
            'estimatedTime', ss.estimated_time,
            'inputFromStep', ss.input_from_step,
            'ingredients', (
              SELECT COALESCE(json_agg(
                json_build_object(
                  'name',         COALESCE(f.name, si.original_text),
                  'amount',       si.quantity::double precision,
                  'unit',         COALESCE(u.abbreviation, ''),
                  'unitId',       si.unit_id,
                  'foodId',       si.food_id,
                  'originalText', si.original_text,
                  'canonicalMl',  si.quantity_canonical_ml,
                  'canonicalG',   si.quantity_canonical_g
                )
                ORDER BY si.id
              ), '[]'::json)
              FROM public.sauceboss_step_ingredients si
              LEFT JOIN public.sauceboss_foods f ON f.id = si.food_id
              LEFT JOIN public.sauceboss_units u ON u.id = si.unit_id
              WHERE si.step_id = ss.id
            )
          )
          ORDER BY ss.step_order
        ), '[]'::json)
        FROM public.sauceboss_sauce_steps ss
        WHERE ss.sauce_id = s.id
      )
    ) AS sauce_obj
    FROM public.sauceboss_sauces s
  ) sub;
$$;


-- ── get_sauceboss_ingredient_categories (from 005) ──────────────────────────
CREATE OR REPLACE FUNCTION public.get_sauceboss_ingredient_categories()
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(
      json_build_object(
        'ingredientName', ingredient_name,
        'category', category
      )
    ), '[]'::json)
    FROM public.sauceboss_ingredient_categories
  );
END;
$$;


-- ── get_sauceboss_substitutions (from 005) ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_sauceboss_substitutions()
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(
      json_build_object(
        'ingredientName', ingredient_name,
        'substituteName', substitute_name,
        'notes', notes
      )
    ), '[]'::json)
    FROM public.sauceboss_ingredient_substitutions
  );
END;
$$;


-- ── upsert_sauceboss_ingredient_category (from 008) ─────────────────────────
-- Used when the user classifies a new ingredient at sauce-creation time.
CREATE OR REPLACE FUNCTION public.upsert_sauceboss_ingredient_category(
  p_ingredient_name TEXT,
  p_category TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.sauceboss_ingredient_categories (ingredient_name, category)
  VALUES (p_ingredient_name, p_category)
  ON CONFLICT (ingredient_name) DO UPDATE SET category = p_category;
END;
$$;


-- ── create_sauceboss_sauce (latest from 063) ────────────────────────────────
-- Atomic sauce creation. Resolves food_id from name (auto-upserts foods);
-- the backend fills in unitId + canonicalMl / canonicalG on the way in.
-- The trigger on sauceboss_sauce_items rejects any item whose category does
-- not match the sauce's sauce_type.
CREATE OR REPLACE FUNCTION public.create_sauceboss_sauce(p_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_id   TEXT;
  v_sauce_type TEXT;
  v_step       JSONB;
  v_step_id    BIGINT;
  v_ing        JSONB;
  v_item       TEXT;
  v_food_name  TEXT;
  v_food_norm  TEXT;
  v_food_id    TEXT;
BEGIN
  v_sauce_id   := p_data->>'id';
  v_sauce_type := COALESCE(p_data->>'sauceType', 'sauce');

  INSERT INTO public.sauceboss_sauces (id, name, cuisine, cuisine_emoji, color, description, sauce_type, source_url)
  VALUES (
    v_sauce_id,
    p_data->>'name',
    p_data->>'cuisine',
    p_data->>'cuisineEmoji',
    p_data->>'color',
    COALESCE(p_data->>'description', ''),
    v_sauce_type,
    NULLIF(p_data->>'sourceUrl', '')
  );

  FOR v_item IN SELECT jsonb_array_elements_text(p_data->'itemIds')
  LOOP
    INSERT INTO public.sauceboss_sauce_items (sauce_id, item_id) VALUES (v_sauce_id, v_item);
  END LOOP;

  FOR v_step IN SELECT * FROM jsonb_array_elements(p_data->'steps')
  LOOP
    INSERT INTO public.sauceboss_sauce_steps (sauce_id, step_order, title, input_from_step)
    VALUES (
      v_sauce_id,
      (v_step->>'stepOrder')::INT,
      v_step->>'title',
      CASE WHEN v_step->>'inputFromStep' IS NOT NULL
           THEN (v_step->>'inputFromStep')::INT
           ELSE NULL END
    )
    RETURNING id INTO v_step_id;

    FOR v_ing IN SELECT * FROM jsonb_array_elements(v_step->'ingredients')
    LOOP
      v_food_name := TRIM(v_ing->>'name');
      v_food_norm := LOWER(v_food_name);
      v_food_id   := NULL;

      IF v_food_name <> '' THEN
        INSERT INTO public.sauceboss_foods (id, name, name_normalized)
        VALUES (
          LEFT(REGEXP_REPLACE(v_food_norm, '[^a-z0-9]+', '-', 'g'), 60)
            || '-' || SUBSTR(MD5(v_food_norm), 1, 6),
          v_food_name,
          v_food_norm
        )
        ON CONFLICT (name_normalized) DO NOTHING;

        SELECT id INTO v_food_id FROM public.sauceboss_foods WHERE name_normalized = v_food_norm;
      END IF;

      INSERT INTO public.sauceboss_step_ingredients
        (step_id, food_id, unit_id, original_text, quantity, quantity_canonical_ml, quantity_canonical_g)
      VALUES (
        v_step_id,
        v_food_id,
        NULLIF(v_ing->>'unitId', ''),
        v_ing->>'originalText',
        (v_ing->>'amount')::numeric,
        NULLIF(v_ing->>'canonicalMl', '')::double precision,
        NULLIF(v_ing->>'canonicalG',  '')::double precision
      );
    END LOOP;
  END LOOP;

  RETURN v_sauce_id;
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Post-066 RPC redefinitions: emit sourceUrl in JSON payloads.
-- These CREATE OR REPLACE the earlier definitions of the same functions.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_sauceboss_all_sauces_full()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'cuisine', sauce_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',              s.id,
      'name',            s.name,
      'cuisine',         s.cuisine,
      'cuisineEmoji',    s.cuisine_emoji,
      'color',           s.color,
      'description',     s.description,
      'sourceUrl',       s.source_url,
      'sauceType',       s.sauce_type,
      'compatibleItems', (
        SELECT COALESCE(json_agg(link.item_id), '[]'::json)
        FROM public.sauceboss_sauce_items link
        WHERE link.sauce_id = s.id
      ),
      'ingredients', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'name',         di.food_name,
            'amount',       di.quantity,
            'unit',         di.unit_abbr,
            'unitId',       di.unit_id,
            'foodId',       di.food_id,
            'originalText', di.original_text,
            'canonicalMl',  di.canonical_ml,
            'canonicalG',   di.canonical_g
          )
          ORDER BY di.step_order, di.id
        ), '[]'::json)
        FROM (
          SELECT DISTINCT ON (di_inner.food_name)
            di_inner.id, di_inner.food_name, di_inner.quantity, di_inner.unit_abbr,
            di_inner.unit_id, di_inner.food_id, di_inner.original_text,
            di_inner.canonical_ml, di_inner.canonical_g, di_inner.step_order
          FROM (
            SELECT
              si_inner.id,
              COALESCE(f.name, si_inner.original_text) AS food_name,
              si_inner.quantity::double precision AS quantity,
              COALESCE(u.abbreviation, '') AS unit_abbr,
              si_inner.unit_id,
              si_inner.food_id,
              si_inner.original_text,
              si_inner.quantity_canonical_ml AS canonical_ml,
              si_inner.quantity_canonical_g  AS canonical_g,
              ss_inner.step_order
            FROM public.sauceboss_sauce_steps ss_inner
            JOIN public.sauceboss_step_ingredients si_inner ON si_inner.step_id = ss_inner.id
            LEFT JOIN public.sauceboss_foods f ON f.id = si_inner.food_id
            LEFT JOIN public.sauceboss_units u ON u.id = si_inner.unit_id
            WHERE ss_inner.sauce_id = s.id
          ) di_inner
          ORDER BY di_inner.food_name, di_inner.step_order, di_inner.id
        ) di
      ),
      'steps', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'title',         ss.title,
            'estimatedTime', ss.estimated_time,
            'inputFromStep', ss.input_from_step,
            'ingredients', (
              SELECT COALESCE(json_agg(
                json_build_object(
                  'name',         COALESCE(f.name, si.original_text),
                  'amount',       si.quantity::double precision,
                  'unit',         COALESCE(u.abbreviation, ''),
                  'unitId',       si.unit_id,
                  'foodId',       si.food_id,
                  'originalText', si.original_text,
                  'canonicalMl',  si.quantity_canonical_ml,
                  'canonicalG',   si.quantity_canonical_g
                )
                ORDER BY si.id
              ), '[]'::json)
              FROM public.sauceboss_step_ingredients si
              LEFT JOIN public.sauceboss_foods f ON f.id = si.food_id
              LEFT JOIN public.sauceboss_units u ON u.id = si.unit_id
              WHERE si.step_id = ss.id
            )
          )
          ORDER BY ss.step_order
        ), '[]'::json)
        FROM public.sauceboss_sauce_steps ss
        WHERE ss.sauce_id = s.id
      )
    ) AS sauce_obj
    FROM public.sauceboss_sauces s
  ) sub;
$$;


CREATE OR REPLACE FUNCTION public.get_sauceboss_sauces_for_item(p_item_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',              s.id,
      'name',            s.name,
      'cuisine',         s.cuisine,
      'cuisineEmoji',    s.cuisine_emoji,
      'color',           s.color,
      'description',     s.description,
      'sourceUrl',       s.source_url,
      'sauceType',       s.sauce_type,
      'compatibleItems', (
        SELECT COALESCE(json_agg(si2.item_id), '[]'::json)
        FROM public.sauceboss_sauce_items si2
        WHERE si2.sauce_id = s.id
      ),
      'ingredients', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'name',         di.food_name,
            'amount',       di.quantity,
            'unit',         di.unit_abbr,
            'unitId',       di.unit_id,
            'foodId',       di.food_id,
            'originalText', di.original_text,
            'canonicalMl',  di.canonical_ml,
            'canonicalG',   di.canonical_g
          )
          ORDER BY di.step_order, di.id
        ), '[]'::json)
        FROM (
          SELECT DISTINCT ON (di_inner.food_name)
            di_inner.id, di_inner.food_name, di_inner.quantity, di_inner.unit_abbr,
            di_inner.unit_id, di_inner.food_id, di_inner.original_text,
            di_inner.canonical_ml, di_inner.canonical_g, di_inner.step_order
          FROM (
            SELECT
              si_inner.id,
              COALESCE(f.name, si_inner.original_text) AS food_name,
              si_inner.quantity::double precision AS quantity,
              COALESCE(u.abbreviation, '') AS unit_abbr,
              si_inner.unit_id,
              si_inner.food_id,
              si_inner.original_text,
              si_inner.quantity_canonical_ml AS canonical_ml,
              si_inner.quantity_canonical_g  AS canonical_g,
              ss_inner.step_order
            FROM public.sauceboss_sauce_steps ss_inner
            JOIN public.sauceboss_step_ingredients si_inner ON si_inner.step_id = ss_inner.id
            LEFT JOIN public.sauceboss_foods f ON f.id = si_inner.food_id
            LEFT JOIN public.sauceboss_units u ON u.id = si_inner.unit_id
            WHERE ss_inner.sauce_id = s.id
          ) di_inner
          ORDER BY di_inner.food_name, di_inner.step_order, di_inner.id
        ) di
      ),
      'steps', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'title',         ss.title,
            'estimatedTime', ss.estimated_time,
            'inputFromStep', ss.input_from_step,
            'ingredients', (
              SELECT COALESCE(json_agg(
                json_build_object(
                  'name',         COALESCE(f.name, si.original_text),
                  'amount',       si.quantity::double precision,
                  'unit',         COALESCE(u.abbreviation, ''),
                  'unitId',       si.unit_id,
                  'foodId',       si.food_id,
                  'originalText', si.original_text,
                  'canonicalMl',  si.quantity_canonical_ml,
                  'canonicalG',   si.quantity_canonical_g
                )
                ORDER BY si.id
              ), '[]'::json)
              FROM public.sauceboss_step_ingredients si
              LEFT JOIN public.sauceboss_foods f ON f.id = si.food_id
              LEFT JOIN public.sauceboss_units u ON u.id = si.unit_id
              WHERE si.step_id = ss.id
            )
          )
          ORDER BY ss.step_order
        ), '[]'::json)
        FROM public.sauceboss_sauce_steps ss
        WHERE ss.sauce_id = s.id
      )
    ) AS sauce_obj
    FROM public.sauceboss_sauces s
    JOIN public.sauceboss_sauce_items link
      ON link.sauce_id = s.id AND link.item_id = p_item_id
  ) sub;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 067 — Ingredient admin RPCs (Sauce Manager → Ingredients tab).
-- ─────────────────────────────────────────────────────────────────────────────

-- List foods + recipe usage counts.
CREATE OR REPLACE FUNCTION public.list_sauceboss_foods_with_usage()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(food_obj ORDER BY food_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',         f.id,
      'name',       f.name,
      'plural',     f.plural,
      'usageCount', COALESCE(usage.cnt, 0),
      'sauceCount', COALESCE(usage.sauce_cnt, 0),
      'createdAt',  f.created_at
    ) AS food_obj
    FROM public.sauceboss_foods f
    LEFT JOIN (
      SELECT
        si.food_id,
        COUNT(*)                               AS cnt,
        COUNT(DISTINCT ss.sauce_id)            AS sauce_cnt
      FROM public.sauceboss_step_ingredients si
      JOIN public.sauceboss_sauce_steps ss ON ss.id = si.step_id
      WHERE si.food_id IS NOT NULL
      GROUP BY si.food_id
    ) usage ON usage.food_id = f.id
  ) sub;
$$;


-- Atomic merge: repoint every step_ingredients.food_id from p_merge_ids to
-- p_keep_id, then delete the merged foods rows. Returns repointed-row count.
CREATE OR REPLACE FUNCTION public.merge_sauceboss_foods(p_keep_id TEXT, p_merge_ids TEXT[])
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_count INT;
BEGIN
  IF p_keep_id IS NULL OR array_length(p_merge_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.sauceboss_step_ingredients
     SET food_id = p_keep_id
   WHERE food_id = ANY(p_merge_ids)
     AND food_id <> p_keep_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  DELETE FROM public.sauceboss_foods
   WHERE id = ANY(p_merge_ids)
     AND id <> p_keep_id;

  RETURN v_count;
END;
$$;


-- Refuse to delete a food still referenced by any step_ingredient (would
-- otherwise orphan recipe rows via ON DELETE SET NULL). Caller can use
-- merge_sauceboss_foods to consolidate first.
CREATE OR REPLACE FUNCTION public.delete_sauceboss_food_safe(p_id TEXT)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.sauceboss_step_ingredients
   WHERE food_id = p_id;

  IF v_count > 0 THEN
    RETURN v_count;
  END IF;

  DELETE FROM public.sauceboss_foods WHERE id = p_id;
  RETURN 0;
END;
$$;
