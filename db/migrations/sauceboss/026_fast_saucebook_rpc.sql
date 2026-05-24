-- sauceboss — strip ingredient_names_agg from get_sauceboss_saucebook
--
-- The slim saucebook RPC was joining sauceboss_sauce_step →
-- sauceboss_sauce_step_ingredient → sauceboss_ingredient just to produce the
-- per-sauce `ingredientNames` array. For active users with many saved sauces
-- this CTE dominated the runtime (observed 30s+ end-to-end while the public
-- /sauces endpoint returns in <1s).
--
-- The web client now derives `ingredientNames` locally from the full
-- envelopes returned by get_sauceboss_all_sauces_full() (which is already
-- fast and runs in parallel), so the RPC no longer needs to compute it.
-- Native callers that still depend on the field should mirror the same
-- client-side hydration; until they do they will see an empty Set, which is
-- equivalent to "no pantry-based availability filtering" — the saucebook
-- list itself still renders.
--
-- All other CTEs (variant_counts, attachments_agg, compatible_items_agg)
-- remain — they're cheap and the frontend uses them on every card.

CREATE OR REPLACE FUNCTION public.get_sauceboss_saucebook(p_user_id UUID)
RETURNS JSON LANGUAGE SQL STABLE AS $$
WITH user_sauces AS (
  SELECT sauce_id, added_at
  FROM public.sauceboss_user_saucebook
  WHERE user_id = p_user_id
),
variant_counts AS (
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
    'defaultServings', s.default_servings,
    'addedAt',         us.added_at,
    'variantCount',    COALESCE(vc.variant_count, 0),
    'attachments',     COALESCE(aa.attachments, '[]'::json),
    'compatibleItems', COALESCE(ca.compatible_items, '[]'::json)
  ) AS sauce_obj
  FROM user_sauces us
  JOIN public.sauceboss_sauce s ON s.id = us.sauce_id
  LEFT JOIN public.sauceboss_user_profiles p ON p.id = s.created_by
  LEFT JOIN public.sauceboss_cuisine_info ci ON ci.cuisine = s.cuisine
  LEFT JOIN variant_counts vc ON vc.family_root = COALESCE(s.parent_sauce_id, s.id)
  LEFT JOIN attachments_agg aa ON aa.sauce_id = s.id
  LEFT JOIN compatible_items_agg ca ON ca.sauce_id = s.id
) sub;
$$;
