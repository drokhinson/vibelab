-- ─────────────────────────────────────────────────────────────────────────────
-- sauceboss — schema rename + consolidation
--
-- Singularizes table names, folds two lookup tables into the ingredient table,
-- moves cuisine_emoji into a dedicated cuisine info table, and drops a pair
-- of legacy/orphan tables (sauceboss_sauce_items, sauceboss_favorites).
--
-- Renames:
--   sauceboss_items                    → sauceboss_dish
--   sauceboss_sauces                   → sauceboss_sauce
--   sauceboss_sauce_steps              → sauceboss_sauce_step
--   sauceboss_sauce_attachments        → sauceboss_sauce_to_dish
--   sauceboss_units                    → sauceboss_unit
--   sauceboss_foods                    → sauceboss_ingredient    (+ category, substitutions cols)
--   sauceboss_step_ingredients         → sauceboss_sauce_step_ingredient (food_id → ingredient_id)
--   sauceboss_profiles                 → sauceboss_user_profiles
--   sauceboss_saucebook                → sauceboss_user_saucebook
--   sauceboss_pantry_missing           → sauceboss_user_pantry_missing (food_id → ingredient_id)
--
-- Drops:
--   sauceboss_sauce_items              — legacy dual-write mirror; replaced by sauceboss_sauce_to_dish.
--   sauceboss_favorites                — superseded by saucebook (per the new schema spec).
--   sauceboss_ingredient_categories    — folded into sauceboss_ingredient.category.
--   sauceboss_ingredient_substitutions — folded into sauceboss_ingredient.substitutions[].
--   sauceboss_sauce.cuisine_emoji      — moved to sauceboss_cuisine_info.cuisine_emoji.
--   sauceboss_sauce sauce_type CHECK   — removed; new schema documents "no constraints".
--
-- Adds:
--   sauceboss_cuisine_info(cuisine, cuisine_emoji, cuisine_image_url)
--
-- JSON field renames (across every RPC output):
--   foodId        → ingredientId
--
-- All RPCs are recreated against the new names; triggers are reattached to
-- the renamed tables. ALTER TABLE RENAME preserves data + FKs + indexes.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1) Drop old triggers (they reference old table/column names; we rebuild after rename) ──
DROP TRIGGER IF EXISTS sauceboss_sauces_variant_check_trg     ON public.sauceboss_sauces;
DROP TRIGGER IF EXISTS sauceboss_items_dish_level_check_trg   ON public.sauceboss_items;
DROP TRIGGER IF EXISTS sauceboss_sauce_attachments_check_trg  ON public.sauceboss_sauce_attachments;
DROP FUNCTION IF EXISTS public.sauceboss_sauces_variant_check()       CASCADE;
DROP FUNCTION IF EXISTS public.sauceboss_items_dish_level_check()     CASCADE;
DROP FUNCTION IF EXISTS public.sauceboss_sauce_attachments_check()    CASCADE;


-- ── 2) Drop all RPCs that reference old table/column names ──
-- They are CREATE OR REPLACE'd at the end of this migration with new bodies.
DROP FUNCTION IF EXISTS public.get_sauceboss_initial_load()                      CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_items_by_category(TEXT)             CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_variants_for_item(TEXT)             CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_sauces_for_item(TEXT)               CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_ingredients_for_item(TEXT)          CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_item_load(TEXT)                     CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_sauces_for_target(TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_all_sauces()                        CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_all_sauces_full()                   CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_saucebook(UUID)                     CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_browse(UUID, TEXT, TEXT[], TEXT[], UUID, INT, INT) CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_browse_authors(TEXT)                CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_pantry_for_user(UUID)               CASCADE;
DROP FUNCTION IF EXISTS public.set_sauceboss_pantry_missing(UUID, TEXT[])        CASCADE;
DROP FUNCTION IF EXISTS public.fork_sauceboss_sauce(TEXT, UUID, JSONB)           CASCADE;
DROP FUNCTION IF EXISTS public.create_sauceboss_sauce(JSONB)                     CASCADE;
DROP FUNCTION IF EXISTS public.update_sauceboss_sauce(JSONB)                     CASCADE;
DROP FUNCTION IF EXISTS public.list_sauceboss_foods_with_usage()                 CASCADE;
DROP FUNCTION IF EXISTS public.merge_sauceboss_foods(TEXT, TEXT[])               CASCADE;
DROP FUNCTION IF EXISTS public.delete_sauceboss_food_safe(TEXT)                  CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_ingredient_categories()             CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_substitutions()                     CASCADE;
DROP FUNCTION IF EXISTS public.upsert_sauceboss_ingredient_category(TEXT, TEXT)  CASCADE;
DROP FUNCTION IF EXISTS public.sauceboss_type_to_category(TEXT)                  CASCADE;


-- ── 3) Cuisine info: extract cuisine_emoji into its own table ──
CREATE TABLE IF NOT EXISTS public.sauceboss_cuisine_info (
  cuisine           TEXT PRIMARY KEY,
  cuisine_emoji     TEXT NOT NULL,
  cuisine_image_url TEXT NULL
);
ALTER TABLE public.sauceboss_cuisine_info ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_cuisine_info TO sauceboss_role;

-- Backfill: one row per distinct (cuisine, cuisine_emoji) seen on existing
-- sauces. Earliest non-empty emoji per cuisine wins.
INSERT INTO public.sauceboss_cuisine_info (cuisine, cuisine_emoji)
SELECT cuisine, MAX(cuisine_emoji)
  FROM public.sauceboss_sauces
 WHERE cuisine IS NOT NULL AND cuisine <> '' AND COALESCE(cuisine_emoji, '') <> ''
 GROUP BY cuisine
ON CONFLICT (cuisine) DO NOTHING;


-- ── 4) Rename tables (preserves data, FKs, RLS, grants, indexes) ──
ALTER TABLE public.sauceboss_items                RENAME TO sauceboss_dish;
ALTER TABLE public.sauceboss_sauces               RENAME TO sauceboss_sauce;
ALTER TABLE public.sauceboss_sauce_steps          RENAME TO sauceboss_sauce_step;
ALTER TABLE public.sauceboss_sauce_attachments    RENAME TO sauceboss_sauce_to_dish;
ALTER TABLE public.sauceboss_units                RENAME TO sauceboss_unit;
ALTER TABLE public.sauceboss_foods                RENAME TO sauceboss_ingredient;
ALTER TABLE public.sauceboss_step_ingredients     RENAME TO sauceboss_sauce_step_ingredient;
ALTER TABLE public.sauceboss_profiles             RENAME TO sauceboss_user_profiles;
ALTER TABLE public.sauceboss_saucebook            RENAME TO sauceboss_user_saucebook;
ALTER TABLE public.sauceboss_pantry_missing       RENAME TO sauceboss_user_pantry_missing;


-- ── 5) Rename columns (food_id → ingredient_id where the FK now points at sauceboss_ingredient) ──
ALTER TABLE public.sauceboss_sauce_step_ingredient  RENAME COLUMN food_id TO ingredient_id;
ALTER TABLE public.sauceboss_user_pantry_missing    RENAME COLUMN food_id TO ingredient_id;


-- ── 6) Add the consolidated columns on sauceboss_ingredient ──
ALTER TABLE public.sauceboss_ingredient
  ADD COLUMN IF NOT EXISTS category      TEXT NOT NULL DEFAULT 'uncategorized',
  ADD COLUMN IF NOT EXISTS substitutions TEXT[];

