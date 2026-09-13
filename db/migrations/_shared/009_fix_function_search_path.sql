-- ─────────────────────────────────────────────────────────────────────────────
-- _shared/009_fix_function_search_path.sql
-- Pin search_path on the two cross-app SECURITY DEFINER admin RPCs.
--
-- Clears Supabase's function_search_path_mutable warning for:
--   admin_table_sizes()        — defined in _shared/002_admin_rpcs.sql
--   analytics_summary_counts() — defined in _shared/007_analytics_summary_rpc.sql
--
-- These are the last two functions in the database without a fixed
-- search_path; every app's RPCs already pin theirs (sauceboss/029,
-- boardgamebuddy's CREATEs, travelscrapbook/027 alongside this).
--
-- WHY IT MATTERS MORE HERE
--   Both are SECURITY DEFINER, so they execute as `postgres`. A definer
--   function that resolves unqualified names against the caller's search_path
--   is the textbook privilege-escalation shape: a caller puts their own schema
--   first, defines an object that shadows one the body names unqualified, and
--   the body runs it with owner privileges.
--
--   _shared/008 already stopped anon and authenticated from reaching these at
--   all, so the remaining caller is the backend's service_role — this closes
--   the shape rather than an open door. Worth closing regardless: the two
--   defences are independent, and this one survives a future grant.
--
-- SAFE
--   admin_table_sizes reads pg_class / pg_namespace and analytics_summary_counts
--   reads public.analytics_events; neither touches auth, storage or extensions,
--   so `public` is a sufficient path. ALTER FUNCTION ... SET only attaches the
--   setting — bodies, volatility, ownership and grants are untouched, so
--   _shared/008's REVOKEs stand and shared-backend/routes/admin.py keeps
--   calling both as service_role.
--
-- Matched on name, not signature, for the same reason as travelscrapbook/027:
-- a replay of the migrations is not byte-identical to production, so a
-- hardcoded argument list is one drift away from erroring. Both are
-- zero-argument today; the loop keeps that from mattering.
--
-- Idempotent: skips anything that already pins a search_path.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  shared_rpcs CONSTANT text[] := ARRAY[
    'admin_table_sizes',
    'analytics_summary_counts'
  ];
  fn      record;
  n_fixed int := 0;
  fixed   text[] := '{}';
BEGIN
  FOR fn IN
    SELECT p.oid,
           quote_ident(n.nspname) || '.' || quote_ident(p.proname)
             || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig,
           p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY (shared_rpcs)
       AND NOT EXISTS (
             SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) AS c
              WHERE c LIKE 'search_path=%')
     ORDER BY p.proname
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO ''public''', fn.sig);
    n_fixed := n_fixed + 1;
    fixed   := fixed || fn.proname;
  END LOOP;

  IF n_fixed = 0 THEN
    RAISE NOTICE 'shared admin RPCs already pin search_path, nothing to do';
  ELSE
    RAISE NOTICE 'pinned search_path on % shared admin RPC(s): %', n_fixed, fixed;
  END IF;
END $$;


-- ── Verification ────────────────────────────────────────────────────────────
-- Run after every app's own search_path migration; this covers the whole
-- schema and must return zero rows:
--
--   SELECT p.oid::regprocedure AS still_mutable
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) AS c
--                       WHERE c LIKE 'search_path=%')
--    ORDER BY 1;
--
-- Rows here mean some app added a function without the `SET search_path TO
-- 'public'` clause its CREATE should carry (.claude/rules/database-supabase.md).
