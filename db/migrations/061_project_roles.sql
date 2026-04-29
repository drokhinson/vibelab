-- ─────────────────────────────────────────────────────────────────────────────
-- 061_project_roles.sql
-- Per-project read-only Postgres LOGIN roles.
--
-- Creates one role per project (e.g. sauceboss_role) that can SELECT only the
-- tables matching its prefix (sauceboss_*) plus the shared analytics_events
-- table. Lets a developer connect via psql / TablePlus / pgAdmin scoped to
-- one project.
--
-- This does NOT affect:
--   - The backend (uses SUPABASE_SERVICE_ROLE_KEY, bypasses these grants)
--   - The Supabase REST API (anon / authenticated / service_role only)
--   - RLS (still enabled empty on every table; unchanged)
--
-- Supabase Studio's SQL Editor always runs as `postgres`; to actually exercise
-- these roles connect with a desktop client:
--   psql "host=db.<ref>.supabase.co port=5432 dbname=postgres
--         user=sauceboss_role password=<from-NOTICE> sslmode=require"
--
-- Idempotent: safe to re-run. Passwords are rotated on every run; capture
-- them from the NOTICE output and store in 1Password.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Defensive: tighten PUBLIC defaults ────────────────────────────────────────
REVOKE ALL ON SCHEMA public FROM PUBLIC;


-- ── Create roles + grant SELECT on prefixed tables ────────────────────────────
DO $$
DECLARE
  proj      record;
  tbl       text;
  pwd       text;
  role_exists boolean;
BEGIN
  FOR proj IN SELECT * FROM (VALUES
    ('sauceboss_role',      'sauceboss_'),
    ('spotme_role',         'spotme_'),
    ('wealthmate_role',     'wealthmate_'),
    ('daywordplay_role',    'daywordplay_'),
    ('plantplanner_role',   'plantplanner_'),
    ('boardgamebuddy_role', 'boardgamebuddy_')
  ) AS t(role_name, prefix) LOOP

    pwd := replace(gen_random_uuid()::text, '-', '');

    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = proj.role_name)
      INTO role_exists;

    IF role_exists THEN
      EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', proj.role_name, pwd);
    ELSE
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOINHERIT', proj.role_name, pwd);
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', proj.role_name);

    -- SELECT on every existing project table
    FOR tbl IN
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE proj.prefix || '%'
    LOOP
      EXECUTE format('GRANT SELECT ON public.%I TO %I', tbl, proj.role_name);
    END LOOP;

    -- Shared cross-project telemetry (read-only)
    EXECUTE format('GRANT SELECT ON public.analytics_events TO %I', proj.role_name);

    RAISE NOTICE 'Role % password: %', proj.role_name, pwd;
  END LOOP;
END $$;


-- ── Defensive: keep admin RPCs out of PUBLIC ──────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.admin_table_sizes()        FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_sauceboss_all_sauces() FROM PUBLIC;