-- Backfill category from the (still-named) lookup table. Match on
-- LOWER(name); rows with no match keep the 'uncategorized' default.
UPDATE public.sauceboss_ingredient i
   SET category = c.category
  FROM public.sauceboss_ingredient_categories c
 WHERE LOWER(TRIM(c.ingredient_name)) = LOWER(TRIM(i.name));

-- Backfill substitutions array from the lookup table.
UPDATE public.sauceboss_ingredient i
   SET substitutions = sub.subs
  FROM (
    SELECT LOWER(TRIM(ingredient_name)) AS key,
           ARRAY_AGG(substitute_name ORDER BY substitute_name) AS subs
      FROM public.sauceboss_ingredient_substitutions
     GROUP BY LOWER(TRIM(ingredient_name))
  ) sub
 WHERE LOWER(TRIM(i.name)) = sub.key;


-- ── 7) Drop the now-folded lookup tables and the legacy/orphan tables ──
DROP TABLE IF EXISTS public.sauceboss_ingredient_categories;
DROP TABLE IF EXISTS public.sauceboss_ingredient_substitutions;
DROP TABLE IF EXISTS public.sauceboss_sauce_items;
DROP TABLE IF EXISTS public.sauceboss_favorites;


-- ── 8) Drop sauceboss_sauce.cuisine_emoji (now lives on sauceboss_cuisine_info) ──
ALTER TABLE public.sauceboss_sauce DROP COLUMN IF EXISTS cuisine_emoji;


-- ── 9) Drop the sauce_type CHECK (new schema documents "no constraints") ──
DO $$
DECLARE
  c TEXT;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'public.sauceboss_sauce'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%sauce_type%';
  IF c IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.sauceboss_sauce DROP CONSTRAINT ' || quote_ident(c);
  END IF;
END$$;


-- ── 10) Rename indexes / parent self-check constraints to track the new names ──
ALTER INDEX IF EXISTS sauceboss_items_by_category_level_idx        RENAME TO sauceboss_dish_by_category_level_idx;
ALTER INDEX IF EXISTS sauceboss_items_subtypes_by_parent_idx       RENAME TO sauceboss_dish_subtypes_by_parent_idx;
ALTER INDEX IF EXISTS idx_sauceboss_sauce_steps_sauce_id           RENAME TO idx_sauceboss_sauce_step_sauce_id;
ALTER INDEX IF EXISTS idx_sauceboss_step_ing_step_id               RENAME TO idx_sauceboss_sauce_step_ing_step_id;
ALTER INDEX IF EXISTS idx_sauceboss_sauces_sauce_type              RENAME TO idx_sauceboss_sauce_sauce_type;
ALTER INDEX IF EXISTS idx_sauceboss_sauces_created_by              RENAME TO idx_sauceboss_sauce_created_by;
ALTER INDEX IF EXISTS sauceboss_sauces_variants_by_parent_idx      RENAME TO sauceboss_sauce_variants_by_parent_idx;
ALTER INDEX IF EXISTS sauceboss_sauces_created_at_idx              RENAME TO sauceboss_sauce_created_at_idx;
ALTER INDEX IF EXISTS sauceboss_sauce_attachments_by_target_idx    RENAME TO sauceboss_sauce_to_dish_by_target_idx;
ALTER INDEX IF EXISTS sauceboss_saucebook_by_sauce_idx             RENAME TO sauceboss_user_saucebook_by_sauce_idx;
ALTER INDEX IF EXISTS sauceboss_pantry_missing_by_user_idx         RENAME TO sauceboss_user_pantry_missing_by_user_idx;
ALTER INDEX IF EXISTS sauceboss_foods_name_normalized              RENAME TO sauceboss_ingredient_name_normalized;

-- Self-check constraints inherit the parent table rename in PG (the constraint
-- name does not auto-rename). Rename for clarity.
ALTER TABLE public.sauceboss_sauce
  DROP CONSTRAINT IF EXISTS sauceboss_sauces_parent_self_chk;
ALTER TABLE public.sauceboss_sauce
  ADD CONSTRAINT sauceboss_sauce_parent_self_chk
  CHECK (parent_sauce_id IS NULL OR parent_sauce_id <> id);


-- ─────────────────────────────────────────────────────────────────────────────
-- Recreate triggers and RPCs against the new schema.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 11) Type ↔ category helper (sauce/dip → carb, marinade → protein, dressing → salad) ──
CREATE OR REPLACE FUNCTION public.sauceboss_type_to_category(p_sauce_type TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE p_sauce_type
    WHEN 'sauce'    THEN 'carb'
    WHEN 'dip'      THEN 'carb'
    WHEN 'marinade' THEN 'protein'
    WHEN 'dressing' THEN 'salad'
    ELSE NULL
  END;
$$;


-- ── 12) Variant-depth check on sauceboss_sauce ──
CREATE OR REPLACE FUNCTION public.sauceboss_sauce_variant_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_parent_parent TEXT;
BEGIN
  IF NEW.parent_sauce_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT parent_sauce_id INTO v_parent_parent
    FROM public.sauceboss_sauce
   WHERE id = NEW.parent_sauce_id;
  IF v_parent_parent IS NOT NULL THEN
    RAISE EXCEPTION 'sauceboss_sauce: variants of variants are not allowed (% → % → %)',
      NEW.id, NEW.parent_sauce_id, v_parent_parent;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sauceboss_sauce_variant_check_trg
  BEFORE INSERT OR UPDATE OF parent_sauce_id ON public.sauceboss_sauce
  FOR EACH ROW EXECUTE FUNCTION public.sauceboss_sauce_variant_check();


-- ── 13) Dish-level check on sauceboss_dish (parent must be dish, not subtype) ──
CREATE OR REPLACE FUNCTION public.sauceboss_dish_level_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_parent_level TEXT;
BEGIN
  IF NEW.parent_id IS NULL THEN
    -- A row without a parent must be 'dish'.
    IF NEW.dish_level <> 'dish' THEN
      RAISE EXCEPTION 'sauceboss_dish: parentless row must have dish_level=dish (got %)', NEW.dish_level;
    END IF;
    RETURN NEW;
  END IF;
  SELECT dish_level INTO v_parent_level
    FROM public.sauceboss_dish WHERE id = NEW.parent_id;
  IF v_parent_level IS NULL THEN
    RAISE EXCEPTION 'sauceboss_dish: parent_id % not found', NEW.parent_id;
  END IF;
  IF v_parent_level <> 'dish' THEN
    RAISE EXCEPTION 'sauceboss_dish: parent must be dish_level=dish (parent % is %)',
      NEW.parent_id, v_parent_level;
  END IF;
  IF NEW.dish_level <> 'subtype' THEN
    RAISE EXCEPTION 'sauceboss_dish: row with parent_id must have dish_level=subtype (got %)', NEW.dish_level;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sauceboss_dish_level_check_trg
  BEFORE INSERT OR UPDATE ON public.sauceboss_dish
  FOR EACH ROW EXECUTE FUNCTION public.sauceboss_dish_level_check();


-- ── 14) Attachment integrity on sauceboss_sauce_to_dish ──
-- Validates that target_kind/target_value resolve to the right category for
-- the sauce's type. full_recipe sauces are not allowed any attachments.
CREATE OR REPLACE FUNCTION public.sauceboss_sauce_to_dish_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_type   TEXT;
  v_expected_cat TEXT;
  v_dish_cat     TEXT;
  v_dish_level   TEXT;
