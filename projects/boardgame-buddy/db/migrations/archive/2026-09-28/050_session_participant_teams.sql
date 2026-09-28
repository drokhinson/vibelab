-- ─────────────────────────────────────────────────────────────────────────────
-- 050_session_participant_teams.sql — the sides reach the spectators
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 048_play_teams.sql gave a SAVED seat the side it played on, and closed with
-- the one consequence it deliberately left open:
--
--     bgb_session_bundle  reads play_session_participants, not play_players.
--                         The lobby table has no team column and the tags are
--                         typed on the host's LOCAL draft, so they do not
--                         exist server-side until finalize. Consequence worth
--                         stating: a spectator's live mirror shows untinted
--                         columns until the play is saved.
--
-- That was true then because there was nowhere to put a tag mid-game. It is
-- the wrong answer for a team night: the one fact the evening turns on — who
-- is with whom — is invisible to everyone but the host for the whole game, and
-- only appears once the play is over and the tints no longer matter. The host
-- reads a grid whose columns are banded into sides; every spectator reads the
-- same grid with six identical columns, and has to hold the pairings in their
-- head from whatever was said out loud.
--
-- So the lobby roster gets the same column the saved roster has. This is the
-- exact shape 056_participant_order.sql took for the other half of the same
-- problem — `position` is which COLUMN a seat is, `team` is which SIDE it is —
-- and it carries the same three pieces: a nullable column, the tag on the
-- bundle so every poll and every mirror sees it, and one host-only write RPC.
--
-- ── AND THE MODE, WHICH IS NOT OPTIONAL HERE ────────────────────────────────
--
-- `play_mode` lands on the session in the same breath, because the tags alone
-- do not tell a spectator what to draw. A side's seats share ONE cell in the
-- scoring grid now (widgets/round-score-grid.js#roundGridColumns) and that
-- merge is gated on the mode: a host who names sides and then switches the
-- game type back to competitive keeps the tags on their draft, so a mirror
-- reading tags alone would merge a grid the host's own screen had un-merged.
-- Two phones showing the same scoreboard with different columns is worse than
-- the untinted grid this migration started out fixing. It is also what lets a
-- spectator's co-op mirror drop the per-seat trophy the host's already has.
--
-- ── WHAT NULL MEANS ──────────────────────────────────────────────────────────
--
-- "This seat has no side": every participant row that exists today, every
-- competitive and co-op lobby, and a team lobby whose sides were never named.
-- No backfill and nothing inferred — ui/team-colors.js reads a roster with no
-- tag on any seat as "render exactly as a non-team play does", which is the
-- behaviour every existing session keeps.
--
-- ── WHY THIS ONE IS NOT GATHER-ONLY ──────────────────────────────────────────
--
-- add / remove / reorder all take bgb_session_gate's require_gather arm,
-- because each changes WHICH ROWS the grid has or WHAT ORDER they are in, and
-- every spectator's cells are keyed off that array index (see 056's header).
-- A tag changes neither: it repaints a header's tint and nothing else. So the
-- one reason those three are frozen does not apply here, and gating anyway
-- would cost a real case. Naming a side after the first round means rolling
-- the cascade back to Gather (play-flow-view._phaseBack), which is an
-- ASYNCHRONOUS phase PATCH — and one _withLobby swallows if it fails. The tag
-- write is debounced and can reach the database while the session still reads
-- 'play'. On the require_gather arm that lands as `roster_locked`, which every
-- lobby write swallows silently: the host would watch their own grid band
-- itself and every spectator stay on the untinted one, which is the exact
-- failure this migration exists to end. Host-only, open session, any phase.
--
-- ── FULL REPLACEMENT, NOT A PATCH ────────────────────────────────────────────
--
-- p_teams is the WHOLE map, {participant_id: tag}, and a participant the map
-- omits is cleared. The host's draft is the only place a tag is ever typed, so
-- the map is always complete with respect to it — and "cleared" is how a side
-- the host deletes, or a whole set of tags abandoned when they switch the game
-- type back to competitive, stops tinting a spectator's grid. A merge-only
-- write could add a side but never take one away.
--
-- ── THE LENGTH CAP ───────────────────────────────────────────────────────────
--
-- 16, the same cap and the same reasoning as 048's on play_players: the six
-- the Gather input enforces is a layout fact about one --rg-col-min column,
-- not a fact about the data. Truncation rather than a raised CHECK, because
-- every lobby write in this app is best-effort — a tag one character too long
-- must cost a spectator a character, never cost the host a 500 on a write they
-- cannot see fail.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- How this table is being scored, mirroring boardgamebuddy_plays.play_mode
-- (migration 007) — the same three values and the same CHECK, so the lobby and
-- the play it becomes cannot describe one evening two ways. NULL means the
-- host never said, which is every session written before today and reads as
-- 'competitive' at both ends, exactly as a game with no play_mode does.
ALTER TABLE public.boardgamebuddy_play_sessions
  ADD COLUMN IF NOT EXISTS play_mode TEXT;

ALTER TABLE public.boardgamebuddy_play_sessions
  DROP CONSTRAINT IF EXISTS bgb_play_sessions_play_mode_chk;
ALTER TABLE public.boardgamebuddy_play_sessions
  ADD CONSTRAINT bgb_play_sessions_play_mode_chk
    CHECK (play_mode IS NULL OR play_mode = ANY (ARRAY['competitive'::text, 'coop'::text, 'team'::text]));

COMMENT ON COLUMN public.boardgamebuddy_play_sessions.play_mode IS
  'How the host is scoring this table: competitive / coop / team (migration 050). NULL = never said, read as competitive. Not the same fact as boardgamebuddy_games.play_mode, which is what the BOX suggests; this is what the table actually did, and it is the gate on whether a spectator''s grid merges a side''s seats into one column.';

