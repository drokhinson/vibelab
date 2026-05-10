-- ─────────────────────────────────────────────────────────────────────────────
-- API logs — current schema snapshot
-- Last updated: matches db/migrations/_shared/004_api_logs.sql
--                       + db/migrations/_shared/006_drop_api_sessions.sql
-- (005_api_sessions.sql was reverted by 006 — sessions removed.)
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per outbound external API call from the shared backend.
-- body_excerpt is truncated to ~8KB at insert; the admin "clear bodies"
-- button nulls it out for old rows while preserving timing/error stats.
-- user_id + user_label are populated when the request was authenticated
-- (resolved by api_logger middleware in shared-backend/main.py); NULL otherwise.
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
  error_message        TEXT,
  user_id              TEXT,
  user_label           TEXT
);
ALTER TABLE public.api_logs ENABLE ROW LEVEL SECURITY;
