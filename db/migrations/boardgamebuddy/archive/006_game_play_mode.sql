-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy 006 — Per-game play_mode (competitive / coop / team)
-- ─────────────────────────────────────────────────────────────────────────────
-- Marks each game with the scoring style its play-logging UI should use.
-- Auto-derived from BGG mechanics on import (see derive_play_mode in
-- shared-backend/routes/boardgame_buddy/constants.py); the one-shot UPDATEs
-- below backfill rows imported before this migration. Keeping the column
-- NOT NULL with a 'competitive' default means existing reads stay safe and
-- the historical insert paths that don't pass play_mode still work.

ALTER TABLE public.boardgamebuddy_games
  ADD COLUMN IF NOT EXISTS play_mode TEXT NOT NULL DEFAULT 'competitive'
    CHECK (play_mode IN ('competitive', 'coop', 'team'));

-- Backfill from existing BGG mechanics. Apply 'team' first so the
-- 'coop' pass overrides any game tagged with both — BGG's taxonomy
-- treats Cooperative Game as the more specific signal.
UPDATE public.boardgamebuddy_games
   SET play_mode = 'team'
 WHERE play_mode = 'competitive'
   AND 'Team-Based Game' = ANY(mechanics);

UPDATE public.boardgamebuddy_games
   SET play_mode = 'coop'
 WHERE play_mode IN ('competitive', 'team')
   AND 'Cooperative Game' = ANY(mechanics);

-- RLS already enabled on boardgamebuddy_games (see 001_baseline.sql);
-- new column inherits. Re-grant SELECT to the project role for
-- explicitness — direct-DB clients (psql/TablePlus) need the column.
GRANT SELECT ON public.boardgamebuddy_games TO boardgamebuddy_role;