ALTER TABLE public.boardgamebuddy_play_session_participants
  ADD COLUMN IF NOT EXISTS team TEXT;

ALTER TABLE public.boardgamebuddy_play_session_participants
  DROP CONSTRAINT IF EXISTS bgb_play_session_participants_team_len_chk;
ALTER TABLE public.boardgamebuddy_play_session_participants
  ADD CONSTRAINT bgb_play_session_participants_team_len_chk
    CHECK (team IS NULL OR char_length(team) <= 16);

COMMENT ON COLUMN public.boardgamebuddy_play_session_participants.team IS
  'Free-text side this seat is on, as the host typed it (migration 050). NULL means no side — every competitive and co-op lobby, and a team lobby whose sides were never named. Matched case-insensitively after trimming, the same comparison ui/team-colors.js and PlaySession.applyTeamTag use, so "Red" and "red" are one side. The lobby twin of boardgamebuddy_play_players.team (migration 048), which is where the tag lands for good at finalize; this column only has to outlive the session.';

-- No new GRANT: migration 011 granted the table to boardgamebuddy_role and a
-- column inherits the table-level grant. Nothing reaches this table with the
-- anon key, so there is no Data API grant to widen either — the same note
-- 056_participant_order.sql made for `position`.


-- ─────────────────────────────────────────────────────────────────────────────
-- bgb_session_bundle — 018's function, plus `team` on every participant
-- ─────────────────────────────────────────────────────────────────────────────
-- Copied from its CURRENT definition, which is 018_scoring_templates.sql and
-- NOT the highest-numbered file that mentions it (003 holds the pre-018 body,
-- 056's is the one 003 was collapsed from). 044's standing warning applies:
-- CREATE OR REPLACE will happily install a function that has quietly lost
-- `scoring_template`, and nothing would raise.
--
-- One key added to the participant object. Additive: a client that does not
-- read it sees today's behaviour, which is what lets the migration land before
-- the web deploy that reads it.
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
           'team', pp.team
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
GRANT EXECUTE ON FUNCTION public.bgb_session_bundle(p_session_id uuid) TO boardgamebuddy_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- bgb_set_session_teams — new in 050. Host-only, any open phase.
-- ─────────────────────────────────────────────────────────────────────────────
-- Publishes the whole team setup in one write: how the table is being scored,
-- and who is on which side. ONE call rather than two because the two are one
-- fact on the client — the mode decides whether the sides mean anything, and a
-- mirror that had the tags but not the mode (or the other way round) would
-- draw a grid the host's screen is not drawing.
--
-- p_mode: 'competitive' | 'coop' | 'team', or NULL to leave it unsaid. An
-- unrecognised value is ignored rather than rejected, so an older client
-- cannot fail a write the rest of which is good.
--
-- p_teams: {"<participant_id>": "<tag>", …}. Ids that do not belong to this
-- session are ignored (same as bgb_reorder_participants' p_order); this
-- session's participants that the map omits are CLEARED — see the header.
--
-- A single UPDATE over the whole roster rather than one per named seat, so a
-- host renaming a side pays one statement and the clear-the-omitted half comes
-- free in the same pass.
CREATE OR REPLACE FUNCTION public.bgb_set_session_teams(p_host uuid, p_code text, p_mode text, p_teams jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate    JSONB;
  v_session UUID;
  v_map     JSONB;
BEGIN
  -- require_gather = FALSE: a tag never renumbers a column — the one reason
  -- add / remove / reorder are frozen — and a debounced write can outrun the
  -- phase PATCH of a host rolling back to Gather to name a side. Same error
  -- vocabulary as every other host write, minus roster_locked.
  v_gate := bgb_session_gate(p_code, p_host, FALSE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  -- A JSON null, a missing argument and an empty object all mean "no seat
  -- carries a side", which is a legitimate write: it is what clearing the last
  -- tag sends, and what a host switching back to a competitive game sends.
  v_map := COALESCE(NULLIF(p_teams, 'null'::jsonb), '{}'::jsonb);
  IF jsonb_typeof(v_map) <> 'object' THEN
    RETURN jsonb_build_object('error', 'invalid_teams');
  END IF;

  -- Left alone when the caller says nothing, so a client that only knows how
  -- to publish tags cannot silently un-say the mode.
  IF p_mode = ANY (ARRAY['competitive', 'coop', 'team']) THEN
    UPDATE boardgamebuddy_play_sessions
       SET play_mode = p_mode
     WHERE id = v_session
       AND play_mode IS DISTINCT FROM p_mode;
  END IF;

  UPDATE boardgamebuddy_play_session_participants pp
     SET team = NULLIF(left(btrim(v_map ->> pp.id::TEXT), 16), '')
   WHERE pp.session_id = v_session
     AND pp.team IS DISTINCT FROM NULLIF(left(btrim(v_map ->> pp.id::TEXT), 16), '');

  RETURN bgb_session_bundle(v_session);
END;
$function$;
-- SECURITY DEFINER + published by PostgREST: the anon key that ships in the
-- web bundle must not reach it. Same trio 028 applies to every bgb RPC, and
-- the one piece of ceremony a new DEFINER function cannot inherit — Postgres
-- hardcodes EXECUTE-to-PUBLIC on CREATE.
GRANT EXECUTE ON FUNCTION public.bgb_set_session_teams(p_host uuid, p_code text, p_mode text, p_teams jsonb) TO boardgamebuddy_role;
REVOKE EXECUTE ON FUNCTION public.bgb_set_session_teams(p_host uuid, p_code text, p_mode text, p_teams jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_set_session_teams(p_host uuid, p_code text, p_mode text, p_teams jsonb) TO service_role;

COMMIT;
