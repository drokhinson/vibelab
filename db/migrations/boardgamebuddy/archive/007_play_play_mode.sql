-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy 007 — play_mode on plays + corrected BGG tag backfill
-- ─────────────────────────────────────────────────────────────────────────────
-- Two follow-ups to migration 006:
--
-- (a) Re-run the games-table backfill with the real BGG mechanic values.
--     BGG's XML returns the mechanic as "Cooperative" / "Team-Based"
--     (without the " Game" suffix), so the 006 UPDATE was a no-op for
--     existing rows. Re-derive, again coop-overrides-team for ties.
--
-- (b) Plays inherit the game's mode by default, but the user can override
--     per session (e.g. play a normally-competitive game in team mode for
--     fun). Add the column, backfill from games, then let the
--     play-logging UI pick on a per-play basis.

-- (a) Fix the games backfill with the corrected mechanic strings.
UPDATE public.boardgamebuddy_games
   SET play_mode = 'team'
 WHERE play_mode = 'competitive'
   AND ('Team-Based' = ANY(mechanics) OR 'Team-Based Game' = ANY(mechanics));

UPDATE public.boardgamebuddy_games
   SET play_mode = 'coop'
 WHERE play_mode IN ('competitive', 'team')
   AND ('Cooperative' = ANY(mechanics) OR 'Cooperative Game' = ANY(mechanics));

-- (b) Per-play mode. Default 'competitive' keeps existing inserts safe;
-- the backfill below copies the game's mode onto every historical play.
ALTER TABLE public.boardgamebuddy_plays
  ADD COLUMN IF NOT EXISTS play_mode TEXT NOT NULL DEFAULT 'competitive'
    CHECK (play_mode IN ('competitive', 'coop', 'team'));

UPDATE public.boardgamebuddy_plays p
   SET play_mode = g.play_mode
  FROM public.boardgamebuddy_games g
 WHERE p.game_id = g.id
   AND p.play_mode = 'competitive'      -- only touch the new-default rows
   AND g.play_mode <> 'competitive';

-- RLS already on; re-grant for explicitness so the project role sees the
-- new column via psql/TablePlus.
GRANT SELECT ON public.boardgamebuddy_plays TO boardgamebuddy_role;
