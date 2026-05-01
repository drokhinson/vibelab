-- ─────────────────────────────────────────────────────────────────────────────
-- 067_sauceboss_ingredient_admin.sql
--
-- RPCs for the Sauce Manager → Ingredients tab:
--   * list_sauceboss_foods_with_usage() — public list with recipe usage counts
--   * merge_sauceboss_foods(p_keep_id, p_merge_ids) — atomic merge: repoint
--     every step_ingredients.food_id from the merged ids to the keep id, then
--     delete the merged foods rows. Returns the count of repointed rows.
--   * delete_sauceboss_food_safe(p_id) — refuses if any step_ingredients still
--     reference the food (would otherwise orphan recipe rows via ON DELETE
--     SET NULL). Caller can use merge to consolidate first.
--
-- Add / rename are simple enough that the route handlers do them inline
-- against the foods table — no RPC needed.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. List foods + usage count ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_sauceboss_foods_with_usage()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(food_obj ORDER BY food_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',         f.id,
      'name',       f.name,
      'plural',     f.plural,
      'usageCount', COALESCE(usage.cnt, 0),
      'sauceCount', COALESCE(usage.sauce_cnt, 0),
      'createdAt',  f.created_at
    ) AS food_obj
    FROM public.sauceboss_foods f
    LEFT JOIN (
      SELECT
        si.food_id,
        COUNT(*) AS cnt,
        COUNT(DISTINCT ss.sauce_id) AS sauce_cnt
      FROM public.sauceboss_step_ingredients si
      JOIN public.sauceboss_sauce_steps ss ON ss.id = si.step_id
      WHERE si.food_id IS NOT NULL
      GROUP BY si.food_id
    ) usage ON usage.food_id = f.id
  ) sub;
$$;


-- ── 2. Atomic merge ─────────────────────────────────────────────────────────
-- Repoints all step_ingredients.food_id from p_merge_ids → p_keep_id, then
-- deletes the merged foods. Returns the number of step_ingredients rows that
-- got repointed (useful for the toast).
CREATE OR REPLACE FUNCTION public.merge_sauceboss_foods(
  p_keep_id   TEXT,
  p_merge_ids TEXT[]
) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_repointed INT := 0;
  v_keep_exists BOOLEAN;
BEGIN
  IF p_keep_id IS NULL OR p_merge_ids IS NULL OR array_length(p_merge_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'merge_sauceboss_foods: p_keep_id and p_merge_ids are required';
  END IF;

  -- Reject self-merge.
  IF p_keep_id = ANY (p_merge_ids) THEN
    RAISE EXCEPTION 'merge_sauceboss_foods: keep id cannot also appear in merge ids';
  END IF;

  SELECT EXISTS(SELECT 1 FROM public.sauceboss_foods WHERE id = p_keep_id) INTO v_keep_exists;
  IF NOT v_keep_exists THEN
    RAISE EXCEPTION 'merge_sauceboss_foods: keep id % does not exist', p_keep_id;
  END IF;

  UPDATE public.sauceboss_step_ingredients
  SET food_id = p_keep_id
  WHERE food_id = ANY (p_merge_ids);

  GET DIAGNOSTICS v_repointed = ROW_COUNT;

  DELETE FROM public.sauceboss_foods WHERE id = ANY (p_merge_ids);

  RETURN v_repointed;
END;
$$;


-- ── 3. Safe delete ──────────────────────────────────────────────────────────
-- Returns the number of step_ingredients rows that reference the food. Zero
-- means the delete went through; non-zero means the caller must merge or
-- remove those references first.
CREATE OR REPLACE FUNCTION public.delete_sauceboss_food_safe(p_id TEXT)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_usage INT;
BEGIN
  SELECT COUNT(*) INTO v_usage
  FROM public.sauceboss_step_ingredients
  WHERE food_id = p_id;

  IF v_usage > 0 THEN
    RETURN v_usage;
  END IF;

  DELETE FROM public.sauceboss_foods WHERE id = p_id;
  RETURN 0;
END;
$$;
