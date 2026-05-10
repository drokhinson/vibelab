-- ─────────────────────────────────────────────────────────────────────────────
-- _shared/005_api_sessions.sql
-- Group external API calls into per-(user, app) "sessions". A session starts
-- when an authenticated user makes their first call; subsequent calls within
-- 30 minutes of the last activity belong to the same session. Calls made
-- after a 30-minute idle gap (or by an unauthenticated context) start a fresh
-- session (or get NULL session_id, respectively).
--
-- The 30-minute boundary is enforced in the application layer
-- (shared-backend/api_logger.py — _resolve_session). This migration only
-- creates the storage; backfill of existing api_logs rows is intentionally
-- skipped (they keep session_id = NULL).
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.api_sessions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app               TEXT        NOT NULL,
  user_id           TEXT,
  user_label        TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  call_count        INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_api_sessions_app_user_active
  ON public.api_sessions(app, user_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_sessions_started
  ON public.api_sessions(started_at DESC);

ALTER TABLE public.api_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.api_logs
  ADD COLUMN IF NOT EXISTS session_id UUID,
  ADD COLUMN IF NOT EXISTS user_id    TEXT;

CREATE INDEX IF NOT EXISTS idx_api_logs_session
  ON public.api_logs(session_id);
