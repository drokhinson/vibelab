-- ─────────────────────────────────────────────────────────────────────────────
-- _shared — analytics events
-- Replaces legacy db/migrations/009_analytics_schema.sql + the analytics-events
-- portion of 026_rls_and_cleanup.sql.
-- FRESH-DB ONLY. Production is already at this state. Do not run on existing DB.
--
-- Cross-app event tracking. Every web app + native client fires-and-forgets
-- POSTs to /api/v1/analytics/track which writes one row per event.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.analytics_events (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app        TEXT        NOT NULL,
  event      TEXT        NOT NULL DEFAULT 'app_open',
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analytics_app_created
  ON public.analytics_events(app, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_created
  ON public.analytics_events(created_at);
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
-- Per-app SELECT grants live in _shared/003_project_roles.sql.
