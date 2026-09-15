-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — Phase 3: bundle RPCs for Profile + Game Detail
--
-- Profile Self is the slowest screen today: cold-load fires five parallel
-- API calls (stats, collection grid, collection map, recent plays, buddies
-- + requests) and Promise.all-blocks render on the slowest of them. Game
-- Detail is second worst — a serial game fetch followed by a fan-out of
-- three more requests for status / plays / expansions.
--
-- Each new RPC packages everything a view needs into one round trip, using
-- the denormalized game fields landed by migration 020 to avoid joining
-- boardgamebuddy_games for tile rendering.
--
-- Scope: cold-load only. Filter / pagination / tab changes still go to the
-- existing per-shelf endpoints (cheap, partial reloads). That keeps the
-- migration tractable and matches where the user actually feels latency.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;


-- ── bgb_game_detail_bundle ───────────────────────────────────────────────────
-- Inputs: game UUID, viewer UUID, plays_limit (default 5).
-- Output JSONB:
--   {
--     game: full boardgamebuddy_games row,
--     base_game: {id, name, thumbnail_url} when game is an expansion, else null,
--     viewer_status: 'owned' | 'wishlist' | null,
--     recent_plays: latest `plays_limit` plays of this game visible to viewer
--                   (own + participated), pre-joined to players + expansions,
--     expansions: list of this game's expansions when it's a base game,
--                 with each expansion's viewer-toggle state,
--     expansion_count_for_viewer: how many of this game's expansions the
--                                 viewer owns (for the "+N exp" badge).
--   }
CREATE OR REPLACE FUNCTION public.bgb_game_detail_bundle(
  game_uuid UUID,
  viewer UUID,
  plays_limit INT DEFAULT 5
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_game JSONB;
  v_base JSONB;
  v_status TEXT;
  v_plays JSONB;
  v_expansions JSONB;
  v_exp_count_viewer INT;
  v_is_expansion BOOLEAN;
  v_base_bgg_id INT;
  v_bgg_id INT;
BEGIN
  -- The game row itself. Returning NULL via null result lets the route layer
  -- 404 without us having to raise.
  SELECT to_jsonb(g.*), g.is_expansion, g.base_game_bgg_id, g.bgg_id
    INTO v_game, v_is_expansion, v_base_bgg_id, v_bgg_id
    FROM boardgamebuddy_games g WHERE g.id = game_uuid;
  IF v_game IS NULL THEN
    RETURN NULL;
  END IF;

  -- Base game (for an expansion). Soft FK via base_game_bgg_id.
  IF v_is_expansion AND v_base_bgg_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'id', g.id,
      'name', g.name,
      'thumbnail_url', g.thumbnail_url
    ) INTO v_base
    FROM boardgamebuddy_games g
    WHERE g.bgg_id = v_base_bgg_id
    LIMIT 1;
  END IF;

  -- Viewer's status pill for this game.
  SELECT status INTO v_status
    FROM boardgamebuddy_collections
    WHERE user_id = viewer AND game_id = game_uuid;

  -- Recent plays of this game, scoped to viewer's visibility (own or
  -- participated). Pre-joined to players + expansions so the FE doesn't
  -- need follow-up fetches.
  SELECT COALESCE(jsonb_agg(play_row ORDER BY played_at DESC, created_at DESC), '[]'::jsonb)
    INTO v_plays
    FROM (
      SELECT
        p.played_at,
        p.created_at,
        jsonb_build_object(
          'id', p.id,
          'game_id', p.game_id,
          'game_name', p.game_name,
          'game_thumbnail', p.game_thumbnail_url,
          'played_at', p.played_at,
          'notes', p.notes,
          'photo_url', p.photo_url,
          'play_mode', COALESCE(p.play_mode, 'competitive'),
          'created_at', p.created_at,
          'logged_by_id', p.user_id,
          'logged_by_name', COALESCE(pr.display_name, 'Unknown'),
          'is_own', p.user_id = viewer,
          'players', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'user_id', pp.player_user_id,
              'name', COALESCE(pp_pr.display_name, pp.player_display_name, 'Unknown'),
              'is_winner', COALESCE(pp.is_winner, false),
              'score', pp.score
            ) ORDER BY pp.id)
            FROM boardgamebuddy_play_players pp
            LEFT JOIN boardgamebuddy_profiles pp_pr ON pp_pr.id = pp.player_user_id
            WHERE pp.play_id = p.id
          ), '[]'::jsonb),
          'expansions', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'expansion_game_id', pe.expansion_game_id,
              'name', eg.name,
              'color', eg.expansion_color
            ))
            FROM boardgamebuddy_play_expansions pe
            JOIN boardgamebuddy_games eg ON eg.id = pe.expansion_game_id
            WHERE pe.play_id = p.id
          ), '[]'::jsonb)
        ) AS play_row
      FROM boardgamebuddy_plays p
      LEFT JOIN boardgamebuddy_profiles pr ON pr.id = p.user_id
      WHERE p.game_id = game_uuid
        AND (
          p.user_id = viewer
          OR EXISTS (
            SELECT 1 FROM boardgamebuddy_play_players pl
            WHERE pl.play_id = p.id AND pl.player_user_id = viewer
          )
        )
      ORDER BY p.played_at DESC, p.created_at DESC
      LIMIT plays_limit
    ) ranked;

  -- Expansions of this game (when it IS a base, not an expansion). Each row
  -- carries the viewer's toggle state from boardgamebuddy_user_expansions so
  -- the picker can render without a follow-up call.
  IF NOT v_is_expansion AND v_bgg_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'expansion_game_id', g.id,
      'bgg_id', g.bgg_id,
      'name', g.name,
      'thumbnail_url', g.thumbnail_url,
      'color', g.expansion_color,
      'is_enabled', EXISTS (
        SELECT 1 FROM boardgamebuddy_user_expansions ue
        WHERE ue.user_id = viewer AND ue.expansion_game_id = g.id
      ),
      'rulebook_url', g.rulebook_url
    ) ORDER BY g.name), '[]'::jsonb)
      INTO v_expansions
      FROM boardgamebuddy_games g
      WHERE g.is_expansion = true AND g.base_game_bgg_id = v_bgg_id;

    -- How many of this base's expansions the viewer owns — drives the
    -- "+N exp" badge on shelves and detail.
    SELECT COUNT(*) INTO v_exp_count_viewer
      FROM boardgamebuddy_games g
      JOIN boardgamebuddy_collections c
        ON c.game_id = g.id
       AND c.user_id = viewer
       AND c.status = 'owned'
      WHERE g.is_expansion = true AND g.base_game_bgg_id = v_bgg_id;
  ELSE
    v_expansions := '[]'::jsonb;
    v_exp_count_viewer := 0;
  END IF;

  RETURN jsonb_build_object(
    'game', v_game,
    'base_game', v_base,
    'viewer_status', v_status,
    'recent_plays', v_plays,
    'expansions', v_expansions,
    'expansion_count_for_viewer', v_exp_count_viewer
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_game_detail_bundle(UUID, UUID, INT) TO boardgamebuddy_role;


-- ── bgb_profile_bundle ───────────────────────────────────────────────────────
-- Inputs: viewer UUID (auth'd caller), target UUID (profile being viewed),
--         col_per_page (default 12), plays_per_page (default 10).
-- Output JSONB:
--   {
--     stats: bgb_user_stats fields for `target` (mapped to FavoriteGame),
--     owned_page / owned_total,
--     wishlist_page / wishlist_total,
--     played_page / played_total,    -- played-not-owned shelf for `target`
--     recent_plays / recent_plays_total,  -- target's plays (own + participated)
--     status_map: { game_id: status } for VIEWER (always — every tile pill
--                 reads the viewer's own collection),
--     expansion_counts: { base_bgg_id: count } for VIEWER's owned expansions,
--     buddies / buddy_requests_incoming / buddy_requests_outgoing:
--                 included only when viewer = target (private blocks).
--   }
CREATE OR REPLACE FUNCTION public.bgb_profile_bundle(
  viewer UUID,
  target UUID,
  col_per_page INT DEFAULT 12,
  plays_per_page INT DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stats JSONB;
  v_owned_page JSONB;
  v_owned_total BIGINT;
  v_wishlist_page JSONB;
  v_wishlist_total BIGINT;
  v_played_page JSONB;
  v_played_total BIGINT;
  v_recent_plays JSONB;
  v_recent_plays_total BIGINT;
  v_status_map JSONB;
  v_expansion_counts JSONB;
  v_buddies JSONB;
  v_buddy_incoming JSONB;
  v_buddy_outgoing JSONB;
  v_is_self BOOLEAN := (viewer = target);
BEGIN
  -- ── Stats: reuse bgb_user_stats. Returned shape mirrors what the FE
  -- already destructures from /users/{id}/stats.
  SELECT jsonb_build_object(
    'total_plays', COALESCE(s.total_plays, 0),
    'unique_games', COALESCE(s.unique_games, 0),
    'win_count', COALESCE(s.win_count, 0),
    'last_played_at', s.last_played_at,
    'hours_played', COALESCE(s.hours_played, 0)::FLOAT,
    'owned_games', COALESCE(s.owned_games, 0),
    'owned_expansions', COALESCE(s.owned_expansions, 0),
    'favorite_game', CASE
      WHEN s.favorite_game_id IS NOT NULL THEN jsonb_build_object(
        'game_id', s.favorite_game_id,
        'name', s.favorite_game_name,
        'play_count', COALESCE(s.favorite_play_count, 0)
      )
      ELSE NULL
    END
  ) INTO v_stats
  FROM bgb_user_stats(target) s;
  v_stats := COALESCE(v_stats, jsonb_build_object(
    'total_plays', 0, 'unique_games', 0, 'win_count', 0,
    'last_played_at', NULL, 'hours_played', 0,
    'owned_games', 0, 'owned_expansions', 0, 'favorite_game', NULL
  ));

  -- ── Owned shelf (base games only — the FE renders expansions through the
  -- expansion_counts map, not nested under each tile). Sort by last-played
  -- DESC then added-at DESC. The LATERAL subquery runs at most col_per_page
  -- times (one per visible row) thanks to the LIMIT happening before the
  -- join is consumed for sort — the planner respects this via the new
  -- idx_bgb_plays_user_played + idx_bgb_play_players_user_play indexes.
  SELECT COUNT(*) INTO v_owned_total
    FROM boardgamebuddy_collections c
    WHERE c.user_id = target AND c.status = 'owned'
      AND COALESCE(c.game_is_expansion, false) = false;

  SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY sort_order_a DESC NULLS LAST, sort_order_b DESC), '[]'::jsonb)
    INTO v_owned_page
    FROM (
      SELECT
        ps.last_played_at AS sort_order_a,
        c.added_at AS sort_order_b,
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
            'expansion_count', 0
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
      WHERE c.user_id = target AND c.status = 'owned'
        AND COALESCE(c.game_is_expansion, false) = false
      ORDER BY ps.last_played_at DESC NULLS LAST, c.added_at DESC
      LIMIT col_per_page
    ) p;

  -- ── Wishlist shelf (newest-added first — aspirational shelf, no play
  -- recency to sort by; play_count still comes through for any odd "I've
  -- played it but still want my own copy" case).
  SELECT COUNT(*) INTO v_wishlist_total
    FROM boardgamebuddy_collections c
    WHERE c.user_id = target AND c.status = 'wishlist'
      AND COALESCE(c.game_is_expansion, false) = false;

  SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY added_at DESC), '[]'::jsonb)
    INTO v_wishlist_page
    FROM (
      SELECT
        c.added_at,
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
            'expansion_count', 0
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
      WHERE c.user_id = target AND c.status = 'wishlist'
        AND COALESCE(c.game_is_expansion, false) = false
      ORDER BY c.added_at DESC
      LIMIT col_per_page
    ) p;

  -- ── Played, not owned: games target has logged or appeared in but
  -- doesn't have on any shelf. Built from plays + group-by + anti-join to
  -- collections. JOIN to games for the GameSummary fields that aren't
  -- denormalized onto plays (year/min/max players etc.).
  WITH played_games AS (
    SELECT
      p.game_id,
      MAX(p.played_at) AS last_played_at,
      COUNT(*)::INT AS play_count
    FROM boardgamebuddy_plays p
    LEFT JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
    WHERE p.user_id = target OR pp.player_user_id = target
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
  SELECT COUNT(*) INTO v_played_total
    FROM played_not_owned pno
    JOIN boardgamebuddy_games g ON g.id = pno.game_id
    WHERE g.is_expansion = false;

  WITH played_games AS (
    SELECT
      p.game_id,
      MAX(p.played_at) AS last_played_at,
      COUNT(*)::INT AS play_count
    FROM boardgamebuddy_plays p
    LEFT JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
    WHERE p.user_id = target OR pp.player_user_id = target
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
  SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY sort_order DESC), '[]'::jsonb)
    INTO v_played_page
    FROM (
      SELECT
        pno.last_played_at AS sort_order,
        jsonb_build_object(
          'id', 'derived-' || pno.game_id::text,
          'game_id', pno.game_id,
          'status', 'played',
          'added_at', (pno.last_played_at::text || 'T00:00:00+00:00'),
          'last_played_at', pno.last_played_at,
          'play_count', pno.play_count,
          'game', jsonb_build_object(
            'id', g.id,
            'bgg_id', g.bgg_id,
            'name', g.name,
            'year_published', g.year_published,
            'min_players', g.min_players,
            'max_players', g.max_players,
            'playing_time', g.playing_time,
            'thumbnail_url', g.thumbnail_url,
            'image_url', g.image_url,
            'theme_color', g.theme_color,
            'is_expansion', g.is_expansion,
            'base_game_bgg_id', g.base_game_bgg_id,
            'expansion_color', g.expansion_color,
            'play_mode', g.play_mode,
            'expansion_count', 0
          ),
          'expansions', '[]'::jsonb
        ) AS row_jsonb
      FROM played_not_owned pno
      JOIN boardgamebuddy_games g ON g.id = pno.game_id
      WHERE g.is_expansion = false
      ORDER BY pno.last_played_at DESC
      LIMIT col_per_page
    ) p;

  -- ── Recent plays for target (own + participated), pre-joined.
  SELECT COUNT(*) INTO v_recent_plays_total
    FROM boardgamebuddy_plays p
    WHERE p.user_id = target
       OR EXISTS (
         SELECT 1 FROM boardgamebuddy_play_players pp
         WHERE pp.play_id = p.id AND pp.player_user_id = target
       );

  SELECT COALESCE(jsonb_agg(play_row ORDER BY played_at DESC, created_at DESC), '[]'::jsonb)
    INTO v_recent_plays
    FROM (
      SELECT
        p.played_at, p.created_at,
        jsonb_build_object(
          'id', p.id,
          'game_id', p.game_id,
          'game_name', p.game_name,
          'game_thumbnail', p.game_thumbnail_url,
          'played_at', p.played_at,
          'notes', p.notes,
          'photo_url', p.photo_url,
          'play_mode', COALESCE(p.play_mode, 'competitive'),
          'created_at', p.created_at,
          'logged_by_id', p.user_id,
          'logged_by_name', COALESCE(pr.display_name, 'Unknown'),
          'is_own', p.user_id = viewer,
          'players', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'user_id', pp.player_user_id,
              'name', COALESCE(pp_pr.display_name, pp.player_display_name, 'Unknown'),
              'is_winner', COALESCE(pp.is_winner, false),
              'score', pp.score
            ) ORDER BY pp.id)
            FROM boardgamebuddy_play_players pp
            LEFT JOIN boardgamebuddy_profiles pp_pr ON pp_pr.id = pp.player_user_id
            WHERE pp.play_id = p.id
          ), '[]'::jsonb),
          'expansions', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'expansion_game_id', pe.expansion_game_id,
              'name', eg.name,
              'color', eg.expansion_color
            ))
            FROM boardgamebuddy_play_expansions pe
            JOIN boardgamebuddy_games eg ON eg.id = pe.expansion_game_id
            WHERE pe.play_id = p.id
          ), '[]'::jsonb)
        ) AS play_row
      FROM boardgamebuddy_plays p
      LEFT JOIN boardgamebuddy_profiles pr ON pr.id = p.user_id
      WHERE p.user_id = target
         OR EXISTS (
           SELECT 1 FROM boardgamebuddy_play_players pp
           WHERE pp.play_id = p.id AND pp.player_user_id = target
         )
      ORDER BY p.played_at DESC, p.created_at DESC
      LIMIT plays_per_page
    ) r;

  -- ── status_map + expansion_counts for VIEWER (always — every tile pill
  -- reads the viewer's own collection regardless of whose profile is open).
  SELECT COALESCE(jsonb_object_agg(c.game_id, c.status), '{}'::jsonb)
    INTO v_status_map
    FROM boardgamebuddy_collections c
    WHERE c.user_id = viewer;

  SELECT COALESCE(jsonb_object_agg(base_bgg, cnt), '{}'::jsonb)
    INTO v_expansion_counts
    FROM (
      SELECT c.game_base_game_bgg_id AS base_bgg, COUNT(*)::INT AS cnt
      FROM boardgamebuddy_collections c
      WHERE c.user_id = viewer
        AND c.status = 'owned'
        AND COALESCE(c.game_is_expansion, false) = true
        AND c.game_base_game_bgg_id IS NOT NULL
      GROUP BY c.game_base_game_bgg_id
    ) e;

  -- ── Buddies + requests — only when looking at your own profile.
  IF v_is_self THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', be.id,
      'other_user_id', CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END,
      'other_display_name', pr.display_name,
      'other_avatar_url', pr.avatar_url,
      'accepted_at', be.accepted_at,
      'created_at', be.created_at
    ) ORDER BY pr.display_name), '[]'::jsonb)
      INTO v_buddies
      FROM boardgamebuddy_buddy_edges be
      JOIN boardgamebuddy_profiles pr
        ON pr.id = (CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END)
      WHERE (be.user_a = viewer OR be.user_b = viewer) AND be.status = 'accepted';

    -- Incoming = the other side requested it (be.requested_by != viewer).
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', be.id,
      'direction', 'incoming',
      'other_user_id', CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END,
      'other_display_name', pr.display_name,
      'other_avatar_url', pr.avatar_url,
      'created_at', be.created_at
    ) ORDER BY be.created_at DESC), '[]'::jsonb)
      INTO v_buddy_incoming
      FROM boardgamebuddy_buddy_edges be
      JOIN boardgamebuddy_profiles pr
        ON pr.id = (CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END)
      WHERE (be.user_a = viewer OR be.user_b = viewer)
        AND be.status = 'pending'
        AND be.requested_by <> viewer;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', be.id,
      'direction', 'outgoing',
      'other_user_id', CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END,
      'other_display_name', pr.display_name,
      'other_avatar_url', pr.avatar_url,
      'created_at', be.created_at
    ) ORDER BY be.created_at DESC), '[]'::jsonb)
      INTO v_buddy_outgoing
      FROM boardgamebuddy_buddy_edges be
      JOIN boardgamebuddy_profiles pr
        ON pr.id = (CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END)
      WHERE (be.user_a = viewer OR be.user_b = viewer)
        AND be.status = 'pending'
        AND be.requested_by = viewer;
  ELSE
    v_buddies := NULL;
    v_buddy_incoming := NULL;
    v_buddy_outgoing := NULL;
  END IF;

  RETURN jsonb_build_object(
    'stats', v_stats,
    'owned_page', v_owned_page,
    'owned_total', v_owned_total,
    'wishlist_page', v_wishlist_page,
    'wishlist_total', v_wishlist_total,
    'played_page', v_played_page,
    'played_total', v_played_total,
    'recent_plays', v_recent_plays,
    'recent_plays_total', v_recent_plays_total,
    'status_map', v_status_map,
    'expansion_counts', v_expansion_counts,
    'buddies', v_buddies,
    'buddy_requests_incoming', v_buddy_incoming,
    'buddy_requests_outgoing', v_buddy_outgoing
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_profile_bundle(UUID, UUID, INT, INT) TO boardgamebuddy_role;

COMMIT;
