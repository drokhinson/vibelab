-- ─────────────────────────────────────────────────────────────────────────────
-- travelscrapbook — pin search_path on this app's functions
--
-- Clears Supabase's function_search_path_mutable warning:
--
--   Function Search Path Mutable — public.travelscrapbook_normalize_name
--
-- WHY IT FIRES
--   A function without a `SET search_path` resolves unqualified names against
--   whatever search_path the caller happens to have. The linter flags that
--   because it is the standard privilege-escalation shape: put a schema ahead
--   of `public` in your search_path, define an object there that shadows one
--   the function names unqualified, and the function runs your object instead.
--
--   travelscrapbook__normalize_name is SECURITY INVOKER and IMMUTABLE, and its
--   body only calls pg_catalog builtins (lower / translate / regexp_replace /
--   btrim / coalesce), which the implicit pg_catalog entry resolves ahead of
--   any user schema. So the practical exposure here is small — this is the
--   hygiene half of the warning class, unlike the two SECURITY DEFINER admin
--   RPCs handled by _shared/009, where it is a real escalation vector.
--   Pinning it costs nothing and closes the class for this app.
--
-- SCOPED TO THIS APP, MATCHED ON NAME NOT SIGNATURE
--   The loop only ever touches functions named travelscrapbook%, so replaying
--   this app on its own lands the same state as a full replay and no other
--   app's objects are in reach. Matching on the name rather than a written-out
--   signature is deliberate: bgb/028 was written with hardcoded argument lists
--   and failed against production, because production had an older overload of
--   one function than the migrations produce on replay. Nothing here depends
--   on the argument list being what a replay says it is.
--
--   It also sidesteps a live discrepancy on this very function: the repo has
--   travelscrapbook__normalize_name (two underscores, 020_unify_checkpoints)
--   while the linter reports travelscrapbook_normalize_name (one). The prefix
--   match covers whichever the database actually has.
--
-- SAFE
--   Every travelscrapbook function either qualifies its tables as public.<t>
--   or calls only pg_catalog builtins; none reaches into auth, storage or
--   extensions, so `public` is a sufficient path. ALTER FUNCTION ... SET only
--   attaches the setting — bodies, volatility, ownership and grants are all
--   untouched, and the REVOKEs 015/017/018/020/024/025 apply still stand.
--
--   One real trade-off: a SQL function carrying a SET clause is no longer
--   inlinable by the planner. travelscrapbook__normalize_name has exactly one
--   call site — a scalar assignment inside a plpgsql loop in
--   travelscrapbook_add_plan_memberships (020, line 184) — and appears in no
--   index expression, constraint, default or view, so there is no query plan
--   for it to be inlined into and nothing to regress. Checked against a
--   replay, not assumed.
--
-- Idempotent: skips functions that already carry a search_path, so re-running
-- after adding RPCs pins only the new ones.
--
-- New functions should declare `SET search_path TO 'public'` in their CREATE
-- rather than rely on a sweep — see .claude/rules/database-supabase.md.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
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
       AND p.proname LIKE 'travelscrapbook%'
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
    RAISE NOTICE 'travelscrapbook: every function already pins search_path, nothing to do';
  ELSE
    RAISE NOTICE 'travelscrapbook: pinned search_path on % function(s): %', n_fixed, fixed;
  END IF;
END $$;


-- ── Verification ────────────────────────────────────────────────────────────
-- Must return zero rows — the linter's own question for this app:
--
--   SELECT p.oid::regprocedure AS still_mutable
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname LIKE 'travelscrapbook%'
--      AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) AS c
--                       WHERE c LIKE 'search_path=%')
--    ORDER BY 1;
