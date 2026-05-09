-- ─────────────────────────────────────────────────────────────────────────────
-- sauceboss — sauce attachment rework
--
-- Replaces the dish-only `sauceboss_sauce_items` junction with a richer
-- `sauceboss_sauce_attachments` table that lets a sauce attach at any level
-- of the new 3-level dish hierarchy:
--
--   target_kind='category' → target_value ∈ ('carb','protein','salad')
--   target_kind='dish'     → target_value = sauceboss_items.id (dish_level='dish')
--   target_kind='subtype'  → target_value = sauceboss_items.id (dish_level='subtype')
--
-- Propagation (handled in the new resolver RPC, not by triggers): a sauce
-- attached at category=salad applies to every salad dish + subtype; a sauce
-- attached at dish=bread applies to bread + every bread subtype.
--
-- Dual-write window: the legacy `sauceboss_sauce_items` table is kept in
-- sync (writes mirror dish-level attachments into it) so the Native app
-- and any other unmigrated reader keeps working. A follow-up migration
-- will drop it once Native ships.
--
-- Read RPCs are rewritten to:
--   * use sauceboss_sauce_attachments as the source of truth for targeting
--   * emit a new `attachments` array on every sauce envelope
--   * keep emitting `compatibleItems` (dish-level ids, including ones
--     inherited via category attachment) for legacy clients
--   * surface `dishLevel` on item rows
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1) Attachments table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sauceboss_sauce_attachments (
  sauce_id     TEXT NOT NULL REFERENCES public.sauceboss_sauces(id) ON DELETE CASCADE,
  target_kind  TEXT NOT NULL CHECK (target_kind IN ('category','dish','subtype')),
  target_value TEXT NOT NULL,
  PRIMARY KEY (sauce_id, target_kind, target_value)
);
CREATE INDEX IF NOT EXISTS sauceboss_sauce_attachments_by_target_idx
  ON public.sauceboss_sauce_attachments (target_kind, target_value);
ALTER TABLE public.sauceboss_sauce_attachments ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_sauce_attachments TO sauceboss_role;


-- ── 2) Type ↔ category map helper (used by the attachments trigger) ───────────
-- 'sauce' → carb, 'marinade' → protein, 'dressing' → salad. Migration 009
-- replaces this function to add 'dip' → carb. Keeping it in a function lets us
-- update one place without regenerating the trigger.
CREATE OR REPLACE FUNCTION public.sauceboss_type_to_category(p_sauce_type TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE p_sauce_type
    WHEN 'sauce'    THEN 'carb'
    WHEN 'marinade' THEN 'protein'
    WHEN 'dressing' THEN 'salad'
    ELSE NULL
  END;
$$;


-- ── 3) Trigger: attachment integrity ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sauceboss_sauce_attachments_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_type   TEXT;
  v_expected_cat TEXT;
  v_item_cat     TEXT;
  v_item_level   TEXT;
BEGIN
  SELECT sauce_type INTO v_sauce_type
    FROM public.sauceboss_sauces
   WHERE id = NEW.sauce_id;

  v_expected_cat := public.sauceboss_type_to_category(v_sauce_type);
  IF v_expected_cat IS NULL THEN
    RAISE EXCEPTION 'sauceboss_sauce_attachments: unknown sauce_type=% on sauce %',
      v_sauce_type, NEW.sauce_id;
  END IF;

  IF NEW.target_kind = 'category' THEN
    IF NEW.target_value NOT IN ('carb','protein','salad') THEN
      RAISE EXCEPTION 'sauceboss_sauce_attachments: category target must be one of carb/protein/salad (got %)',
        NEW.target_value;
    END IF;
    IF NEW.target_value <> v_expected_cat THEN
      RAISE EXCEPTION 'sauceboss_sauce_attachments: sauce_type=% expects category=% (got %)',
        v_sauce_type, v_expected_cat, NEW.target_value;
    END IF;
    RETURN NEW;
  END IF;

  -- dish or subtype: look up the item
  SELECT category, dish_level INTO v_item_cat, v_item_level
    FROM public.sauceboss_items
   WHERE id = NEW.target_value;

  IF v_item_cat IS NULL THEN
    RAISE EXCEPTION 'sauceboss_sauce_attachments: unknown item % for kind=%',
      NEW.target_value, NEW.target_kind;
  END IF;

  IF v_item_level <> NEW.target_kind THEN
    RAISE EXCEPTION 'sauceboss_sauce_attachments: item % is dish_level=% but attachment kind=%',
      NEW.target_value, v_item_level, NEW.target_kind;
  END IF;

  IF v_item_cat <> v_expected_cat THEN
    RAISE EXCEPTION 'sauceboss_sauce_attachments: sauce_type=% expects category=% but item % is category=%',
      v_sauce_type, v_expected_cat, NEW.target_value, v_item_cat;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sauceboss_sauce_attachments_check_trg ON public.sauceboss_sauce_attachments;
