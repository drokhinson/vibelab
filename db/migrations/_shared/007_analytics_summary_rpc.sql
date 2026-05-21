-- ─────────────────────────────────────────────────────────────────────────────
-- _shared — analytics summary RPC
--
-- The previous Python implementation (shared-backend/routes/analytics.py)
-- pulled every row via `sb.table("analytics_events").select(...).execute()`
-- and counted in Python. PostgREST silently caps that response at the
-- project-wide `max-rows` (1000 in Supabase defaults), so once total events
-- exceeded ~1k the lowest-volume / newest apps simply vanished from the
-- admin dashboard — BoardgameBuddy looked dead even with heavy usage.
--
-- Aggregating in SQL avoids the row cap entirely (one row per app, no
-- 1000-row truncation) and matches `.claude/rules/performance-caching.md`
-- ("Count or aggregate in the database, not in Python loops").
--
-- SECURITY DEFINER + REVOKE EXECUTE FROM PUBLIC mirrors admin_table_sizes
-- (see _shared/002_admin_rpcs.sql + _shared/003_project_roles.sql).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.analytics_summary_counts()
RETURNS TABLE(
  app       text,
  all_time  bigint,
  last_30d  bigint,
  last_7d   bigint,
  last_24h  bigint
) AS $$
  SELECT
    app,
    COUNT(*)::bigint                                                                    AS all_time,
    COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::bigint            AS last_30d,
    COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::bigint             AS last_7d,
    COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::bigint           AS last_24h
  FROM public.analytics_events
  GROUP BY app
  ORDER BY app;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

REVOKE EXECUTE ON FUNCTION public.analytics_summary_counts() FROM PUBLIC;
