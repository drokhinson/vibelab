-- sauceboss — scope get_sauceboss_saucebook CTEs to the user's sauces
--
-- PERFORMANCE IMPROVEMENT:
--   Before: CTEs aggregate ALL sauces globally, then outer query filters to user
--   After:  A leading CTE selects the user's sauce IDs; all subsequent CTEs
--           are scoped to only those IDs, converting O(all_sauces) → O(user_sauces)

CREATE OR REPLACE FUNCTION public.get_sauceboss_saucebook(p_user_id UUID)
RETURNS JSON LANGUAGE SQL STABLE AS $$
WITH user_sauces AS (
  -- Anchor: only the sauces in this user's saucebook
  SELECT sauce_id, added_at
  FROM public.sauceboss_user_saucebook
  WHERE user_id = p_user_id
),
variant_counts AS (
  -- Count variants per family root, scoped to sauces the user has saved
  SELECT COALESCE(s.parent_sauce_id, s.id) AS family_root, COUNT(*)::int AS variant_count
  FROM public.sauceboss_sauce s
  WHERE s.parent_sauce_id IS NOT NULL
    AND COALESCE(s.parent_sauce_id, s.id) IN (
      SELECT us.sauce_id FROM user_sauces us
      UNION
      SELECT ss.parent_sauce_id FROM user_sauces us
      JOIN public.sauceboss_sauce ss ON ss.id = us.sauce_id
      WHERE ss.parent_sauce_id IS NOT NULL
    )
  GROUP BY COALESCE(s.parent_sauce_id, s.id)
),
attachments_agg AS (
  SELECT d.sauce_id,
         COALESCE(json_agg(json_build_object('kind', d.target_kind, 'value', d.target_value)
                           ORDER BY d.target_kind, d.target_value), '[]'::json) AS attachments
  FROM public.sauceboss_sauce_to_dish d
  WHERE d.sauce_id IN (SELECT sauce_id FROM user_sauces)
  GROUP BY d.sauce_id
),
compatible_items_agg AS (
  SELECT d.sauce_id,
         COALESCE(json_agg(d.target_value ORDER BY d.target_value), '[]'::json) AS compatible_items
  FROM public.sauceboss_sauce_to_dish d
  WHERE d.target_kind = 'dish'
    AND d.sauce_id IN (SELECT sauce_id FROM user_sauces)
  GROUP BY d.sauce_id
),
ingredient_names_agg AS (
  SELECT ss.sauce_id,
         COALESCE(array_agg(DISTINCT COALESCE(ing.name, si.original_text)
                            ORDER BY COALESCE(ing.name, si.original_text)),
                  ARRAY[]::TEXT[]) AS ingredient_names
  FROM public.sauceboss_sauce_step ss
  JOIN public.sauceboss_sauce_step_ingredient si ON si.step_id = ss.id
  LEFT JOIN public.sauceboss_ingredient ing ON ing.id = si.ingredient_id
  WHERE ss.sauce_id IN (SELECT sauce_id FROM user_sauces)
    AND COALESCE(ing.name, si.original_text) IS NOT NULL
  GROUP BY ss.sauce_id
)
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
    'addedAt',         us.added_at,
    'variantCount',    COALESCE(vc.variant_count, 0),
    'attachments',     COALESCE(aa.attachments, '[]'::json),
    'compatibleItems', COALESCE(ca.compatible_items, '[]'::json),
    'ingredientNames', COALESCE(ia.ingredient_names, ARRAY[]::TEXT[])
  ) AS sauce_obj
  FROM user_sauces us
  JOIN public.sauceboss_sauce s ON s.id = us.sauce_id
  LEFT JOIN public.sauceboss_user_profiles p ON p.id = s.created_by
  LEFT JOIN public.sauceboss_cuisine_info ci ON ci.cuisine = s.cuisine
  LEFT JOIN variant_counts vc ON vc.family_root = COALESCE(s.parent_sauce_id, s.id)
  LEFT JOIN attachments_agg aa ON aa.sauce_id = s.id
  LEFT JOIN compatible_items_agg ca ON ca.sauce_id = s.id
  LEFT JOIN ingredient_names_agg ia ON ia.sauce_id = s.id
) sub;
$$;
