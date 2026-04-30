-- ─────────────────────────────────────────────────────────────────────────────
-- 063_sauceboss_normalize_ingredients.sql
--
-- Mealie-inspired ingredient normalization for sauceboss:
--   1. New sauceboss_units lookup table (volume / mass / count, with aliases
--      and canonical conversion factors). Single source of truth that the
--      backend mirrors in routes/sauceboss/units.py.
--   2. New sauceboss_foods table (name + plural + aliases). One row per
--      distinct ingredient food; ingredients FK into it.
--      NOTE: no density column for v1. Volume↔mass conversion is unsupported
--      until a curated density map is added — see units.py DENSITY_TODO.
--   3. sauceboss_step_ingredients gains food_id, unit_id, original_text,
--      quantity (numeric), quantity_canonical_ml, quantity_canonical_g.
--      Existing rows are backfilled by inserting foods/units on the fly,
--      then the legacy name / amount / unit columns are dropped.
--   4. RPCs that read or write step_ingredients are rewritten to use the new
--      shape. Read-side RPCs continue to emit name/amount/unit JSON keys for
--      backwards-compat with the existing frontend, plus new canonical
--      fields the unit toggle can use.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- Idempotent for the table creates / column adds; the column drops at the
-- bottom guard against re-runs by checking information_schema first.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. sauceboss_units lookup table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sauceboss_units (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  plural              TEXT NOT NULL,
  abbreviation        TEXT NOT NULL,
  plural_abbreviation TEXT NOT NULL,
  dimension           TEXT NOT NULL CHECK (dimension IN ('volume', 'mass', 'count')),
  ml_per_unit         DOUBLE PRECISION,
  g_per_unit          DOUBLE PRECISION,
  aliases             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
);
ALTER TABLE public.sauceboss_units ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_units TO sauceboss_role;

INSERT INTO public.sauceboss_units (id, name, plural, abbreviation, plural_abbreviation, dimension, ml_per_unit, g_per_unit, aliases) VALUES
  ('teaspoon',    'teaspoon',    'teaspoons',    'tsp',      'tsp',      'volume',  4.92892, NULL, ARRAY['tsp','tsps','teaspoon','teaspoons','t']),
  ('tablespoon',  'tablespoon',  'tablespoons',  'tbsp',     'tbsp',     'volume',  14.7868, NULL, ARRAY['tbsp','tbsps','tablespoon','tablespoons','tbs','tbl','T']),
  ('cup',         'cup',         'cups',         'cup',      'cups',     'volume',  236.588, NULL, ARRAY['cup','cups','c']),
  ('fluid_ounce', 'fluid ounce', 'fluid ounces', 'fl oz',    'fl oz',    'volume',  29.5735, NULL, ARRAY['fl oz','fl. oz.','fluid ounce','fluid ounces','floz']),
  ('millilitre',  'millilitre',  'millilitres',  'ml',       'ml',       'volume',  1.0,     NULL, ARRAY['ml','milliliter','milliliters','millilitre','millilitres']),
  ('litre',       'litre',       'litres',       'l',        'l',        'volume',  1000.0,  NULL, ARRAY['l','liter','liters','litre','litres']),
  ('gram',        'gram',        'grams',        'g',        'g',        'mass',    NULL,    1.0,     ARRAY['g','gram','grams','gr']),
  ('kilogram',    'kilogram',    'kilograms',    'kg',       'kg',       'mass',    NULL,    1000.0,  ARRAY['kg','kilogram','kilograms']),
  ('ounce',       'ounce',       'ounces',       'oz',       'oz',       'mass',    NULL,    28.3495, ARRAY['oz','ounce','ounces']),
  ('pound',       'pound',       'pounds',       'lb',       'lbs',      'mass',    NULL,    453.592, ARRAY['lb','lbs','pound','pounds']),
  ('piece',       'piece',       'pieces',       'piece',    'pieces',   'count',   NULL,    NULL,    ARRAY['piece','pieces','pc','pcs']),
  ('clove',       'clove',       'cloves',       'clove',    'cloves',   'count',   NULL,    NULL,    ARRAY['clove','cloves']),
  ('pinch',       'pinch',       'pinches',      'pinch',    'pinches',  'count',   NULL,    NULL,    ARRAY['pinch','pinches']),
  ('dash',        'dash',        'dashes',       'dash',     'dashes',   'count',   NULL,    NULL,    ARRAY['dash','dashes']),
  ('to_taste',    'to taste',    'to taste',     'to taste', 'to taste', 'count',   NULL,    NULL,    ARRAY['to taste'])
ON CONFLICT (id) DO NOTHING;


