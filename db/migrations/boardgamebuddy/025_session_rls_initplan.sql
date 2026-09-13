-- ─────────────────────────────────────────────────────────────────────────────
-- 025 — Live-session RLS evaluates auth.uid() once, not once per row
-- ─────────────────────────────────────────────────────────────────────────────
-- Supabase's database linter flags all three policies on the two live-session
-- tables (auth_rls_initplan):
--
--   Table public.boardgamebuddy_play_sessions has a row level security policy
--   bgb_play_sessions_select that re-evaluates current_setting() or
--   auth.<function>() for each row.
--
-- auth.uid() is `current_setting('request.jwt.claim.sub')` behind a STABLE
-- wrapper. STABLE lets Postgres cache the result within a statement but does
-- not oblige it to: written bare in a policy predicate, the call is part of the
-- per-row qual and is executed once per row scanned. Written as a scalar
-- subquery — `(select auth.uid())` — the planner hoists it into an InitPlan,
-- runs it once for the whole statement, and the policy compares each row
-- against a constant.
--
-- The value is identical either way (the JWT does not change mid-statement), so
-- this is a pure plan change: same rows in, same rows out.
--
-- Both tables are in the supabase_realtime publication and are the only two the
-- web client reads through supabase-js instead of the backend — every device at
-- a live table re-reads them on every score change, which is where a per-row
-- function call is worst.
--
-- Recreated rather than altered: Postgres has no way to edit a policy's USING
-- clause in place, and a DROP + CREATE pair inside one transaction is not a
-- window of open access — DDL takes an ACCESS EXCLUSIVE lock, so no session
-- reads the table between the two statements.
--
-- 001_baseline.sql is deliberately NOT edited. It reproduces the replayed
-- archive exactly and says so in its header; a fresh database reaches this
-- state by running that file and then this one, like every other migration.

BEGIN;

-- You can see a session you host or are a participant in.
DROP POLICY IF EXISTS bgb_play_sessions_select ON public.boardgamebuddy_play_sessions;
CREATE POLICY bgb_play_sessions_select ON public.boardgamebuddy_play_sessions
  FOR SELECT TO authenticated USING (
    host_user_id = (select auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_session_participants p
      WHERE p.session_id = boardgamebuddy_play_sessions.id
        AND p.user_id = (select auth.uid())
    )
  );

-- Everyone at the table reads live scores…
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
        )
    )
  );

-- …but only the host writes them, and only while the session is being played.
-- Both halves of the check are load-bearing: without the phase test a host
-- could rewrite scores after finalizing (archive/053).
DROP POLICY IF EXISTS bgb_session_scores_write ON public.boardgamebuddy_play_session_scores;
CREATE POLICY bgb_session_scores_write ON public.boardgamebuddy_play_session_scores
  FOR ALL TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_sessions s
      WHERE s.id = boardgamebuddy_play_session_scores.session_id
        AND s.phase = 'play'
        AND s.host_user_id = (select auth.uid())
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_sessions s
      WHERE s.id = boardgamebuddy_play_session_scores.session_id
        AND s.phase = 'play'
        AND s.host_user_id = (select auth.uid())
    )
  );

COMMIT;
