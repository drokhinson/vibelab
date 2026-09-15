-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — hide expansions from the unified game search
--
-- Expansions are no longer pickable as a session's main game: they belong in
-- the base game's expansion section (game detail page + host Gather screen),
-- and enter the catalog through that section's "Import expansions" popup.
-- So the per-keystroke picker must stop listing them alongside base games,
-- where "Catan: Cities & Knights" is visually indistinguishable from "Catan".
--
-- Adds p_include_expansions (default false) to boardgamebuddy_search_games.
-- CREATE OR REPLACE can't add a parameter — a 3-arg call would become
-- ambiguous between the old signature and the new one's default — so the old
-- function is dropped and recreated. Everything else is verbatim from
-- 040_search_rpc.sql.
--
-- The backend tolerates either deploy order: search_service._rpc_hits wraps
-- the RPC call in a try/except and falls back to a two-query PostgREST path
-- (which filters is_expansion itself) whenever the RPC is missing or its
-- signature doesn't match.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DROP FUNCTION IF EXISTS public.boardgamebuddy_search_games(UUID, TEXT, INT);

CREATE OR REPLACE FUNCTION public.boardgamebuddy_search_games(
  p_viewer             UUID,
  p_query              TEXT,
  p_limit              INT     DEFAULT 20,
  p_include_expansions BOOLEAN DEFAULT false
)
RETURNS TABLE (
  id                UUID,
  bgg_id            INTEGER,
  name              TEXT,
  year_published    INTEGER,
  min_players       INTEGER,
  max_players       INTEGER,
  playing_time      INTEGER,
  thumbnail_url     TEXT,
  image_url         TEXT,
  theme_color       TEXT,
  is_expansion      BOOLEAN,
  base_game_bgg_id  INTEGER,
  expansion_color   TEXT,
  rulebook_url      TEXT,
  play_mode         TEXT,
  collection_status TEXT,
  in_collection     BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    g.id,
    g.bgg_id,
    g.name,
    g.year_published,
    g.min_players,
    g.max_players,
    g.playing_time,
    g.thumbnail_url,
    g.image_url,
    g.theme_color,
    g.is_expansion,
    g.base_game_bgg_id,
    g.expansion_color,
    g.rulebook_url,
    g.play_mode,
    c.status                 AS collection_status,
    (c.user_id IS NOT NULL)  AS in_collection
  FROM public.boardgamebuddy_games g
  LEFT JOIN public.boardgamebuddy_collections c
    ON c.game_id = g.id AND c.user_id = p_viewer
  WHERE g.name ILIKE '%' || COALESCE(p_query, '') || '%'
    AND (COALESCE(p_include_expansions, false) OR NOT g.is_expansion)
  ORDER BY (c.user_id IS NOT NULL) DESC, g.name
  LIMIT GREATEST(COALESCE(p_limit, 20), 0);
$$;

GRANT EXECUTE ON FUNCTION public.boardgamebuddy_search_games(UUID, TEXT, INT, BOOLEAN) TO boardgamebuddy_role;

COMMIT;