BEGIN
  SELECT sauce_type INTO v_sauce_type
    FROM public.sauceboss_sauce
   WHERE id = NEW.sauce_id;

  IF v_sauce_type = 'full_recipe' THEN
    RAISE EXCEPTION 'sauceboss_sauce_to_dish: full_recipe sauces cannot have dish attachments (sauce %)',
      NEW.sauce_id;
  END IF;

  v_expected_cat := public.sauceboss_type_to_category(v_sauce_type);
  IF v_expected_cat IS NULL THEN
    RAISE EXCEPTION 'sauceboss_sauce_to_dish: unknown sauce_type=% on sauce %',
      v_sauce_type, NEW.sauce_id;
  END IF;

  IF NEW.target_kind = 'category' THEN
    IF NEW.target_value NOT IN ('carb','protein','salad') THEN
      RAISE EXCEPTION 'sauceboss_sauce_to_dish: category target must be carb/protein/salad (got %)',
        NEW.target_value;
    END IF;
    IF NEW.target_value <> v_expected_cat THEN
      RAISE EXCEPTION 'sauceboss_sauce_to_dish: sauce_type=% expects category=% (got %)',
        v_sauce_type, v_expected_cat, NEW.target_value;
    END IF;
    RETURN NEW;
  END IF;

  SELECT category, dish_level INTO v_dish_cat, v_dish_level
    FROM public.sauceboss_dish WHERE id = NEW.target_value;
  IF v_dish_cat IS NULL THEN
    RAISE EXCEPTION 'sauceboss_sauce_to_dish: unknown dish % for kind=%',
      NEW.target_value, NEW.target_kind;
  END IF;
  IF v_dish_level <> NEW.target_kind THEN
    RAISE EXCEPTION 'sauceboss_sauce_to_dish: dish % is dish_level=% but attachment kind=%',
      NEW.target_value, v_dish_level, NEW.target_kind;
  END IF;
  IF v_dish_cat <> v_expected_cat THEN
    RAISE EXCEPTION 'sauceboss_sauce_to_dish: sauce_type=% expects category=% but dish % is category=%',
      v_sauce_type, v_expected_cat, NEW.target_value, v_dish_cat;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER sauceboss_sauce_to_dish_check_trg
  BEFORE INSERT OR UPDATE ON public.sauceboss_sauce_to_dish
  FOR EACH ROW EXECUTE FUNCTION public.sauceboss_sauce_to_dish_check();


-- ─────────────────────────────────────────────────────────────────────────────
-- Read RPCs — every JSON envelope LEFT JOINs sauceboss_cuisine_info to surface
-- cuisineEmoji (since it no longer lives on sauceboss_sauce). foodId is now
-- emitted as ingredientId everywhere; legacy compatibleItems is gone (the
-- frontend now reads attachments directly).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_sauceboss_items_by_category(p_category TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."sortOrder", t.name), '[]'::json)
  FROM (
    SELECT
      d.id,
      d.category,
      d.name,
      d.emoji,
      d.description,
      d.instructions,
      d.dish_level         AS "dishLevel",
      d.parent_id          AS "parentId",
      d.water_ratio        AS "waterRatio",
      d.cook_time_minutes  AS "cookTimeMinutes",
      d.portion_per_person AS "portionPerPerson",
      d.portion_unit       AS "portionUnit",
      d.sort_order         AS "sortOrder",
      (
        SELECT COUNT(*)::int FROM public.sauceboss_sauce_to_dish a
         WHERE (a.target_kind = 'dish'    AND a.target_value = d.id)
            OR (a.target_kind = 'subtype' AND a.target_value = d.id)
      ) AS "sauceCount",
      CASE WHEN d.dish_level = 'dish' THEN (
        SELECT COALESCE(json_agg(
          json_build_object(
            'id', sub.id,
            'name', sub.name,
            'emoji', sub.emoji,
            'description', sub.description,
            'instructions', sub.instructions,
            'cookTimeMinutes', sub.cook_time_minutes,
            'waterRatio', sub.water_ratio,
            'portionPerPerson', sub.portion_per_person,
            'portionUnit', sub.portion_unit,
            'sortOrder', sub.sort_order,
            'parentId', sub.parent_id,
            'dishLevel', sub.dish_level
          ) ORDER BY sub.sort_order, sub.name
        ), '[]'::json)
        FROM public.sauceboss_dish sub
        WHERE sub.parent_id = d.id AND sub.dish_level = 'subtype'
      ) ELSE NULL END AS subtypes
    FROM public.sauceboss_dish d
    WHERE d.category = p_category AND d.dish_level = 'dish'
  ) t;
$$;


CREATE OR REPLACE FUNCTION public.get_sauceboss_initial_load()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT json_build_object(
    'carbs',      public.get_sauceboss_items_by_category('carb'),
    'proteins',   public.get_sauceboss_items_by_category('protein'),
    'saladBases', public.get_sauceboss_items_by_category('salad')
  );
$$;


CREATE OR REPLACE FUNCTION public.get_sauceboss_variants_for_item(p_item_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."sortOrder", t.name), '[]'::json)
  FROM (
    SELECT
      d.id,
      d.name,
      d.emoji,
      d.description,
      d.cook_time_minutes  AS "cookTimeMinutes",
      d.water_ratio        AS "waterRatio",
      d.instructions,
      d.dish_level         AS "dishLevel",
      d.sort_order         AS "sortOrder"
    FROM public.sauceboss_dish d
    WHERE d.parent_id = p_item_id
      AND d.dish_level = 'subtype'
  ) t;
$$;


