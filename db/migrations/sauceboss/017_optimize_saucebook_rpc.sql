-- sauceboss — optimize get_sauceboss_saucebook RPC using CTEs
-- Replace correlated subqueries (O(n) per recipe) with batch aggregations (O(1))
--
-- PERFORMANCE IMPROVEMENT:
--   Before: 4 subqueries per recipe × recipe count = potentially 400+ DB operations for 100 recipes
--   After:  Single efficient query with pre-computed CTEs + OUTER JOINs
--
-- Changes:
--   1. Variant counts: single GROUP BY instead of COUNT per recipe
--   2. Attachments: single aggregation instead of json_agg per recipe
--   3. Compatible items: single aggregation instead of json_agg per recipe
--   4. Ingredient names: single aggregation instead of array_agg per recipe
--   5. Add indexes to support faster GROUP BY operations

-- ── Indexes for faster CTE aggregations ────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sauceboss_sauce_parent_id
  ON public.sauceboss_sauce(parent_sauce_id)
  WHERE parent_sauce_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sauceboss_sauce_to_dish_sauce_id
  ON public.sauceboss_sauce_to_dish(sauce_id);

CREATE INDEX IF NOT EXISTS idx_sauceboss_sauce_step_sauce_id
  ON public.sauceboss_sauce_step(sauce_id);

CREATE INDEX IF NOT EXISTS idx_sauceboss_sauce_step_ingredient_step_id
  ON public.sauceboss_sauce_step_ingredient(step_id);


-- ── Optimized RPC: batch aggregations via CTEs ─────────────────────────────
CREATE OR REPLACE FUNCTION public.get_sauceboss_saucebook(p_user_id UUID)
RETURNS JSON LANGUAGE SQL STABLE AS $$
WITH variant_counts AS (
  -- Count variants per family root (one row per family)
  SELECT parent_sauce_id, COUNT(*)::int AS variant_count
  FROM public.sauceboss_sauce
  WHERE parent_sauce_id IS NOT NULL
  GROUP BY parent_sauce_id
),
attachments_agg AS (
  -- Aggregate attachments per sauce (one row per sauce with attachments)
  SELECT sauce_id,
         COALESCE(json_agg(json_build_object('kind', target_kind, 'value', target_value)
                           ORDER BY target_kind, target_value), '[]'::json) AS attachments
  FROM public.sauceboss_sauce_to_dish
  GROUP BY sauce_id
),
compatible_items_agg AS (
  -- Aggregate dish targets per sauce (one row per sauce with dishes)
  SELECT sauce_id,
         COALESCE(json_agg(target_value ORDER BY target_value), '[]'::json) AS compatible_items
  FROM public.sauceboss_sauce_to_dish
  WHERE target_kind = 'dish'
  GROUP BY sauce_id
),
ingredient_names_agg AS (
  -- Aggregate distinct ingredient names per sauce (one row per sauce with ingredients)
  SELECT ss.sauce_id,
         COALESCE(array_agg(DISTINCT COALESCE(ing.name, si.original_text)
                            ORDER BY COALESCE(ing.name, si.original_text)),
                  ARRAY[]::TEXT[]) AS ingredient_names
  FROM public.sauceboss_sauce_step ss
  JOIN public.sauceboss_sauce_step_ingredient si ON si.step_id = ss.id
  LEFT JOIN public.sauceboss_ingredient ing ON ing.id = si.ingredient_id
  WHERE COALESCE(ing.name, si.original_text) IS NOT NULL
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
    'addedAt',         sb.added_at,
    'variantCount',    COALESCE(vc.variant_count, 0),
    'attachments',     COALESCE(aa.attachments, '[]'::json),
    'compatibleItems', COALESCE(ca.compatible_items, '[]'::json),
    'ingredientNames', COALESCE(ia.ingredient_names, ARRAY[]::TEXT[])
  ) AS sauce_obj
  FROM public.sauceboss_user_saucebook sb
  JOIN public.sauceboss_sauce s ON s.id = sb.sauce_id
  LEFT JOIN public.sauceboss_user_profiles p ON p.id = s.created_by
  LEFT JOIN public.sauceboss_cuisine_info ci ON ci.cuisine = s.cuisine
  LEFT JOIN variant_counts vc ON vc.parent_sauce_id = COALESCE(s.parent_sauce_id, s.id)
  LEFT JOIN attachments_agg aa ON aa.sauce_id = s.id
  LEFT JOIN compatible_items_agg ca ON ca.sauce_id = s.id
  LEFT JOIN ingredient_names_agg ia ON ia.sauce_id = s.id
  WHERE sb.user_id = p_user_id
) sub;
$$;
