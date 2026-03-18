-- ─────────────────────────────────────────────────────────────────────────────
-- Analytics — current schema snapshot
-- Last updated: migration 026
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────

-- Cross-app event tracking (fire-and-forget from all web prototypes and native apps)
CREATE TABLE IF NOT EXISTS public.analytics_events (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app        TEXT        NOT NULL,
  event      TEXT        NOT NULL DEFAULT 'app_open',
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
