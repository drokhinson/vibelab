-- ─────────────────────────────────────────────────────────────────────────────
-- 056_participant_order.sql — the host's roster order reaches the spectators.
--
-- The scoring grid's columns ARE the roster order. widgets/round-score-grid.js
-- keys every cell, input id and inline handler off the players ARRAY INDEX, and
-- session-viewer-view builds the same grid straight from `participants`. Until
-- now that array came back ORDER BY joined_at, so the host's Gather list and a
-- spectator's mirror agreed only by accident — and now that the host can drag a
-- row (widgets/player-reorder.js), not even that.
--
-- `position` is the order the host set. NULL means "never ordered": every row
-- that exists today, and every row bgb_join_session and bgb_create_session
-- write. So the sort is (position NULLS LAST, joined_at) — byte-identical to
-- the old behaviour for a session nobody has reordered, and a late joiner lands
-- at the END of one that has been, which is exactly where the host's own lobby
-- poll appends them locally. That equivalence is why those two INSERT sites are
-- deliberately left alone; only bgb_add_participant, which seats a player the
-- host explicitly named, takes a position of its own.
--
-- Reorder is Gather-only, on the same gate add/remove already use (046). From
-- Play onward the column order is what every spectator's grid is drawn from and
-- what the host's index-keyed cell patchers assume, so renumbering it mid-game
-- desyncs both. A write that arrives late gets `roster_locked`, which
-- _withLobby swallows — play-flow-view flushes any pending order write before
-- it advances the phase, so that window is closed on the client.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.boardgamebuddy_play_session_participants
  ADD COLUMN IF NOT EXISTS position SMALLINT;

COMMENT ON COLUMN public.boardgamebuddy_play_session_participants.position IS
  'Host-assigned column order, 0-based. NULL = never ordered; see bgb_session_bundle''s (position NULLS LAST, joined_at) sort.';

-- Open sessions keep the order their spectators are already looking at, so a
-- host who drags one row of a live lobby doesn't renumber the rest from
-- scratch. Guarded on NULL so a re-run can't flatten a real ordering.
UPDATE public.boardgamebuddy_play_session_participants pp
   SET position = ord.rn
  FROM (
    SELECT id,
           (row_number() OVER (PARTITION BY session_id ORDER BY joined_at) - 1)::SMALLINT AS rn
      FROM public.boardgamebuddy_play_session_participants
  ) ord
 WHERE ord.id = pp.id
   AND pp.position IS NULL;

-- No new GRANT: migration 011 granted the table to boardgamebuddy_role and a
-- column inherits the table-level grant. Nothing reaches this table with the
-- anon key, so there is no Data API grant to widen either.


