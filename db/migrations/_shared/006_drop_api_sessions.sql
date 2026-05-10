-- ─────────────────────────────────────────────────────────────────────────────
-- _shared/006_drop_api_sessions.sql
-- Sessions turned out to add complexity without enough payoff for the admin UI.
-- Drop the api_sessions table + the session_id column on api_logs and replace
-- with a denormalized user_label column so the admin UI can filter calls by
-- user without joining anywhere.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.api_sessions;

ALTER TABLE public.api_logs
  DROP COLUMN IF EXISTS session_id,
  ADD  COLUMN IF NOT EXISTS user_label TEXT;

CREATE INDEX IF NOT EXISTS idx_api_logs_user_sent
  ON public.api_logs(user_id, sent_at DESC);