-- Resolver: sauces matching a target. Returns one envelope per sauce, joined
-- against cuisine_info for cuisineEmoji and against ingredient/unit for the
-- step ingredient names + units. attachments is the source of truth for
-- targeting; the legacy compatibleItems array is no longer emitted.
CREATE OR REPLACE FUNCTION public.get_sauceboss_sauces_for_target(
  p_category   TEXT,
  p_dish_id    TEXT,
  p_subtype_id TEXT
)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  WITH parent_dish AS (
    SELECT parent_id
      FROM public.sauceboss_dish
     WHERE p_subtype_id IS NOT NULL AND id = p_subtype_id
  ),
  matches AS (
    SELECT DISTINCT s.id
      FROM public.sauceboss_sauce s
      JOIN public.sauceboss_sauce_to_dish a ON a.sauce_id = s.id
     WHERE
       (p_category   IS NOT NULL AND a.target_kind = 'category' AND a.target_value = p_category)
       OR (p_dish_id    IS NOT NULL AND a.target_kind = 'dish'     AND a.target_value = p_dish_id)
       OR (p_subtype_id IS NOT NULL AND a.target_kind = 'subtype'  AND a.target_value = p_subtype_id)
       OR (p_subtype_id IS NOT NULL AND a.target_kind = 'dish'     AND a.target_value = (SELECT parent_id FROM parent_dish))
  )
  SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',              s.id,
      'name',            s.name,
      'cuisine',         s.cuisine,
      'cuisineEmoji',    COALESCE(ci.cuisine_emoji, ''),
      'color',           s.color,
      'description',     s.description,
      'sourceUrl',       s.source_url,
      'sauceType',       s.sauce_type,
      'createdBy',       s.created_by,
      'parentSauceId',   s.parent_sauce_id,
      'attachments', (
        SELECT COALESCE(json_agg(json_build_object('kind', a2.target_kind, 'value', a2.target_value)
                                 ORDER BY a2.target_kind, a2.target_value), '[]'::json)
          FROM public.sauceboss_sauce_to_dish a2
         WHERE a2.sauce_id = s.id
      ),
      'ingredients', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'name',         di.ing_name,
            'amount',       di.quantity,
            'unit',         di.unit_abbr,
            'unitId',       di.unit_id,
            'ingredientId', di.ingredient_id,
            'originalText', di.original_text,
            'canonicalMl',  di.canonical_ml,
            'canonicalG',   di.canonical_g
          )
          ORDER BY di.step_order, di.id
        ), '[]'::json)
        FROM (
          SELECT DISTINCT ON (di_inner.ing_name)
            di_inner.id, di_inner.ing_name, di_inner.quantity, di_inner.unit_abbr,
            di_inner.unit_id, di_inner.ingredient_id, di_inner.original_text,
            di_inner.canonical_ml, di_inner.canonical_g, di_inner.step_order
          FROM (
            SELECT
              si.id,
              COALESCE(ing.name, si.original_text) AS ing_name,
              si.quantity::double precision AS quantity,
              COALESCE(u.abbreviation, '') AS unit_abbr,
              si.unit_id,
              si.ingredient_id,
              si.original_text,
              si.quantity_canonical_ml AS canonical_ml,
              si.quantity_canonical_g  AS canonical_g,
              ss.step_order
            FROM public.sauceboss_sauce_step ss
            JOIN public.sauceboss_sauce_step_ingredient si ON si.step_id = ss.id
            LEFT JOIN public.sauceboss_ingredient ing ON ing.id = si.ingredient_id
            LEFT JOIN public.sauceboss_unit u         ON u.id  = si.unit_id
            WHERE ss.sauce_id = s.id
          ) di_inner
          ORDER BY di_inner.ing_name, di_inner.step_order, di_inner.id
        ) di
      ),
      'steps', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'title',         ss.title,
            'instructions',  ss.instructions,
            'estimatedTime', ss.estimated_time,
            'inputFromStep', ss.input_from_step,
            'ingredients', (
              SELECT COALESCE(json_agg(
                json_build_object(
                  'name',         COALESCE(ing.name, si.original_text),
                  'amount',       si.quantity::double precision,
                  'unit',         COALESCE(u.abbreviation, ''),
                  'unitId',       si.unit_id,
                  'ingredientId', si.ingredient_id,
                  'originalText', si.original_text,
                  'canonicalMl',  si.quantity_canonical_ml,
                  'canonicalG',   si.quantity_canonical_g
                )
                ORDER BY si.id
              ), '[]'::json)
              FROM public.sauceboss_sauce_step_ingredient si
              LEFT JOIN public.sauceboss_ingredient ing ON ing.id = si.ingredient_id
              LEFT JOIN public.sauceboss_unit u         ON u.id  = si.unit_id
              WHERE si.step_id = ss.id
            )
          )
          ORDER BY ss.step_order
        ), '[]'::json)
        FROM public.sauceboss_sauce_step ss
        WHERE ss.sauce_id = s.id
      )
    ) AS sauce_obj
    FROM public.sauceboss_sauce s
    LEFT JOIN public.sauceboss_cuisine_info ci ON ci.cuisine = s.cuisine
    WHERE s.id IN (SELECT id FROM matches)
  ) sub;
$$;


CREATE OR REPLACE FUNCTION public.get_sauceboss_sauces_for_item(p_item_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT public.get_sauceboss_sauces_for_target(
    (SELECT category FROM public.sauceboss_dish WHERE id = p_item_id),
    CASE WHEN (SELECT dish_level FROM public.sauceboss_dish WHERE id = p_item_id) = 'dish'    THEN p_item_id ELSE NULL END,
    CASE WHEN (SELECT dish_level FROM public.sauceboss_dish WHERE id = p_item_id) = 'subtype' THEN p_item_id ELSE NULL END
  );
$$;


CREATE OR REPLACE FUNCTION public.get_sauceboss_ingredients_for_item(p_item_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  WITH item_meta AS (
    SELECT id, category, dish_level, parent_id
      FROM public.sauceboss_dish WHERE id = p_item_id
  ),
  matched_sauces AS (
    SELECT DISTINCT a.sauce_id
      FROM public.sauceboss_sauce_to_dish a, item_meta im
     WHERE
       (a.target_kind = 'category' AND a.target_value = im.category)
       OR (a.target_kind = 'dish'    AND im.dish_level = 'dish'    AND a.target_value = im.id)
       OR (a.target_kind = 'subtype' AND im.dish_level = 'subtype' AND a.target_value = im.id)
       OR (a.target_kind = 'dish'    AND im.dish_level = 'subtype' AND a.target_value = im.parent_id)
  )
  SELECT COALESCE(json_agg(name ORDER BY name), '[]'::json)
  FROM (
    SELECT DISTINCT COALESCE(ing.name, si.original_text) AS name
      FROM matched_sauces ms
      JOIN public.sauceboss_sauce_step ss            ON ss.sauce_id = ms.sauce_id
      JOIN public.sauceboss_sauce_step_ingredient si ON si.step_id  = ss.id
      LEFT JOIN public.sauceboss_ingredient ing      ON ing.id      = si.ingredient_id
     WHERE COALESCE(ing.name, si.original_text) IS NOT NULL
  ) sub;
$$;


CREATE OR REPLACE FUNCTION public.get_sauceboss_item_load(p_item_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT json_build_object(
    'item', (
      SELECT json_build_object(
        'id',                d.id,
        'category',          d.category,
        'name',              d.name,
        'emoji',             d.emoji,
        'description',       d.description,
        'cookTimeMinutes',   d.cook_time_minutes,
        'instructions',      d.instructions,
        'dishLevel',         d.dish_level,
        'parentId',          d.parent_id,
        'waterRatio',        d.water_ratio,
        'portionPerPerson',  d.portion_per_person,
        'portionUnit',       d.portion_unit
      )
      FROM public.sauceboss_dish d WHERE d.id = p_item_id
    ),
    'variants',    public.get_sauceboss_variants_for_item(p_item_id),
    'sauces',      public.get_sauceboss_sauces_for_item(p_item_id),
    'ingredients', public.get_sauceboss_ingredients_for_item(p_item_id)
  );
$$;


CREATE OR REPLACE FUNCTION public.get_sauceboss_all_sauces_full()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'cuisine', sauce_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',              s.id,
      'name',            s.name,
      'cuisine',         s.cuisine,
      'cuisineEmoji',    COALESCE(ci.cuisine_emoji, ''),
      'color',           s.color,
      'description',     s.description,
      'sourceUrl',       s.source_url,
      'sauceType',       s.sauce_type,
      'createdBy',       s.created_by,
      'parentSauceId',   s.parent_sauce_id,
      'attachments', (
        SELECT COALESCE(json_agg(json_build_object('kind', a.target_kind, 'value', a.target_value)
                                 ORDER BY a.target_kind, a.target_value), '[]'::json)
          FROM public.sauceboss_sauce_to_dish a
         WHERE a.sauce_id = s.id
      ),
      'ingredients', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'name',         di.ing_name,
            'amount',       di.quantity,
            'unit',         di.unit_abbr,
            'unitId',       di.unit_id,
            'ingredientId', di.ingredient_id,
            'originalText', di.original_text,
            'canonicalMl',  di.canonical_ml,
            'canonicalG',   di.canonical_g
          )
          ORDER BY di.step_order, di.id
        ), '[]'::json)
        FROM (
          SELECT DISTINCT ON (di_inner.ing_name)
            di_inner.id, di_inner.ing_name, di_inner.quantity, di_inner.unit_abbr,
            di_inner.unit_id, di_inner.ingredient_id, di_inner.original_text,
            di_inner.canonical_ml, di_inner.canonical_g, di_inner.step_order
          FROM (
            SELECT
              si.id,
              COALESCE(ing.name, si.original_text) AS ing_name,
              si.quantity::double precision AS quantity,
              COALESCE(u.abbreviation, '') AS unit_abbr,
              si.unit_id,
              si.ingredient_id,
              si.original_text,
              si.quantity_canonical_ml AS canonical_ml,
              si.quantity_canonical_g  AS canonical_g,
              ss.step_order
            FROM public.sauceboss_sauce_step ss
            JOIN public.sauceboss_sauce_step_ingredient si ON si.step_id = ss.id
            LEFT JOIN public.sauceboss_ingredient ing ON ing.id = si.ingredient_id
            LEFT JOIN public.sauceboss_unit u         ON u.id  = si.unit_id
            WHERE ss.sauce_id = s.id
          ) di_inner
          ORDER BY di_inner.ing_name, di_inner.step_order, di_inner.id
        ) di
      ),
      'steps', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'title',         ss.title,
            'instructions',  ss.instructions,
            'estimatedTime', ss.estimated_time,
            'inputFromStep', ss.input_from_step,
            'ingredients', (
              SELECT COALESCE(json_agg(
                json_build_object(
                  'name',         COALESCE(ing.name, si.original_text),
                  'amount',       si.quantity::double precision,
                  'unit',         COALESCE(u.abbreviation, ''),
                  'unitId',       si.unit_id,
                  'ingredientId', si.ingredient_id,
                  'originalText', si.original_text,
                  'canonicalMl',  si.quantity_canonical_ml,
                  'canonicalG',   si.quantity_canonical_g
                )
                ORDER BY si.id
              ), '[]'::json)
              FROM public.sauceboss_sauce_step_ingredient si
              LEFT JOIN public.sauceboss_ingredient ing ON ing.id = si.ingredient_id
              LEFT JOIN public.sauceboss_unit u         ON u.id  = si.unit_id
              WHERE si.step_id = ss.id
            )
          )
          ORDER BY ss.step_order
        ), '[]'::json)
        FROM public.sauceboss_sauce_step ss
        WHERE ss.sauce_id = s.id
      )
    ) AS sauce_obj
    FROM public.sauceboss_sauce s
    LEFT JOIN public.sauceboss_cuisine_info ci ON ci.cuisine = s.cuisine
  ) sub;
