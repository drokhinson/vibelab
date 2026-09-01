-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — perf pass: the last un-folded host writes
--
-- Everything the host touches on the Gather screen still went through the
-- Python orchestration session_service kept after 036/042:
--
--     _fetch_open_session()  → SELECT the session, gate open/expiry
--     …work…                 → 1-2 more SELECT / INSERT / DELETE / UPDATE
--     _build_response()      → bgb_session_bundle RPC
--
-- Adding a player was four sequential PostgREST round trips; so was removing
-- one; the game swap and each phase step were three. Those fire constantly
-- while a table is being set up — once per player added, once per game swap,
-- three times per session for the phase cursor — so they set the floor on how
-- fast hosting feels.
--
--   bgb_session_gate         → shared open/expiry/host/phase gate, so the four
--                              functions below don't each re-implement it
--   bgb_add_participant      → 4 round trips → 1
--   bgb_remove_participant   → 4 → 1
--   bgb_update_session_game  → 2-3 → 1
--   bgb_advance_phase        → 2-3 → 1
--   bgb_abandon_session      → 2 → 1  (also retires _fetch_open_session, the
--                              last Python-side session gate)
--
-- Gate semantics are a deliberate one-for-one port of
-- session_service._fetch_open_session + each function's own checks — same
-- statuses, same order, same messages. The expiry path sets `status` only,
-- NOT `phase`, matching _fetch_open_session and bgb_get_session.
--
-- The phase transition table is passed IN as JSONB rather than encoded here:
-- ALLOWED_PHASE_TRANSITIONS in constants.py stays the single source of truth.
-- (036/038 already show what happens otherwise — their comments still point at
-- PLAY_SESSION_CODE_ALPHABET / _LENGTH constants that no longer exist.)
--
-- Supabase schema note (038/039): extensions live in the `extensions` schema,
-- not public. Nothing here needs one.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Shared gate ──────────────────────────────────────────────────────────────
-- Returns {'error': …} on any gate failure, otherwise the session's identifying
-- columns. Callers check ->>'error' and short-circuit.
--
-- Not retrofitted onto bgb_get_session / bgb_join_session on purpose: those sit
-- on the 2s poll path and this migration carries zero behavior change for them.
CREATE OR REPLACE FUNCTION public.bgb_session_gate(
  p_code TEXT,
  p_host UUID,
  p_require_gather BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT s.id, s.host_user_id, s.game_id, s.expires_at, COALESCE(s.phase, 'gather') AS phase
    INTO v_row
    FROM boardgamebuddy_play_sessions s
   WHERE s.code = upper(p_code)
     AND s.status = 'open';

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_row.expires_at < now() THEN
    -- Status only — phase is left alone, exactly as the Python gate and
    -- bgb_get_session do.
    UPDATE boardgamebuddy_play_sessions
       SET status = 'abandoned'
     WHERE id = v_row.id;
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  IF v_row.host_user_id <> p_host THEN
    RETURN jsonb_build_object('error', 'host_only');
  END IF;

  IF p_require_gather AND v_row.phase <> 'gather' THEN
    RETURN jsonb_build_object('error', 'roster_locked');
  END IF;

  RETURN jsonb_build_object(
    'session_id', v_row.id,
    'host_user_id', v_row.host_user_id,
    'game_id', v_row.game_id,
    'phase', v_row.phase
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_session_gate(TEXT, UUID, BOOLEAN) TO boardgamebuddy_role;


-- ── Add a participant ────────────────────────────────────────────────────────
-- Host-seats a buddy (p_user set) or a ghost (p_user NULL). Dedup mirrors
-- bgb_join_session: by user_id for accounts, by case-insensitive display_name
-- for ghosts — the same predicates the two partial unique indexes cover.
--
-- The INSERT is wrapped against unique_violation so a double-tap (or a joiner
-- racing the host's add) is an idempotent success rather than a 500.
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
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, TRUE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  v_name := btrim(COALESCE(p_display_name, ''));
  IF v_name = '' THEN
    RETURN jsonb_build_object('error', 'display_name_required');
  END IF;

  BEGIN
    IF p_user IS NOT NULL THEN
      INSERT INTO boardgamebuddy_play_session_participants (session_id, user_id, display_name)
      SELECT v_session, p_user, v_name
       WHERE NOT EXISTS (
         SELECT 1 FROM boardgamebuddy_play_session_participants
          WHERE session_id = v_session AND user_id = p_user
       );
    ELSE
      INSERT INTO boardgamebuddy_play_session_participants (session_id, display_name)
      SELECT v_session, v_name
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


-- ── Remove a participant ─────────────────────────────────────────────────────
-- The host can't be removed this way — abandoning the session is the way to
-- end it (mirrors the old 400).
CREATE OR REPLACE FUNCTION public.bgb_remove_participant(
  p_host UUID,
  p_code TEXT,
  p_participant UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gate JSONB;
  v_session UUID;
  v_user UUID;
  v_found BOOLEAN;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, TRUE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  SELECT TRUE, pp.user_id
    INTO v_found, v_user
    FROM boardgamebuddy_play_session_participants pp
   WHERE pp.id = p_participant
     AND pp.session_id = v_session;

  IF NOT COALESCE(v_found, FALSE) THEN
    RETURN jsonb_build_object('error', 'participant_not_found');
  END IF;

  IF v_user IS NOT NULL AND v_user = (v_gate ->> 'host_user_id')::UUID THEN
    RETURN jsonb_build_object('error', 'cannot_remove_host');
  END IF;

  DELETE FROM boardgamebuddy_play_session_participants
   WHERE id = p_participant AND session_id = v_session;

  RETURN bgb_session_bundle(v_session);
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_remove_participant(UUID, TEXT, UUID) TO boardgamebuddy_role;


-- ── Change (or clear) the game ───────────────────────────────────────────────
-- Not gather-gated: the old service allowed a swap in any open phase, and the
-- host flow's picker relies on that. p_game NULL is the legitimate "clear the
-- pick" case, so it is never treated as a missing game.
CREATE OR REPLACE FUNCTION public.bgb_update_session_game(
  p_host UUID,
  p_code TEXT,
  p_game UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gate JSONB;
  v_session UUID;
  v_current UUID;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, FALSE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;
  v_current := (v_gate ->> 'game_id')::UUID;

  IF v_current IS DISTINCT FROM p_game THEN
    UPDATE boardgamebuddy_play_sessions SET game_id = p_game WHERE id = v_session;
  END IF;

  RETURN bgb_session_bundle(v_session);
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_update_session_game(UUID, TEXT, UUID) TO boardgamebuddy_role;


-- ── Advance the phase cursor ─────────────────────────────────────────────────
-- p_transitions is ALLOWED_PHASE_TRANSITIONS serialized by the service:
--   {"gather":["play","abandoned"], "play":["gather","settle","abandoned"],
--    "settle":["play","finalized","abandoned"], "finalized":[], "abandoned":[]}
-- Keeping it a parameter is what stops this table from being duplicated in two
-- languages. An illegal move returns from/to so the service can compose the
-- same dynamic 400 message the route has always sent.
CREATE OR REPLACE FUNCTION public.bgb_advance_phase(
  p_host UUID,
  p_code TEXT,
  p_phase TEXT,
  p_transitions JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gate JSONB;
  v_session UUID;
  v_current TEXT;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, FALSE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;
  v_current := v_gate ->> 'phase';

  -- Idempotent: re-asserting the current phase is a no-op, not an error.
  IF p_phase = v_current THEN
    RETURN bgb_session_bundle(v_session);
  END IF;

  IF NOT (COALESCE(p_transitions -> v_current, '[]'::jsonb) ? p_phase) THEN
    RETURN jsonb_build_object(
      'error', 'invalid_transition', 'from', v_current, 'to', p_phase
    );
  END IF;

  UPDATE boardgamebuddy_play_sessions
     SET phase = p_phase,
         -- Keep status in step for the abandoned shortcut (mirrors
         -- abandon_session). `finalized` is set later by mark_finalized, once
         -- the play row exists.
         status = CASE WHEN p_phase = 'abandoned' THEN 'abandoned' ELSE status END
   WHERE id = v_session;

  RETURN bgb_session_bundle(v_session);
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_advance_phase(UUID, TEXT, TEXT, JSONB) TO boardgamebuddy_role;


-- ── Abandon ──────────────────────────────────────────────────────────────────
-- Returns {'ok': true} — the route is a 204, so there's no bundle to build.
CREATE OR REPLACE FUNCTION public.bgb_abandon_session(
  p_host UUID,
  p_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gate JSONB;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, FALSE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;

  UPDATE boardgamebuddy_play_sessions
     SET status = 'abandoned', phase = 'abandoned'
   WHERE id = (v_gate ->> 'session_id')::UUID;

  RETURN jsonb_build_object('ok', TRUE);
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_abandon_session(UUID, TEXT) TO boardgamebuddy_role;


-- ── Index housekeeping ───────────────────────────────────────────────────────
-- 026 added (code, phase), but every session lookup in the codebase filters
-- `code = X AND status = 'open'`, which the partial unique index
-- idx_bgb_play_sessions_open_code serves better. The leftover is pure write
-- amplification on a table every host tap writes to — and it never made it into
-- db/schema/boardgamebuddy.sql, so nothing was reading it as current either.
DROP INDEX IF EXISTS public.idx_bgb_play_sessions_code_phase;

COMMIT;
