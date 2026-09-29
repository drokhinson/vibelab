-- 049_collection_shelf.sql — bgb_collection_shelf: one round trip for a whole
-- collection shelf, so the Profile games list can paginate on the client.
--
-- GET /collection/grid materializes the user's entire shelf on every request
-- and slices it in Python (collection_routes.py:407-479, no .range()), so page
-- 9 costs exactly what page 1 costs — 2-3 DB round trips each, ~1s per page
-- turn on mobile. The web client now fetches a shelf once and pages, filters
-- and searches locally; this function is the single read behind that.
--
-- Three round trips collapse to one:
--   1. The shelf itself reads the denormalized c.game_* columns added in 020,
--      so the boardgamebuddy_games embed is gone and
--      idx_bgb_collections_user_status serves the scan. (As bgb_profile_bundle
--      already does — 045:96-115.)
--   2. Play stats fold in as a LEFT JOIN LATERAL, copied from 045:118-131, so
--      the visibility rule stays identical to bgb_play_stats (039): a play
--      counts when the target logged it OR appears on it as a participant.
--      This also drops the several-hundred-element p_game_ids array parameter
--      that the bgb_play_stats call had to plan against.
--   3. expansion_count is computed in SQL instead of a follow-up IN-query
--      (_attach_page_expansion_counts). The badge is now correct on the first
--      cached paint rather than popping in when the grid fetch lands.
--
-- Ordering matches what the Python built (collection_routes.py:448-476) so the
-- client can slice without re-sorting: owned/played by last_played_at DESC
-- NULLS LAST then added_at DESC; wishlist by added_at DESC.
--
-- Wishlist is self-only, matching bgb_profile_bundle's privacy stance — a
-- non-self viewer gets an empty shelf rather than someone else's wishlist.
--
-- No schema change; new function only.

BEGIN;

CREATE OR REPLACE FUNCTION public.bgb_collection_shelf(
  viewer UUID,
  target UUID,
  p_status TEXT DEFAULT 'owned',
  p_exclude_expansions BOOLEAN DEFAULT true,
  p_limit INT DEFAULT 1000
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_items JSONB;
  v_total BIGINT := 0;
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 5000);
  v_excl BOOLEAN := COALESCE(p_exclude_expansions, true);
