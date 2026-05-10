-- ─────────────────────────────────────────────────────────────────────────────
-- API logs + sessions — current schema snapshot
-- Last updated: matches db/migrations/_shared/004_api_logs.sql
--                       + db/migrations/_shared/005_api_sessions.sql
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per outbound external API call from the shared backend.
-- body_excerpt is truncated to ~8KB at insert; the admin "clear bodies"
-- button nulls it out for old rows while preserving timing/error stats.
-- session_id + user_id are populated when the request had an authenticated
-- user context (api_logger.set_request_user); NULL otherwise.
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
  session_id           UUID,
  user_id              TEXT
);
ALTER TABLE public.api_logs ENABLE ROW LEVEL SECURITY;

-- One row per (user, app) "burst" of API activity. A new row is created when
-- a user's first call arrives more than 30 minutes after their previous one
-- (boundary enforced in shared-backend/api_logger.py).
CREATE TABLE IF NOT EXISTS public.api_sessions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app               TEXT        NOT NULL,
  user_id           TEXT,
  user_label        TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  call_count        INTEGER     NOT NULL DEFAULT 0
);
ALTER TABLE public.api_sessions ENABLE ROW LEVEL SECURITY;