-- ── Reorder the roster ───────────────────────────────────────────────────────
-- p_order is the FULL ordered array of participant ids, front to back. Ids that
-- don't belong to this session are ignored. Participants the array omits — a
-- joiner who arrived between the host's drag and this write — are appended
-- AFTER every listed one in joined_at order rather than dropped, so nobody can
-- fall off the end of the grid because of a race.
CREATE OR REPLACE FUNCTION public.bgb_reorder_participants(
  p_host  UUID,
  p_code  TEXT,
  p_order UUID[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gate    JSONB;
  v_session UUID;
  v_listed  INT;
BEGIN
  -- require_gather = TRUE: same gate, same error vocabulary (not_found /
  -- expired / host_only / roster_locked) as add and remove.
  v_gate := bgb_session_gate(p_code, p_host, TRUE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  v_listed := COALESCE(array_length(p_order, 1), 0);

  UPDATE boardgamebuddy_play_session_participants pp
     SET position = ord.idx
    FROM (
      SELECT t.id, (t.ordinality - 1)::SMALLINT AS idx
        FROM unnest(p_order) WITH ORDINALITY AS t(id, ordinality)
    ) ord
   WHERE pp.id = ord.id
     AND pp.session_id = v_session;

  UPDATE boardgamebuddy_play_session_participants pp
     SET position = (v_listed + rest.rn)::SMALLINT
    FROM (
      SELECT id, (row_number() OVER (ORDER BY joined_at) - 1) AS rn
        FROM boardgamebuddy_play_session_participants
       WHERE session_id = v_session
         AND NOT (id = ANY (COALESCE(p_order, ARRAY[]::UUID[])))
    ) rest
   WHERE pp.id = rest.id;

  RETURN bgb_session_bundle(v_session);
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_reorder_participants(UUID, TEXT, UUID[]) TO boardgamebuddy_role;


-- ── A host-added player lands at the end, not at NULL ────────────────────────
-- Redefinition of migration 046's function. The ONLY change is the position on
-- the two INSERTs: without it every player the host adds sorts NULLS LAST in
-- joined_at order, which is correct until the host reorders and then appends —
-- at which point the new row would jump ahead of nobody but sit in a second,
-- separate ordering. Giving it max+1 keeps one ordering for the whole roster.
CREATE OR REPLACE FUNCTION public.bgb_add_participant(
  p_host UUID,
  p_code TEXT,
  p_user UUID,
  p_display_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gate JSONB;
  v_session UUID;
  v_name TEXT;
  v_next SMALLINT;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, TRUE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  v_name := btrim(COALESCE(p_display_name, ''));
  IF v_name = '' THEN
    RETURN jsonb_build_object('error', 'display_name_required');
  END IF;

  SELECT (COALESCE(max(position), -1) + 1)::SMALLINT
    INTO v_next
    FROM boardgamebuddy_play_session_participants
   WHERE session_id = v_session;

  BEGIN
    IF p_user IS NOT NULL THEN
      INSERT INTO boardgamebuddy_play_session_participants (session_id, user_id, display_name, position)
      SELECT v_session, p_user, v_name, v_next
       WHERE NOT EXISTS (
         SELECT 1 FROM boardgamebuddy_play_session_participants
          WHERE session_id = v_session AND user_id = p_user
       );
    ELSE
      INSERT INTO boardgamebuddy_play_session_participants (session_id, display_name, position)
      SELECT v_session, v_name, v_next
       WHERE NOT EXISTS (
         SELECT 1 FROM boardgamebuddy_play_session_participants
          WHERE session_id = v_session
            AND user_id IS NULL
            AND lower(display_name) = lower(v_name)
       );
    END IF;
  EXCEPTION WHEN unique_violation THEN
    NULL;   -- already seated; the bundle below reflects reality either way
  END;

  RETURN bgb_session_bundle(v_session);
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_add_participant(UUID, TEXT, UUID, TEXT) TO boardgamebuddy_role;



-- ── The host is seated at position 0 ─────────────────────────────────────────
-- Redefinition of migration 038's function (which itself redefined 036's to fix
-- the code entropy). The ONLY change is the participant INSERT's position.
--
-- Without it the host is the one row with a NULL position, so the moment
-- bgb_add_participant above gives everyone else a real one the host sorts LAST
-- — dead last in the lobby list and in the rightmost grid column, on every
-- spectator's screen, in a session nobody had reordered. The host is player[0]
-- of their own roster (_ensureSelfIncluded), and this is what keeps the two
-- ends agreeing.
--
-- bgb_join_session is deliberately NOT redefined: a joiner really does arrive
-- last, and a NULL position sorting after every seated player (then by
-- joined_at among themselves) is exactly where the host's own lobby poll
-- appends them locally.
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
  v_bytes BYTEA;
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
    -- One v4 UUID per attempt as the entropy source. 256 % 32 = 0, so a
    -- random byte mod 32 is uniform over the alphabet.
    v_bytes := uuid_send(gen_random_uuid());
    v_code := '';
    FOR i IN 1..v_code_len LOOP
      v_code := v_code
        || substr(v_alphabet, 1 + (get_byte(v_bytes, i - 1) % 32), 1);
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

  -- Position 0, not NULL. The host is player[0] in their own Gather list
  -- (_ensureSelfIncluded), and once bgb_add_participant hands every other
  -- player a real position a NULL here would sort the host LAST on every
  -- spectator's screen and last in the grid.
  INSERT INTO boardgamebuddy_play_session_participants
    (session_id, user_id, display_name, position)
  VALUES (v_session_id, p_host, p_host_display_name, 0);

  RETURN bgb_session_bundle(v_session_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_create_session(UUID, TEXT, UUID) TO boardgamebuddy_role;
GRANT EXECUTE ON FUNCTION public.bgb_create_session(UUID, TEXT, UUID) TO boardgamebuddy_role;


-- ── The bundle sorts by position ─────────────────────────────────────────────
-- Redefinition of migration 054's builder. The ONLY change is the participants
-- aggregate's ORDER BY. 036's and 037's earlier bodies of this same function
-- are superseded, not live, and are left alone; bgb_joinable_sessions only
-- counts participants, so it has no ordering to fix. That makes this the one
-- and only live participant-ordering site.
--
-- `position` is deliberately NOT emitted into the JSON: the array's order is
-- the contract every consumer already reads, and a second representation of the
-- same fact is a second thing that can disagree with the first.
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
         ) ORDER BY pp.position NULLS LAST, pp.joined_at), '[]'::jsonb)
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

COMMIT;