$$;


CREATE OR REPLACE FUNCTION public.get_sauceboss_all_sauces()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(
    json_build_object(
      'id',              s.id,
      'name',            s.name,
      'cuisine',         s.cuisine,
      'cuisineEmoji',    COALESCE(ci.cuisine_emoji, ''),
      'color',           s.color,
      'description',     s.description,
      'sauceType',       s.sauce_type,
      'createdBy',       s.created_by,
      'parentSauceId',   s.parent_sauce_id,
      'attachments', (
        SELECT COALESCE(json_agg(json_build_object('kind', a.target_kind, 'value', a.target_value)
                                 ORDER BY a.target_kind, a.target_value), '[]'::json)
          FROM public.sauceboss_sauce_to_dish a
         WHERE a.sauce_id = s.id
      )
    )
    ORDER BY s.cuisine, s.name
  ), '[]'::json)
  FROM public.sauceboss_sauce s
  LEFT JOIN public.sauceboss_cuisine_info ci ON ci.cuisine = s.cuisine;
$$;


-- Saucebook: full envelopes + addedAt + variantCount + ingredientNames.
CREATE OR REPLACE FUNCTION public.get_sauceboss_saucebook(p_user_id UUID)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'cuisine', sauce_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',              s.id,
      'name',            s.name,
      'cuisine',         s.cuisine,
      'cuisineEmoji',    COALESCE(ci.cuisine_emoji, ''),
      'color',           s.color,
      'sauceType',       s.sauce_type,
      'createdBy',       s.created_by,
      'authorName',      COALESCE(p.display_name, ''),
      'parentSauceId',   s.parent_sauce_id,
      'addedAt',         sb.added_at,
      'variantCount', (
        SELECT COUNT(*)::int FROM public.sauceboss_sauce v
         WHERE v.parent_sauce_id = COALESCE(s.parent_sauce_id, s.id)
      ),
      'attachments', (
        SELECT COALESCE(json_agg(json_build_object('kind', a.target_kind, 'value', a.target_value)
                                 ORDER BY a.target_kind, a.target_value), '[]'::json)
          FROM public.sauceboss_sauce_to_dish a
         WHERE a.sauce_id = s.id
      ),
      'ingredientNames', (
        SELECT COALESCE(array_agg(DISTINCT COALESCE(ing.name, si.original_text)
                                  ORDER BY COALESCE(ing.name, si.original_text)),
                        ARRAY[]::TEXT[])
          FROM public.sauceboss_sauce_step ss
          JOIN public.sauceboss_sauce_step_ingredient si ON si.step_id = ss.id
          LEFT JOIN public.sauceboss_ingredient ing      ON ing.id     = si.ingredient_id
         WHERE ss.sauce_id = s.id
           AND COALESCE(ing.name, si.original_text) IS NOT NULL
      )
    ) AS sauce_obj
    FROM public.sauceboss_user_saucebook sb
    JOIN public.sauceboss_sauce s ON s.id = sb.sauce_id
    LEFT JOIN public.sauceboss_user_profiles p ON p.id = s.created_by
    LEFT JOIN public.sauceboss_cuisine_info  ci ON ci.cuisine = s.cuisine
    WHERE sb.user_id = p_user_id
  ) sub;
$$;


CREATE OR REPLACE FUNCTION public.get_sauceboss_browse(
  p_user_id   UUID,
  p_q         TEXT,
  p_cuisines  TEXT[],
  p_types     TEXT[],
  p_author    UUID,
  p_limit     INT,
  p_offset    INT
)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  WITH filtered AS (
    SELECT s.*, COALESCE(p.display_name, '') AS author_name
      FROM public.sauceboss_sauce s
      LEFT JOIN public.sauceboss_user_profiles p ON p.id = s.created_by
     WHERE
       (p_q IS NULL OR p_q = '' OR s.name ILIKE ('%' || p_q || '%'))
       AND (p_cuisines IS NULL OR cardinality(p_cuisines) = 0 OR s.cuisine = ANY(p_cuisines))
       AND (p_types    IS NULL OR cardinality(p_types)    = 0 OR s.sauce_type = ANY(p_types))
       AND (p_author IS NULL OR s.created_by = p_author)
       AND s.parent_sauce_id IS NULL
  ),
  total_count AS (SELECT COUNT(*)::int AS n FROM filtered),
  page AS (
    SELECT * FROM filtered
     ORDER BY created_at DESC, id
     OFFSET COALESCE(p_offset, 0)
     LIMIT  COALESCE(p_limit, 20)
  )
  SELECT json_build_object(
    'total', (SELECT n FROM total_count),
    'items', COALESCE((
      SELECT json_agg(
        json_build_object(
          'id',            f.id,
          'name',          f.name,
          'cuisine',       f.cuisine,
          'cuisineEmoji',  COALESCE(ci.cuisine_emoji, ''),
          'color',         f.color,
          'sauceType',     f.sauce_type,
          'sourceUrl',     f.source_url,
          'createdBy',     f.created_by,
          'authorName',    f.author_name,
          'parentSauceId', f.parent_sauce_id,
          'variantCount', (
            SELECT COUNT(*)::int FROM public.sauceboss_sauce v WHERE v.parent_sauce_id = f.id
          ),
          'attachments', (
            SELECT COALESCE(json_agg(json_build_object('kind', a.target_kind, 'value', a.target_value)
                                     ORDER BY a.target_kind, a.target_value), '[]'::json)
              FROM public.sauceboss_sauce_to_dish a
             WHERE a.sauce_id = f.id
          ),
          'inSaucebook', (
            p_user_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.sauceboss_user_saucebook sb
               WHERE sb.user_id = p_user_id AND sb.sauce_id = f.id
            )
          )
        )
      )
      FROM page f
      LEFT JOIN public.sauceboss_cuisine_info ci ON ci.cuisine = f.cuisine
    ), '[]'::json)
  );
