-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — play-write RPCs (collapse the Save round trips)
--
-- Migrations 036/037/039 folded the *read* fan-outs into single RPCs (session
-- poll 4→1, joinable 5→1, plays page 8-11→1). The write paths never got the
-- same treatment, so a host tapping Save still paid:
--
--   POST /sessions/{code}/finalize  → 10 sequential PostgREST round trips
--     (auth profile SELECT, bgb_get_session, live-scores SELECT, then
--      log_play's 6 raw writes, then mark_finalized)
--
-- Every one of them blocking, at cross-region RTTs, while each joiner's phone
-- polls GET /sessions/{code} every 2s behind it. These two functions fold the
-- whole write into ONE call:
--
--   bgb_log_play(user, payload)              → PlayResponse-shaped JSONB
--   bgb_finalize_session(host, code, payload)→ gate + live-score merge
--                                              + bgb_log_play + mark finalized
--
-- Error convention matches 036: gate failures return {"error": "<code>"}
-- (not_found / expired / forbidden / game_not_found) rather than raising, and
-- the service layer maps them to the existing HTTPExceptions. JSONB keys match
-- the Pydantic models in shared-backend/routes/boardgame_buddy/models.py
-- (PlayResponse, PlayPlayerResponse, PlayExpansionRef) so responses parse
-- directly.
--
-- No table changes — functions only.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;


-- Write a play and everything hanging off it in one transaction.
--
-- p_payload mirrors the PlayCreate model:
--   {game_id, played_at, notes, photo_url, play_mode, expansion_ids[],
--    players: [{name, is_winner, score, user_id, round_scores}]}
--
-- Replaces play_routes.log_play's six round trips (game SELECT, play INSERT,
-- buddies upsert, players INSERT, expansions INSERT, expansions read-back).
-- The read-back is gone entirely: the expansion names/colors are joined in
-- the same statement that inserts the junction rows.
CREATE OR REPLACE FUNCTION public.bgb_log_play(
  p_user    UUID,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_game        RECORD;
  v_mode        TEXT;
  v_play        RECORD;
  v_logged_name TEXT;
  v_players     JSONB;
  v_expansions  JSONB;
BEGIN
  SELECT g.id, g.name, g.thumbnail_url, g.image_url, g.play_mode
    INTO v_game
    FROM boardgamebuddy_games g
   WHERE g.id = (p_payload->>'game_id')::UUID;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'game_not_found');
  END IF;

  -- Explicit override wins; otherwise inherit the game's intrinsic mode.
  -- Mirrors log_play's `effective_mode`.
  v_mode := COALESCE(
    NULLIF(p_payload->>'play_mode', ''),
    v_game.play_mode,
    'competitive'
  );

  -- game_name / game_thumbnail_url / game_image_url / game_play_mode are the
  -- denormalized columns from migration 020 — the same set
  -- game_routes.play_denormalized_from_game() supplies.
  INSERT INTO boardgamebuddy_plays (
    user_id, game_id, played_at, notes, photo_url, play_mode,
    game_name, game_thumbnail_url, game_image_url, game_play_mode
  )
  VALUES (
    p_user,
    v_game.id,
    (p_payload->>'played_at')::DATE,
    p_payload->>'notes',
    p_payload->>'photo_url',
    v_mode,
    v_game.name,
    v_game.thumbnail_url,
    v_game.image_url,
    v_game.play_mode
  )
  RETURNING id, created_at INTO v_play;

  -- Legacy per-owner roster. The play_players row hasn't referenced it since
  -- migration 013, but the plays-by-buddy filter in the legacy admin tools
  -- still reads it. DISTINCT because the same (owner_id, name) twice in one
  -- statement would trip "ON CONFLICT cannot affect row a second time".
  INSERT INTO boardgamebuddy_buddies (owner_id, name)
  SELECT DISTINCT p_user, pl.name
    FROM jsonb_to_recordset(COALESCE(p_payload->'players', '[]'::JSONB))
           AS pl(name TEXT)
   WHERE COALESCE(pl.name, '') <> ''
  ON CONFLICT (owner_id, name) DO NOTHING;

  INSERT INTO boardgamebuddy_play_players (
    play_id, player_user_id, player_display_name, is_winner, score, round_scores
  )
  SELECT
    v_play.id,
    pl.user_id,
    pl.name,
    COALESCE(pl.is_winner, false),
    pl.score,
    pl.round_scores
  FROM jsonb_to_recordset(COALESCE(p_payload->'players', '[]'::JSONB))
         AS pl(name TEXT, is_winner BOOLEAN, score INTEGER,
               user_id UUID, round_scores JSONB);

  -- DISTINCT guards the (play_id, expansion_game_id) primary key against a
  -- payload that repeats an id.
  INSERT INTO boardgamebuddy_play_expansions (play_id, expansion_game_id)
  SELECT DISTINCT v_play.id, eid::UUID
    FROM jsonb_array_elements_text(
           COALESCE(p_payload->'expansion_ids', '[]'::JSONB)
         ) AS eid
   WHERE COALESCE(eid, '') <> '';

  SELECT pr.display_name INTO v_logged_name
    FROM boardgamebuddy_profiles pr
   WHERE pr.id = p_user;

  -- Response blocks are built from the payload (plus the profile/game joins
  -- they need), not by reading the rows back — the values are identical and
  -- WITH ORDINALITY keeps the player list in the order the host entered it,
  -- which a RETURNING or a re-SELECT wouldn't guarantee.
  --
  -- A linked account's display name and avatar win over the typed label;
  -- ghosts fall back to the typed name. Same precedence as
  -- play_routes._fetch_players.
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'buddy_id',     NULL,
             'user_id',      pl.user_id,
             'name',         COALESCE(prof.display_name, pl.name, 'Unknown'),
             'avatar',       prof.avatar,
             'is_winner',    COALESCE(pl.is_winner, false),
             'score',        pl.score,
             'round_scores', pl.round_scores
           ) ORDER BY pl.ord
         ), '[]'::JSONB)
    INTO v_players
    FROM ROWS FROM (
           jsonb_to_recordset(COALESCE(p_payload->'players', '[]'::JSONB))
             AS (name TEXT, is_winner BOOLEAN, score INTEGER,
                 user_id UUID, round_scores JSONB)
         ) WITH ORDINALITY AS pl(name, is_winner, score, user_id, round_scores, ord)
    LEFT JOIN boardgamebuddy_profiles prof ON prof.id = pl.user_id;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'expansion_game_id', eg.id,
             'name',              eg.name,
             'color',             eg.expansion_color
           ) ORDER BY eg.name
         ), '[]'::JSONB)
    INTO v_expansions
    FROM (
      SELECT DISTINCT eid::UUID AS id
        FROM jsonb_array_elements_text(
               COALESCE(p_payload->'expansion_ids', '[]'::JSONB)
             ) AS eid
       WHERE COALESCE(eid, '') <> ''
    ) picked
    JOIN boardgamebuddy_games eg ON eg.id = picked.id;

  RETURN jsonb_build_object(
    'id',              v_play.id,
    'game_id',         v_game.id,
    'game_name',       v_game.name,
    'game_thumbnail',  v_game.thumbnail_url,
    'played_at',       (p_payload->>'played_at')::DATE,
    'notes',           p_payload->>'notes',
    'players',         v_players,
    'photo_url',       p_payload->>'photo_url',
    'expansions',      v_expansions,
    'created_at',      v_play.created_at,
    'play_mode',       v_mode,
    'logged_by_id',    p_user,
    'logged_by_name',  COALESCE(v_logged_name, ''),
    'is_own',          true
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_log_play(UUID, JSONB) TO boardgamebuddy_role;


-- Turn an open lobby into a play row. Same gates as the old Python chain
-- (bgb_get_session's open/expiry check + finalize_session's host check),
-- the same live-score overlay as session_service.merge_live_scores_into_players,
-- then bgb_log_play and mark-finalized — one round trip instead of ten.
CREATE OR REPLACE FUNCTION public.bgb_finalize_session(
  p_host    UUID,
  p_code    TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session RECORD;
  v_merged  JSONB;
  v_play    JSONB;
BEGIN
  SELECT s.id, s.host_user_id, s.expires_at
    INTO v_session
    FROM boardgamebuddy_play_sessions s
   WHERE s.code = upper(p_code)
     AND s.status = 'open';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_session.expires_at < now() THEN
    UPDATE boardgamebuddy_play_sessions
       SET status = 'abandoned'
     WHERE id = v_session.id;
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  IF v_session.host_user_id <> p_host THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  -- Overlay live scoring onto the host's payload: each authenticated player's
  -- `score` becomes the sum of the rounds joiners streamed in during
  -- phase='play'. Guests (user_id IS NULL) are never in the scores table, so
  -- their host-typed scores ride through untouched — as do authed players who
  -- have no rows there.
  WITH totals AS (
    SELECT sc.player_user_id, SUM(COALESCE(sc.score, 0))::INT AS total
      FROM boardgamebuddy_play_session_scores sc
     WHERE sc.session_id = v_session.id
     GROUP BY sc.player_user_id
  )
  SELECT COALESCE(jsonb_agg(
           CASE
             WHEN t.player_user_id IS NOT NULL
               THEN jsonb_set(pl.value, '{score}', to_jsonb(t.total))
             ELSE pl.value
           END ORDER BY pl.ord
         ), '[]'::JSONB)
    INTO v_merged
    FROM jsonb_array_elements(COALESCE(p_payload->'players', '[]'::JSONB))
           WITH ORDINALITY AS pl(value, ord)
    LEFT JOIN totals t
           ON pl.value->>'user_id' IS NOT NULL
          AND t.player_user_id = (pl.value->>'user_id')::UUID;

  v_play := bgb_log_play(p_host, jsonb_set(p_payload, '{players}', v_merged));

  -- A failed write (e.g. game_not_found) must not finalize the lobby —
  -- the host stays on Settle Up and can retry.
  IF v_play ? 'error' THEN
    RETURN v_play;
  END IF;

  UPDATE boardgamebuddy_play_sessions
     SET status            = 'finalized',
         phase             = 'finalized',
         finalized_play_id = (v_play->>'id')::UUID,
         finalized_at      = now()
   WHERE id = v_session.id;

  RETURN v_play;
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_finalize_session(UUID, TEXT, JSONB) TO boardgamebuddy_role;

COMMIT;