CREATE TRIGGER sauceboss_sauce_attachments_check_trg
  BEFORE INSERT OR UPDATE ON public.sauceboss_sauce_attachments
  FOR EACH ROW EXECUTE FUNCTION public.sauceboss_sauce_attachments_check();


-- ── 4) Backfill from existing sauceboss_sauce_items ───────────────────────────
-- Every existing junction row points at a top-level item (today: parent_id IS
-- NULL ⇒ 'dish' after migration 007). Mirror them as dish-level attachments.
INSERT INTO public.sauceboss_sauce_attachments (sauce_id, target_kind, target_value)
SELECT sauce_id, 'dish', item_id
  FROM public.sauceboss_sauce_items
ON CONFLICT (sauce_id, target_kind, target_value) DO NOTHING;


-- ── 5) Resolver RPC: sauces matching a target ─────────────────────────────────
-- Caller passes whichever of (category, dishId, subtypeId) is known. Returns
-- the union of:
--   * sauces attached at category-level matching p_category
--   * sauces attached at dish-level matching p_dish_id
--   * sauces attached at subtype-level matching p_subtype_id
--   * sauces attached at dish-level matching the subtype's parent (so a sauce
--     paired with the parent dish propagates to its subtypes)
CREATE OR REPLACE FUNCTION public.get_sauceboss_sauces_for_target(
  p_category   TEXT,
  p_dish_id    TEXT,
  p_subtype_id TEXT
)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  WITH parent_dish AS (
    SELECT parent_id
      FROM public.sauceboss_items
     WHERE p_subtype_id IS NOT NULL AND id = p_subtype_id
  ),
  matches AS (
    SELECT DISTINCT s.id
      FROM public.sauceboss_sauces s
      JOIN public.sauceboss_sauce_attachments a ON a.sauce_id = s.id
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
      'cuisineEmoji',    s.cuisine_emoji,
      'color',           s.color,
      'description',     s.description,
      'sourceUrl',       s.source_url,
      'sauceType',       s.sauce_type,
      'createdBy',       s.created_by,
      'parentSauceId',   s.parent_sauce_id,
      'attachments', (
        SELECT COALESCE(json_agg(json_build_object('kind', a2.target_kind, 'value', a2.target_value)
                                 ORDER BY a2.target_kind, a2.target_value), '[]'::json)
          FROM public.sauceboss_sauce_attachments a2
         WHERE a2.sauce_id = s.id
      ),
      'compatibleItems', (
        SELECT COALESCE(json_agg(link.item_id ORDER BY link.item_id), '[]'::json)
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
            'instructions',  ss.instructions,
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
    WHERE s.id IN (SELECT id FROM matches)
  ) sub;
$$;


-- ── 6) Update get_sauceboss_sauces_for_item to include propagation ────────────
-- Same shape as before; now also includes sauces attached at the item's
-- category level. Used by the legacy item-load path; the new meal-builder
-- flow calls get_sauceboss_sauces_for_target instead.
CREATE OR REPLACE FUNCTION public.get_sauceboss_sauces_for_item(p_item_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT public.get_sauceboss_sauces_for_target(
    (SELECT category FROM public.sauceboss_items WHERE id = p_item_id),
    CASE WHEN (SELECT dish_level FROM public.sauceboss_items WHERE id = p_item_id) = 'dish'    THEN p_item_id ELSE NULL END,
    CASE WHEN (SELECT dish_level FROM public.sauceboss_items WHERE id = p_item_id) = 'subtype' THEN p_item_id ELSE NULL END
  );
$$;


-- ── 7) Update get_sauceboss_all_sauces_full + get_sauceboss_all_sauces ────────
-- Add attachments array; keep compatibleItems for legacy clients.
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
      'createdBy',       s.created_by,
      'parentSauceId',   s.parent_sauce_id,
      'attachments', (
        SELECT COALESCE(json_agg(json_build_object('kind', a.target_kind, 'value', a.target_value)
                                 ORDER BY a.target_kind, a.target_value), '[]'::json)
          FROM public.sauceboss_sauce_attachments a
         WHERE a.sauce_id = s.id
      ),
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
            'instructions',  ss.instructions,
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
      'createdBy',       s.created_by,
      'parentSauceId',   s.parent_sauce_id,
      'attachments', (
        SELECT COALESCE(json_agg(json_build_object('kind', a.target_kind, 'value', a.target_value)
                                 ORDER BY a.target_kind, a.target_value), '[]'::json)
          FROM public.sauceboss_sauce_attachments a
         WHERE a.sauce_id = s.id
      ),
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