$$;


CREATE OR REPLACE FUNCTION public.get_sauceboss_browse_authors(p_q TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."displayName"), '[]'::json)
  FROM (
    SELECT
      p.id           AS "userId",
      p.display_name AS "displayName",
      (SELECT COUNT(*)::int FROM public.sauceboss_sauce s WHERE s.created_by = p.id) AS "sauceCount"
    FROM public.sauceboss_user_profiles p
    WHERE EXISTS (SELECT 1 FROM public.sauceboss_sauce s WHERE s.created_by = p.id)
      AND (p_q IS NULL OR p_q = '' OR p.display_name ILIKE ('%' || p_q || '%'))
    LIMIT 20
  ) t;
$$;


-- Pantry read: every ingredient appearing in any sauce in the user's
-- saucebook, with a `missing` flag from sauceboss_user_pantry_missing.
CREATE OR REPLACE FUNCTION public.get_sauceboss_pantry_for_user(p_user_id UUID)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  WITH user_sauces AS (
    SELECT sauce_id FROM public.sauceboss_user_saucebook WHERE user_id = p_user_id
  ),
  user_ings AS (
    SELECT DISTINCT si.ingredient_id, ing.name
      FROM user_sauces us
      JOIN public.sauceboss_sauce_step ss            ON ss.sauce_id = us.sauce_id
      JOIN public.sauceboss_sauce_step_ingredient si ON si.step_id  = ss.id
      LEFT JOIN public.sauceboss_ingredient ing      ON ing.id      = si.ingredient_id
     WHERE si.ingredient_id IS NOT NULL
  )
  SELECT json_build_object(
    'ingredients', COALESCE((
      SELECT json_agg(
        json_build_object(
          'ingredientId', ui.ingredient_id,
          'name',         ui.name,
          'missing',      EXISTS (
            SELECT 1 FROM public.sauceboss_user_pantry_missing pm
             WHERE pm.user_id = p_user_id AND pm.ingredient_id = ui.ingredient_id
          )
        )
        ORDER BY ui.name
      )
      FROM user_ings ui
    ), '[]'::json),
    'saucebookSauceIds', COALESCE((SELECT json_agg(sauce_id) FROM user_sauces), '[]'::json)
  );
$$;


CREATE OR REPLACE FUNCTION public.set_sauceboss_pantry_missing(
  p_user_id        UUID,
  p_ingredient_ids TEXT[]
)
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.sauceboss_user_pantry_missing WHERE user_id = p_user_id;

  IF p_ingredient_ids IS NOT NULL AND cardinality(p_ingredient_ids) > 0 THEN
    INSERT INTO public.sauceboss_user_pantry_missing (user_id, ingredient_id)
    SELECT p_user_id, x
      FROM UNNEST(p_ingredient_ids) AS x
      JOIN public.sauceboss_ingredient ing ON ing.id = x  -- silently skip unknown ids
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN public.get_sauceboss_pantry_for_user(p_user_id);
END;
$$;


-- ── Writers: create / update / fork ──
-- Inputs accept `cuisineEmoji` for backwards-compat; the value is upserted
-- into sauceboss_cuisine_info (latest non-empty value wins per cuisine).
-- Inputs accept `ingredients[].ingredientId` (preferred); fallback to legacy
-- `foodId` is supported for one release.

