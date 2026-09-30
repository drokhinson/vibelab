-- ─────────────────────────────────────────────────────────────────────────────
-- 063_play_invites.sql — being seated in somebody else's play is an invite
-- ─────────────────────────────────────────────────────────────────────────────
--
-- When somebody logs a play and seats another account, that seat is written as
-- an INVITE. It shows on the play as the account it names, to everyone who can
-- see the play, but it counts toward that person's stats, achievements, profile
-- and played-with links only once they accept. Declining turns the seat into a
-- guest carrying the same name, so the logger's result does not change.
--
-- 1. boardgamebuddy_play_players.pending_user_id holds the invited account.
--    An invited seat has player_user_id NULL, so every reader that counts a
--    person's plays by player_user_id leaves it out with no change of its own.
--    boardgamebuddy_play_session_participants.accepted_at records a lobby seat
--    accepted while the game is on (or joined by the person themselves).
-- 2. bgb_log_play writes invites. The logger's own seat, and lobby seats that
--    were accepted, count at once. Imports go through the same function, so an
--    import that seats a buddy invites them too.
-- 3. Live sessions: bgb_join_session marks the joiner accepted,
--    bgb_session_bundle reports each seat's `accepted`, bgb_answer_session_seat
--    accepts or declines from the spectator screen, and bgb_finalize_session
--    passes the accepted seats to bgb_log_play.
-- 4. The roster readers (feed, plays page, game page, profile) show an invited
--    seat as its account and mark it `pending`. The feed also shows the invitee
--    the play, so they can answer it from there.
-- 5. The ghost readers skip invited seats, bgb_link_ghost invites the account
--    it links unless it is the caller's own, and bgb_ghost_out_of_plays (leave
--    and unlink) also declines invites.
-- 6. bgb_accept_play_invites, bgb_play_invites (the bell's "Needs an answer"
--    list) and bgb_notifications_pending (the bell's count).
--
-- Every seat that exists today stays counted: nothing is moved to pending.
--
-- Deploy order: API first, then this migration, then web. The API reads the
-- two new notification RPCs softly, so it runs before this does.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Columns ───────────────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_play_players
  ADD COLUMN IF NOT EXISTS pending_user_id uuid
    REFERENCES public.boardgamebuddy_profiles(id) ON DELETE SET NULL;

ALTER TABLE public.boardgamebuddy_play_players
  DROP CONSTRAINT IF EXISTS bgb_play_players_pending_chk;
ALTER TABLE public.boardgamebuddy_play_players
  ADD CONSTRAINT bgb_play_players_pending_chk
    CHECK (player_user_id IS NULL OR pending_user_id IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bgb_play_players_play_pending
  ON public.boardgamebuddy_play_players (play_id, pending_user_id)
  WHERE pending_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bgb_play_players_pending
  ON public.boardgamebuddy_play_players (pending_user_id, linked_at DESC)
  WHERE pending_user_id IS NOT NULL;

COMMENT ON COLUMN public.boardgamebuddy_play_players.pending_user_id IS
  'An account invited to this seat that has not accepted. Shown as that account; counted for nobody until accepted, when it moves to player_user_id.';

ALTER TABLE public.boardgamebuddy_play_session_participants
  ADD COLUMN IF NOT EXISTS accepted_at timestamp with time zone;

-- Seats in lobbies open during the deploy keep counting, as they would have.
UPDATE public.boardgamebuddy_play_session_participants
   SET accepted_at = joined_at
 WHERE user_id IS NOT NULL AND accepted_at IS NULL;

COMMENT ON COLUMN public.boardgamebuddy_play_session_participants.accepted_at IS
  'When this account said the game counts for them: by joining, or by accepting on the spectator screen. NULL means the saved play invites them.';

-- ── 2. bgb_log_play: other people's seats are written as invites ──────────

CREATE OR REPLACE FUNCTION public.bgb_log_play(p_user uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_game        RECORD;
  v_mode        TEXT;
  v_play        RECORD;
  v_logged_name TEXT;
  v_roster      JSONB;
  v_players     JSONB;
  v_expansions  JSONB;
  v_client_key  UUID;
  v_existing    UUID;
  v_country     TEXT;
  v_group       UUID;
  v_batch       UUID;
  v_template    JSONB;
  v_bga_table   BIGINT;
  v_bgg_play_id BIGINT;
  v_accepted    UUID[];
BEGIN
  -- Empty string and absent both mean "no key" — the client omits the field
  -- entirely for live writes, but a serializer that emits "" must not be read
  -- as a key shared by every unkeyed play.
  v_client_key := NULLIF(p_payload->>'client_key', '')::UUID;

  -- Set only by the Settings play importer, and only on plays
  -- it judged identical to at least one other in the same import: same game,
  -- same date, same players, same winner, and no score or note on either. The
  -- feed and the plays log show one card per group; every counter still sees
  -- the individual rows, which is the whole reason this is a tag rather than
  -- a row multiplier.
  v_group := NULLIF(p_payload->>'import_group_id', '')::UUID;

  -- One id per IMPORT, where the group above is one per RUN.
  -- Both are set only by the importer; a live log has neither, and neither is
  -- read by anything that counts plays.
  v_batch := NULLIF(p_payload->>'import_batch_id', '')::UUID;

  -- The scoring grid this play was scored on, snapshotted.
  -- jsonb 'null' and absent both mean "no template": the client sends an
  -- explicit null for a play scored on the plain R1..Rn grid.
  v_template := NULLIF(p_payload->'scoring_template', 'null'::jsonb);

  -- The BGA table this play came from, if any.
  v_bga_table := NULLIF(p_payload->>'bga_table_id', '')::BIGINT;

  -- The BoardGameGeek play this row came from, set only by the
  -- importer's BoardGameGeek source. Same empty-string rule as the two keys
  -- above.
  v_bgg_play_id := NULLIF(p_payload->>'bgg_play_id', '')::BIGINT;

  -- Accounts that already said yes: set only by bgb_finalize_session, from
  -- the lobby seats accepted while the game was on. The API never passes a
  -- client's own copy of this key through.
  v_accepted := ARRAY(
    SELECT a::UUID
      FROM jsonb_array_elements_text(
             COALESCE(p_payload->'accepted_user_ids', '[]'::JSONB)) AS a
  );

  IF v_client_key IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.client_key = v_client_key;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- Same envelope, different key: a table already imported is
  -- not a failure, it is the answer "you already have this one".
  IF v_bga_table IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.bga_table_id = v_bga_table;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- The third key, and the only one that can see the plays the
  -- RETIRED POST /bgg/sync write path landed: those rows carry a bgg_play_id
  -- and no client_key at all, so nothing derived from the importer's own draft
  -- ids could ever recognise them. This is what makes re-importing from
  -- BoardGameGeek a no-op rather than a duplicate.
  IF v_bgg_play_id IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.bgg_play_id = v_bgg_play_id;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- The roster gate, before anything is written.
  SELECT COALESCE(jsonb_agg(kept.seat ORDER BY kept.ord), '[]'::JSONB)
    INTO v_roster
    FROM (
      SELECT s.seat, s.ord
        FROM jsonb_array_elements(COALESCE(p_payload->'players', '[]'::JSONB))
               WITH ORDINALITY AS s(seat, ord)
       WHERE NULLIF(btrim(COALESCE(s.seat->>'user_id', '')), '') IS NOT NULL
          OR NULLIF(btrim(COALESCE(s.seat->>'name', '')), '') IS NOT NULL
    ) kept;

  IF jsonb_array_length(v_roster) = 0 THEN
    RETURN jsonb_build_object('error', 'no_players');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_roster) AS s(seat)
     WHERE NULLIF(btrim(COALESCE(s.seat->>'user_id', '')), '') IS NOT NULL
     GROUP BY NULLIF(btrim(s.seat->>'user_id'), '')::UUID
    HAVING count(*) > 1
  ) THEN
    RETURN jsonb_build_object('error', 'duplicate_player');
  END IF;

  -- Unresolvable / malformed becomes NULL — "we don't know
  -- where this was played" is a legitimate row and a rejected save is not.
  v_country := upper(NULLIF(btrim(COALESCE(p_payload->>'country_code', '')), ''));
  IF v_country IS NOT NULL AND v_country !~ '^[A-Z]{2}$' THEN
    v_country := NULL;
  END IF;

  SELECT g.id, g.name, g.thumbnail_url, g.play_mode
    INTO v_game
    FROM boardgamebuddy_games g
   WHERE g.id = (p_payload->>'game_id')::UUID;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'game_not_found');
  END IF;

  -- Explicit override wins; otherwise inherit the game's intrinsic mode.
  v_mode := COALESCE(
    NULLIF(p_payload->>'play_mode', ''),
    v_game.play_mode,
    'competitive'
  );

  BEGIN
    INSERT INTO boardgamebuddy_plays (
      user_id, game_id, played_at, notes, photo_url, play_mode,
      game_name, game_thumbnail_url, client_key, country_code,
      import_group_id, import_batch_id, imported_at, scoring_template,
      bga_table_id, bgg_play_id
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
      v_client_key,
      v_country,
      v_group,
      v_batch,
      -- Stamped server-side, and only for an import: a client clock is the one
      -- thing here nobody should have to trust, and the Settings list orders by
      -- this value.
      CASE WHEN v_batch IS NULL THEN NULL ELSE now() END,
      v_template,
      v_bga_table,
      v_bgg_play_id
    )
    RETURNING id, created_at INTO v_play;
  EXCEPTION WHEN unique_violation THEN
    -- Lost the race against a concurrent flush of the same queued play, or
    -- against a concurrent import of the same BGA table. The winner's row is
    -- the canonical one; hand its id back on the same duplicate envelope the
    -- pre-checks use.
    --
    -- EVERY key, not just client_key: there are
    -- three unique indexes a play can violate now, and resolving on the wrong
    -- one returns id: null — a wrong answer that raises nothing and looks like
    -- success. The BGG arm also covers the pending-imports worker still
    -- draining legacy kind='play' rows, which writes a bgg_play_id and no
    -- client_key, so no other arm could resolve that race.
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user
       AND ((v_client_key  IS NOT NULL AND p.client_key   = v_client_key)
         OR (v_bga_table   IS NOT NULL AND p.bga_table_id = v_bga_table)
         OR (v_bgg_play_id IS NOT NULL AND p.bgg_play_id  = v_bgg_play_id));
    RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
  END;

  INSERT INTO boardgamebuddy_play_players (
    play_id, player_user_id, pending_user_id, player_display_name, is_winner,
    score, round_scores, team
  )
  SELECT
    v_play.id,
    -- The logger's own seat, and a seat accepted in the lobby, count at once.
    -- Every other account is invited: the seat shows on the play, and counts
    -- for that person only once they accept (bgb_accept_play_invites).
    CASE WHEN pl.user_id = p_user OR pl.user_id = ANY(v_accepted)
         THEN pl.user_id END,
    CASE WHEN pl.user_id <> p_user AND NOT (pl.user_id = ANY(v_accepted))
         THEN pl.user_id END,
    -- An invited seat always carries a name, so a decline can leave it as a
    -- guest without tripping bgb_play_players_identity_chk.
    COALESCE(
      NULLIF(btrim(pl.name), ''),
      (SELECT pr.display_name FROM boardgamebuddy_profiles pr WHERE pr.id = pl.user_id),
      CASE WHEN pl.user_id IS NULL THEN pl.name ELSE 'Player' END
    ),
    COALESCE(pl.is_winner, false),
    pl.score,
    pl.round_scores,
    -- '' is the COMMON case, not an edge one: the client seeds every seat with
    -- team:"" and writes "" back when a tag is cleared. Stored as NULL, or
    -- every untagged seat in the app would share one anonymous side.
    NULLIF(btrim(pl.team), '')
  FROM jsonb_to_recordset(v_roster)
         AS pl(name TEXT, is_winner BOOLEAN, score NUMERIC,
               user_id UUID, round_scores JSONB, team TEXT);

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

  -- Response blocks are built from the NORMALIZED roster (plus the profile/game
  -- joins they need), not by reading the rows back — the values are identical
  -- and WITH ORDINALITY keeps the player list in the order the host entered it,
  -- which a RETURNING or a re-SELECT wouldn't guarantee.
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'user_id',      pl.user_id,
             'name',         COALESCE(prof.display_name, pl.name, 'Unknown'),
             'avatar',       prof.avatar,
             'is_winner',    COALESCE(pl.is_winner, false),
             'score',        pl.score,
             'round_scores', pl.round_scores,
             -- Echoed from the same NULLIF the INSERT used, for the reason
             -- country_code is echoed from its normalized local below: the
             -- client has to read back the value that actually landed.
             'team',         NULLIF(btrim(pl.team), ''),
             'pending',      COALESCE(pl.user_id <> p_user
                                      AND NOT (pl.user_id = ANY(v_accepted)), false)
           ) ORDER BY pl.ord
         ), '[]'::JSONB)
    INTO v_players
    FROM ROWS FROM (
           jsonb_to_recordset(v_roster)
             AS (name TEXT, is_winner BOOLEAN, score NUMERIC,
                 user_id UUID, round_scores JSONB, team TEXT)
         ) WITH ORDINALITY AS pl(name, is_winner, score, user_id, round_scores,
                                 team, ord)
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

  -- country_code is echoed from the NORMALIZED local, not from the payload:
  -- the client has to see the value that actually landed, or a "gb" it sent
  -- would read back as "gb" while the row holds "GB". scoring_template is
  -- echoed from its local for the same reason (an absent key vs. an explicit
  -- null must read back identically).
  RETURN jsonb_build_object(
    'id',               v_play.id,
    'game_id',          v_game.id,
    'game_name',        v_game.name,
    'game_thumbnail',   v_game.thumbnail_url,
    'played_at',        (p_payload->>'played_at')::DATE,
    'notes',            p_payload->>'notes',
    'players',          v_players,
    'photo_url',        p_payload->>'photo_url',
    'expansions',       v_expansions,
    'created_at',       v_play.created_at,
    'play_mode',        v_mode,
    'country_code',     v_country,
    'scoring_template', v_template,
    'group_count',      1,
    'logged_by_id',     p_user,
    'logged_by_name',   COALESCE(v_logged_name, ''),
    'is_own',           true
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_log_play(p_user uuid, p_payload jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_log_play(p_user uuid, p_payload jsonb) TO boardgamebuddy_role;

-- ── 3. Live sessions: a seat can be accepted while the game is on ─────────

CREATE OR REPLACE FUNCTION public.bgb_finalize_session(p_host uuid, p_code text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session RECORD;
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

  v_play := bgb_log_play(
    p_host,
    p_payload || jsonb_build_object(
      'accepted_user_ids',
      (SELECT COALESCE(jsonb_agg(sp.user_id), '[]'::JSONB)
         FROM boardgamebuddy_play_session_participants sp
        WHERE sp.session_id = v_session.id
          AND sp.user_id IS NOT NULL
          AND sp.accepted_at IS NOT NULL)
    )
  );

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
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_finalize_session(p_host uuid, p_code text, p_payload jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_finalize_session(p_host uuid, p_code text, p_payload jsonb) TO boardgamebuddy_role;

CREATE OR REPLACE FUNCTION public.bgb_join_session(p_code text, p_user uuid DEFAULT NULL::uuid, p_user_display_name text DEFAULT NULL::text, p_guest_display_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        (session_id, user_id, display_name, accepted_at)
      SELECT v_id, p_user, COALESCE(p_user_display_name, 'Player'), now()
      WHERE NOT EXISTS (
        SELECT 1 FROM boardgamebuddy_play_session_participants
        WHERE session_id = v_id AND user_id = p_user
      );
      -- Joining a lobby the host already seated you in is saying yes to it.
      UPDATE boardgamebuddy_play_session_participants
         SET accepted_at = now()
       WHERE session_id = v_id AND user_id = p_user AND accepted_at IS NULL;
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
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_join_session(p_code text, p_user uuid, p_user_display_name text, p_guest_display_name text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_join_session(p_code text, p_user uuid, p_user_display_name text, p_guest_display_name text) TO boardgamebuddy_role;

CREATE OR REPLACE FUNCTION public.bgb_session_bundle(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
           'finalized_play_id', s.finalized_play_id,
           'scoring_template', s.scoring_template,
           'play_mode', s.play_mode
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
           'avatar', pr.avatar,
           'team', pp.team,
           'accepted', pp.accepted_at IS NOT NULL
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
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_session_bundle(p_session_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_session_bundle(p_session_id uuid) TO boardgamebuddy_role;

CREATE OR REPLACE FUNCTION public.bgb_answer_session_seat(p_code text, p_user uuid, p_accept boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
BEGIN
  SELECT s.id INTO v_id
    FROM boardgamebuddy_play_sessions s
   WHERE s.code = upper(p_code)
     AND s.status = 'open';

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM boardgamebuddy_play_session_participants
     WHERE session_id = v_id AND user_id = p_user
  ) THEN
    RETURN jsonb_build_object('error', 'not_seated');
  END IF;

  IF p_accept THEN
    UPDATE boardgamebuddy_play_session_participants
       SET accepted_at = COALESCE(accepted_at, now())
     WHERE session_id = v_id AND user_id = p_user;
  ELSE
    -- "Not me": the seat stays at the table under the same name, as a guest.
    BEGIN
      UPDATE boardgamebuddy_play_session_participants
         SET user_id = NULL, accepted_at = NULL
       WHERE session_id = v_id AND user_id = p_user;
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('error', 'guest_name_taken');
    END;
  END IF;

  RETURN bgb_session_bundle(v_id);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_answer_session_seat(p_code text, p_user uuid, p_accept boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_answer_session_seat(p_code text, p_user uuid, p_accept boolean) TO boardgamebuddy_role;

-- ── 4. Rosters show an invited seat as the account it is ──────────────────

CREATE OR REPLACE FUNCTION public.bgb_feed_plays(viewer uuid, before_played_at date DEFAULT NULL::date, before_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, lim integer DEFAULT 20)
 RETURNS TABLE(play_id uuid, play_user_id uuid, play_user_name text, play_user_avatar jsonb, game_id uuid, game_name text, game_image_url text, game_thumbnail_url text, played_at date, created_at timestamp with time zone, notes text, photo_url text, play_mode text, winner_display_name text, participant_count integer, participants jsonb, group_count integer, import_group_id uuid, players jsonb, expansions jsonb, country_code text, reaction_count integer, viewer_reacted boolean, reactors jsonb, import_batch_id uuid, scoring_template jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Dynamic SQL for one reason: `lim` is interpolated as a literal instead of
  -- being bound as a parameter. With BOTH `viewer` and `lim` opaque, the
  -- planner has no idea the `page` CTE yields ~20 rows, so it plans the roster
  -- lookup as if `page` were huge and reads the whole play_players table —
  -- measured 555 ms versus 12 ms with the limit visible. Interpolating just
  -- the limit restores the estimate; viewer/cursor stay bound via USING, which
  -- is enough for a good plan. Injection-safe because `lim` is typed INT, so
  -- it cannot carry SQL, and it's clamped to a sane range below.
  --
  -- EXECUTE also sidesteps plpgsql's substitution of RETURNS TABLE column
  -- names (play_id, played_at, notes, participants, players, …) into the query
  -- body: the string is handed to the SQL engine untouched. The shadowed
  -- names include `players`, `expansions`, `reactors`, `import_batch_id` and
  -- `scoring_template` —
  -- all of which `page` selects by name from the plays table, so the shadowing
  -- would be a live bug rather than a theoretical one. One more reason this
  -- stays EXECUTE.
  RETURN QUERY EXECUTE format($q$
  WITH visible AS (
    SELECT $1::uuid AS uid
    UNION
    SELECT CASE WHEN be.user_a = $1::uuid THEN be.user_b ELSE be.user_a END AS uid
    FROM public.boardgamebuddy_buddy_edges be
    WHERE be.status = 'accepted'
      AND $1::uuid IN (be.user_a, be.user_b)
  ),
  -- Plays the viewer themselves attended — used to widen the roster
  -- filter so non-buddy participants are exposed on cards for plays
  -- the viewer was at.
  viewer_was_at AS (
    SELECT DISTINCT pp.play_id
    FROM public.boardgamebuddy_play_players pp
    WHERE pp.player_user_id = $1::uuid OR pp.pending_user_id = $1::uuid
  ),
  -- Plays where at least one visible user (viewer or any accepted buddy)
  -- appears in play_players. This is the "main" visibility branch.
  attended AS (
    SELECT DISTINCT pp.play_id
    FROM public.boardgamebuddy_play_players pp
    WHERE pp.player_user_id IN (SELECT uid FROM visible)
  ),
  -- Final candidate set: legacy "logger ∈ visible" UNION attended. The
  -- legacy branch is technically subsumed by `attended` when the logger
  -- is always tagged as a participant (the standard log_play flow does
  -- this), but we keep it as a belt-and-suspenders cover for any
  -- historical rows where it isn't.
  visible_plays AS (
    SELECT p.id
    FROM public.boardgamebuddy_plays p
    JOIN visible v ON v.uid = p.user_id
    UNION
    SELECT play_id FROM attended
    UNION
    SELECT play_id FROM viewer_was_at
  ),
  -- Resolve the page BEFORE touching play_players. This is the whole point of
  -- the rewrite: the roster lookup below runs per page row, so it reads at
  -- most `lim` plays' worth of play_players instead of the entire table.
  page AS (
    SELECT p.id, p.user_id, p.game_id, p.played_at, p.created_at,
           p.notes, p.photo_url, p.play_mode, p.import_group_id,
           -- Free: `page` already reads this row, and the column
           -- is a plain uuid on it.
           p.import_batch_id,
           -- Free for the same reason — a jsonb column on the row
           -- `page` already selects from.
           p.scoring_template,
           p.country_code,
           -- How many plays this row stands for. 1 for everything the app has
           -- ever logged live; the run's size for an imported group.
           CASE WHEN p.import_group_id IS NULL THEN 1
                ELSE (SELECT COUNT(*)::INT
                        FROM public.boardgamebuddy_plays q
                       WHERE q.import_group_id = p.import_group_id)
           END AS group_count
    FROM public.boardgamebuddy_plays p
    JOIN visible_plays vp ON vp.id = p.id
    WHERE (
      $2::date IS NULL
      OR $3::timestamptz IS NULL
      OR (p.played_at, p.created_at) < ($2::date, $3::timestamptz)
    )
      -- One representative row per imported run: the lowest id
      -- in the run, so the choice is stable and deleting the representative
      -- just promotes the next row rather than losing the group.
      --
      -- ORDER BY ... LIMIT 1 rather than MIN(): Postgres has no MIN aggregate
      -- for uuid, though the type orders fine in an index.
      --
      -- This sits INSIDE `page`, before the LIMIT, on purpose: that is what
      -- makes a page 20 CARDS rather than 20 rows of which 19 are the same
      -- run. A 106-play import used to consume five pages of everyone's feed
      -- before anything else could appear.
      --
      -- Deliberately a correlated lookup on the partial index rather than a
      -- window function over the viewer's visible plays: the window is the
      -- slower shape (105 ms vs 5 ms on a 30k-play fixture),
      -- and it would make every feed call pay for grouping that almost no row
      -- needs. Both subqueries are short-circuited by the NULL check for every
      -- play that was not imported, which is all of them but a handful.
      AND (
        p.import_group_id IS NULL
        OR p.id = (SELECT q.id
                     FROM public.boardgamebuddy_plays q
                    WHERE q.import_group_id = p.import_group_id
                    ORDER BY q.id
                    LIMIT 1)
      )
    ORDER BY p.played_at DESC, p.created_at DESC, p.id
    LIMIT %s
  )
  -- Roster + winners, resolved per page row via LATERAL rather than as
  -- page-filtered CTEs. This matters: `lim` is a function parameter, so the
  -- planner has no idea `page` yields ~20 rows. Given `pp.play_id IN (SELECT
  -- id FROM page)` it assumes `page` is large and picks a hash semi-join over
  -- the whole play_players table — twice — which measured ~8x SLOWER than the
  -- original. A LATERAL keyed on p.id is an index lookup on
  -- idx_bgb_play_players_play per page row, so the work stays bounded by `lim`
  -- no matter what the planner estimates.
  SELECT
    p.id,
    p.user_id,
    prof.display_name,
    prof.avatar,
    g.id,
    g.name,
    g.image_url,
    g.thumbnail_url,
    p.played_at,
    p.created_at,
    p.notes,
    p.photo_url,
    p.play_mode,
    roster.winner_display_name,
    COALESCE(roster.participant_count, 0),
    COALESCE(roster.participants, '[]'::jsonb),
    p.group_count,
    p.import_group_id,
    COALESCE(roster.players, '[]'::jsonb),
    COALESCE(exp.expansions, '[]'::jsonb),
    p.country_code,
    COALESCE(rx.reaction_count, 0),
    COALESCE(rx.viewer_reacted, false),
    COALESCE(rx.reactors, '[]'::jsonb),
    p.import_batch_id,
    p.scoring_template
  FROM page p
  JOIN public.boardgamebuddy_profiles prof ON prof.id = p.user_id
  JOIN public.boardgamebuddy_games g       ON g.id = p.game_id
  LEFT JOIN LATERAL (
    SELECT
      string_agg(
        COALESCE(pprof.display_name, pp.player_display_name), ', '
        ORDER BY COALESCE(pprof.display_name, pp.player_display_name)
      ) FILTER (WHERE pp.is_winner = true) AS winner_display_name,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'user_id',      COALESCE(pp.player_user_id, pp.pending_user_id)::text,
            'display_name', COALESCE(pprof.display_name, pp.player_display_name)
          )
          ORDER BY COALESCE(pprof.display_name, pp.player_display_name)
        ) FILTER (
          WHERE COALESCE(pp.player_user_id, pp.pending_user_id) IS NOT NULL
            AND (
              COALESCE(pp.player_user_id, pp.pending_user_id) IN (SELECT uid FROM visible)
              OR p.id IN (SELECT play_id FROM viewer_was_at)
            )
        ),
        '[]'::jsonb
      ) AS participants,
      -- The scorecard. UNFILTERED, unlike `participants`: this
      -- is the roster the back of the card and the detail popup draw, and both
      -- have always shown every seat — ghosts included — because that is what
      -- GET /plays/{id} returns them today.
      --
      -- Ordered by is_winner then score, both DESC NULLS LAST, so the array
      -- arrives in the order the scoreboard wants and the client's sort is a
      -- no-op on well-formed data rather than the thing that makes it correct.
      -- Field names mirror PlayPlayerResponse exactly (name, not display_name)
      -- so the FE adapter is a pass-through.
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'user_id',      COALESCE(pp.player_user_id, pp.pending_user_id)::text,
            'name',         COALESCE(pprof.display_name, pp.player_display_name),
            'avatar',       pprof.avatar,
            'is_winner',    COALESCE(pp.is_winner, false),
            'score',        pp.score,
            'round_scores', pp.round_scores,
            -- Required, not optional: Play.fromFeedCard passes
            -- this array straight into the detail popup's seed and the popup
            -- paints from it in the same frame as the tap. Without it a play
            -- opened from the feed would show an ungrouped roster that then
            -- reshuffled into sides when GET /plays/{id} landed.
            'team',         pp.team,
            'pending',      pp.pending_user_id IS NOT NULL
          )
          ORDER BY COALESCE(pp.is_winner, false) DESC, pp.score DESC NULLS LAST
        ),
        '[]'::jsonb
      ) AS players,
      COUNT(*)::INT AS participant_count
    FROM public.boardgamebuddy_play_players pp
    LEFT JOIN public.boardgamebuddy_profiles pprof
           ON pprof.id = COALESCE(pp.player_user_id, pp.pending_user_id)
    WHERE pp.play_id = p.id
  ) roster ON true
  -- Expansions. Same LATERAL shape as the roster so it
  -- inherits the same bounded-by-`lim` property: an index lookup per page row
  -- on the (play_id, expansion_game_id) primary key. Most plays have no
  -- expansions and the aggregate collapses to NULL -> '[]'.
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
             jsonb_build_object(
               'expansion_game_id', pe.expansion_game_id::text,
               'name',              eg.name,
               'color',             eg.theme_color
             )
             ORDER BY eg.name
           ) AS expansions
    FROM public.boardgamebuddy_play_expansions pe
    JOIN public.boardgamebuddy_games eg ON eg.id = pe.expansion_game_id
    WHERE pe.play_id = p.id
  ) exp ON true
  -- Reactions. Same bounded-by-`lim` LATERAL shape as the two
  -- above: an index lookup per page row on the (play_id, user_id) primary key.
  --
  -- `reactors` is capped at 8 and newest-first because the footer only ever
  -- draws three avatars; the exact total rides in `reaction_count`, so the cap
  -- never makes the number wrong. The viewer's own row is answered by an EXISTS
  -- rather than by scanning the capped array, which would go wrong the moment a
  -- ninth person reacted.
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::int AS reaction_count,
      bool_or(r.user_id = $1::uuid) AS viewer_reacted,
      COALESCE(
        (SELECT jsonb_agg(x)
           FROM (SELECT jsonb_build_object(
                          'user_id',      r2.user_id::text,
                          'display_name', rprof.display_name,
                          'avatar',       rprof.avatar
                        ) AS x
                   FROM public.boardgamebuddy_play_reactions r2
                   LEFT JOIN public.boardgamebuddy_profiles rprof ON rprof.id = r2.user_id
                  WHERE r2.play_id = p.id
                  ORDER BY r2.created_at DESC
                  LIMIT 8) capped),
        '[]'::jsonb
      ) AS reactors
    FROM public.boardgamebuddy_play_reactions r
    WHERE r.play_id = p.id
  ) rx ON true
  ORDER BY p.played_at DESC, p.created_at DESC, p.id
  -- The clamp bounds what a caller can interpolate. The ceiling must stay
  -- ABOVE every caller's own cap, because feed_service derives next_cursor
  -- from `len(rows) == limit` — if this silently returned fewer rows than
  -- asked for, pagination would stop early. Today /feed is capped at 50
  -- (feed_routes.py) and bootstrap asks for 20, so 100 has margin.
  $q$, LEAST(GREATEST(COALESCE(lim, 20), 1), 100))
  USING viewer, before_played_at, before_created_at;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_feed_plays(viewer uuid, before_played_at date, before_created_at timestamp with time zone, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_feed_plays(viewer uuid, before_played_at date, before_created_at timestamp with time zone, lim integer) TO boardgamebuddy_role;

CREATE OR REPLACE FUNCTION public.bgb_plays_page(p_target uuid, p_page integer DEFAULT 1, p_per_page integer DEFAULT 20, p_game uuid DEFAULT NULL::uuid, p_buddy uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_own_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_search TEXT := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_total BIGINT;
  v_plays JSONB;
BEGIN
  WITH filtered AS (
    SELECT p.*
    FROM boardgamebuddy_plays p
    WHERE (
        p.user_id = p_target
        OR (NOT p_own_only AND EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = p_target))
      )
      AND (p_own_only IS FALSE OR p.user_id = p_target)
      AND (p_game IS NULL OR p.game_id = p_game)
      AND (p_buddy IS NULL OR EXISTS (
            SELECT 1 FROM boardgamebuddy_play_players pp
            WHERE pp.play_id = p.id AND pp.player_user_id = p_buddy))
      AND (v_search IS NULL
           OR p.game_name ILIKE '%' || v_search || '%'
           OR EXISTS (
                SELECT 1 FROM boardgamebuddy_play_players pp
                WHERE pp.play_id = p.id
                  AND pp.player_display_name ILIKE '%' || v_search || '%'))
      -- One row per imported run, same representative rule as
      -- bgb_feed_plays. It sits in `filtered` rather than in `page` so
      -- `counted` totals CARDS — a pager reading 106 over a six-row list would
      -- send the reader to five empty pages.
      AND (
        p.import_group_id IS NULL
        OR p.id = (SELECT q.id
                     FROM boardgamebuddy_plays q
                    WHERE q.import_group_id = p.import_group_id
                    ORDER BY q.id
                    LIMIT 1)
      )
  ),
  counted AS (SELECT count(*) AS total FROM filtered),
  page AS (
    SELECT f.*
    FROM filtered f
    ORDER BY f.played_at DESC, f.created_at DESC
    LIMIT p_per_page OFFSET GREATEST(p_page - 1, 0) * p_per_page
  )
  SELECT
    (SELECT total FROM counted),
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', pg.id,
      'game_id', pg.game_id,
      'game_name', pg.game_name,
      'game_thumbnail', pg.game_thumbnail_url,
      'played_at', pg.played_at,
      'notes', pg.notes,
      'photo_url', pg.photo_url,
      'created_at', pg.created_at,
      'play_mode', COALESCE(pg.play_mode, 'competitive'),
      'country_code', pg.country_code,
      'scoring_template', pg.scoring_template,
      'group_count', CASE WHEN pg.import_group_id IS NULL THEN 1
                          ELSE (SELECT COUNT(*)::INT
                                  FROM boardgamebuddy_plays q
                                 WHERE q.import_group_id = pg.import_group_id)
                     END,
      'logged_by_id', pg.user_id,
      'logged_by_name', COALESCE(lp.display_name, 'Unknown'),
      'is_own', (pg.user_id = p_target),
      'players', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'user_id', COALESCE(pp.player_user_id, pp.pending_user_id),
          'pending', pp.pending_user_id IS NOT NULL,
          'name', COALESCE(ppr.display_name, pp.player_display_name, 'Unknown'),
          'avatar', ppr.avatar,
          'is_winner', COALESCE(pp.is_winner, false),
          'score', pp.score,
          'round_scores', pp.round_scores,
          'team', pp.team
        ))
        FROM boardgamebuddy_play_players pp
        LEFT JOIN boardgamebuddy_profiles ppr ON ppr.id = COALESCE(pp.player_user_id, pp.pending_user_id)
        WHERE pp.play_id = pg.id
      ), '[]'::jsonb),
      'expansions', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'expansion_game_id', pe.expansion_game_id,
          'name', COALESCE(eg.name, 'Unknown'),
          'color', eg.expansion_color
        ))
        FROM boardgamebuddy_play_expansions pe
        LEFT JOIN boardgamebuddy_games eg ON eg.id = pe.expansion_game_id
        WHERE pe.play_id = pg.id
      ), '[]'::jsonb)
    ) ORDER BY pg.played_at DESC, pg.created_at DESC), '[]'::jsonb)
    INTO v_total, v_plays
  FROM page pg
  LEFT JOIN boardgamebuddy_profiles lp ON lp.id = pg.user_id;

  RETURN jsonb_build_object('plays', v_plays, 'total', COALESCE(v_total, 0));
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_plays_page(p_target uuid, p_page integer, p_per_page integer, p_game uuid, p_buddy uuid, p_search text, p_own_only boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_plays_page(p_target uuid, p_page integer, p_per_page integer, p_game uuid, p_buddy uuid, p_search text, p_own_only boolean) TO boardgamebuddy_role;

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
              'user_id', COALESCE(pp.player_user_id, pp.pending_user_id),
              'pending', pp.pending_user_id IS NOT NULL,
              'name', COALESCE(pp_pr.display_name, pp.player_display_name, 'Unknown'),
              'is_winner', COALESCE(pp.is_winner, false),
              'score', pp.score
            ) ORDER BY pp.id)
            FROM boardgamebuddy_play_players pp
            LEFT JOIN boardgamebuddy_profiles pp_pr ON pp_pr.id = COALESCE(pp.player_user_id, pp.pending_user_id)
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

  -- ── Viewer's record with this game ──────────────────────────────────────
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
REVOKE EXECUTE ON FUNCTION public.bgb_game_detail_bundle(game_uuid uuid, viewer uuid, plays_limit integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_game_detail_bundle(game_uuid uuid, viewer uuid, plays_limit integer) TO boardgamebuddy_role;

CREATE OR REPLACE FUNCTION public.bgb_profile_bundle(viewer uuid, target uuid, col_per_page integer DEFAULT 12, plays_per_page integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_stats JSONB;
  v_owned_page JSONB;
  v_owned_total BIGINT;
  v_owned_parted_total BIGINT;
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
  v_ghost_claims_incoming JSONB;
  v_together JSONB;
  v_top_games JSONB;
  v_is_self BOOLEAN := (viewer = target);
  v_is_buddy BOOLEAN := false;
BEGIN
  -- Edges are canonical (user_a < user_b), so match the pair either way round.
  IF NOT v_is_self THEN
    SELECT EXISTS (
      SELECT 1 FROM boardgamebuddy_buddy_edges be
      WHERE be.status = 'accepted'
        AND ((be.user_a = viewer AND be.user_b = target)
          OR (be.user_a = target AND be.user_b = viewer))
    ) INTO v_is_buddy;
  END IF;

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

  -- owned_total is games you actually OWN, so it keeps the bare 'owned'
  -- predicate: a prev_owned row (sold, gifted, donated) is on the Owned
  -- shelf for display only and is counted separately, in owned_parted_total.
  -- owned_page below returns BOTH, because it is the Collection spoke's
  -- first-frame seed and has to hold the same rows bgb_collection_shelf will.
  SELECT
    COUNT(*) FILTER (WHERE c.status = 'owned'),
    COUNT(*) FILTER (WHERE c.status = 'prev_owned')
    INTO v_owned_total, v_owned_parted_total
    FROM boardgamebuddy_collections c
    WHERE c.user_id = target AND c.status IN ('owned', 'prev_owned')
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
            'image_url', gi.image_url,
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
      LEFT JOIN boardgamebuddy_games gi ON gi.id = c.game_id
      -- image_url only — see the header. Every other game field stays denorm.
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
      WHERE c.user_id = target AND c.status IN ('owned', 'prev_owned')
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
            'image_url', gi.image_url,
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
      LEFT JOIN boardgamebuddy_games gi ON gi.id = c.game_id
      -- image_url only — see the header. Every other game field stays denorm.
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
    -- EXISTS, not a LEFT JOIN onto play_players: the join fans one play out
    -- to one row per participant, so COUNT(*) over it multiplied every play
    -- the target logged by its player count. Matches bgb_play_stats.
    SELECT
      mp.game_id,
      MAX(mp.played_at) AS last_played_at,
      COUNT(*)::INT AS play_count
    FROM (
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
      UNION
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE pp.player_user_id = target
    ) mp
    GROUP BY mp.game_id
    UNION ALL
    -- Played but never logged here (status 'played').
    -- A game with a play is already above, so only the rest join.
    SELECT c.game_id, NULL, 0
    FROM boardgamebuddy_collections c
    WHERE c.user_id = target AND c.status = 'played'
      AND NOT EXISTS (
            SELECT 1 FROM boardgamebuddy_plays p2
            WHERE p2.game_id = c.game_id
              AND (p2.user_id = target OR EXISTS (
                    SELECT 1 FROM boardgamebuddy_play_players pp2
                    WHERE pp2.play_id = p2.id AND pp2.player_user_id = target))
          )
  ),
  played_not_owned AS (
    SELECT pg.*
    FROM played_games pg
    WHERE NOT EXISTS (
      SELECT 1 FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.game_id = pg.game_id AND c.status <> 'played'
    )
  )
  SELECT COUNT(*) INTO v_played_total
    FROM played_not_owned pno
    JOIN boardgamebuddy_games g ON g.id = pno.game_id
    WHERE g.is_expansion = false;

  WITH played_games AS (
    -- EXISTS, not a LEFT JOIN onto play_players: the join fans one play out
    -- to one row per participant, so COUNT(*) over it multiplied every play
    -- the target logged by its player count. Matches bgb_play_stats.
    SELECT
      mp.game_id,
      MAX(mp.played_at) AS last_played_at,
      COUNT(*)::INT AS play_count
    FROM (
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
      UNION
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE pp.player_user_id = target
    ) mp
    GROUP BY mp.game_id
    UNION ALL
    -- Played but never logged here (status 'played').
    -- A game with a play is already above, so only the rest join.
    SELECT c.game_id, NULL, 0
    FROM boardgamebuddy_collections c
    WHERE c.user_id = target AND c.status = 'played'
      AND NOT EXISTS (
            SELECT 1 FROM boardgamebuddy_plays p2
            WHERE p2.game_id = c.game_id
              AND (p2.user_id = target OR EXISTS (
                    SELECT 1 FROM boardgamebuddy_play_players pp2
                    WHERE pp2.play_id = p2.id AND pp2.player_user_id = target))
          )
  ),
  played_not_owned AS (
    SELECT pg.*
    FROM played_games pg
    WHERE NOT EXISTS (
      SELECT 1 FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.game_id = pg.game_id AND c.status <> 'played'
    )
  )
  SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY sort_order DESC NULLS LAST), '[]'::jsonb)
    INTO v_played_page
    FROM (
      SELECT
        pno.last_played_at AS sort_order,
        jsonb_build_object(
          'id', 'derived-' || pno.game_id::text,
          'game_id', pno.game_id,
          'status', 'played',
          'added_at', COALESCE(pno.last_played_at::TEXT || 'T00:00:00+00:00', (SELECT to_jsonb(c.added_at) #>> '{}' FROM boardgamebuddy_collections c WHERE c.user_id = target AND c.game_id = pno.game_id)),
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

  -- The total is a general stat and stays visible to everyone; only the log
  -- below it is buddies-only.
  SELECT COUNT(*) INTO v_recent_plays_total
    FROM (
      SELECT p.id
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
      UNION
      SELECT p.id
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE pp.player_user_id = target
    ) mp;

  IF v_is_self OR v_is_buddy THEN
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
                'user_id', COALESCE(pp.player_user_id, pp.pending_user_id),
                'pending', pp.pending_user_id IS NOT NULL,
                'name', COALESCE(pp_pr.display_name, pp.player_display_name, 'Unknown'),
                'is_winner', COALESCE(pp.is_winner, false),
                'score', pp.score,
                'avatar', pp_pr.avatar
              ) ORDER BY pp.id)
              FROM boardgamebuddy_play_players pp
              LEFT JOIN boardgamebuddy_profiles pp_pr ON pp_pr.id = COALESCE(pp.player_user_id, pp.pending_user_id)
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
        FROM (
          SELECT p.id, p.played_at, p.created_at
          FROM boardgamebuddy_plays p
          WHERE p.user_id = target
          UNION
          SELECT p.id, p.played_at, p.created_at
          FROM boardgamebuddy_plays p
          JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
          WHERE pp.player_user_id = target
          ORDER BY played_at DESC, created_at DESC
          LIMIT plays_per_page
        ) mp
        JOIN boardgamebuddy_plays p ON p.id = mp.id
        LEFT JOIN boardgamebuddy_profiles pr ON pr.id = p.user_id
        ORDER BY p.played_at DESC, p.created_at DESC
      ) r;
  ELSE
    -- NULL, not '[]': an empty array is the honest answer for "this person has
    -- never logged a play", and the screen says exactly that under it. A
    -- stranger must not be told that.
    v_recent_plays := NULL;
  END IF;

  -- No status filter, so prev_owned reaches the map unaided — which is
  -- what the status tag and its picker sheet read to know which row to check.
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

  -- Owned-only on purpose: an expansion you sold is no longer clutter on
  -- the base game's shelf. Mirrors bgb_collection_status_map's block exactly.
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

  -- ── Buddy-only blocks ──────────────────────────────────────────────────
  IF v_is_buddy THEN
    -- Shared record. Both sides must have a player row on the play — see the
    -- header on why the logger alone does not count and why co-op is out.
    -- GROUP BY p.id collapses the two joins back to one row per play, so a
    -- duplicated participant row cannot inflate the count.
    WITH shared AS (
      SELECT
        p.id AS play_id,
        p.played_at,
        COALESCE(BOOL_OR(vp.is_winner), false) AS you_won,
        COALESCE(BOOL_OR(tp.is_winner), false) AS they_won
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players vp
        ON vp.play_id = p.id AND vp.player_user_id = viewer
      JOIN boardgamebuddy_play_players tp
        ON tp.play_id = p.id AND tp.player_user_id = target
      WHERE COALESCE(p.play_mode, 'competitive') <> 'coop'
        -- Only plays that recorded a result. shared_plays is the denominator
        -- your_wins and their_wins are read against, so a play nobody won and
        -- nobody scored would show up as a game you both somehow lost.
        AND EXISTS (
          SELECT 1 FROM boardgamebuddy_play_players d
           WHERE d.play_id = p.id AND (d.is_winner OR d.score IS NOT NULL)
        )
      GROUP BY p.id, p.played_at
    )
    SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE jsonb_build_object(
      'shared_plays', COUNT(*)::INT,
      'your_wins', COUNT(*) FILTER (WHERE you_won)::INT,
      'their_wins', COUNT(*) FILTER (WHERE they_won)::INT,
      'last_played_at', MAX(played_at)
    ) END INTO v_together FROM shared;

    -- Target's three most-played games, over the same "logged it or sat at the
    -- table" set every other block here uses. Name and thumbnail come off the
    -- denormalized play columns, with boardgamebuddy_games filling in
    -- full-size art the plays table never carried.
    SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY plays DESC, name), '[]'::jsonb)
      INTO v_top_games
      FROM (
        SELECT
          tg.plays,
          tg.name,
          jsonb_build_object(
            'game_id', tg.game_id,
            'name', tg.name,
            'thumbnail_url', COALESCE(g.thumbnail_url, tg.thumbnail_url),
            'image_url', g.image_url,
            'play_count', tg.plays,
            'last_played_at', tg.last_played_at
          ) AS row_jsonb
        FROM (
          SELECT
            mp.game_id,
            MAX(mp.game_name) AS name,
            MAX(mp.game_thumbnail_url) AS thumbnail_url,
            MAX(mp.played_at) AS last_played_at,
            COUNT(*)::INT AS plays
          FROM (
            SELECT p.id, p.game_id, p.game_name, p.game_thumbnail_url, p.played_at
            FROM boardgamebuddy_plays p
            WHERE p.user_id = target
            UNION
            SELECT p.id, p.game_id, p.game_name, p.game_thumbnail_url, p.played_at
            FROM boardgamebuddy_plays p
            JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
            WHERE pp.player_user_id = target
          ) mp
          GROUP BY mp.game_id
          ORDER BY plays DESC, name
          LIMIT 3
        ) tg
        LEFT JOIN boardgamebuddy_games g ON g.id = tg.game_id
      ) t;
  ELSE
    v_together := NULL;
    v_top_games := NULL;
  END IF;

  IF v_is_self THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', be.id,
      'other_user_id', CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END,
      'other_display_name', pr.display_name,
      'other_avatar', pr.avatar,
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
      'other_avatar', pr.avatar,
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
      'other_avatar', pr.avatar,
      'created_at', be.created_at
    ) ORDER BY be.created_at DESC), '[]'::jsonb)
      INTO v_buddy_outgoing
      FROM boardgamebuddy_buddy_edges be
      JOIN boardgamebuddy_profiles pr
        ON pr.id = (CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END)
      WHERE (be.user_a = viewer OR be.user_b = viewer)
        AND be.status = 'pending'
        AND be.requested_by = viewer;

    -- Ghost claims waiting on the viewer. Same shape and same
    -- reason as buddy_requests_incoming: the Profile tab's dot and the Buddies
    -- card's count both have to be right on FIRST PAINT, and /bootstrap
    -- already carries this bundle. A separate fetch would put a round trip on
    -- the app's slowest path to publish one integer.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', gc.id,
      'direction', 'incoming',
      'other_user_id', pr.id,
      'other_display_name', pr.display_name,
      'other_avatar', pr.avatar,
      'ghost_display_name', gc.ghost_display_name,
      'created_at', gc.created_at
    ) ORDER BY gc.created_at DESC), '[]'::jsonb)
      INTO v_ghost_claims_incoming
      FROM boardgamebuddy_ghost_claims gc
      JOIN boardgamebuddy_profiles pr ON pr.id = gc.claimant_id
     WHERE gc.owner_id = viewer AND gc.status = 'pending';
  ELSE
    v_buddies := NULL;
    v_buddy_incoming := NULL;
    v_buddy_outgoing := NULL;
    v_ghost_claims_incoming := NULL;
  END IF;

  RETURN jsonb_build_object(
    'is_buddy', v_is_buddy,
    'stats', v_stats,
    'owned_page', v_owned_page,
    'owned_total', v_owned_total,
    'owned_parted_total', v_owned_parted_total,
    'wishlist_page', v_wishlist_page,
    'wishlist_total', v_wishlist_total,
    'played_page', v_played_page,
    'played_total', v_played_total,
    'recent_plays', v_recent_plays,
    'recent_plays_total', v_recent_plays_total,
    'together', v_together,
    'top_games', v_top_games,
    'status_map', v_status_map,
    'expansion_counts', v_expansion_counts,
    'buddies', v_buddies,
    'buddy_requests_incoming', v_buddy_incoming,
    'buddy_requests_outgoing', v_buddy_outgoing,
    'ghost_claims_incoming', v_ghost_claims_incoming
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_profile_bundle(viewer uuid, target uuid, col_per_page integer, plays_per_page integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_profile_bundle(viewer uuid, target uuid, col_per_page integer, plays_per_page integer) TO boardgamebuddy_role;

-- ── 5. An invited seat is not a ghost ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bgb_ghost_claim_suggestions(p_viewer uuid, p_limit integer DEFAULT 10, p_threshold real DEFAULT 0.35)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_out JSONB;
BEGIN
  WITH me AS (
    SELECT lower(btrim(display_name)) AS dn, username
      FROM boardgamebuddy_profiles
     WHERE id = p_viewer
  ),
  owners AS (
    SELECT CASE WHEN be.user_a = p_viewer THEN be.user_b ELSE be.user_a END AS owner_id
      FROM boardgamebuddy_buddy_edges be
     WHERE be.status = 'accepted'
       AND p_viewer IN (be.user_a, be.user_b)
  ),
  ghost_rows AS (
    SELECT p.user_id AS owner_id,
           lower(btrim(pp.player_display_name)) AS name_key,
           btrim(pp.player_display_name) AS name_raw,
           p.played_at,
           p.game_name,
           EXISTS (
             SELECT 1 FROM boardgamebuddy_play_players s
              WHERE s.play_id = p.id AND s.player_user_id = p_viewer
           ) AS seats_viewer
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
     WHERE p.user_id IN (SELECT owner_id FROM owners)
       AND pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
       AND btrim(COALESCE(pp.player_display_name, '')) <> ''
  ),
  grouped AS (
    SELECT owner_id,
           name_key,
           mode() WITHIN GROUP (ORDER BY name_raw) AS ghost_display_name,
           COUNT(*)::INT AS play_count,
           MAX(played_at) AS last_played_at,
           (array_agg(game_name ORDER BY played_at DESC))[1] AS last_game_name,
           bool_or(seats_viewer) AS collides
      FROM ghost_rows
     GROUP BY owner_id, name_key
  ),
  scored AS (
    SELECT g.*, m.score, m.is_match
      FROM grouped g, me, LATERAL (
        SELECT GREATEST(
                 extensions.similarity(g.name_key, me.dn),
                 extensions.similarity(g.name_key, me.username)
               ) AS score,
               (
                    extensions.similarity(g.name_key, me.dn) >= p_threshold
                 OR extensions.similarity(g.name_key, me.username) >= p_threshold
                 OR (
                      char_length(g.name_key) >= 3
                      AND position(' ' IN g.name_key) = 0
                      AND (
                           starts_with(me.dn, g.name_key)
                        OR starts_with(me.username, g.name_key)
                        OR g.name_key = split_part(me.dn, ' ', 1)
                      )
                    )
               ) AS is_match
      ) m
     -- A ghost the viewer is already seated beside is almost certainly not
     -- the viewer. Dropped whole, never partially — see bgb_create_ghost_claim.
     WHERE NOT g.collides
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY s_score DESC, s_count DESC, s_last DESC NULLS LAST), '[]'::jsonb)
    INTO v_out
    FROM (
      SELECT jsonb_build_object(
               'owner_user_id',      s.owner_id,
               'owner_display_name', pr.display_name,
               'owner_username',     pr.username,
               'owner_avatar',       pr.avatar,
               'ghost_display_name', s.ghost_display_name,
               'ghost_name_key',     s.name_key,
               'play_count',         s.play_count,
               'last_played_at',     s.last_played_at,
               'last_game_name',     s.last_game_name,
               'match_score',        round(s.score::numeric, 3),
               'claim_status',       c.status,
               'claim_id',           c.id
             ) AS x,
             s.score AS s_score,
             s.play_count AS s_count,
             s.last_played_at AS s_last
        FROM scored s
        JOIN boardgamebuddy_profiles pr ON pr.id = s.owner_id
        LEFT JOIN boardgamebuddy_ghost_claims c
               ON c.owner_id = s.owner_id
              AND c.ghost_name_key = s.name_key
              AND c.claimant_id = p_viewer
       WHERE s.is_match
         -- A PENDING claim is kept, and surfaced with claim_status so the row
         -- shows a disabled "Requested" chip instead of vanishing out from
         -- under the finger that just tapped it. Every other status means
         -- this ghost is settled and must stop appearing.
         AND (c.id IS NULL OR c.status = 'pending')
       ORDER BY s.score DESC, s.play_count DESC, s.last_played_at DESC NULLS LAST
       LIMIT GREATEST(p_limit, 0)
    ) q;

  RETURN COALESCE(v_out, '[]'::jsonb);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_claim_suggestions(p_viewer uuid, p_limit integer, p_threshold real) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claim_suggestions(p_viewer uuid, p_limit integer, p_threshold real) TO boardgamebuddy_role;

CREATE OR REPLACE FUNCTION public.bgb_ghost_claims(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_incoming JSONB;
  v_outgoing JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(x ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_incoming
    FROM (
      SELECT jsonb_build_object(
               'id',                 c.id,
               'direction',          'incoming',
               'other_user_id',      pr.id,
               'other_display_name', pr.display_name,
               'other_username',     pr.username,
               'other_avatar',       pr.avatar,
               'ghost_display_name', c.ghost_display_name,
               'play_count',         COALESCE(st.play_count, 0),
               'last_played_at',     st.last_played_at,
               'created_at',         c.created_at
             ) AS x,
             c.created_at
        FROM boardgamebuddy_ghost_claims c
        JOIN boardgamebuddy_profiles pr ON pr.id = c.claimant_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::INT AS play_count, MAX(p.played_at) AS last_played_at
            FROM boardgamebuddy_plays p
            JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
           WHERE p.user_id = c.owner_id
             AND pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
             AND lower(btrim(COALESCE(pp.player_display_name, ''))) = c.ghost_name_key
        ) st ON TRUE
       WHERE c.owner_id = p_viewer AND c.status = 'pending'
    ) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_outgoing
    FROM (
      SELECT jsonb_build_object(
               'id',                 c.id,
               'direction',          'outgoing',
               'other_user_id',      pr.id,
               'other_display_name', pr.display_name,
               'other_username',     pr.username,
               'other_avatar',       pr.avatar,
               'ghost_display_name', c.ghost_display_name,
               'play_count',         COALESCE(st.play_count, 0),
               'last_played_at',     st.last_played_at,
               'created_at',         c.created_at
             ) AS x,
             c.created_at
        FROM boardgamebuddy_ghost_claims c
        JOIN boardgamebuddy_profiles pr ON pr.id = c.owner_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::INT AS play_count, MAX(p.played_at) AS last_played_at
            FROM boardgamebuddy_plays p
            JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
           WHERE p.user_id = c.owner_id
             AND pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
             AND lower(btrim(COALESCE(pp.player_display_name, ''))) = c.ghost_name_key
        ) st ON TRUE
       WHERE c.claimant_id = p_viewer AND c.status = 'pending'
    ) s;

  RETURN jsonb_build_object('incoming', v_incoming, 'outgoing', v_outgoing);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_claims(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claims(p_viewer uuid) TO boardgamebuddy_role;

CREATE OR REPLACE FUNCTION public.bgb_ghost_summary(p_viewer uuid, p_owner uuid, p_name_key text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH visible AS (
    SELECT p_viewer AS uid
    UNION
    SELECT CASE WHEN be.user_a = p_viewer THEN be.user_b ELSE be.user_a END
      FROM boardgamebuddy_buddy_edges be
     WHERE be.status = 'accepted'
       AND p_viewer IN (be.user_a, be.user_b)
  ),
  g_rows AS (
    SELECT p.played_at,
           p.game_name,
           btrim(pp.player_display_name) AS name_raw,
           EXISTS (
             SELECT 1 FROM boardgamebuddy_play_players s
              WHERE s.play_id = p.id AND s.player_user_id = p_viewer
           ) AS seats_viewer,
           (
             p.user_id IN (SELECT uid FROM visible)
             OR EXISTS (
               SELECT 1 FROM boardgamebuddy_play_players v
                WHERE v.play_id = p.id
                  AND v.player_user_id IN (SELECT uid FROM visible)
             )
           ) AS is_visible
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
     WHERE p.user_id = p_owner
       AND pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
       AND lower(btrim(COALESCE(pp.player_display_name, ''))) = p_name_key
  )
  SELECT jsonb_build_object(
           'exists',             COUNT(*) > 0,
           'play_count',         COUNT(*)::INT,
           'last_played_at',     MAX(played_at),
           'last_game_name',     (array_agg(game_name ORDER BY played_at DESC))[1],
           'ghost_display_name', mode() WITHIN GROUP (ORDER BY name_raw),
           'collides',           COALESCE(bool_or(seats_viewer), false),
           'visible',            COALESCE(bool_or(is_visible), false)
         )
    FROM g_rows;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_summary(p_viewer uuid, p_owner uuid, p_name_key text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_summary(p_viewer uuid, p_owner uuid, p_name_key text) TO boardgamebuddy_role;

CREATE OR REPLACE FUNCTION public.bgb_link_ghost_rows(p_owner uuid, p_name_key text, p_target uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated INT;
BEGIN
  -- Scoped to plays the owner logged, so a caller can never touch someone
  -- else's roster.
  UPDATE boardgamebuddy_play_players pp
     SET player_user_id = p_target
   WHERE pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_owner
         )
     AND pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
     AND lower(btrim(COALESCE(pp.player_display_name, ''))) = p_name_key;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_link_ghost_rows(p_owner uuid, p_name_key text, p_target uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_link_ghost_rows(p_owner uuid, p_name_key text, p_target uuid) TO boardgamebuddy_role;

CREATE OR REPLACE FUNCTION public.bgb_merge_ghosts(p_viewer uuid, p_source text, p_target text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated INT;
BEGIN
  UPDATE boardgamebuddy_play_players pp
     SET player_display_name = p_target
   WHERE pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_viewer
         )
     AND pp.player_display_name ILIKE p_source
     AND pp.player_user_id IS NULL AND pp.pending_user_id IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_updated);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_merge_ghosts(p_viewer uuid, p_source text, p_target text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_merge_ghosts(p_viewer uuid, p_source text, p_target text) TO boardgamebuddy_role;

CREATE OR REPLACE FUNCTION public.bgb_play_partners(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_accounts JSONB;
  v_pending JSONB;
  v_ghosts JSONB;
  v_recent JSONB;
BEGIN
  -- accounts: accepted mutual edges, from the viewer's side.
  SELECT COALESCE(jsonb_agg(a ORDER BY a_sort), '[]'::jsonb)
    INTO v_accounts
    FROM (
      SELECT jsonb_build_object(
               'id', e.id,
               'other_user_id', pr.id,
               'other_display_name', pr.display_name,
               'other_username', pr.username,
               'other_avatar', pr.avatar,
               -- The viewer's own private alias for this buddy, off
               -- whichever side of the canonical row the viewer sits on. NULL
               -- for the other party by construction — a per-viewer
               -- projection, not a property of the edge.
               'other_alias',
                 CASE WHEN e.user_a = p_viewer THEN e.alias_by_a ELSE e.alias_by_b END,
               'accepted_at', e.accepted_at,
               'created_at', e.created_at
             ) AS a,
             lower(pr.display_name) AS a_sort
        FROM boardgamebuddy_buddy_edges e
        JOIN boardgamebuddy_profiles pr
          ON pr.id = CASE WHEN e.user_a = p_viewer THEN e.user_b ELSE e.user_a END
       WHERE e.status = 'accepted'
         AND (e.user_a = p_viewer OR e.user_b = p_viewer)
    ) s;

  -- pending: live requests either way, newest first — a request
  -- made minutes ago is likelier to be the person in front of you than one
  -- that has been sitting for a fortnight, which is the opposite of the
  -- alphabetical order `accounts` wants (that list is browsed; this one is a
  -- short "oh, them" list at the top of a picker).
  --
  -- A rejected or cancelled request is a DELETED row (buddy_service.reject_request
  -- / cancel_request), not a status, so "pending" here means genuinely waiting.
  -- 'blocked' edges are excluded by the same test.
  SELECT COALESCE(jsonb_agg(q ORDER BY q_sort DESC NULLS LAST, q_name), '[]'::jsonb)
    INTO v_pending
    FROM (
      SELECT jsonb_build_object(
               'id', e.id,
               'other_user_id', pr.id,
               'other_display_name', pr.display_name,
               'other_username', pr.username,
               'other_avatar', pr.avatar,
               'direction',
                 CASE WHEN e.requested_by = p_viewer THEN 'outgoing' ELSE 'incoming' END,
               'created_at', e.created_at
             ) AS q,
             e.created_at AS q_sort,
             lower(pr.display_name) AS q_name
        FROM boardgamebuddy_buddy_edges e
        JOIN boardgamebuddy_profiles pr
          ON pr.id = CASE WHEN e.user_a = p_viewer THEN e.user_b ELSE e.user_a END
       WHERE e.status = 'pending'
         AND (e.user_a = p_viewer OR e.user_b = p_viewer)
    ) s;

  -- ghosts: free-text names from the viewer's OWN plays, grouped
  -- case-sensitively on the trimmed name.
  SELECT COALESCE(jsonb_agg(g ORDER BY g_count DESC, g_sort), '[]'::jsonb)
    INTO v_ghosts
    FROM (
      SELECT jsonb_build_object(
               'display_name', btrim(pp.player_display_name),
               'play_count', COUNT(*),
               'last_played_at', MAX(p.played_at)
             ) AS g,
             COUNT(*) AS g_count,
             lower(btrim(pp.player_display_name)) AS g_sort
        FROM boardgamebuddy_plays p
        JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
       WHERE p.user_id = p_viewer
         AND pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
         AND btrim(COALESCE(pp.player_display_name, '')) <> ''
       GROUP BY btrim(pp.player_display_name)
    ) s;

  -- recent: real accounts sharing a play with the viewer, ranked by how many.
  -- Visibility matches bgb_play_stats — plays the viewer logged, plus plays
  -- they appear in. Relation flags come from the same pass rather than the
  -- second query _relations_for_viewer used to run.
  WITH visible_plays AS (
    SELECT p.id FROM boardgamebuddy_plays p WHERE p.user_id = p_viewer
    UNION
    SELECT pp.play_id
      FROM boardgamebuddy_play_players pp
     WHERE pp.player_user_id = p_viewer
  ),
  counts AS (
    SELECT pp.player_user_id AS uid, COUNT(*) AS play_count
      FROM boardgamebuddy_play_players pp
      JOIN visible_plays v ON v.id = pp.play_id
     WHERE pp.player_user_id IS NOT NULL
       AND pp.player_user_id <> p_viewer
     GROUP BY pp.player_user_id
  )
  SELECT COALESCE(jsonb_agg(r ORDER BY r_count DESC, r_sort), '[]'::jsonb)
    INTO v_recent
    FROM (
      SELECT jsonb_build_object(
               'user_id', pr.id,
               'display_name', pr.display_name,
               'avatar', pr.avatar,
               'play_count', c.play_count,
               'is_buddy', COALESCE(e.status = 'accepted', FALSE),
               'has_pending_request', COALESCE(e.status = 'pending', FALSE),
               'pending_request_direction',
                 CASE WHEN e.status = 'pending'
                      THEN CASE WHEN e.requested_by = p_viewer THEN 'outgoing' ELSE 'incoming' END
                 END,
               -- The edge id, so the row can cancel an outgoing
               -- request (or accept an incoming one) without first fetching
               -- /buddies/requests to look it up by other_user_id.
               'pending_request_id',
                 CASE WHEN e.status = 'pending' THEN e.id END
             ) AS r,
             c.play_count AS r_count,
             lower(pr.display_name) AS r_sort
        FROM counts c
        -- Inner join: a co-player with no profile row is dropped, as the
        -- Python did when the profile lookup came back empty.
        JOIN boardgamebuddy_profiles pr ON pr.id = c.uid
        LEFT JOIN boardgamebuddy_buddy_edges e
          ON ((e.user_a = p_viewer AND e.user_b = c.uid)
           OR (e.user_b = p_viewer AND e.user_a = c.uid))
         AND e.status IN ('accepted', 'pending')
    ) s;

  RETURN jsonb_build_object(
    'accounts', v_accounts,
    'pending', v_pending,
    'ghosts', v_ghosts,
    'recent', v_recent
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_play_partners(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_play_partners(p_viewer uuid) TO boardgamebuddy_role;

CREATE OR REPLACE FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key     TEXT := lower(btrim(COALESCE(p_display_name, '')));
  v_updated INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_profiles WHERE id = p_target) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- One statement, so every row moved by one act of linking shares one
  -- timestamp — which is also what lets the notification list collapse a
  -- retroactive link across forty old plays into a single entry.
  UPDATE boardgamebuddy_play_players pp
     SET linked_at = now()
   WHERE pp.player_user_id IS NULL AND pp.pending_user_id IS NULL
     AND lower(btrim(COALESCE(pp.player_display_name, ''))) = v_key
     AND pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_viewer
         );

  -- Linking your own name counts at once. Linking somebody else's is an
  -- invite, the same as seating them in a new play.
  IF p_target = p_viewer THEN
    RETURN jsonb_build_object(
      'updated',
      bgb_link_ghost_rows(p_viewer, v_key, p_target)
    );
  END IF;

  UPDATE boardgamebuddy_play_players pp
     SET pending_user_id = p_target
   WHERE pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_viewer
         )
     AND pp.player_user_id IS NULL
     AND pp.pending_user_id IS NULL
     AND lower(btrim(COALESCE(pp.player_display_name, ''))) = v_key
     AND NOT EXISTS (
           SELECT 1 FROM boardgamebuddy_play_players o
            WHERE o.play_id = pp.play_id
              AND p_target IN (o.player_user_id, o.pending_user_id)
         );
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object('updated', v_updated);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid) TO boardgamebuddy_role;

CREATE OR REPLACE FUNCTION public.bgb_ghost_out_of_plays(p_viewer uuid, p_play_ids uuid[] DEFAULT '{}'::uuid[], p_group_ids uuid[] DEFAULT '{}'::uuid[], p_batch_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name    TEXT;
  v_plays   UUID[] := COALESCE(p_play_ids,  '{}'::uuid[]);
  v_groups  UUID[] := COALESCE(p_group_ids, '{}'::uuid[]);
  v_batches UUID[] := COALESCE(p_batch_ids, '{}'::uuid[]);
  v_updated INT;
  v_declined INT;
BEGIN
  IF array_length(v_plays, 1) IS NULL
     AND array_length(v_groups, 1) IS NULL
     AND array_length(v_batches, 1) IS NULL THEN
    RETURN 0;
  END IF;

  SELECT display_name INTO v_name
  FROM boardgamebuddy_profiles WHERE id = p_viewer;

  -- The COALESCE is a defensive backfill: bgb_play_players_identity_chk needs
  -- one of (player_user_id, player_display_name), so nulling the first on a row
  -- that never carried the second would abort the whole statement. Rows written
  -- by _write_play_players always carry a name, so this normally changes
  -- nothing — but "normally" is not a constraint. NULLIF catches a name that is
  -- present but blank, which the CHECK accepts and a reader would not.
  UPDATE boardgamebuddy_play_players pp
     SET player_display_name =
           COALESCE(NULLIF(btrim(COALESCE(pp.player_display_name, '')), ''), v_name, 'Player'),
         player_user_id = NULL
    FROM boardgamebuddy_plays p
   WHERE p.id = pp.play_id
     AND pp.player_user_id = p_viewer
     AND p.user_id <> p_viewer
     AND (
           p.id = ANY(v_plays)
        OR (p.import_group_id IS NOT NULL AND p.import_group_id = ANY(v_groups))
        OR (p.import_batch_id IS NOT NULL AND p.import_batch_id = ANY(v_batches))
     );

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Declining an invite is the same act: the seat stays as a guest carrying
  -- the name it was written with.
  UPDATE boardgamebuddy_play_players pp
     SET pending_user_id = NULL
    FROM boardgamebuddy_plays p
   WHERE p.id = pp.play_id
     AND pp.pending_user_id = p_viewer
     AND (
           p.id = ANY(v_plays)
        OR (p.import_group_id IS NOT NULL AND p.import_group_id = ANY(v_groups))
        OR (p.import_batch_id IS NOT NULL AND p.import_batch_id = ANY(v_batches))
     );
  GET DIAGNOSTICS v_declined = ROW_COUNT;

  RETURN v_updated + v_declined;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_out_of_plays(p_viewer uuid, p_play_ids uuid[], p_group_ids uuid[], p_batch_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_out_of_plays(p_viewer uuid, p_play_ids uuid[], p_group_ids uuid[], p_batch_ids uuid[]) TO boardgamebuddy_role;

-- ── 6. Answering invites, and the bell ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bgb_accept_play_invites(p_viewer uuid, p_play_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated INT;
BEGIN
  -- linked_at is left as it is: it is when the seat was offered, which is what
  -- the bell groups and orders the answered row by.
  UPDATE boardgamebuddy_play_players pp
     SET player_user_id  = pp.pending_user_id,
         pending_user_id = NULL
   WHERE pp.pending_user_id = p_viewer
     AND pp.play_id = ANY(COALESCE(p_play_ids, '{}'::uuid[]))
     AND NOT EXISTS (
           SELECT 1 FROM boardgamebuddy_play_players o
            WHERE o.play_id = pp.play_id AND o.player_user_id = p_viewer
         );

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_accept_play_invites(p_viewer uuid, p_play_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_accept_play_invites(p_viewer uuid, p_play_ids uuid[]) TO boardgamebuddy_role;

-- Every unanswered invite, grouped the way bgb_notifications groups seats, in
-- the same row shape so the client renders both with one model. Oldest first:
-- this is a queue to work through, not a feed.
CREATE OR REPLACE FUNCTION public.bgb_play_invites(p_viewer uuid, p_limit integer DEFAULT 100)
 RETURNS TABLE(entry_key text, kind text, occurred_at timestamp with time zone, is_unread boolean, actor_id uuid, actor_display_name text, actor_username text, actor_avatar jsonb, play_group text, play_id uuid, play_ids uuid[], group_count integer, game_count integer, played_from date, played_to date, game_id uuid, game_name text, game_thumbnail_url text, import_batch_id uuid, edge_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH seen AS (
    SELECT COALESCE(pr.link_notifications_seen_at, '-infinity'::timestamptz) AS at
      FROM boardgamebuddy_profiles pr WHERE pr.id = p_viewer
  ),
  seats AS (
    SELECT pp.play_id AS p_id, pp.linked_at AS l_at, p.user_id AS o_id,
           p.game_id AS g_id, p.played_at AS p_at, p.game_name AS g_name,
           p.game_thumbnail_url AS g_thumb, p.import_batch_id AS b_id,
           CASE
             WHEN p.import_batch_id IS NOT NULL THEN 'b:' || p.import_batch_id::text
             WHEN p.import_group_id IS NOT NULL THEN 'g:' || p.import_group_id::text
             ELSE 'a:' || p.user_id::text || ':'
                  || to_char(pp.linked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
           END AS k,
           CASE
             WHEN p.import_batch_id IS NOT NULL THEN 'batch'
             WHEN p.import_group_id IS NOT NULL THEN 'run'
             ELSE 'act'
           END AS kd
      FROM boardgamebuddy_play_players pp
      JOIN boardgamebuddy_plays p ON p.id = pp.play_id
     WHERE pp.pending_user_id = p_viewer
  ),
  entries AS (
    SELECT s.k, s.kd, s.o_id,
           MAX(s.l_at)                 AS l_at,
           COUNT(*)::int               AS n_plays,
           COUNT(DISTINCT s.g_id)::int AS n_games,
           MIN(s.p_at)                 AS from_at,
           MAX(s.p_at)                 AS to_at,
           array_agg(s.p_id    ORDER BY s.p_at DESC NULLS LAST, s.p_id)      AS ids,
           (array_agg(s.p_id   ORDER BY s.p_at DESC NULLS LAST, s.p_id))[1] AS rep,
           (array_agg(s.g_id   ORDER BY s.p_at DESC NULLS LAST, s.p_id))[1] AS rep_game,
           (array_agg(s.g_name ORDER BY s.p_at DESC NULLS LAST, s.p_id))[1] AS rep_name,
           (array_agg(s.g_thumb ORDER BY s.p_at DESC NULLS LAST, s.p_id))[1] AS rep_thumb,
           (array_agg(s.b_id   ORDER BY s.p_at DESC NULLS LAST, s.p_id))[1] AS rep_batch
      FROM seats s
     GROUP BY s.k, s.kd, s.o_id
  )
  SELECT 'inv:' || e.k, 'play_invite'::text, e.l_at,
         e.l_at > COALESCE((SELECT at FROM seen), '-infinity'::timestamptz),
         e.o_id, pr.display_name, pr.username, pr.avatar,
         e.kd, e.rep, e.ids, e.n_plays, e.n_games, e.from_at, e.to_at,
         e.rep_game, COALESCE(e.rep_name, g.name), COALESCE(e.rep_thumb, g.thumbnail_url),
         e.rep_batch, NULL::uuid
    FROM entries e
    LEFT JOIN boardgamebuddy_profiles pr ON pr.id = e.o_id
    LEFT JOIN boardgamebuddy_games g ON g.id = e.rep_game
   ORDER BY e.l_at ASC, e.k ASC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_play_invites(p_viewer uuid, p_limit integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_play_invites(p_viewer uuid, p_limit integer) TO boardgamebuddy_role;

-- The number on the bell: things waiting on an answer. Invite entries (an
-- import is one) plus buddy requests received. Unlike the unread count, reading
-- the bell does not lower it; answering does.
CREATE OR REPLACE FUNCTION public.bgb_notifications_pending(p_viewer uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    (SELECT COUNT(DISTINCT
              CASE
                WHEN p.import_batch_id IS NOT NULL THEN 'b:' || p.import_batch_id::text
                WHEN p.import_group_id IS NOT NULL THEN 'g:' || p.import_group_id::text
                ELSE 'a:' || p.user_id::text || ':' || pp.linked_at::text
              END)::int
       FROM boardgamebuddy_play_players pp
       JOIN boardgamebuddy_plays p ON p.id = pp.play_id
      WHERE pp.pending_user_id = p_viewer)
  + (SELECT COUNT(*)::int
       FROM boardgamebuddy_buddy_edges be
      WHERE be.status = 'pending'
        AND be.requested_by <> p_viewer
        AND (be.user_a = p_viewer OR be.user_b = p_viewer));
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_notifications_pending(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_notifications_pending(p_viewer uuid) TO boardgamebuddy_role;

COMMIT;