-- ── 8) Item-level RPCs: surface dishLevel + restructure initial-load ──────────
-- Initial load now returns dishes grouped by category, each with its subtypes
-- nested. Frontend uses this to render the meal-builder accordion.
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
      i.dish_level         AS "dishLevel",
      i.parent_id          AS "parentId",
      i.water_ratio        AS "waterRatio",
      i.cook_time_minutes  AS "cookTimeMinutes",
      i.portion_per_person AS "portionPerPerson",
      i.portion_unit       AS "portionUnit",
      i.sort_order         AS "sortOrder",
      (
        SELECT COUNT(*)::int FROM public.sauceboss_sauce_attachments a
         WHERE (a.target_kind = 'dish'    AND a.target_value = i.id)
            OR (a.target_kind = 'subtype' AND a.target_value = i.id)
      ) AS "sauceCount",
      CASE WHEN i.dish_level = 'dish' THEN (
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
        FROM public.sauceboss_items sub
        WHERE sub.parent_id = i.id AND sub.dish_level = 'subtype'
      ) ELSE NULL END AS subtypes
    FROM public.sauceboss_items i
    WHERE i.category = p_category AND i.dish_level = 'dish'
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


-- ── 9) Item load: keep compat shape, surface dishLevel, propagate to siblings ─
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
      i.dish_level         AS "dishLevel",
      i.sort_order         AS "sortOrder"
    FROM public.sauceboss_items i
    WHERE i.parent_id = p_item_id
      AND i.dish_level = 'subtype'
  ) t;
$$;


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
        'dishLevel',         i.dish_level,
        'parentId',          i.parent_id,
        'waterRatio',        i.water_ratio,
        'portionPerPerson',  i.portion_per_person,
        'portionUnit',       i.portion_unit
      )
      FROM public.sauceboss_items i
      WHERE i.id = p_item_id
    ),
    'variants',    public.get_sauceboss_variants_for_item(p_item_id),
    'sauces',      public.get_sauceboss_sauces_for_item(p_item_id),
    'ingredients', public.get_sauceboss_ingredients_for_item(p_item_id)
  );
$$;


