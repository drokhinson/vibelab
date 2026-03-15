-- 010_admin_table_sizes_rpc.sql — PostgreSQL function for admin storage monitoring
-- Run in Supabase dashboard → SQL Editor → New Query → Run

CREATE OR REPLACE FUNCTION admin_table_sizes()
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