-- ── 2. sauceboss_foods table ─────────────────────────────────────────────────
-- TODO(density): add density_g_per_ml DOUBLE PRECISION column when a curated
-- food→density map is built (mirror routes/sauceboss/units.py DENSITY_TODO).
CREATE TABLE IF NOT EXISTS public.sauceboss_foods (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  plural          TEXT,
  name_normalized TEXT NOT NULL UNIQUE,
  aliases         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.sauceboss_foods ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_foods TO sauceboss_role;
-- Regular b-tree on name_normalized covers exact-match upserts; the foods
-- table is small enough that ILIKE typeahead scans are fine without pg_trgm.
CREATE INDEX IF NOT EXISTS sauceboss_foods_name_normalized
  ON public.sauceboss_foods (name_normalized);


-- ── 3. Add normalized columns to sauceboss_step_ingredients ──────────────────
ALTER TABLE public.sauceboss_step_ingredients
  ADD COLUMN IF NOT EXISTS food_id               TEXT REFERENCES public.sauceboss_foods(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unit_id               TEXT REFERENCES public.sauceboss_units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS original_text         TEXT,
  ADD COLUMN IF NOT EXISTS quantity              NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS quantity_canonical_ml DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS quantity_canonical_g  DOUBLE PRECISION;


-- ── 4. Backfill ──────────────────────────────────────────────────────────────
-- Only run while the legacy name/amount/unit columns still exist (idempotent).
DO $$
DECLARE
  has_legacy BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='sauceboss_step_ingredients' AND column_name='name'
  ) INTO has_legacy;
  IF NOT has_legacy THEN
    RAISE NOTICE 'sauceboss_step_ingredients.name already dropped — backfill skipped.';
    RETURN;
  END IF;

  -- 4a. Foods: one row per distinct lower(trim(name)).
  EXECUTE $sql$
    INSERT INTO public.sauceboss_foods (id, name, name_normalized)
    SELECT
      LEFT(REGEXP_REPLACE(LOWER(TRIM(name)), '[^a-z0-9]+', '-', 'g'), 60)
        || '-' || SUBSTR(MD5(LOWER(TRIM(name))), 1, 6) AS id,
      MIN(TRIM(name)) AS name,
      LOWER(TRIM(name)) AS name_normalized
    FROM public.sauceboss_step_ingredients
    WHERE name IS NOT NULL AND TRIM(name) <> ''
    GROUP BY LOWER(TRIM(name))
    ON CONFLICT (name_normalized) DO NOTHING
  $sql$;

  -- 4b. Wire up food_id, unit_id, original_text, quantity, canonical fields.
  EXECUTE $sql$
    UPDATE public.sauceboss_step_ingredients si
    SET
      food_id  = f.id,
      unit_id  = u.id,
      original_text = COALESCE(si.original_text,
        TRIM(BOTH ' ' FROM CONCAT_WS(' ', si.amount::text, NULLIF(si.unit, ''), si.name))),
      quantity = COALESCE(si.quantity, si.amount::numeric),
      quantity_canonical_ml = COALESCE(
        si.quantity_canonical_ml,
        CASE WHEN u.dimension = 'volume' THEN si.amount::double precision * u.ml_per_unit ELSE NULL END
      ),
      quantity_canonical_g = COALESCE(
        si.quantity_canonical_g,
        CASE WHEN u.dimension = 'mass' THEN si.amount::double precision * u.g_per_unit ELSE NULL END
      )
    FROM public.sauceboss_foods f
    LEFT JOIN public.sauceboss_units u ON LOWER(TRIM(si.unit)) = ANY(SELECT LOWER(a) FROM UNNEST(u.aliases) a)
    WHERE f.name_normalized = LOWER(TRIM(si.name))
  $sql$;
END $$;


-- ── 5. Drop legacy columns ───────────────────────────────────────────────────
ALTER TABLE public.sauceboss_step_ingredients DROP COLUMN IF EXISTS name;
ALTER TABLE public.sauceboss_step_ingredients DROP COLUMN IF EXISTS amount;
ALTER TABLE public.sauceboss_step_ingredients DROP COLUMN IF EXISTS unit;


-- ── 6. Updated RPCs ──────────────────────────────────────────────────────────
-- All read-side RPCs continue to emit ``name`` / ``amount`` / ``unit`` JSON
-- keys for backwards-compat with the existing web + native frontends, plus
-- new ``canonicalMl`` / ``canonicalG`` fields that the unit toggle can use.

-- 6a. Sauces for an item (sauce-selector + recipe view)
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


-- 6b. Public sauces full-list (settings tab + admin grid)
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


-- 6c. Ingredient name list per item (now reads from foods table)
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


-- 6d. Sauce creation: resolve food_id from name, persist canonical quantities.
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

  INSERT INTO public.sauceboss_sauces (id, name, cuisine, cuisine_emoji, color, description, sauce_type)
  VALUES (
    v_sauce_id,
    p_data->>'name',
    p_data->>'cuisine',
    p_data->>'cuisineEmoji',
    p_data->>'color',
    COALESCE(p_data->>'description', ''),
    v_sauce_type
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
