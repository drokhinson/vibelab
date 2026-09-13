-- ─────────────────────────────────────────────────────────────────────────────
-- sauceboss — clear Supabase database-linter warnings
--
-- Two warning classes were reported against the sauceboss schema:
--
--   1. duplicate_index (PERFORMANCE)
--      Migration 017 added two indexes that already existed under different
--      names, created back in 001/005 and renamed by 013. Duplicates cost
--      write throughput and disk for no read benefit.
--
--   2. function_search_path_mutable (SECURITY)
--      Every sauceboss function was created without a fixed `search_path`, so
--      it resolves unqualified names against the caller's search_path. The
--      bodies qualify their tables as `public.<table>`, so this is not
--      currently exploitable, but pinning the path is the convention already
--      used by boardgamebuddy's RPCs and removes the warning class for good.
--
-- No function body changes — `ALTER FUNCTION … SET` only attaches the config
-- setting, so behaviour, grants, and dependent triggers are untouched.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1) Drop the duplicate indexes ───────────────────────────────────────────
-- public.sauceboss_sauce:
--   sauceboss_sauce_variants_by_parent_idx  (005, renamed in 013)
--     ON (parent_sauce_id) WHERE parent_sauce_id IS NOT NULL   ← keep
--   idx_sauceboss_sauce_parent_id           (017)
--     ON (parent_sauce_id) WHERE parent_sauce_id IS NOT NULL   ← identical, drop
DROP INDEX IF EXISTS public.idx_sauceboss_sauce_parent_id;

-- public.sauceboss_sauce_step_ingredient:
--   idx_sauceboss_sauce_step_ing_step_id         (001, renamed in 013)
--     ON (step_id)                                            ← keep
--   idx_sauceboss_sauce_step_ingredient_step_id  (017)
--     ON (step_id)                                            ← identical, drop
DROP INDEX IF EXISTS public.idx_sauceboss_sauce_step_ingredient_step_id;

-- Note: 017 also issued CREATE INDEX IF NOT EXISTS for
-- idx_sauceboss_sauce_step_sauce_id, which 013 had already produced by
-- renaming idx_sauceboss_sauce_steps_sauce_id — same name, so that statement
-- was a no-op and left nothing to clean up here.


-- ── 2) Pin search_path on every sauceboss function ──────────────────────────

-- Trigger functions and helpers
ALTER FUNCTION public.sauceboss_type_to_category(text)          SET search_path TO 'public';
ALTER FUNCTION public.sauceboss_sauce_variant_check()           SET search_path TO 'public';
ALTER FUNCTION public.sauceboss_dish_level_check()              SET search_path TO 'public';
ALTER FUNCTION public.sauceboss_sauce_to_dish_check()           SET search_path TO 'public';

-- Read functions (public RPC)
ALTER FUNCTION public.get_sauceboss_items_by_category(text)         SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_initial_load()                  SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_variants_for_item(text)         SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_sauces_for_item(text)           SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_sauces_for_target(text, text, text) SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_ingredients_for_item(text)      SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_item_load(text)                 SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_all_sauces()                    SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_all_sauces_full()               SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_sauce_with_family(text)         SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_ingredient_categories()         SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_substitutions()                 SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_distinct_cuisines()             SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_filter_dishes()                 SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_pantry_for_user(uuid)           SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_saucebook(uuid)                 SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_browse_authors(text)            SET search_path TO 'public';
ALTER FUNCTION public.get_sauceboss_browse(
  uuid, text, text[], text[], text[], uuid, integer, integer
) SET search_path TO 'public';
ALTER FUNCTION public.list_sauceboss_ingredients_with_usage()       SET search_path TO 'public';

-- Write functions (public RPC)
ALTER FUNCTION public.upsert_sauceboss_ingredient_category(text, text) SET search_path TO 'public';
ALTER FUNCTION public.create_sauceboss_sauce(jsonb)                 SET search_path TO 'public';
ALTER FUNCTION public.update_sauceboss_sauce(jsonb)                 SET search_path TO 'public';
ALTER FUNCTION public.fork_sauceboss_sauce(text, uuid, jsonb)       SET search_path TO 'public';
ALTER FUNCTION public.set_sauceboss_pantry_missing(uuid, text[])    SET search_path TO 'public';
ALTER FUNCTION public.merge_sauceboss_ingredients(text, text[])     SET search_path TO 'public';
ALTER FUNCTION public.delete_sauceboss_ingredient_safe(text)        SET search_path TO 'public';

-- Legacy aliases (013) — still callable, so still linted
ALTER FUNCTION public.list_sauceboss_foods_with_usage()             SET search_path TO 'public';
ALTER FUNCTION public.merge_sauceboss_foods(text, text[])           SET search_path TO 'public';
ALTER FUNCTION public.delete_sauceboss_food_safe(text)              SET search_path TO 'public';


-- ── 3) Verification ─────────────────────────────────────────────────────────
-- Both queries must come back with zero rows. Run them after the statements
-- above; the linter itself only refreshes on its own schedule.

-- 3a) Any sauceboss function still carrying a mutable search_path:
--
--   SELECT p.oid::regprocedure AS fn
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname LIKE '%sauceboss%'
--      AND NOT EXISTS (
--            SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}'))  AS c
--             WHERE c LIKE 'search_path=%')
--    ORDER BY 1;

-- 3b) Any remaining duplicate index pair on the sauceboss tables. Comparing
--     the rendered definition with the index name blanked out is what catches
--     partial indexes -- grouping on pg_index.indpred does not, because the
--     two stored node trees differ even when the predicates are equivalent.
--
--   SELECT tablename, array_agg(indexname ORDER BY indexname) AS dupes
--     FROM (SELECT tablename, indexname,
--                  regexp_replace(indexdef, ' INDEX .* ON ', ' INDEX ON ') AS def
--             FROM pg_indexes
--            WHERE schemaname = 'public'
--              AND tablename LIKE 'sauceboss_%') t
--    GROUP BY tablename, def
--   HAVING count(*) > 1;
