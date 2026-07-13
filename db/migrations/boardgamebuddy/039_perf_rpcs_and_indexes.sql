-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — perf pass: plays/collection/sync-status RPCs + search idx
--
-- Collapses the remaining multi-round-trip read paths found by the perf
-- audit into single RPC calls, and makes the per-keystroke ILIKE searches
-- index-backed:
--
--   bgb_plays_page(...)       → History tab / game plays. The Python path
--                               fetched EVERY visible play tuple, merged +
--                               sorted + paginated in Python, then hydrated
--                               players/expansions: 8-11 round trips per
--                               page. Now one call, paginated in SQL.
--   bgb_play_stats(...)       → per-game {play_count, last_played_at} via
--                               GROUP BY. Replaces _plays_visible_to_user +
--                               _index_plays, which shipped every play row
--                               to Python just to count them (Closet tabs).
--   bgb_bgg_sync_status(...)  → the FE poll target during BGG import: was
--                               up to 7 round trips per poll, now one.
--   pg_trgm GIN indexes       → games.name and play_players.
--                               player_display_name are ILIKE '%q%'
--                               substring searches fired per keystroke; the
--                               existing to_tsvector GIN cannot serve them
--                               (seq scans today).
--
-- Supabase schema note (learned the hard way in 038): extensions install
-- into the `extensions` schema, NOT public — so the extension is created
-- WITH SCHEMA extensions and the operator classes below are schema-
-- qualified. Functions avoid extension dependencies entirely.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Trigram search indexes ───────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_bgb_games_name_trgm
  ON public.boardgamebuddy_games
  USING gin (name extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_bgb_play_players_display_name_trgm
  ON public.boardgamebuddy_play_players
  USING gin (player_display_name extensions.gin_trgm_ops);

-- The sync-status session roll-up filters on (user_id, created_at); the
-- existing partial index only covers status='pending'.
CREATE INDEX IF NOT EXISTS idx_bgb_pending_imports_user_created
  ON public.boardgamebuddy_bgg_pending_imports (user_id, created_at);


-- ── Plays page bundle ────────────────────────────────────────────────────────
-- One call for GET /plays (History tab) and GET /games/{id}/plays. Returns
-- {"plays": [PlayResponse-shaped...], "total": N}. Visibility matches the
-- old list_plays: plays the target logged plus plays where the target
-- appears as a participant (player_user_id). p_own_only=true restricts to
-- logged-only (the /games/{id}/plays behavior). Game name/thumbnail read
-- the denormalized plays.game_* columns (migration 020, immutable).
CREATE OR REPLACE FUNCTION public.bgb_plays_page(
  p_target UUID,
  p_page INT DEFAULT 1,
  p_per_page INT DEFAULT 20,
  p_game UUID DEFAULT NULL,
  p_buddy UUID DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_own_only BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_search TEXT := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_total BIGINT;
  v_plays JSONB;
BEGIN
  WITH filtered AS (
    SELECT p.*
    FROM boardgamebuddy_plays p
    WHERE (
        p.user_id = p_target
        OR (NOT p_own_only AND EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = p_target))
      )
      AND (p_own_only IS FALSE OR p.user_id = p_target)
      AND (p_game IS NULL OR p.game_id = p_game)
      AND (p_buddy IS NULL OR EXISTS (
            SELECT 1 FROM boardgamebuddy_play_players pp
            WHERE pp.play_id = p.id AND pp.player_user_id = p_buddy))
      AND (v_search IS NULL
           OR p.game_name ILIKE '%' || v_search || '%'
           OR EXISTS (
                SELECT 1 FROM boardgamebuddy_play_players pp
                WHERE pp.play_id = p.id
                  AND pp.player_display_name ILIKE '%' || v_search || '%'))
  ),
  counted AS (SELECT count(*) AS total FROM filtered),
  page AS (
    SELECT f.*
    FROM filtered f
    ORDER BY f.played_at DESC, f.created_at DESC
    LIMIT p_per_page OFFSET GREATEST(p_page - 1, 0) * p_per_page
  )
  SELECT
    (SELECT total FROM counted),
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', pg.id,
      'game_id', pg.game_id,
      'game_name', pg.game_name,
      'game_thumbnail', pg.game_thumbnail_url,
      'played_at', pg.played_at,
      'notes', pg.notes,
      'photo_url', pg.photo_url,
      'created_at', pg.created_at,
      'play_mode', COALESCE(pg.play_mode, 'competitive'),
      'logged_by_id', pg.user_id,
      'logged_by_name', COALESCE(lp.display_name, 'Unknown'),
      'is_own', (pg.user_id = p_target),
      'players', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'user_id', pp.player_user_id,
          'name', COALESCE(ppr.display_name, pp.player_display_name, 'Unknown'),
          'avatar', ppr.avatar,
          'is_winner', COALESCE(pp.is_winner, false),
          'score', pp.score,
          'round_scores', pp.round_scores
        ))
        FROM boardgamebuddy_play_players pp
        LEFT JOIN boardgamebuddy_profiles ppr ON ppr.id = pp.player_user_id
        WHERE pp.play_id = pg.id
      ), '[]'::jsonb),
      'expansions', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'expansion_game_id', pe.expansion_game_id,
          'name', COALESCE(eg.name, 'Unknown'),
          'color', eg.expansion_color
        ))
        FROM boardgamebuddy_play_expansions pe
        LEFT JOIN boardgamebuddy_games eg ON eg.id = pe.expansion_game_id
        WHERE pe.play_id = pg.id
      ), '[]'::jsonb)
    ) ORDER BY pg.played_at DESC, pg.created_at DESC), '[]'::jsonb)
    INTO v_total, v_plays
  FROM page pg
  LEFT JOIN boardgamebuddy_profiles lp ON lp.id = pg.user_id;

  RETURN jsonb_build_object('plays', v_plays, 'total', COALESCE(v_total, 0));
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_plays_page(UUID, INT, INT, UUID, UUID, TEXT, BOOLEAN) TO boardgamebuddy_role;


