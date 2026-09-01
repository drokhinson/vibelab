-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — joinable-sessions RPC (follow-up to 036)
--
-- list_joinable (the Join chooser screen) was the last session flow still
-- fanning out round trips: open sessions + host profiles + games +
-- participants + buddy edges = 5 sequential PostgREST calls. This folds it
-- into one RPC returning a JoinableSession-shaped JSONB array.
--
-- Also factors the GameSummary JSON builder out of bgb_session_bundle into
-- bgb_game_summary so both call sites share one canonical shape, and
-- redefines bgb_session_bundle to delegate to it (CREATE OR REPLACE — safe
-- to run whether or not 036 is already applied).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;


-- GameSummary JSONB for one game id, or NULL when the id is NULL/unknown.
-- Keys mirror _helpers._GAME_SELECT / models.GameSummary; bgg_url and
-- expansion_count are computed/defaulted Pydantic-side — omitted here.
CREATE OR REPLACE FUNCTION public.bgb_game_summary(p_game_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
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
           'is_expansion', COALESCE(g.is_expansion, false),
           'base_game_bgg_id', g.base_game_bgg_id,
           'expansion_color', g.expansion_color,
           'rulebook_url', g.rulebook_url,
           'play_mode', COALESCE(g.play_mode, 'competitive')
         )
    FROM boardgamebuddy_games g
    WHERE g.id = p_game_id;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_game_summary(UUID) TO boardgamebuddy_role;


-- Redefinition of 036's builder: identical output, game block now delegated
-- to bgb_game_summary.
CREATE OR REPLACE FUNCTION public.bgb_session_bundle(p_session_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session JSONB;
  v_game_id UUID;
  v_participants JSONB;
BEGIN
  SELECT jsonb_build_object(
           'id', s.id,
           'code', s.code,
           'status', s.status,
           'phase', COALESCE(s.phase, 'gather'),
           'host_user_id', s.host_user_id,
           'game_id', s.game_id,
           'created_at', s.created_at,
           'expires_at', s.expires_at,
           'finalized_play_id', s.finalized_play_id
         ),
         s.game_id
    INTO v_session, v_game_id
    FROM boardgamebuddy_play_sessions s
    WHERE s.id = p_session_id;

  IF v_session IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', pp.id,
           'user_id', pp.user_id,
           'display_name', pp.display_name,
           'joined_at', pp.joined_at,
           'avatar', pr.avatar
         ) ORDER BY pp.joined_at), '[]'::jsonb)
    INTO v_participants
    FROM boardgamebuddy_play_session_participants pp
    LEFT JOIN boardgamebuddy_profiles pr ON pr.id = pp.user_id
    WHERE pp.session_id = p_session_id;

  RETURN v_session || jsonb_build_object(
    'participants', v_participants,
    'game', bgb_game_summary(v_game_id)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_session_bundle(UUID) TO boardgamebuddy_role;


-- Join chooser: every open in-progress session (phase gather/play/settle,
-- not expired) the viewer has visibility into — their own hosted sessions
-- (refresh recovery), sessions they already joined (disconnect recovery),
-- or sessions hosted by an accepted buddy. Newest first. Same semantics as
-- the old session_service.list_joinable.
CREATE OR REPLACE FUNCTION public.bgb_joinable_sessions(p_viewer UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_out JSONB;
BEGIN
  WITH buddies AS (
    SELECT CASE WHEN e.user_a = p_viewer THEN e.user_b ELSE e.user_a END AS buddy_id
    FROM boardgamebuddy_buddy_edges e
    WHERE e.status = 'accepted'
      AND (e.user_a = p_viewer OR e.user_b = p_viewer)
  ),
  visible AS (
    SELECT
      s.id,
      s.code,
      s.host_user_id,
      s.game_id,
      COALESCE(s.phase, 'gather') AS phase,
      s.created_at,
      (SELECT count(*)
         FROM boardgamebuddy_play_session_participants pp
         WHERE pp.session_id = s.id) AS participant_count,
      EXISTS (SELECT 1
                FROM boardgamebuddy_play_session_participants pp
                WHERE pp.session_id = s.id
                  AND pp.user_id = p_viewer) AS is_participant,
      s.host_user_id IN (SELECT buddy_id FROM buddies) AS is_host_buddy
    FROM boardgamebuddy_play_sessions s
    WHERE s.status = 'open'
      AND COALESCE(s.phase, 'gather') IN ('gather', 'play', 'settle')
      AND s.expires_at > now()
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', v.id,
           'code', v.code,
           'host_user_id', v.host_user_id,
           'host_display_name', COALESCE(pr.display_name, 'Host'),
           'host_avatar', pr.avatar,
           'game', bgb_game_summary(v.game_id),
           'phase', v.phase,
           'participant_count', v.participant_count,
           'is_participant', v.is_participant,
           'is_host_buddy', v.is_host_buddy,
           'created_at', v.created_at
         ) ORDER BY v.created_at DESC), '[]'::jsonb)
    INTO v_out
    FROM visible v
    LEFT JOIN boardgamebuddy_profiles pr ON pr.id = v.host_user_id
    WHERE v.is_participant
       OR v.host_user_id = p_viewer
       OR v.is_host_buddy;

  RETURN v_out;
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_joinable_sessions(UUID) TO boardgamebuddy_role;

COMMIT;
