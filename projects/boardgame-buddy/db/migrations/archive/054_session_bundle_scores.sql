-- 054_session_bundle_scores.sql — the session bundle carries the live grid.
--
-- Closes the "late spectator's grid stays blank" gap documented in
-- projects/boardgame-buddy/STRUCTURE.md.
--
-- bgb_join_session only writes a participant row while the session is in
-- phase='gather'; join during Play and you are a spectator with no row of your
-- own. bgb_session_scores_select (migration 026, unchanged by 053) is scoped
-- to host-OR-participant, so that spectator's browser reads the scores table
-- and gets nothing back — not an error, just zero rows — and their mirror sits
-- on an empty grid with a 0 total for the whole game while the host scores
-- away. Supabase Realtime applies the same policy, so the socket is silent for
-- them too.
--
-- The fix is to hand the scores to them through the channel they are already
-- authorized on: GET /sessions/{code}, whose access token is knowing the code,
-- and which goes through this SECURITY DEFINER builder rather than RLS. It
-- costs one indexed read per poll (idx_bgb_play_session_scores_session) and no
-- policy anywhere gets broader — an unfiltered SELECT grant on the table would
-- have leaked every open session's scores to every authenticated user.
--
-- Scoped to phase='play' because that is the only phase whose bundle anyone
-- renders a live grid from: Gather has no scores yet, and from Settle Up on
-- the play row is the record. The array is otherwise `[]`, never absent, so
-- the client can seed unconditionally.
--
-- Redefinition of the builder from migration 037 (which itself redefined 036's
-- to delegate the game block to bgb_game_summary). Everything else about the
-- output is byte-for-byte what 037 returned, plus the new `scores` key.

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
  v_phase TEXT;
  v_participants JSONB;
  v_scores JSONB := '[]'::jsonb;
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
         s.game_id,
         COALESCE(s.phase, 'gather')
    INTO v_session, v_game_id, v_phase
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

  IF v_phase = 'play' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'participant_id', sc.participant_id,
             'round_index', sc.round_index,
             'score', sc.score
           ) ORDER BY sc.round_index), '[]'::jsonb)
      INTO v_scores
      FROM boardgamebuddy_play_session_scores sc
      WHERE sc.session_id = p_session_id;
  END IF;

  RETURN v_session || jsonb_build_object(
    'participants', v_participants,
    'game', bgb_game_summary(v_game_id),
    'scores', v_scores
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_session_bundle(UUID) TO boardgamebuddy_role;
