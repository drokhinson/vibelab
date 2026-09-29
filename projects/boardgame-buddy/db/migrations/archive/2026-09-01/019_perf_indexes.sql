-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — Phase 1 perf indexes + distinct-mechanics RPC
--
-- All shelf/recent-plays/feed queries today either rely on single-column
-- indexes (user_id, game_id) and then sort/paginate in app code, or scan
-- the games table to derive mechanics. This migration adds composite
-- indexes that match the actual access patterns and drops the now-redundant
-- single-column variants. It also introduces bgb_distinct_mechanics() so
-- the mechanics filter dropdown stops scanning the whole games table.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Drop indexes superseded by composites added below. The new composites
-- still serve queries on the leading column, so nothing loses an index.
DROP INDEX IF EXISTS public.idx_bgb_collections_user;
DROP INDEX IF EXISTS public.idx_bgb_collections_game;
DROP INDEX IF EXISTS public.idx_bgb_plays_user;
DROP INDEX IF EXISTS public.idx_bgb_plays_game;
DROP INDEX IF EXISTS public.idx_bgb_play_players_user;

-- Shelf scans: WHERE user_id = ? AND status = ? ORDER BY added_at DESC.
CREATE INDEX IF NOT EXISTS idx_bgb_collections_user_status
  ON public.boardgamebuddy_collections (user_id, status, added_at DESC);

-- Game Detail "do I own this?" + collection.statusFor lookup keyed by game.
CREATE INDEX IF NOT EXISTS idx_bgb_collections_game_user
  ON public.boardgamebuddy_collections (game_id, user_id);

-- Recent plays + feed cursor: ORDER BY played_at DESC, created_at DESC
-- for a given user. Matches bgb_feed_plays' lexicographic cursor.
CREATE INDEX IF NOT EXISTS idx_bgb_plays_user_played
  ON public.boardgamebuddy_plays (user_id, played_at DESC, created_at DESC);

-- Game Detail recent plays: latest plays of a single game.
CREATE INDEX IF NOT EXISTS idx_bgb_plays_game_played
  ON public.boardgamebuddy_plays (game_id, played_at DESC);

-- Shared-plays expansion: "plays where I appeared as a participant" needs
-- (player_user_id, play_id) so the planner can index-only-scan to fetch
-- play_id without a heap visit.
CREATE INDEX IF NOT EXISTS idx_bgb_play_players_user_play
  ON public.boardgamebuddy_play_players (player_user_id, play_id)
  WHERE player_user_id IS NOT NULL;


-- ── bgb_distinct_mechanics ───────────────────────────────────────────────────
-- Returns the sorted distinct mechanic strings across the games catalog.
-- Replaces a full-table scan + Python aggregation in the /games/mechanics
-- endpoint.
CREATE OR REPLACE FUNCTION public.bgb_distinct_mechanics()
RETURNS TABLE (mechanic TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT m
  FROM public.boardgamebuddy_games,
       LATERAL unnest(COALESCE(mechanics, ARRAY[]::TEXT[])) AS m
  WHERE m IS NOT NULL AND m <> ''
  ORDER BY m;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_distinct_mechanics() TO boardgamebuddy_role;

COMMIT;
