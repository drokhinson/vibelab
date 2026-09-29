-- ─────────────────────────────────────────────────────────────────────────────
-- 056_game_ranks.sql — rank your games: boardgamebuddy_game_ranks, the two
--                      write RPCs, and boardgamebuddy_games.bgg_family
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A player records how much they like a game by RANKING it against the other
-- games of its kind rather than by giving it stars. The flow is a gut check
-- (Love it / A good game / Not for me) followed by a handful of "which do
-- you prefer?" questions that binary-search the new game into its tier. The
-- result is a total order per category, so there are no ties.
--
-- 1. boardgamebuddy_games.bgg_family. The category a game is ranked in is
--    BGG's, never the player's: the /thing?stats=1 response the metadata sync
--    already reads lists every family list the game is ranked in
--    (<rank type="family" name="strategygames" …>), and the parser used to read
--    past them. It now keeps the one the game ranks highest in, raw
--    ("strategygames", "familygames", …); services/rank_category.py maps it to
--    the app's category, with a fallback for games BGG files in no family.
--
--    RE-QUEUED FOR THE METADATA BACKFILL. Every game already synced has a NULL
--    here, and the backfill's queue is bgg_meta_synced_at IS NULL (045), so the
--    stamp is cleared for those rows. An admin run of
--    POST /games/admin/backfill-metadata then fills it in, 20 games per BGG
--    call. Until it has, those games get the fallback category — which is why
--    a rank stores its category rather than re-deriving it on read: a game
--    must not move lists under the player when the sync lands.
--
-- 2. boardgamebuddy_game_ranks. One row per (user, game): the category it was
--    ranked in, its tier, and its 0-based position within that tier. The
--    player-facing number (#3 Family) is the count of games ahead of it in the
--    category, tiers stacked love → good → not, and is computed on read. Rows
--    per user are in the tens, so there is no point storing it.
--
--    Service-role only, like every table the API is the sole reader of: RLS on,
--    no policies, no API-role grants — just SELECT for boardgamebuddy_role, the
--    read-only login every table here carries.
--
-- 3. bgb_rank_game / bgb_unrank_game. Positions within a tier are dense
--    (0..n-1), so a write is "close the gap where it was, open one where it
--    goes, insert" — three statements that have to land together or a tier
--    gains a hole or a collision. One function each, so they do.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. bgg_family ────────────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_games
  ADD COLUMN IF NOT EXISTS bgg_family TEXT;

COMMENT ON COLUMN public.boardgamebuddy_games.bgg_family IS
  'The BGG family rank list this game ranks highest in, raw (strategygames, familygames, partygames, thematic, wargames, abstracts, childrensgames, cgs). NULL = not synced yet, or BGG files it in none. Decides which category a game is ranked in (migration 056). Written by import, refresh-metadata and backfill-metadata.';

UPDATE public.boardgamebuddy_games
   SET bgg_meta_synced_at = NULL
 WHERE bgg_id IS NOT NULL
   AND bgg_family IS NULL
   AND is_expansion = false;


-- ── 2. The ranks table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_game_ranks (
  user_id   UUID        NOT NULL,
  game_id   UUID        NOT NULL,
  category  TEXT        NOT NULL,
  tier      TEXT        NOT NULL,
  position  INTEGER     NOT NULL,
  ranked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT boardgamebuddy_game_ranks_pkey PRIMARY KEY (user_id, game_id),
  CONSTRAINT boardgamebuddy_game_ranks_user_fkey FOREIGN KEY (user_id)
    REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_game_ranks_game_fkey FOREIGN KEY (game_id)
    REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE,
  CONSTRAINT bgb_game_ranks_tier_chk CHECK (tier = ANY (ARRAY['love'::text, 'good'::text, 'not'::text])),
  CONSTRAINT bgb_game_ranks_position_chk CHECK (position >= 0)
);
ALTER TABLE public.boardgamebuddy_game_ranks ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_game_ranks TO boardgamebuddy_role;

CREATE INDEX IF NOT EXISTS idx_bgb_game_ranks_list
  ON public.boardgamebuddy_game_ranks (user_id, category, tier, position);

COMMENT ON TABLE public.boardgamebuddy_game_ranks IS
  'A player''s ranking of the games they own or have played (migration 056). Per category, tiers love → good → not, position dense 0..n-1 within a tier. Written only through bgb_rank_game / bgb_unrank_game; read by GET /ranks*.';


-- ── 3. Writes ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bgb_rank_game(
  p_user uuid, p_game uuid, p_category text, p_tier text, p_index integer
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old   boardgamebuddy_game_ranks%ROWTYPE;
  v_count integer;
  v_pos   integer;
BEGIN
  IF p_tier NOT IN ('love', 'good', 'not') THEN
    RETURN jsonb_build_object('error', 'invalid_tier');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_games WHERE id = p_game) THEN
    RETURN jsonb_build_object('error', 'game_not_found');
  END IF;

  -- Re-ranking: take it out of wherever it was first, closing the gap.
  DELETE FROM boardgamebuddy_game_ranks
   WHERE user_id = p_user AND game_id = p_game
  RETURNING * INTO v_old;
  IF FOUND THEN
    UPDATE boardgamebuddy_game_ranks
       SET position = position - 1
     WHERE user_id = p_user AND category = v_old.category AND tier = v_old.tier
       AND position > v_old.position;
  END IF;

  -- The client computed p_index against the list it was shown. Clamped, so a
  -- list that shrank since (a rank removed in another tab) cannot open a hole.
  SELECT count(*) INTO v_count
    FROM boardgamebuddy_game_ranks
   WHERE user_id = p_user AND category = p_category AND tier = p_tier;
  v_pos := LEAST(GREATEST(COALESCE(p_index, v_count), 0), v_count);

  UPDATE boardgamebuddy_game_ranks
     SET position = position + 1
   WHERE user_id = p_user AND category = p_category AND tier = p_tier
     AND position >= v_pos;

  INSERT INTO boardgamebuddy_game_ranks (user_id, game_id, category, tier, position)
  VALUES (p_user, p_game, p_category, p_tier, v_pos);

  RETURN jsonb_build_object('category', p_category, 'tier', p_tier, 'position', v_pos);
END;
$function$;

-- Naming PUBLIC alone does not close this — see 028 and 051. Left open, the
-- anon key in the frontend bundle could write anybody's ranks by uuid.
REVOKE EXECUTE ON FUNCTION public.bgb_rank_game(uuid, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.bgb_rank_game(uuid, uuid, text, text, integer) TO service_role;

COMMENT ON FUNCTION public.bgb_rank_game(uuid, uuid, text, text, integer) IS
  'Insert (or move) a game into a player''s ranking at p_index within p_category/p_tier, keeping positions dense. Returns {category, tier, position} or {error}. Called by PUT /api/v1/boardgame_buddy/ranks/games/{game_id} (migration 056).';


CREATE OR REPLACE FUNCTION public.bgb_unrank_game(p_user uuid, p_game uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old boardgamebuddy_game_ranks%ROWTYPE;
BEGIN
  DELETE FROM boardgamebuddy_game_ranks
   WHERE user_id = p_user AND game_id = p_game
  RETURNING * INTO v_old;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('removed', false);
  END IF;
  UPDATE boardgamebuddy_game_ranks
     SET position = position - 1
   WHERE user_id = p_user AND category = v_old.category AND tier = v_old.tier
     AND position > v_old.position;
  RETURN jsonb_build_object('removed', true);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.bgb_unrank_game(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.bgb_unrank_game(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.bgb_unrank_game(uuid, uuid) IS
  'Remove a game from a player''s ranking, closing the gap in its tier. Returns {removed}. Called by DELETE /api/v1/boardgame_buddy/ranks/games/{game_id} (migration 056).';

COMMIT;
