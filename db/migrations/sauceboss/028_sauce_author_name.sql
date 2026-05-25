-- sauceboss — expose authorName on the recipe-open RPCs
--
-- The recipe page now shows an "Authored by <name>" footnote. The
-- saucebook RPC (026_fast_saucebook_rpc.sql) already joins
-- sauceboss_user_profiles to emit `authorName`, but the three other
-- RPCs that feed state.selectedSauce do not. Mirror that join + field:
--
--   1) get_sauceboss_sauce_with_family  (permalink / browse / saucebook tap)
--   2) get_sauceboss_all_sauces_full    (admin Sauce Manager)
--   3) get_sauceboss_sauces_for_target  (meal-builder sauce picker)
--
-- Each function's json_build_object gets a new `authorName` field right
-- after `createdBy`, populated from sauceboss_user_profiles.display_name
-- (COALESCE to '' for seed sauces with created_by IS NULL).


-- ── get_sauceboss_sauce_with_family (re-cut of 027) ──
CREATE OR REPLACE FUNCTION public.get_sauceboss_sauce_with_family(p_sauce_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  WITH root AS (
    SELECT COALESCE(s.parent_sauce_id, s.id) AS root_id
      FROM public.sauceboss_sauce s
     WHERE s.id = p_sauce_id
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
      'authorName',      COALESCE(p.display_name, ''),
      'parentSauceId',   s.parent_sauce_id,
      'defaultServings', s.default_servings,
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
            'canonicalG',   di.canonical_g,
            'modifier',     di.modifier
          )
          ORDER BY di.step_order, di.id
        ), '[]'::json)
        FROM (
          SELECT DISTINCT ON (di_inner.ing_name, di_inner.modifier)
            di_inner.id, di_inner.ing_name, di_inner.quantity, di_inner.unit_abbr,
            di_inner.unit_id, di_inner.ingredient_id, di_inner.original_text,
            di_inner.canonical_ml, di_inner.canonical_g, di_inner.modifier, di_inner.step_order
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
              si.modifier,
              ss.step_order
            FROM public.sauceboss_sauce_step ss
            JOIN public.sauceboss_sauce_step_ingredient si ON si.step_id = ss.id
            LEFT JOIN public.sauceboss_ingredient ing ON ing.id = si.ingredient_id
            LEFT JOIN public.sauceboss_unit u         ON u.id  = si.unit_id
            WHERE ss.sauce_id = s.id
          ) di_inner
          ORDER BY di_inner.ing_name, di_inner.modifier, di_inner.step_order, di_inner.id
        ) di
      ),
      'steps', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'title',          ss.title,
            'instructions',   ss.instructions,
            'estimatedTime',  ss.estimated_time,
            'inputFromStep',  ss.input_from_step,
            'inputFromSteps', ss.input_from_steps,
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
                  'canonicalG',   si.quantity_canonical_g,
                  'modifier',     si.modifier
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
    LEFT JOIN public.sauceboss_user_profiles p ON p.id = s.created_by
    CROSS JOIN root
    WHERE s.id = root.root_id OR s.parent_sauce_id = root.root_id
  ) sub;
$$;


-- ── get_sauceboss_all_sauces_full (re-cut of 023) ──
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
      'authorName',      COALESCE(p.display_name, ''),
      'parentSauceId',   s.parent_sauce_id,
      'defaultServings', s.default_servings,
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
            'canonicalG',   di.canonical_g,
            'modifier',     di.modifier
          )
          ORDER BY di.step_order, di.id
        ), '[]'::json)
        FROM (
          SELECT DISTINCT ON (di_inner.ing_name, di_inner.modifier)
            di_inner.id, di_inner.ing_name, di_inner.quantity, di_inner.unit_abbr,
            di_inner.unit_id, di_inner.ingredient_id, di_inner.original_text,
            di_inner.canonical_ml, di_inner.canonical_g, di_inner.modifier, di_inner.step_order
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
              si.modifier,
              ss.step_order
            FROM public.sauceboss_sauce_step ss
            JOIN public.sauceboss_sauce_step_ingredient si ON si.step_id = ss.id
            LEFT JOIN public.sauceboss_ingredient ing ON ing.id = si.ingredient_id
            LEFT JOIN public.sauceboss_unit u         ON u.id  = si.unit_id
            WHERE ss.sauce_id = s.id
          ) di_inner
          ORDER BY di_inner.ing_name, di_inner.modifier, di_inner.step_order, di_inner.id
        ) di
      ),
      'steps', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'title',          ss.title,
            'instructions',   ss.instructions,
            'estimatedTime',  ss.estimated_time,
            'inputFromStep',  ss.input_from_step,
            'inputFromSteps', ss.input_from_steps,
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
                  'canonicalG',   si.quantity_canonical_g,
                  'modifier',     si.modifier
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
    LEFT JOIN public.sauceboss_user_profiles p ON p.id = s.created_by
  ) sub;
$$;


-- ── get_sauceboss_sauces_for_target (re-cut of 023) ──
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
      'authorName',      COALESCE(p.display_name, ''),
      'parentSauceId',   s.parent_sauce_id,
      'defaultServings', s.default_servings,
      'attachments', (
        SELECT COALESCE(json_agg(json_build_object('kind', a2.target_kind, 'value', a2.target_value)
                                 ORDER BY a2.target_kind, a2.target_value), '[]'::json)
          FROM public.sauceboss_sauce_to_dish a2
         WHERE a2.sauce_id = s.id
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
            'canonicalG',   di.canonical_g,
            'modifier',     di.modifier
          )
          ORDER BY di.step_order, di.id
        ), '[]'::json)
        FROM (
          SELECT DISTINCT ON (di_inner.ing_name, di_inner.modifier)
            di_inner.id, di_inner.ing_name, di_inner.quantity, di_inner.unit_abbr,
            di_inner.unit_id, di_inner.ingredient_id, di_inner.original_text,
            di_inner.canonical_ml, di_inner.canonical_g, di_inner.modifier, di_inner.step_order
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
              si.modifier,
              ss.step_order
            FROM public.sauceboss_sauce_step ss
            JOIN public.sauceboss_sauce_step_ingredient si ON si.step_id = ss.id
            LEFT JOIN public.sauceboss_ingredient ing ON ing.id = si.ingredient_id
            LEFT JOIN public.sauceboss_unit u         ON u.id  = si.unit_id
            WHERE ss.sauce_id = s.id
          ) di_inner
          ORDER BY di_inner.ing_name, di_inner.modifier, di_inner.step_order, di_inner.id
        ) di
      ),
      'steps', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'title',          ss.title,
            'instructions',   ss.instructions,
            'estimatedTime',  ss.estimated_time,
            'inputFromStep',  ss.input_from_step,
            'inputFromSteps', ss.input_from_steps,
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
                  'canonicalG',   si.quantity_canonical_g,
                  'modifier',     si.modifier
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
    LEFT JOIN public.sauceboss_user_profiles p ON p.id = s.created_by
    WHERE s.id IN (SELECT id FROM matches)
  ) sub;
$$;