-- ── Per-game play stats ──────────────────────────────────────────────────────
-- {game_id, play_count, last_played_at} for every game in the viewer's
-- visible play history (own + participant), optionally scoped to a game-id
-- list. Feeds the Closet's last-played/play-count tile fields and the
-- derived Played shelf without shipping every play row to Python.
CREATE OR REPLACE FUNCTION public.bgb_play_stats(
  p_viewer UUID,
  p_game_ids UUID[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'game_id', s.game_id,
           'play_count', s.play_count,
           'last_played_at', s.last_played_at
         )), '[]'::jsonb)
  FROM (
    SELECT p.game_id, count(*) AS play_count, max(p.played_at) AS last_played_at
    FROM boardgamebuddy_plays p
    WHERE (p.user_id = p_viewer
           OR EXISTS (
                SELECT 1 FROM boardgamebuddy_play_players pp
                WHERE pp.play_id = p.id AND pp.player_user_id = p_viewer))
      AND (p_game_ids IS NULL OR p.game_id = ANY (p_game_ids))
    GROUP BY p.game_id
  ) s;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_play_stats(UUID, UUID[]) TO boardgamebuddy_role;


-- ── BGG sync status ──────────────────────────────────────────────────────────
-- The FE polls GET /bgg/sync/status during import; the Python path was up
-- to 7 round trips per poll. Mirrors that logic exactly:
--   * lifetime pending/errored counts + last completed_at
--   * session roll-up per distinct bgg_id anchored at
--     profiles.bgg_last_sync_started_at (pending wins over error wins over
--     done, matching the Python precedence)
--   * up to 20 most-recently-completed game names for the sync log
-- has_credentials mirrors bgg_client.has_stored_credentials (username AND
-- encrypted password present) so the route can derive auth_state without
-- shipping the encrypted secret through JSONB.
CREATE OR REPLACE FUNCTION public.bgb_bgg_sync_status(p_user UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_username TEXT;
  v_has_creds BOOLEAN;
  v_session_start TIMESTAMPTZ;
  v_pending BIGINT;
  v_errored BIGINT;
  v_last_completed TIMESTAMPTZ;
  v_session_total BIGINT := 0;
  v_session_done BIGINT := 0;
  v_session_errored BIGINT := 0;
  v_names JSONB := '[]'::jsonb;
BEGIN
  SELECT pr.bgg_username,
         (COALESCE(pr.bgg_username, '') <> '' AND COALESCE(pr.bgg_password_enc, '') <> ''),
         pr.bgg_last_sync_started_at
    INTO v_username, v_has_creds, v_session_start
    FROM boardgamebuddy_profiles pr
    WHERE pr.id = p_user;

  SELECT count(*) FILTER (WHERE status = 'pending'),
         count(*) FILTER (WHERE status = 'error'),
         max(completed_at) FILTER (WHERE status = 'done')
    INTO v_pending, v_errored, v_last_completed
    FROM boardgamebuddy_bgg_pending_imports
    WHERE user_id = p_user;

  IF v_session_start IS NOT NULL THEN
    WITH roll AS (
      SELECT bgg_id,
             CASE WHEN bool_or(status = 'pending') THEN 'pending'
                  WHEN bool_or(status = 'error') THEN 'error'
                  ELSE 'done' END AS st
      FROM boardgamebuddy_bgg_pending_imports
      WHERE user_id = p_user
        AND created_at >= v_session_start
        AND bgg_id IS NOT NULL
        AND status IS NOT NULL
      GROUP BY bgg_id
    )
    SELECT count(*),
           count(*) FILTER (WHERE st = 'done'),
           count(*) FILTER (WHERE st = 'error')
      INTO v_session_total, v_session_done, v_session_errored
      FROM roll;

    IF v_session_done > 0 THEN
      WITH roll AS (
        SELECT bgg_id,
               CASE WHEN bool_or(status = 'pending') THEN 'pending'
                    WHEN bool_or(status = 'error') THEN 'error'
                    ELSE 'done' END AS st
        FROM boardgamebuddy_bgg_pending_imports
        WHERE user_id = p_user
          AND created_at >= v_session_start
          AND bgg_id IS NOT NULL
          AND status IS NOT NULL
        GROUP BY bgg_id
      ),
      -- Most recent all-time completed_at per session-done bgg_id (the
      -- Python path queried done rows for those ids without the session
      -- filter), newest 20 first.
      latest AS (
        SELECT DISTINCT ON (pi.bgg_id) pi.bgg_id, pi.completed_at
        FROM boardgamebuddy_bgg_pending_imports pi
        JOIN roll r ON r.bgg_id = pi.bgg_id AND r.st = 'done'
        WHERE pi.user_id = p_user AND pi.status = 'done'
        ORDER BY pi.bgg_id, pi.completed_at DESC
      ),
      top20 AS (
        SELECT bgg_id, completed_at
        FROM latest
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 20
      )
      SELECT COALESCE(jsonb_agg(g.name ORDER BY t.completed_at DESC NULLS LAST), '[]'::jsonb)
        INTO v_names
        FROM top20 t
        JOIN boardgamebuddy_games g ON g.bgg_id = t.bgg_id
        WHERE g.name IS NOT NULL;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'bgg_username', v_username,
    'has_credentials', COALESCE(v_has_creds, false),
    'pending_count', COALESCE(v_pending, 0),
    'errored_count', COALESCE(v_errored, 0),
    'last_completed_at', v_last_completed,
    'session_started_at', v_session_start,
    'session_total', COALESCE(v_session_total, 0),
    'session_done', COALESCE(v_session_done, 0),
    'session_errored', COALESCE(v_session_errored, 0),
    'session_game_names', v_names
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_bgg_sync_status(UUID) TO boardgamebuddy_role;

COMMIT;
