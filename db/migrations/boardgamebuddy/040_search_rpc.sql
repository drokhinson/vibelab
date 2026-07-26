-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — unified game search RPC
--
-- The per-keystroke game picker (GameFinder) previously ran TWO PostgREST
-- queries per search: one ILIKE against an EMBEDDED boardgamebuddy_games.name
-- column (via a !inner collection join) and one ILIKE against the catalog.
-- The embedded-column ILIKE was not reliably served by the trigram index
-- (idx_bgb_games_name_trgm, migration 039) — the planner could fall back to
-- scanning the viewer's collection rows and filtering names in the join.
--
-- This collapses both into ONE index-backed query:
--   * the catalog ILIKE '%q%' is driven by the pg_trgm GIN index on games.name
--   * a LEFT JOIN onto the viewer's collection marks in_collection + status
--   * collection-first ordering (in_collection DESC, then name) happens in SQL
--
-- Return shape is the game_select_clause() columns plus two extras
-- (collection_status, in_collection) so search_service.game_summary_from_row()
-- can hydrate each row directly. The backend maps in_collection → source
-- 'collection' (with collection_status) vs 'db'.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION public.boardgamebuddy_search_games(
  p_viewer UUID,
  p_query  TEXT,
  p_limit  INT DEFAULT 20
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
  ORDER BY (c.user_id IS NOT NULL) DESC, g.name
  LIMIT GREATEST(COALESCE(p_limit, 20), 0);
$$;

GRANT EXECUTE ON FUNCTION public.boardgamebuddy_search_games(UUID, TEXT, INT) TO boardgamebuddy_role;

COMMIT;
