-- ─────────────────────────────────────────────────────────────────────────────
-- 062_boardgamebuddy_bgg_link.sql
-- BoardGameGeek account linking + collection/plays import.
--
-- Adds:
--   1. bgg_username on boardgamebuddy_profiles (the linked BGG handle).
--   2. bgg_play_id on boardgamebuddy_plays (dedup key for re-imported plays).
--   3. boardgamebuddy_bgg_pending_imports table — when the user's BGG library
--      references a game we don't yet have in boardgamebuddy_games, we persist
--      the pending collection-status / play-record here and a background worker
--      drains it after fetching the missing game(s) from BGG.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Profile gets a BGG username (linked account).
ALTER TABLE public.boardgamebuddy_profiles
  ADD COLUMN IF NOT EXISTS bgg_username TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_profiles_bgg_username
  ON public.boardgamebuddy_profiles (bgg_username)
  WHERE bgg_username IS NOT NULL;

-- 2. Plays get a BGG play_id so resync is idempotent.
ALTER TABLE public.boardgamebuddy_plays
  ADD COLUMN IF NOT EXISTS bgg_play_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_plays_user_bgg_play
  ON public.boardgamebuddy_plays (user_id, bgg_play_id)
  WHERE bgg_play_id IS NOT NULL;

-- 3. Pending imports — rows that referenced a bgg_id not yet in our catalog.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_bgg_pending_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  bgg_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('collection', 'play')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'error')),
  error_message TEXT,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
ALTER TABLE public.boardgamebuddy_bgg_pending_imports ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_bgg_pending_imports TO boardgamebuddy_role;

CREATE INDEX IF NOT EXISTS idx_bgb_bgg_pending_user_status
  ON public.boardgamebuddy_bgg_pending_imports (user_id, status)
  WHERE status = 'pending';

-- One pending row per (user, bgg_id, kind) so re-running sync upserts cleanly
-- instead of stacking duplicate work.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_bgg_pending_unique
  ON public.boardgamebuddy_bgg_pending_imports (user_id, bgg_id, kind)
  WHERE status = 'pending';
