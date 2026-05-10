-- ─────────────────────────────────────────────────────────────────────────────
-- sauceboss — slim get_sauceboss_saucebook to a Browse-shaped envelope
--
-- The Saucebook tab only needs sauce cards (grouped by cuisine) — it never
-- reads `steps` and only needs ingredient *names* for the missing-from-pantry
-- badge. Migration 010 returned the same heavy envelope as
-- `get_sauceboss_all_sauces_full` (full steps, per-step ingredients, the flat
-- ingredients[]), which is multiple orders of magnitude heavier than the tab
-- needs and dragged the whole tab into a multi-join hot path on every
-- saucebook fetch.
--
-- This migration replaces the function with a Browse-shaped envelope plus
-- two saucebook-specific additions:
--   * addedAt         — TIMESTAMPTZ the user added the sauce.
--   * ingredientNames — TEXT[] (JSON array) of distinct ingredient names.
--                       Sole input to the frontend's `sauceMissingCount`.
--
-- Dropped from the envelope: full `ingredients` array, `steps`, `description`,
-- `sourceUrl`. The recipe view fetches the full envelope via the existing
-- /sauces (allSauces) path on tap — same flow Browse uses.
--
-- Unlike Browse, this RPC does NOT filter to family roots — saucebook should
-- surface variants directly when the user added a variant.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_sauceboss_saucebook(p_user_id UUID)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'cuisine', sauce_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',              s.id,
      'name',            s.name,
      'cuisine',         s.cuisine,
      'cuisineEmoji',    s.cuisine_emoji,
      'color',           s.color,
      'sauceType',       s.sauce_type,
      'createdBy',       s.created_by,
      'authorName',      COALESCE(p.display_name, ''),
      'parentSauceId',   s.parent_sauce_id,
      'addedAt',         sb.added_at,
      'variantCount', (
        SELECT COUNT(*)::int FROM public.sauceboss_sauces v
         WHERE v.parent_sauce_id = COALESCE(s.parent_sauce_id, s.id)
      ),
      'attachments', (
        SELECT COALESCE(json_agg(json_build_object('kind', a.target_kind, 'value', a.target_value)
                                 ORDER BY a.target_kind, a.target_value), '[]'::json)
          FROM public.sauceboss_sauce_attachments a
         WHERE a.sauce_id = s.id
      ),
      'ingredientNames', (
        SELECT COALESCE(json_agg(DISTINCT COALESCE(f.name, si.original_text) ORDER BY COALESCE(f.name, si.original_text)), '[]'::json)
          FROM public.sauceboss_sauce_steps ss
          JOIN public.sauceboss_step_ingredients si ON si.step_id = ss.id
          LEFT JOIN public.sauceboss_foods f ON f.id = si.food_id
         WHERE ss.sauce_id = s.id
           AND COALESCE(f.name, si.original_text) IS NOT NULL
      )
    ) AS sauce_obj
    FROM public.sauceboss_saucebook sb
    JOIN public.sauceboss_sauces s ON s.id = sb.sauce_id
    LEFT JOIN public.sauceboss_profiles p ON p.id = s.created_by
    WHERE sb.user_id = p_user_id
  ) sub;
$$;
