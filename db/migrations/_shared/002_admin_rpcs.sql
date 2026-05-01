-- ─────────────────────────────────────────────────────────────────────────────
-- _shared — admin RPCs
-- Replaces legacy db/migrations/010_admin_table_sizes_rpc.sql.
-- FRESH-DB ONLY. Production is already at this state. Do not run on existing DB.
--
-- admin_table_sizes(): used by the admin storage dashboard. SECURITY DEFINER
-- so the service role's restricted view of pg_class is bypassed. EXECUTE on
-- this function is REVOKEd from PUBLIC by _shared/003_project_roles.sql.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_table_sizes()
RETURNS TABLE(table_name text, total_bytes bigint, row_estimate bigint) AS $$
  SELECT
    c.relname::text AS table_name,
    pg_total_relation_size(c.oid) AS total_bytes,
    c.reltuples::bigint AS row_estimate
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
  ORDER BY pg_total_relation_size(c.oid) DESC;
$$ LANGUAGE sql SECURITY DEFINER;
