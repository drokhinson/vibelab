-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — bgb_profile_bundle status_map fix
--
-- Phase 5 wired the FE to read its viewer status pills from the bundle's
-- status_map (instead of an extra /collection call). But migration 021's
-- status_map only included games in boardgamebuddy_collections — the
-- legacy /collection endpoint synthesised "played" entries for games the
-- viewer had logged plays on but didn't own/wishlist, and the FE renderer
-- depends on those entries to paint the purple "Played" pill.
--
-- This migration recreates bgb_profile_bundle with status_map union'd
-- against the viewer's plays so played-not-owned games appear as
-- 'played'. Nothing else changes; everything stays JSONB / STABLE /
-- SECURITY DEFINER / executable by boardgamebuddy_role.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

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

  -- ── status_map: every game the viewer has a relationship with.
  -- Collection rows go in with their stored status ('owned' / 'wishlist').
  -- Plays-only games (the viewer logged or appeared in a play, but has no
  -- collection row) get a synthetic 'played' entry so the FE tile renderer
  -- paints the purple Played pill — same shape the legacy /collection
  -- endpoint produced via its synthetic played-row branch. Without this
  -- branch the bundle's status_map was incomplete and played-not-owned
  -- tiles fell back to the default "owned" pill.
  SELECT COALESCE(jsonb_object_agg(game_id, status), '{}'::jsonb)
    INTO v_status_map
    FROM (
      SELECT c.game_id, c.status
      FROM boardgamebuddy_collections c
      WHERE c.user_id = viewer
      UNION ALL
      SELECT DISTINCT p.game_id, 'played'::TEXT AS status
      FROM boardgamebuddy_plays p
      LEFT JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE (p.user_id = viewer OR pp.player_user_id = viewer)
        AND NOT EXISTS (
          SELECT 1 FROM boardgamebuddy_collections c2
          WHERE c2.user_id = viewer AND c2.game_id = p.game_id
        )
    ) m;

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