-- ── 10) Ingredients-for-item must follow attachments now (with propagation) ───
CREATE OR REPLACE FUNCTION public.get_sauceboss_ingredients_for_item(p_item_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  WITH item_meta AS (
    SELECT id, category, dish_level, parent_id
      FROM public.sauceboss_items
     WHERE id = p_item_id
  ),
  matched_sauces AS (
    SELECT DISTINCT a.sauce_id
      FROM public.sauceboss_sauce_attachments a, item_meta im
     WHERE
       (a.target_kind = 'category' AND a.target_value = im.category)
       OR (a.target_kind = 'dish'    AND im.dish_level = 'dish'    AND a.target_value = im.id)
       OR (a.target_kind = 'subtype' AND im.dish_level = 'subtype' AND a.target_value = im.id)
       OR (a.target_kind = 'dish'    AND im.dish_level = 'subtype' AND a.target_value = im.parent_id)
  )
  SELECT COALESCE(json_agg(name ORDER BY name), '[]'::json)
  FROM (
    SELECT DISTINCT COALESCE(f.name, si.original_text) AS name
      FROM matched_sauces ms
      JOIN public.sauceboss_sauce_steps ss      ON ss.sauce_id = ms.sauce_id
      JOIN public.sauceboss_step_ingredients si ON si.step_id = ss.id
      LEFT JOIN public.sauceboss_foods f        ON f.id = si.food_id
     WHERE COALESCE(f.name, si.original_text) IS NOT NULL
  ) sub;
$$;


-- ── 11) Writers: dual-write attachments + legacy junction ─────────────────────
-- create_sauceboss_sauce now consumes either p_data->'attachments' (preferred,
-- shape: [{kind,value}, ...]) or p_data->'itemIds' (legacy, mapped to dish-
-- level attachments). Mirrors dish-level attachments into the legacy
-- sauceboss_sauce_items table during the transition.
CREATE OR REPLACE FUNCTION public.create_sauceboss_sauce(p_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_id     TEXT;
  v_sauce_type   TEXT;
  v_created_by   UUID;
  v_parent       TEXT;
  v_step         JSONB;
  v_step_id      BIGINT;
  v_ing          JSONB;
  v_food_name    TEXT;
  v_food_norm    TEXT;
  v_food_id      TEXT;
  v_attach       JSONB;
  v_kind         TEXT;
  v_value        TEXT;
  v_item         TEXT;
BEGIN
  v_sauce_id   := p_data->>'id';
  v_sauce_type := COALESCE(p_data->>'sauceType', 'sauce');
  v_created_by := NULLIF(p_data->>'createdBy', '')::UUID;
  v_parent     := NULLIF(p_data->>'parentSauceId', '');

  INSERT INTO public.sauceboss_sauces
    (id, name, cuisine, cuisine_emoji, color, description,
     sauce_type, source_url, created_by, parent_sauce_id)
  VALUES (
    v_sauce_id,
    p_data->>'name',
    p_data->>'cuisine',
    p_data->>'cuisineEmoji',
    p_data->>'color',
    COALESCE(p_data->>'description', ''),
    v_sauce_type,
    NULLIF(p_data->>'sourceUrl', ''),
    v_created_by,
    v_parent
  );

  -- Attachments (preferred). If the payload has attachments, use them and
  -- mirror dish-level rows into the legacy sauceboss_sauce_items table.
  IF p_data ? 'attachments' AND jsonb_array_length(p_data->'attachments') > 0 THEN
    FOR v_attach IN SELECT * FROM jsonb_array_elements(p_data->'attachments')
    LOOP
      v_kind  := v_attach->>'kind';
      v_value := v_attach->>'value';
      INSERT INTO public.sauceboss_sauce_attachments (sauce_id, target_kind, target_value)
        VALUES (v_sauce_id, v_kind, v_value)
        ON CONFLICT DO NOTHING;
      IF v_kind = 'dish' THEN
        INSERT INTO public.sauceboss_sauce_items (sauce_id, item_id)
          VALUES (v_sauce_id, v_value)
          ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  ELSIF p_data ? 'itemIds' THEN
    -- Legacy alias: every itemId is treated as a dish-level attachment.
    FOR v_item IN SELECT jsonb_array_elements_text(p_data->'itemIds')
    LOOP
      INSERT INTO public.sauceboss_sauce_attachments (sauce_id, target_kind, target_value)
        VALUES (v_sauce_id, 'dish', v_item)
        ON CONFLICT DO NOTHING;
      INSERT INTO public.sauceboss_sauce_items (sauce_id, item_id)
        VALUES (v_sauce_id, v_item)
        ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  FOR v_step IN SELECT * FROM jsonb_array_elements(p_data->'steps')
  LOOP
    INSERT INTO public.sauceboss_sauce_steps
      (sauce_id, step_order, title, instructions, input_from_step)
    VALUES (
      v_sauce_id,
      (v_step->>'stepOrder')::INT,
      v_step->>'title',
      NULLIF(v_step->>'instructions', ''),
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


CREATE OR REPLACE FUNCTION public.update_sauceboss_sauce(p_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_id   TEXT;
  v_sauce_type TEXT;
  v_step       JSONB;
  v_step_id    BIGINT;
  v_ing        JSONB;
  v_food_name  TEXT;
  v_food_norm  TEXT;
  v_food_id    TEXT;
  v_attach     JSONB;
  v_kind       TEXT;
  v_value      TEXT;
  v_item       TEXT;
BEGIN
  v_sauce_id   := p_data->>'id';
  v_sauce_type := COALESCE(p_data->>'sauceType', 'sauce');

  IF NOT EXISTS (SELECT 1 FROM public.sauceboss_sauces WHERE id = v_sauce_id) THEN
    RAISE EXCEPTION 'update_sauceboss_sauce: sauce % not found', v_sauce_id;
  END IF;

  UPDATE public.sauceboss_sauces SET
    name            = p_data->>'name',
    cuisine         = p_data->>'cuisine',
    cuisine_emoji   = p_data->>'cuisineEmoji',
    color           = p_data->>'color',
    description     = COALESCE(p_data->>'description', ''),
    sauce_type      = v_sauce_type,
    source_url      = NULLIF(p_data->>'sourceUrl', ''),
    parent_sauce_id = NULLIF(p_data->>'parentSauceId', '')
  WHERE id = v_sauce_id;

  -- Replace attachments + legacy item links in lockstep.
  DELETE FROM public.sauceboss_sauce_attachments WHERE sauce_id = v_sauce_id;
  DELETE FROM public.sauceboss_sauce_items WHERE sauce_id = v_sauce_id;

  IF p_data ? 'attachments' AND jsonb_array_length(p_data->'attachments') > 0 THEN
    FOR v_attach IN SELECT * FROM jsonb_array_elements(p_data->'attachments')
    LOOP
      v_kind  := v_attach->>'kind';
      v_value := v_attach->>'value';
      INSERT INTO public.sauceboss_sauce_attachments (sauce_id, target_kind, target_value)
        VALUES (v_sauce_id, v_kind, v_value)
        ON CONFLICT DO NOTHING;
      IF v_kind = 'dish' THEN
        INSERT INTO public.sauceboss_sauce_items (sauce_id, item_id)
          VALUES (v_sauce_id, v_value)
          ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  ELSIF p_data ? 'itemIds' THEN
    FOR v_item IN SELECT jsonb_array_elements_text(p_data->'itemIds')
    LOOP
      INSERT INTO public.sauceboss_sauce_attachments (sauce_id, target_kind, target_value)
        VALUES (v_sauce_id, 'dish', v_item)
        ON CONFLICT DO NOTHING;
      INSERT INTO public.sauceboss_sauce_items (sauce_id, item_id)
        VALUES (v_sauce_id, v_item)
        ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  -- Replace steps (cascade clean step ingredients)
  DELETE FROM public.sauceboss_sauce_steps WHERE sauce_id = v_sauce_id;
  FOR v_step IN SELECT * FROM jsonb_array_elements(p_data->'steps')
  LOOP
    INSERT INTO public.sauceboss_sauce_steps
      (sauce_id, step_order, title, instructions, input_from_step)
    VALUES (
      v_sauce_id,
      (v_step->>'stepOrder')::INT,
      v_step->>'title',
      NULLIF(v_step->>'instructions', ''),
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