BEGIN
  -- Wishlist is private to its owner (bgb_profile_bundle gates it the same way).
  IF p_status = 'wishlist' AND viewer IS DISTINCT FROM target THEN
    RETURN jsonb_build_object('items', '[]'::jsonb, 'total', 0, 'truncated', false);
  END IF;

  IF p_status = 'played' THEN
    -- Played-not-owned: every game the target has a play for that has NO row
    -- on their collection table at all (owned AND wishlist both live there).
    -- Mirrors collection_routes.py:335-404 and 045's played_not_owned CTE.
    -- No denormalized columns available here — there is no collection row —
    -- so this branch does join boardgamebuddy_games.
    WITH played_games AS (
      -- EXISTS, not a LEFT JOIN onto play_players: the join fans one play out
      -- to one row per participant, which would multiply play_count. Matches
      -- bgb_play_stats (039) and the 045 fix.
      SELECT p.game_id
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
         OR EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = target
            )
      GROUP BY p.game_id
    )
    SELECT COUNT(*) INTO v_total
      FROM played_games pg
      JOIN boardgamebuddy_games g ON g.id = pg.game_id
      WHERE NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_collections c
              WHERE c.user_id = target AND c.game_id = pg.game_id
            )
        AND (NOT v_excl OR COALESCE(g.is_expansion, false) = false);

    WITH played_games AS (
      SELECT p.game_id,
             MAX(p.played_at) AS last_played_at,
             COUNT(*)::INT    AS play_count
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
         OR EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = target
            )
      GROUP BY p.game_id
    ),
    played_not_owned AS (
      SELECT pg.*
      FROM played_games pg
      WHERE NOT EXISTS (
        SELECT 1 FROM boardgamebuddy_collections c
        WHERE c.user_id = target AND c.game_id = pg.game_id
      )
    )
    SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY sort_a DESC NULLS LAST), '[]'::jsonb)
      INTO v_items
      FROM (
        SELECT
          pno.last_played_at AS sort_a,
          jsonb_build_object(
            -- Matches the synthetic id the Python branch minted so the client
            -- can key tiles identically across both endpoints.
            'id', 'played-' || g.id::TEXT,
            'game_id', g.id,
            'status', 'played',
            'added_at', pno.last_played_at::TEXT || 'T00:00:00+00:00',
            'last_played_at', pno.last_played_at,
            'play_count', COALESCE(pno.play_count, 0),
            'game', jsonb_build_object(
              'id', g.id,
              'bgg_id', g.bgg_id,
              'name', g.name,
              'year_published', g.year_published,
              'min_players', g.min_players,
              'max_players', g.max_players,
              'playing_time', g.playing_time,
              'thumbnail_url', g.thumbnail_url,
              'image_url', NULL,
              'theme_color', g.theme_color,
              'is_expansion', COALESCE(g.is_expansion, false),
              'base_game_bgg_id', g.base_game_bgg_id,
              'expansion_color', g.expansion_color,
              'play_mode', COALESCE(g.play_mode, 'competitive'),
              'expansion_count', COALESCE(xc.n, 0)
            ),
            'expansions', '[]'::jsonb
          ) AS row_jsonb
        FROM played_not_owned pno
        JOIN boardgamebuddy_games g ON g.id = pno.game_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::INT AS n
          FROM boardgamebuddy_games e
          WHERE COALESCE(g.is_expansion, false) = false
            AND g.bgg_id IS NOT NULL
            AND e.is_expansion = true
            AND e.base_game_bgg_id = g.bgg_id
        ) xc ON true
        WHERE (NOT v_excl OR COALESCE(g.is_expansion, false) = false)
        ORDER BY pno.last_played_at DESC NULLS LAST
        LIMIT v_limit
      ) q;

  ELSE
    -- owned / wishlist: served entirely from the denormalized c.game_* columns.
    SELECT COUNT(*) INTO v_total
      FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.status = p_status
        AND (NOT v_excl OR COALESCE(c.game_is_expansion, false) = false);

    SELECT COALESCE(
             jsonb_agg(row_jsonb ORDER BY sort_a DESC NULLS LAST, sort_b DESC),
             '[]'::jsonb
           )
      INTO v_items
      FROM (
        SELECT
          -- Wishlist sorts on added_at alone (matching bgb_profile_bundle and
          -- the Python grid); collapsing sort_a to NULL makes the shared
          -- ORDER BY above degrade to `added_at DESC` for it.
          CASE WHEN p_status = 'wishlist' THEN NULL ELSE ps.last_played_at END AS sort_a,
          c.added_at AS sort_b,
          jsonb_build_object(
            'id', c.id,
            'game_id', c.game_id,
            'status', c.status,
            'added_at', c.added_at,
            'last_played_at', ps.last_played_at,
            'play_count', COALESCE(ps.play_count, 0),
            'game', jsonb_build_object(
              'id', c.game_id,
              'bgg_id', c.game_bgg_id,
              'name', c.game_name,
              'year_published', c.game_year_published,
              'min_players', c.game_min_players,
              'max_players', c.game_max_players,
              'playing_time', c.game_playing_time,
              'thumbnail_url', c.game_thumbnail_url,
              'image_url', NULL,
              'theme_color', c.game_theme_color,
              'is_expansion', COALESCE(c.game_is_expansion, false),
              'base_game_bgg_id', c.game_base_game_bgg_id,
              'expansion_color', c.game_expansion_color,
              'play_mode', COALESCE(c.game_play_mode, 'competitive'),
              'expansion_count', COALESCE(xc.n, 0)
            ),
            'expansions', '[]'::jsonb
          ) AS row_jsonb
        FROM boardgamebuddy_collections c
        LEFT JOIN LATERAL (
          SELECT MAX(p.played_at) AS last_played_at, COUNT(*)::INT AS play_count
          FROM boardgamebuddy_plays p
          WHERE p.game_id = c.game_id
            AND (
              p.user_id = target
              OR EXISTS (
                   SELECT 1 FROM boardgamebuddy_play_players pp
                   WHERE pp.play_id = p.id AND pp.player_user_id = target
                 )
            )
        ) ps ON true
        LEFT JOIN LATERAL (
          -- CATALOG-wide expansion count, not the viewer's owned ones — the
          -- same number the game page's "Expansions (N)" heading shows.
          -- _attach_page_expansion_counts (collection_routes.py:238-251) is
          -- explicit about this: expansions arrive via the import popup
          -- without touching anyone's collection, so an owned-only count
          -- reads as zero for a game that plainly has eleven of them.
          -- Only base games get a count; expansion rows stay at 0.
          SELECT COUNT(*)::INT AS n
          FROM boardgamebuddy_games e
          WHERE COALESCE(c.game_is_expansion, false) = false
            AND c.game_bgg_id IS NOT NULL
            AND e.is_expansion = true
            AND e.base_game_bgg_id = c.game_bgg_id
        ) xc ON true
        WHERE c.user_id = target AND c.status = p_status
          AND (NOT v_excl OR COALESCE(c.game_is_expansion, false) = false)
        ORDER BY
          CASE WHEN p_status = 'wishlist' THEN NULL ELSE ps.last_played_at END
            DESC NULLS LAST,
          c.added_at DESC
        LIMIT v_limit
      ) q;
  END IF;

  RETURN jsonb_build_object(
    'items', COALESCE(v_items, '[]'::jsonb),
    'total', v_total,
    'truncated', v_total > v_limit
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.bgb_collection_shelf(UUID, UUID, TEXT, BOOLEAN, INT)
  TO boardgamebuddy_role;

COMMIT;
