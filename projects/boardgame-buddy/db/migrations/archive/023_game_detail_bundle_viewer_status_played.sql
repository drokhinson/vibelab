-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — bgb_game_detail_bundle viewer_status fix
--
-- Migration 021 set viewer_status from boardgamebuddy_collections alone, so
-- a game the viewer has plays of but doesn't own/wishlist came back with
-- viewer_status = NULL and the Game Detail hero rendered the bare
-- "Add to collection" banner instead of the purple Played pill.
--
-- This recreates bgb_game_detail_bundle so viewer_status falls through to
-- 'played' when the viewer has any visible play of the game (own play or
-- play_players row). Mirrors the status_map fix that migration 022 made for
-- bgb_profile_bundle. Nothing else changes.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

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
  SELECT to_jsonb(g.*), g.is_expansion, g.base_game_bgg_id, g.bgg_id
    INTO v_game, v_is_expansion, v_base_bgg_id, v_bgg_id
    FROM boardgamebuddy_games g WHERE g.id = game_uuid;
  IF v_game IS NULL THEN
    RETURN NULL;
  END IF;

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

  -- Viewer's pill: collection row wins; otherwise fall through to 'played'
  -- when the viewer has any visible play (own or as a participant) so the
  -- played-not-owned case paints the purple Played banner instead of the
  -- bare "+ Add" picker.
  SELECT status INTO v_status
    FROM boardgamebuddy_collections
    WHERE user_id = viewer AND game_id = game_uuid;
  IF v_status IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM boardgamebuddy_plays p
      WHERE p.game_id = game_uuid
        AND (
          p.user_id = viewer
          OR EXISTS (
            SELECT 1 FROM boardgamebuddy_play_players pp
            WHERE pp.play_id = p.id AND pp.player_user_id = viewer
          )
        )
    ) THEN
      v_status := 'played';
    END IF;
  END IF;

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

COMMIT;
