-- ─────────────────────────────────────────────────────────────────────────────
-- 027 — Everybody watching a session sees the live grid; only the host edits it
-- ─────────────────────────────────────────────────────────────────────────────
-- Until now "can I see the live scores?" answered "are you SEATED?", and the
-- app has two kinds of viewer as a result:
--
--   * a seated player — has a participant row, so (after 026) the scores table
--     and its Realtime channel are readable, and the grid updates as the host
--     types;
--   * a spectator — joined after Gather, so bgb_join_session skipped the INSERT
--     (003_rpcs.sql, `IF v_phase = 'gather'`), no participant row, and both the
--     table and the channel are silent for them. They fall back to the copy of
--     the grid baked into the session bundle and a 4s poll
--     (views/session-viewer-view.js, `isSeedOnly`).
--
-- Nobody asked for two. Watching a game is watching a game: the grid is the
-- same grid, and what separates people is whether they can CHANGE it — the host
-- can, everyone else cannot. bgb_session_scores_write already says exactly that
-- and is not touched here.
--
-- The read rule this replaces it with is the one the app already runs on:
-- "knowing the code is the access token for the lobby"
-- (session_routes.py's GET /sessions/{code}, which is unauthenticated and hands
-- the whole bundle — live scores included — to any caller). The database could
-- not express that, because a policy cannot ask what the caller typed in. So
-- the code, once used, is RECORDED: opening a session writes a viewer row, and
-- the policies read that.
--
-- WHY NOT JUST `USING (true)` FOR authenticated. Because PostgREST would then
-- answer `.from('boardgamebuddy_play_sessions').select('*')` with no filter —
-- every session in the table, every host's id, and every OPEN session's 5-char
-- code, which is a join ticket. A 25-bit code that is hard to guess one at a
-- time must not be listable. A viewer row keeps the read addressed: you see the
-- sessions you actually opened, and nothing else.
--
-- WHY NOT SEAT SPECTATORS AS PARTICIPANTS. The participants table is the
-- ROSTER: bgb_session_bundle builds the scoring columns from it, and
-- bgb_finalize_session turns it into the play's player rows. A spectator seated
-- there would become a column in everyone's grid and then a player in the saved
-- play. Watching and playing are different facts, so they get different tables
-- and nothing downstream of the roster changes.

BEGIN;

-- ── Who is watching ──────────────────────────────────────────────────────────
-- One row per (session, signed-in viewer). Written by bgb_watch_session below,
-- read only by the two policies further down. Rows die with the session they
-- point at; a session lives two hours (expires_at), so the table stays roughly
-- "sessions this week × people who opened them".
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_session_viewers (
  session_id    UUID NOT NULL REFERENCES public.boardgamebuddy_play_sessions(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);
ALTER TABLE public.boardgamebuddy_play_session_viewers ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_play_session_viewers TO boardgamebuddy_role;

-- The Data API grant plus a self-scoped policy, for the same reason 026 needed
-- both on the participants table: a policy's subquery is privilege-checked AND
-- row-filtered as the querying user, so a missing grant fails the outer read
-- outright and a missing policy silently matches nothing.
GRANT SELECT ON public.boardgamebuddy_play_session_viewers TO authenticated;
DROP POLICY IF EXISTS bgb_play_session_viewers_select_self
  ON public.boardgamebuddy_play_session_viewers;
CREATE POLICY bgb_play_session_viewers_select_self
  ON public.boardgamebuddy_play_session_viewers
  FOR SELECT TO authenticated USING (
    user_id = (select auth.uid())
  );

-- ── Recording a viewer ───────────────────────────────────────────────────────
-- SECURITY DEFINER, like every other bgb_* session RPC: the backend calls it
-- with the service role and the client never writes this table directly.
-- Returns the same bundle as bgb_get_session, so the screen that calls it needs
-- no second round trip, and the same {"error": …} envelopes, so a dead or
-- expired code surfaces as the 404/410 the routes already map.
CREATE OR REPLACE FUNCTION public.bgb_watch_session(p_code TEXT, p_viewer UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  -- Idempotent: the viewer screen calls this on every open, and a reload must
  -- not move first_seen_at.
  IF p_viewer IS NOT NULL THEN
    INSERT INTO boardgamebuddy_play_session_viewers (session_id, user_id)
    VALUES (v_id, p_viewer)
    ON CONFLICT (session_id, user_id) DO NOTHING;
  END IF;

  RETURN bgb_session_bundle(v_id);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_watch_session(p_code TEXT, p_viewer UUID) TO boardgamebuddy_role;

-- ── The read policies, with watching as a third way in ───────────────────────
-- Host OR seated player OR watcher. auth.uid() stays wrapped in a scalar
-- subquery throughout (025) so it is evaluated once per statement.
DROP POLICY IF EXISTS bgb_play_sessions_select ON public.boardgamebuddy_play_sessions;
CREATE POLICY bgb_play_sessions_select ON public.boardgamebuddy_play_sessions
  FOR SELECT TO authenticated USING (
    host_user_id = (select auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_session_participants p
      WHERE p.session_id = boardgamebuddy_play_sessions.id
        AND p.user_id = (select auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_session_viewers v
      WHERE v.session_id = boardgamebuddy_play_sessions.id
        AND v.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS bgb_session_scores_select ON public.boardgamebuddy_play_session_scores;
CREATE POLICY bgb_session_scores_select ON public.boardgamebuddy_play_session_scores
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_sessions s
      WHERE s.id = boardgamebuddy_play_session_scores.session_id
        AND (
          s.host_user_id = (select auth.uid())
          OR EXISTS (
            SELECT 1 FROM public.boardgamebuddy_play_session_participants p
            WHERE p.session_id = s.id AND p.user_id = (select auth.uid())
          )
          OR EXISTS (
            SELECT 1 FROM public.boardgamebuddy_play_session_viewers v
            WHERE v.session_id = s.id AND v.user_id = (select auth.uid())
          )
        )
    )
  );

-- bgb_session_scores_write is deliberately untouched: phase = 'play' AND
-- host_user_id = auth.uid(). Watching gains you the grid, never the pencil.

COMMIT;
