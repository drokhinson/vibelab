-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — play-session RPCs (collapse lobby round trips)
--
-- The host/join flow was 4-6 sequential PostgREST round trips per request
-- (session_service.py fanned out: mutate → select participants → select
-- profiles → select game). At cross-region RTTs that put a "Host" tap at
-- 1s+, and GET /sessions/{code} — polled every 2s per participant — paid
-- 4 round trips per poll. These functions fold each flow into ONE call:
--
--   bgb_session_bundle(session_id)  → SessionResponse-shaped JSONB (builder)
--   bgb_create_session(...)         → abandon stale + allocate code + seat host
--   bgb_get_session(code)           → open/expiry gate + bundle (the 2s poll)
--   bgb_join_session(...)           → open/expiry gate + roster insert + bundle
--
-- Error convention: instead of raising, gate failures return
-- {"error": "<code>"} (not_found / expired / guest_name_required /
-- code_allocation_failed) and session_service maps them to the existing
-- HTTPExceptions. JSONB keys match the Pydantic models in
-- shared-backend/routes/boardgame_buddy/models.py (SessionResponse,
-- SessionParticipantResponse, GameSummary) so responses parse directly.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- gen_random_bytes for code generation (enabled by default on Supabase).
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- Bundle builder: one query each for the session row, the participant list
-- (with profile avatars), and the optional game summary. Shared by the three
-- entry points below and by session_service._build_response for the
-- remaining host-only mutations (add/remove participant, game pick, phase).
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
  v_game JSONB;
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

  IF v_game_id IS NOT NULL THEN
    -- Keys mirror _helpers._GAME_SELECT / models.GameSummary. bgg_url and
    -- expansion_count are computed/defaulted Pydantic-side — omitted here.
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
      INTO v_game
      FROM boardgamebuddy_games g
      WHERE g.id = v_game_id;
  END IF;

  RETURN v_session
      || jsonb_build_object('participants', v_participants, 'game', v_game);
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_session_bundle(UUID) TO boardgamebuddy_role;


-- Open a lobby: abandon the host's stale open sessions, allocate a unique
-- short code (retrying on collision against the partial unique index on
-- (code) WHERE status='open'), seat the host as participant #1.
CREATE OR REPLACE FUNCTION public.bgb_create_session(
  p_host UUID,
  p_host_display_name TEXT,
  p_game UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Crockford base32, mirrors PLAY_SESSION_CODE_ALPHABET / _LENGTH in
  -- shared-backend/routes/boardgame_buddy/constants.py — keep in step.
  v_alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_code_len CONSTANT INT := 5;
  v_max_attempts CONSTANT INT := 6;
  v_code TEXT;
  v_session_id UUID;
BEGIN
  -- The Log Play tab always opens a fresh session on entry to Gather; a
  -- host who navigated away would otherwise leave orphan open rows.
  UPDATE boardgamebuddy_play_sessions
     SET status = 'abandoned', phase = 'abandoned'
   WHERE host_user_id = p_host
     AND status = 'open';

  FOR attempt IN 1..v_max_attempts LOOP
    v_code := '';
    FOR i IN 1..v_code_len LOOP
      -- 256 % 32 = 0, so a single random byte mod 32 is uniform.
      v_code := v_code
        || substr(v_alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % 32), 1);
    END LOOP;
    BEGIN
      INSERT INTO boardgamebuddy_play_sessions
        (code, host_user_id, game_id, status, phase)
      VALUES (v_code, p_host, p_game, 'open', 'gather')
      RETURNING id INTO v_session_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_session_id := NULL;
    END;
  END LOOP;

  IF v_session_id IS NULL THEN
    RETURN jsonb_build_object('error', 'code_allocation_failed');
  END IF;

  INSERT INTO boardgamebuddy_play_session_participants
    (session_id, user_id, display_name)
  VALUES (v_session_id, p_host, p_host_display_name);

  RETURN bgb_session_bundle(v_session_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_create_session(UUID, TEXT, UUID) TO boardgamebuddy_role;


-- Poll target: fetch an open session by code. Expired sessions are marked
-- abandoned (status only, matching the old _fetch_open_session behavior)
-- and reported as {"error": "expired"} → 410.
CREATE OR REPLACE FUNCTION public.bgb_get_session(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_expires TIMESTAMPTZ;
BEGIN
  SELECT s.id, s.expires_at
    INTO v_id, v_expires
    FROM boardgamebuddy_play_sessions s
    WHERE s.code = upper(p_code)
      AND s.status = 'open';

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_expires < now() THEN
    UPDATE boardgamebuddy_play_sessions
       SET status = 'abandoned'
     WHERE id = v_id;
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  RETURN bgb_session_bundle(v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_get_session(TEXT) TO boardgamebuddy_role;


-- Idempotent join, same semantics as the old session_service.join_session:
-- during Gather an authed caller (p_user set) is added by user_id and a
-- guest by case-insensitive display_name; after Gather the roster is left
-- untouched and the caller becomes a spectator. Dedup happens inline via
-- NOT EXISTS guards.
CREATE OR REPLACE FUNCTION public.bgb_join_session(
  p_code TEXT,
  p_user UUID DEFAULT NULL,
  p_user_display_name TEXT DEFAULT NULL,
  p_guest_display_name TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_expires TIMESTAMPTZ;
  v_phase TEXT;
  v_guest_name TEXT;
BEGIN
  SELECT s.id, s.expires_at, COALESCE(s.phase, 'gather')
    INTO v_id, v_expires, v_phase
    FROM boardgamebuddy_play_sessions s
    WHERE s.code = upper(p_code)
      AND s.status = 'open';

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_expires < now() THEN
    UPDATE boardgamebuddy_play_sessions
       SET status = 'abandoned'
     WHERE id = v_id;
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  IF v_phase = 'gather' THEN
    IF p_user IS NOT NULL THEN
      INSERT INTO boardgamebuddy_play_session_participants
        (session_id, user_id, display_name)
      SELECT v_id, p_user, COALESCE(p_user_display_name, 'Player')
      WHERE NOT EXISTS (
        SELECT 1 FROM boardgamebuddy_play_session_participants
        WHERE session_id = v_id AND user_id = p_user
      );
    ELSE
      v_guest_name := btrim(COALESCE(p_guest_display_name, ''));
      IF v_guest_name = '' THEN
        RETURN jsonb_build_object('error', 'guest_name_required');
      END IF;
      INSERT INTO boardgamebuddy_play_session_participants
        (session_id, display_name)
      SELECT v_id, v_guest_name
      WHERE NOT EXISTS (
        SELECT 1 FROM boardgamebuddy_play_session_participants
        WHERE session_id = v_id
          AND lower(display_name) = lower(v_guest_name)
      );
    END IF;
  END IF;

  RETURN bgb_session_bundle(v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_join_session(TEXT, UUID, TEXT, TEXT) TO boardgamebuddy_role;

COMMIT;
