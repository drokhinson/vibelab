-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy 027 — BGG sync session timestamp
--
-- Stamps the moment a user kicks off POST /bgg/sync so the status endpoint
-- can scope its progress counts to the *current* sync session. Without this
-- column, GET /bgg/sync/status sees the lifetime pending/done counts and can
-- only report "X remaining", not "X of Y imported" — which is the UI we want
-- to drive a real progress bar.
--
-- The column is set by the backend at the start of every successful sync;
-- the status endpoint counts boardgamebuddy_bgg_pending_imports rows whose
-- created_at >= bgg_last_sync_started_at to compute session_total /
-- session_done / session_errored.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_profiles
  ADD COLUMN IF NOT EXISTS bgg_last_sync_started_at TIMESTAMPTZ;
