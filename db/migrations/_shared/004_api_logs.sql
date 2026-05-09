-- ─────────────────────────────────────────────────────────────────────────────
-- _shared/004_api_logs.sql
-- Cross-app log of every external (third-party) API call the backend makes.
-- Populated by shared-backend/api_logger.py from each route package's HTTP
-- client (bgg_client, plant_planner.api_clients, image_mirror, etc.).
--
-- Response bodies are truncated to ~8KB at insert time. The admin UI exposes
-- a "clear bodies older than 1w / 1m / all" button that nulls out body_excerpt
-- without dropping the row, so latency/error stats stay queryable forever.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.api_logs (
  id                   BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app                  TEXT        NOT NULL,
  api_name             TEXT        NOT NULL,
  method               TEXT        NOT NULL DEFAULT 'GET',
  url                  TEXT        NOT NULL,
  request_params       JSONB,
  sent_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_time_ms     INTEGER,
  status_code          INTEGER,
  response_size_bytes  INTEGER,
  body_excerpt         TEXT,
  error_message        TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_logs_sent_at
  ON public.api_logs(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_app_sent
  ON public.api_logs(app, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_api_sent
  ON public.api_logs(api_name, sent_at DESC);

ALTER TABLE public.api_logs ENABLE ROW LEVEL SECURITY;
-- Backend uses service role key (bypasses RLS); admin reads via the same.
-- No project-role grants — these are cross-app and only the admin should see them.
