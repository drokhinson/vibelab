-- ─────────────────────────────────────────────────────────────────────────────
-- sauceboss — release/sauceboss-1.0 compat layer
--
-- Migration 013 renamed tables, dropped legacy junctions, and renamed JSON
-- fields in every read RPC (foodId → ingredientId, removed compatibleItems
-- in favor of attachments[]). The release-branch web/native code (commit
-- 13d7461 on origin/release/sauceboss-1.0) is still in beta and shares the
-- same Railway backend + Supabase project as main, so it would break the
-- moment 013 deployed.
--
-- This migration adds a thin compat layer:
--   * Sauce envelope RPCs emit BOTH `foodId` and `ingredientId` per ingredient.
--   * Sauce envelope RPCs emit a `compatibleItems` array synthesized from
--     sauceboss_sauce_to_dish where target_kind='dish' (no resurrected junction).
--   * Pantry RPC emits BOTH `foodId` and `ingredientId` per row.
--   * Re-adds get_sauceboss_ingredient_categories / get_sauceboss_substitutions /
--     upsert_sauceboss_ingredient_category, all reading from the consolidated
--     sauceboss_ingredient.{category, substitutions[]} columns.
--   * set_sauceboss_pantry_missing gains a legacy-named overload accepting
--     p_food_ids (delegates to the post-013 p_ingredient_ids signature).
--
-- The favorites table is NOT resurrected — the release's /favorites HTTP
-- endpoints are restored as backend-side aliases that read/write
-- sauceboss_user_saucebook (see shared-backend/routes/sauceboss/favorites_routes.py).
--
-- Drop this layer in a follow-up migration once release/sauceboss-1.0 is
-- retired (delete the compat field emits + the alias RPCs + the alias HTTP
-- routes — schema itself stays as 013 left it).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1) Drop & recreate sauce envelope RPCs to emit legacy fields ────────────

DROP FUNCTION IF EXISTS public.get_sauceboss_sauces_for_target(TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_sauces_for_item(TEXT)               CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_all_sauces()                        CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_all_sauces_full()                   CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_saucebook(UUID)                     CASCADE;
DROP FUNCTION IF EXISTS public.get_sauceboss_pantry_for_user(UUID)               CASCADE;


-- Resolver — adds compatibleItems[] (synthesized) and dual-emit foodId.
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
      -- Compat: release/sauceboss-1.0 reads `compatibleItems` as an array of
      -- dish ids. Synthesized from attachments where target_kind='dish'.
      'compatibleItems', (
        SELECT COALESCE(json_agg(a3.target_value ORDER BY a3.target_value), '[]'::json)
          FROM public.sauceboss_sauce_to_dish a3
         WHERE a3.sauce_id = s.id AND a3.target_kind = 'dish'
      ),
      'ingredients', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'name',         di.ing_name,
            'amount',       di.quantity,
            'unit',         di.unit_abbr,
            'unitId',       di.unit_id,
            'ingredientId', di.ingredient_id,
            'foodId',       di.ingredient_id,           -- compat alias
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
                  'foodId',       si.ingredient_id,        -- compat alias
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
      'compatibleItems', (
        SELECT COALESCE(json_agg(a3.target_value ORDER BY a3.target_value), '[]'::json)
          FROM public.sauceboss_sauce_to_dish a3
         WHERE a3.sauce_id = s.id AND a3.target_kind = 'dish'
      ),
      'ingredients', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'name',         di.ing_name,
            'amount',       di.quantity,
            'unit',         di.unit_abbr,
            'unitId',       di.unit_id,
            'ingredientId', di.ingredient_id,
            'foodId',       di.ingredient_id,
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
                  'foodId',       si.ingredient_id,
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
      ),
      'compatibleItems', (
        SELECT COALESCE(json_agg(a3.target_value ORDER BY a3.target_value), '[]'::json)
          FROM public.sauceboss_sauce_to_dish a3
         WHERE a3.sauce_id = s.id AND a3.target_kind = 'dish'
      )
    )
    ORDER BY s.cuisine, s.name
  ), '[]'::json)
  FROM public.sauceboss_sauce s
  LEFT JOIN public.sauceboss_cuisine_info ci ON ci.cuisine = s.cuisine;
$$;


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
      'compatibleItems', (
        SELECT COALESCE(json_agg(a3.target_value ORDER BY a3.target_value), '[]'::json)
          FROM public.sauceboss_sauce_to_dish a3
         WHERE a3.sauce_id = s.id AND a3.target_kind = 'dish'
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


-- ── 2) Pantry RPC: dual-emit foodId + ingredientId ──────────────────────────
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
          'foodId',       ui.ingredient_id,        -- compat alias
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


-- ── 3) Lookup-table RPCs the release still calls ───────────────────────────
-- (set_sauceboss_pantry_missing keeps its post-013 signature with
-- p_ingredient_ids. The release-branch frontend hits Railway, not Supabase
-- directly; the new Python backend translates the legacy `missingFoodIds`
-- body field to `p_ingredient_ids` before calling the RPC — see
-- shared-backend/routes/sauceboss/pantry_routes.py.)

-- Shape mirrors the pre-013 RPC: array of {ingredientName, category} rows.
-- The release's api.js coerces both array and dict, but emit array for
-- determinism.
CREATE OR REPLACE FUNCTION public.get_sauceboss_ingredient_categories()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(json_build_object(
    'ingredientName', LOWER(ing.name),
    'category',       ing.category
  ) ORDER BY ing.name), '[]'::json)
  FROM public.sauceboss_ingredient ing
  WHERE ing.category IS NOT NULL AND ing.category <> 'uncategorized';
$$;


-- Emit one row per substitute (unnest the array). notes is always NULL —
-- the legacy column moved to a flat string array, so the field is gone.
CREATE OR REPLACE FUNCTION public.get_sauceboss_substitutions()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(json_build_object(
    'ingredientName', LOWER(ing.name),
    'substituteName', sub,
    'notes',          NULL
  ) ORDER BY ing.name, sub), '[]'::json)
  FROM public.sauceboss_ingredient ing,
       LATERAL UNNEST(COALESCE(ing.substitutions, ARRAY[]::TEXT[])) AS sub
  WHERE ing.substitutions IS NOT NULL AND cardinality(ing.substitutions) > 0;
$$;


-- Writes through to sauceboss_ingredient.category. No-op if the named
-- ingredient doesn't exist (the release's POST silently absorbs failures).
CREATE OR REPLACE FUNCTION public.upsert_sauceboss_ingredient_category(
  p_ingredient_name TEXT,
  p_category        TEXT
)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.sauceboss_ingredient
     SET category = p_category
   WHERE LOWER(TRIM(name)) = LOWER(TRIM(p_ingredient_name));
END;
$$;