CREATE OR REPLACE FUNCTION public.create_sauceboss_sauce(p_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_id   TEXT;
  v_sauce_type TEXT;
  v_created_by UUID;
  v_parent     TEXT;
  v_cuisine    TEXT;
  v_cui_emoji  TEXT;
  v_step       JSONB;
  v_step_id    BIGINT;
  v_ing        JSONB;
  v_ing_name   TEXT;
  v_ing_norm   TEXT;
  v_ing_id     TEXT;
  v_attach     JSONB;
  v_kind       TEXT;
  v_value      TEXT;
  v_dish       TEXT;
BEGIN
  v_sauce_id   := p_data->>'id';
  v_sauce_type := COALESCE(p_data->>'sauceType', 'sauce');
  v_created_by := NULLIF(p_data->>'createdBy', '')::UUID;
  v_parent     := NULLIF(p_data->>'parentSauceId', '');
  v_cuisine    := p_data->>'cuisine';
  v_cui_emoji  := COALESCE(p_data->>'cuisineEmoji', '');

  IF v_cuisine IS NOT NULL AND v_cuisine <> '' AND v_cui_emoji <> '' THEN
    INSERT INTO public.sauceboss_cuisine_info (cuisine, cuisine_emoji)
    VALUES (v_cuisine, v_cui_emoji)
    ON CONFLICT (cuisine) DO UPDATE SET cuisine_emoji = EXCLUDED.cuisine_emoji;
  END IF;

  INSERT INTO public.sauceboss_sauce
    (id, name, cuisine, color, description, sauce_type, source_url, created_by, parent_sauce_id)
  VALUES (
    v_sauce_id,
    p_data->>'name',
    v_cuisine,
    p_data->>'color',
    COALESCE(p_data->>'description', ''),
    v_sauce_type,
    NULLIF(p_data->>'sourceUrl', ''),
    v_created_by,
    v_parent
  );

  IF p_data ? 'attachments' AND jsonb_array_length(p_data->'attachments') > 0 THEN
    FOR v_attach IN SELECT * FROM jsonb_array_elements(p_data->'attachments')
    LOOP
      INSERT INTO public.sauceboss_sauce_to_dish (sauce_id, target_kind, target_value)
        VALUES (v_sauce_id, v_attach->>'kind', v_attach->>'value')
        ON CONFLICT DO NOTHING;
    END LOOP;
  ELSIF p_data ? 'itemIds' THEN
    FOR v_dish IN SELECT jsonb_array_elements_text(p_data->'itemIds')
    LOOP
      INSERT INTO public.sauceboss_sauce_to_dish (sauce_id, target_kind, target_value)
        VALUES (v_sauce_id, 'dish', v_dish)
        ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  FOR v_step IN SELECT * FROM jsonb_array_elements(p_data->'steps')
  LOOP
    INSERT INTO public.sauceboss_sauce_step
      (sauce_id, step_order, title, instructions, input_from_step, estimated_time)
    VALUES (
      v_sauce_id,
      (v_step->>'stepOrder')::INT,
      v_step->>'title',
      NULLIF(v_step->>'instructions', ''),
      CASE WHEN v_step->>'inputFromStep' IS NOT NULL THEN (v_step->>'inputFromStep')::INT ELSE NULL END,
      CASE WHEN v_step->>'estimatedTime' IS NOT NULL THEN (v_step->>'estimatedTime')::INT ELSE NULL END
    )
    RETURNING id INTO v_step_id;

    FOR v_ing IN SELECT * FROM jsonb_array_elements(v_step->'ingredients')
    LOOP
      v_ing_name := TRIM(COALESCE(v_ing->>'name', ''));
      v_ing_norm := LOWER(v_ing_name);
      v_ing_id   := NULL;

      IF v_ing_name <> '' THEN
        INSERT INTO public.sauceboss_ingredient (id, name, name_normalized)
        VALUES (
          LEFT(REGEXP_REPLACE(v_ing_norm, '[^a-z0-9]+', '-', 'g'), 60)
            || '-' || SUBSTR(MD5(v_ing_norm), 1, 6),
          v_ing_name,
          v_ing_norm
        )
        ON CONFLICT (name_normalized) DO NOTHING;
        SELECT id INTO v_ing_id FROM public.sauceboss_ingredient WHERE name_normalized = v_ing_norm;
      END IF;

      INSERT INTO public.sauceboss_sauce_step_ingredient
        (step_id, ingredient_id, unit_id, original_text, quantity, quantity_canonical_ml, quantity_canonical_g)
      VALUES (
        v_step_id,
        v_ing_id,
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


CREATE OR REPLACE FUNCTION public.update_sauceboss_sauce(p_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_id   TEXT;
  v_sauce_type TEXT;
  v_cuisine    TEXT;
  v_cui_emoji  TEXT;
  v_step       JSONB;
  v_step_id    BIGINT;
  v_ing        JSONB;
  v_ing_name   TEXT;
  v_ing_norm   TEXT;
  v_ing_id     TEXT;
  v_attach     JSONB;
  v_dish       TEXT;
BEGIN
  v_sauce_id   := p_data->>'id';
  v_sauce_type := COALESCE(p_data->>'sauceType', 'sauce');
  v_cuisine    := p_data->>'cuisine';
  v_cui_emoji  := COALESCE(p_data->>'cuisineEmoji', '');

  IF NOT EXISTS (SELECT 1 FROM public.sauceboss_sauce WHERE id = v_sauce_id) THEN
    RAISE EXCEPTION 'update_sauceboss_sauce: sauce % not found', v_sauce_id;
  END IF;

  IF v_cuisine IS NOT NULL AND v_cuisine <> '' AND v_cui_emoji <> '' THEN
    INSERT INTO public.sauceboss_cuisine_info (cuisine, cuisine_emoji)
    VALUES (v_cuisine, v_cui_emoji)
    ON CONFLICT (cuisine) DO UPDATE SET cuisine_emoji = EXCLUDED.cuisine_emoji;
  END IF;

  UPDATE public.sauceboss_sauce SET
    name            = p_data->>'name',
    cuisine         = v_cuisine,
    color           = p_data->>'color',
    description     = COALESCE(p_data->>'description', ''),
    sauce_type      = v_sauce_type,
    source_url      = NULLIF(p_data->>'sourceUrl', ''),
    parent_sauce_id = NULLIF(p_data->>'parentSauceId', '')
  WHERE id = v_sauce_id;

  DELETE FROM public.sauceboss_sauce_to_dish WHERE sauce_id = v_sauce_id;

  IF p_data ? 'attachments' AND jsonb_array_length(p_data->'attachments') > 0 THEN
    FOR v_attach IN SELECT * FROM jsonb_array_elements(p_data->'attachments')
    LOOP
      INSERT INTO public.sauceboss_sauce_to_dish (sauce_id, target_kind, target_value)
        VALUES (v_sauce_id, v_attach->>'kind', v_attach->>'value')
        ON CONFLICT DO NOTHING;
    END LOOP;
  ELSIF p_data ? 'itemIds' THEN
    FOR v_dish IN SELECT jsonb_array_elements_text(p_data->'itemIds')
    LOOP
      INSERT INTO public.sauceboss_sauce_to_dish (sauce_id, target_kind, target_value)
        VALUES (v_sauce_id, 'dish', v_dish)
        ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  DELETE FROM public.sauceboss_sauce_step WHERE sauce_id = v_sauce_id;
  FOR v_step IN SELECT * FROM jsonb_array_elements(p_data->'steps')
  LOOP
    INSERT INTO public.sauceboss_sauce_step
      (sauce_id, step_order, title, instructions, input_from_step, estimated_time)
    VALUES (
      v_sauce_id,
      (v_step->>'stepOrder')::INT,
      v_step->>'title',
      NULLIF(v_step->>'instructions', ''),
      CASE WHEN v_step->>'inputFromStep' IS NOT NULL THEN (v_step->>'inputFromStep')::INT ELSE NULL END,
      CASE WHEN v_step->>'estimatedTime' IS NOT NULL THEN (v_step->>'estimatedTime')::INT ELSE NULL END
    )
    RETURNING id INTO v_step_id;

    FOR v_ing IN SELECT * FROM jsonb_array_elements(v_step->'ingredients')
    LOOP
      v_ing_name := TRIM(COALESCE(v_ing->>'name', ''));
      v_ing_norm := LOWER(v_ing_name);
      v_ing_id   := NULL;
      IF v_ing_name <> '' THEN
        INSERT INTO public.sauceboss_ingredient (id, name, name_normalized)
        VALUES (
          LEFT(REGEXP_REPLACE(v_ing_norm, '[^a-z0-9]+', '-', 'g'), 60)
            || '-' || SUBSTR(MD5(v_ing_norm), 1, 6),
          v_ing_name, v_ing_norm
        )
        ON CONFLICT (name_normalized) DO NOTHING;
        SELECT id INTO v_ing_id FROM public.sauceboss_ingredient WHERE name_normalized = v_ing_norm;
      END IF;
      INSERT INTO public.sauceboss_sauce_step_ingredient
        (step_id, ingredient_id, unit_id, original_text, quantity, quantity_canonical_ml, quantity_canonical_g)
      VALUES (
        v_step_id,
        v_ing_id,
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


CREATE OR REPLACE FUNCTION public.fork_sauceboss_sauce(
  p_source_id TEXT,
  p_user      UUID,
  p_data      JSONB
)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_root_id     TEXT;
  v_new_id      TEXT;
  v_src         RECORD;
  v_step_row    RECORD;
  v_new_step_id BIGINT;
  v_step_data   JSONB;
  v_ing         JSONB;
  v_ing_name    TEXT;
  v_ing_norm    TEXT;
  v_ing_id      TEXT;
  v_step_id     BIGINT;
  v_cuisine     TEXT;
  v_cui_emoji   TEXT;
BEGIN
  SELECT id, COALESCE(parent_sauce_id, id) AS root_id
    INTO v_src
    FROM public.sauceboss_sauce
   WHERE id = p_source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'fork_sauceboss_sauce: source % not found', p_source_id;
  END IF;
  v_root_id := v_src.root_id;

  v_new_id := COALESCE(NULLIF(p_data->>'id', ''),
    'fork-' || SUBSTR(MD5(p_source_id || '|' || COALESCE(p_user::TEXT, 'anon') || '|' || NOW()::TEXT), 1, 12));

  -- Cuisine emoji upsert (from override only; source's cuisine carries forward).
  v_cuisine   := COALESCE(p_data->>'cuisine',      (SELECT cuisine FROM public.sauceboss_sauce WHERE id = p_source_id));
  v_cui_emoji := COALESCE(p_data->>'cuisineEmoji', '');
  IF v_cuisine IS NOT NULL AND v_cuisine <> '' AND v_cui_emoji <> '' THEN
    INSERT INTO public.sauceboss_cuisine_info (cuisine, cuisine_emoji)
    VALUES (v_cuisine, v_cui_emoji)
    ON CONFLICT (cuisine) DO UPDATE SET cuisine_emoji = EXCLUDED.cuisine_emoji;
  END IF;

  INSERT INTO public.sauceboss_sauce
    (id, name, cuisine, color, description, sauce_type, source_url, created_by, parent_sauce_id)
  SELECT
    v_new_id,
    COALESCE(p_data->>'name',         s.name),
    COALESCE(p_data->>'cuisine',      s.cuisine),
    COALESCE(p_data->>'color',        s.color),
    COALESCE(p_data->>'description',  s.description),
    COALESCE(p_data->>'sauceType',    s.sauce_type),
    COALESCE(NULLIF(p_data->>'sourceUrl', ''), s.source_url),
    p_user,
    v_root_id
  FROM public.sauceboss_sauce s
  WHERE s.id = p_source_id;

  IF p_data ? 'attachments' AND jsonb_array_length(p_data->'attachments') > 0 THEN
    INSERT INTO public.sauceboss_sauce_to_dish (sauce_id, target_kind, target_value)
    SELECT v_new_id, a->>'kind', a->>'value'
      FROM jsonb_array_elements(p_data->'attachments') a
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO public.sauceboss_sauce_to_dish (sauce_id, target_kind, target_value)
    SELECT v_new_id, target_kind, target_value
      FROM public.sauceboss_sauce_to_dish
     WHERE sauce_id = p_source_id
    ON CONFLICT DO NOTHING;
  END IF;

  IF p_data ? 'steps' AND jsonb_array_length(p_data->'steps') > 0 THEN
    FOR v_step_data IN SELECT * FROM jsonb_array_elements(p_data->'steps')
    LOOP
      INSERT INTO public.sauceboss_sauce_step
        (sauce_id, step_order, title, instructions, input_from_step, estimated_time)
      VALUES (
        v_new_id,
        (v_step_data->>'stepOrder')::INT,
        v_step_data->>'title',
        NULLIF(v_step_data->>'instructions', ''),
        CASE WHEN v_step_data->>'inputFromStep' IS NOT NULL THEN (v_step_data->>'inputFromStep')::INT ELSE NULL END,
        CASE WHEN v_step_data->>'estimatedTime' IS NOT NULL THEN (v_step_data->>'estimatedTime')::INT ELSE NULL END
      )
      RETURNING id INTO v_step_id;
      FOR v_ing IN SELECT * FROM jsonb_array_elements(v_step_data->'ingredients')
      LOOP
        v_ing_name := TRIM(COALESCE(v_ing->>'name', ''));
        v_ing_norm := LOWER(v_ing_name);
        v_ing_id   := NULL;
        IF v_ing_name <> '' THEN
          INSERT INTO public.sauceboss_ingredient (id, name, name_normalized)
          VALUES (
            LEFT(REGEXP_REPLACE(v_ing_norm, '[^a-z0-9]+', '-', 'g'), 60)
              || '-' || SUBSTR(MD5(v_ing_norm), 1, 6),
            v_ing_name, v_ing_norm
          )
          ON CONFLICT (name_normalized) DO NOTHING;
          SELECT id INTO v_ing_id FROM public.sauceboss_ingredient WHERE name_normalized = v_ing_norm;
        END IF;
        INSERT INTO public.sauceboss_sauce_step_ingredient
          (step_id, ingredient_id, unit_id, original_text, quantity, quantity_canonical_ml, quantity_canonical_g)
        VALUES (
          v_step_id,
          v_ing_id,
          NULLIF(v_ing->>'unitId', ''),
          v_ing->>'originalText',
          (v_ing->>'amount')::numeric,
          NULLIF(v_ing->>'canonicalMl', '')::double precision,
          NULLIF(v_ing->>'canonicalG',  '')::double precision
        );
      END LOOP;
    END LOOP;
  ELSE
    FOR v_step_row IN
      SELECT id, step_order, title, instructions, input_from_step, estimated_time
        FROM public.sauceboss_sauce_step
       WHERE sauce_id = p_source_id
       ORDER BY step_order
    LOOP
      INSERT INTO public.sauceboss_sauce_step
        (sauce_id, step_order, title, instructions, input_from_step, estimated_time)
      VALUES
        (v_new_id, v_step_row.step_order, v_step_row.title, v_step_row.instructions,
         v_step_row.input_from_step, v_step_row.estimated_time)
      RETURNING id INTO v_new_step_id;

      INSERT INTO public.sauceboss_sauce_step_ingredient
        (step_id, ingredient_id, unit_id, original_text, quantity,
         quantity_canonical_ml, quantity_canonical_g)
      SELECT
        v_new_step_id, ingredient_id, unit_id, original_text, quantity,
        quantity_canonical_ml, quantity_canonical_g
        FROM public.sauceboss_sauce_step_ingredient
       WHERE step_id = v_step_row.id;
    END LOOP;
  END IF;

  IF p_user IS NOT NULL THEN
    DELETE FROM public.sauceboss_user_saucebook
     WHERE user_id = p_user AND sauce_id = p_source_id;
    INSERT INTO public.sauceboss_user_saucebook (user_id, sauce_id)
    VALUES (p_user, v_new_id) ON CONFLICT DO NOTHING;
  END IF;

  RETURN v_new_id;
END;
$$;


-- ── Ingredient admin RPCs ──
-- (These were named `*_foods_*` historically. New names mirror the table; a
-- thin alias keeps the legacy name callable for one release while the
-- backend migrates.)

CREATE OR REPLACE FUNCTION public.list_sauceboss_ingredients_with_usage()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.name), '[]'::json)
  FROM (
    SELECT
      ing.id,
      ing.name,
      ing.plural,
      ing.category,
      ing.substitutions,
      (
        SELECT COUNT(*)::int FROM public.sauceboss_sauce_step_ingredient si
         WHERE si.ingredient_id = ing.id
      ) AS "usageCount",
      (
        SELECT COUNT(DISTINCT ss.sauce_id)::int
          FROM public.sauceboss_sauce_step_ingredient si
          JOIN public.sauceboss_sauce_step ss ON ss.id = si.step_id
         WHERE si.ingredient_id = ing.id
      ) AS "sauceCount",
      ing.created_at AS "createdAt"
    FROM public.sauceboss_ingredient ing
  ) t;
$$;


CREATE OR REPLACE FUNCTION public.merge_sauceboss_ingredients(p_keep TEXT, p_merge TEXT[])
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_repointed INT;
BEGIN
  IF p_keep IS NULL OR cardinality(p_merge) = 0 THEN RETURN 0; END IF;

  UPDATE public.sauceboss_sauce_step_ingredient
     SET ingredient_id = p_keep
   WHERE ingredient_id = ANY(p_merge)
     AND ingredient_id <> p_keep;
  GET DIAGNOSTICS v_repointed = ROW_COUNT;

  UPDATE public.sauceboss_user_pantry_missing
     SET ingredient_id = p_keep
   WHERE ingredient_id = ANY(p_merge)
     AND ingredient_id <> p_keep;

  DELETE FROM public.sauceboss_ingredient
   WHERE id = ANY(p_merge) AND id <> p_keep;

  RETURN v_repointed;
END;
$$;


CREATE OR REPLACE FUNCTION public.delete_sauceboss_ingredient_safe(p_id TEXT)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_usage INT;
BEGIN
  SELECT COUNT(*) INTO v_usage
    FROM public.sauceboss_sauce_step_ingredient
   WHERE ingredient_id = p_id;
  IF v_usage > 0 THEN
    RETURN v_usage;
  END IF;
  DELETE FROM public.sauceboss_ingredient WHERE id = p_id;
  RETURN 0;
END;
$$;


-- Legacy aliases — kept callable for one release window so any unmigrated
-- backend code keeps working; remove in a follow-up migration.
CREATE OR REPLACE FUNCTION public.list_sauceboss_foods_with_usage()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT public.list_sauceboss_ingredients_with_usage();
$$;

CREATE OR REPLACE FUNCTION public.merge_sauceboss_foods(p_keep TEXT, p_merge TEXT[])
RETURNS INT LANGUAGE SQL AS $$
  SELECT public.merge_sauceboss_ingredients(p_keep, p_merge);
$$;

CREATE OR REPLACE FUNCTION public.delete_sauceboss_food_safe(p_id TEXT)
RETURNS INT LANGUAGE SQL AS $$
  SELECT public.delete_sauceboss_ingredient_safe(p_id);
$$;
