-- sauceboss — per-sauce-family fetch RPC
--
-- Opening a recipe today calls get_sauceboss_all_sauces_full() and then the
-- frontend .find()s the matching id. For browse / saucebook / permalink
-- entry points that means fetching every sauce in the DB just to render
-- one. This RPC takes a sauce id, resolves it to its family root
-- (parent_sauce_id or id), and returns just that family — same JSON
-- envelope shape as get_sauceboss_all_sauces_full so the frontend can
-- treat the result interchangeably.

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
    CROSS JOIN root
    WHERE s.id = root.root_id OR s.parent_sauce_id = root.root_id
  ) sub;
$$;
