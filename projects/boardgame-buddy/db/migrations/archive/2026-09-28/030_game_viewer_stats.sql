-- ─────────────────────────────────────────────────────────────────────────────
-- 030 — Your record with THIS game, on the game's own page
-- ─────────────────────────────────────────────────────────────────────────────
-- Game Detail showed a viewer everything about a game except the one thing only
-- they know: how it has actually gone for them. The numbers existed —
-- bgb_user_stats_detail computes exactly this row, per game, for the Stats
-- spoke's By game card — but that payload is the whole play history (eleven
-- aggregates, LIMIT 100 games) and self-only, which is far too big a read to
-- hang off opening a game.
--
-- So the same row is computed here, for one game, inside the bundle the screen
-- already fetches: no extra round trip, and no second definition of "a play I
-- was at" or of what counts as a win.
--
-- The semantics are 020's, verbatim, because the two surfaces draw the SAME
-- component (web/ui/game-stats-panel.js) and a ring that disagrees with the one
-- on the Stats spoke is worse than no ring:
--   * `plays` counts every play of this game the viewer logged OR sat in;
--   * `decided_plays` is the win-rate denominator — a play where no seat is
--     flagged a winner and no seat carries a score recorded no outcome, and is
--     not a loss;
--   * `scored_plays` / `avg_winning_score` are about the WINNER's score, which
--     is a different question from either of the above;
--   * a play logged but sat out has no seat of the viewer's, so it counts in
--     `plays` and in nothing else.
--
-- NULL when the viewer has never played the game, so the section simply is not
-- drawn — the same shape every other empty block on that screen takes.
--
-- Same signature, so CREATE OR REPLACE is enough. Everything above the new
-- block is 003_rpcs.sql's body unchanged.
--
-- bootstrap_version is deliberately NOT bumped, for the reason migrations 064
-- and 071 give: the key is purely additive, and bgb_game_bundles warms these
-- same bundles at boot, so a device holding a pre-030 copy simply draws no
-- stats section until its cache revalidates. Wiping every cache to bring one
-- block forward a few minutes early is the more expensive of the two.

CREATE OR REPLACE FUNCTION public.bgb_game_detail_bundle(game_uuid uuid, viewer uuid, plays_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_viewer_stats JSONB;
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
      -- Full-size art for the expansion reel's polaroids: at 132x110 with
      -- object-fit: cover, BGG's ~200px thumbnail was being upscaled.
      'image_url', g.image_url,
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

  -- ── Viewer's record with this game (migration 030) ──────────────────────
  WITH my_plays AS (
    SELECT p.id, p.played_at
      FROM boardgamebuddy_plays p
     WHERE p.game_id = game_uuid
       AND (
         p.user_id = viewer
         OR EXISTS (
           SELECT 1 FROM boardgamebuddy_play_players pp
            WHERE pp.play_id = p.id AND pp.player_user_id = viewer
         )
       )
  ),
  -- The viewer's own seat on each of those plays. A play they logged but sat
  -- out has no row here, so it has no result and no score.
  mine AS (
    SELECT mp.id AS play_id, pp.is_winner, pp.score,
           EXISTS (
             SELECT 1 FROM boardgamebuddy_play_players d
              WHERE d.play_id = mp.id
                AND (d.is_winner OR d.score IS NOT NULL)
           ) AS decided
      FROM my_plays mp
      JOIN boardgamebuddy_play_players pp
        ON pp.play_id = mp.id AND pp.player_user_id = viewer
  ),
  winner_scores AS (
    SELECT w.play_id, w.score
      FROM boardgamebuddy_play_players w
      JOIN my_plays mp ON mp.id = w.play_id
     WHERE w.is_winner AND w.score IS NOT NULL
  )
  SELECT CASE WHEN (SELECT COUNT(*) FROM my_plays) = 0 THEN NULL ELSE
    jsonb_build_object(
      'game_id',           game_uuid,
      'play_mode',         COALESCE(v_game->>'play_mode', 'competitive'),
      'plays',             (SELECT COUNT(*)::INT FROM my_plays),
      'wins',              (SELECT COUNT(*)::INT FROM mine WHERE is_winner),
      'decided_plays',     (SELECT COUNT(*)::INT FROM mine WHERE decided),
      'scored_plays',      (SELECT COUNT(DISTINCT play_id)::INT FROM winner_scores),
      'avg_winning_score', (SELECT ROUND(AVG(score))::INT FROM winner_scores),
      'your_avg_score',    (SELECT ROUND(AVG(score))::INT FROM mine WHERE score IS NOT NULL),
      'your_best_score',   (SELECT MAX(score) FROM mine),
      'first_played_at',   (SELECT MIN(played_at) FROM my_plays),
      'last_played_at',    (SELECT MAX(played_at) FROM my_plays)
    )
  END INTO v_viewer_stats;

  RETURN jsonb_build_object(
    'game', v_game,
    'base_game', v_base,
    'viewer_status', v_status,
    'recent_plays', v_plays,
    'expansions', v_expansions,
    'expansion_count_for_viewer', v_exp_count_viewer,
    'viewer_stats', v_viewer_stats
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_game_detail_bundle(game_uuid uuid, viewer uuid, plays_limit integer) TO boardgamebuddy_role;
