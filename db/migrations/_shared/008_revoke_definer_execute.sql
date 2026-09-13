-- ─────────────────────────────────────────────────────────────────────────────
-- _shared/008_revoke_definer_execute.sql
-- Revoke anon/authenticated EXECUTE on the two cross-app SECURITY DEFINER
-- admin RPCs, clearing their "Public Can Execute SECURITY DEFINER Function"
-- warnings.
--
-- Scope is deliberately just the functions _shared owns:
--   admin_table_sizes()        — defined in _shared/002_admin_rpcs.sql
--   analytics_summary_counts() — defined in _shared/007_analytics_summary_rpc.sql
--
-- Each app revokes its own RPCs in its own directory, so replaying one app in
-- isolation still ends up with the right grants:
--   boardgamebuddy/028_revoke_definer_execute.sql   (60 functions)
--   travelscrapbook/015, 017, 018, 020, 024, 025    (already revoke inline)
--
-- WHY THESE TWO WERE STILL FLAGGED
--   Both already carry a revoke — _shared/003_project_roles.sql for
--   admin_table_sizes() and _shared/007 itself for analytics_summary_counts():
--
--     REVOKE EXECUTE ON FUNCTION public.admin_table_sizes() FROM PUBLIC;
--
--   That drops only the PUBLIC entry. Supabase's stock default privileges
--   (GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role) give anon and
--   authenticated their own direct ACL entries, which survive a FROM PUBLIC
--   revoke:
--
--     {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--                          ^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^ left behind
--
--   PostgREST publishes both at /rest/v1/rpc/<name>, so until anon and
--   authenticated are named explicitly, anyone with the anon key could read
--   the whole database's table sizes and analytics rollups.
--
-- SAFE
--   Both are called only by shared-backend/routes/admin.py, whose client is
--   built from SUPABASE_SERVICE_ROLE_KEY and executes as `service_role`.
--   service_role is not named in the revoke, so it keeps EXECUTE. Function
--   EXECUTE only — no schema or table grants change.
--
-- Idempotent: revoking an absent privilege is a no-op.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────


REVOKE EXECUTE ON FUNCTION public.admin_table_sizes()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.analytics_summary_counts()
  FROM PUBLIC, anon, authenticated;


-- ── Verification ────────────────────────────────────────────────────────────
-- Must return zero rows:
--
--   SELECT p.oid::regprocedure AS still_exposed
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.prosecdef
--      AND (has_function_privilege('anon',          p.oid, 'EXECUTE')
--        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
--    ORDER BY 1;
--
-- Run after every app's own revoke migration, this covers the whole database:
-- if it returns rows, some app has added a SECURITY DEFINER function without
-- the revoke its CREATE should carry (see .claude/rules/database-supabase.md).
