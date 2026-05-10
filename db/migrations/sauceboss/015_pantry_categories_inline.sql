-- ─────────────────────────────────────────────────────────────────────────────
-- sauceboss — fold ingredient.category into the pantry RPC response
--
-- Today the pantry tab needs two round-trips: GET /pantry for ingredient rows +
-- missing flags, then GET /ingredient-categories for the {name → category} map
-- pantry.js groups by. The category column already lives on sauceboss_ingredient
-- and get_sauceboss_pantry_for_user already LEFT JOINs that table to pull the
-- ingredient name — so the category is one column away on a join we already do.
--
-- This migration extends user_ings to select ing.category and emits it on each
-- per-ingredient row as `category`, NULLIF'd against the literal default
-- 'uncategorized' so the JSON stays small and the frontend's
-- `|| 'Uncategorized'` fallback handles the unset case without a special branch.
--
-- /ingredient-categories stays for the recipe-builder reference flow (it needs
-- the global map covering ingredients the user hasn't put in their saucebook).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_sauceboss_pantry_for_user(p_user_id UUID)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  WITH user_sauces AS (
    SELECT sauce_id FROM public.sauceboss_user_saucebook WHERE user_id = p_user_id
  ),
  user_ings AS (
    SELECT DISTINCT si.ingredient_id, ing.name, ing.category
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
          'foodId',       ui.ingredient_id,                -- release/sauceboss-1.0 compat alias
          'name',         ui.name,
          'category',     NULLIF(ui.category, 'uncategorized'),
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
