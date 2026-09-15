-- ─────────────────────────────────────────────────────────────────────────────
-- 026 — A seated player can actually read the session they are seated in
-- ─────────────────────────────────────────────────────────────────────────────
-- Both live-session SELECT policies are written as "the host, OR someone with a
-- participant row":
--
--   USING (host_user_id = (select auth.uid()) OR EXISTS (
--     SELECT 1 FROM boardgamebuddy_play_session_participants p …))
--
-- The second half has never matched. Postgres applies RLS to every table a
-- query touches, including ones pulled in by another policy's subquery, and
-- boardgamebuddy_play_session_participants has RLS enabled with NO policy
-- (001_baseline.sql) — so for the `authenticated` role that EXISTS sees an
-- empty table and returns false for everyone, every time. Measured on a scratch
-- Postgres 16 built from the baseline's own RLS and grants: the host reads its
-- sessions and their live scores, and a guest holding a participant row in the
-- same session reads NOTHING from either table. In the plan the branch shows up
-- as `Filter: (false AND (user_id = …))` — the policy folded to a constant.
--
-- The visible effect: everyone except the host falls back to the server-
-- rendered grid in the session bundle, and their Realtime subscription (which
-- is RLS-filtered the same way) delivers nothing, so live scores do not stream
-- to the people watching them.
--
-- A grant alone would not fix it — the rows would still be filtered away — and
-- a policy alone would not either, once Supabase drops the legacy blanket grant
-- of public.* to the API roles on 2026-10-30 (see archive/034), after which the
-- subquery fails outright with "permission denied". Both are needed.
--
-- SCOPE: a signed-in user may read THEIR OWN seat rows and nothing else. That
-- is exactly what the two EXISTS clauses ask for — each already filters on
-- `p.user_id = auth.uid()` — so nothing wider is required, and nothing wider is
-- given: the roster of who else is at a table still comes from the backend,
-- which reads it with the service role.
--
-- Deliberately NOT "you can see every seat in a session you are in": that
-- policy would have to consult boardgamebuddy_play_sessions, whose own policy
-- consults this table, and Postgres would reject the cycle at query time
-- ("infinite recursion detected in policy"). Breaking the cycle needs a
-- SECURITY DEFINER helper, which is a bigger hammer than any current read
-- wants.
--
-- Ghost seats (a participant row with user_id IS NULL, for someone at the table
-- without an account) match nobody: NULL = anything is NULL, never true. That
-- is the pre-existing behaviour and is left alone — a ghost has no JWT to read
-- with.

BEGIN;

-- Visible to the Data API at all (the half that survives 2026-10-30).
GRANT SELECT ON public.boardgamebuddy_play_session_participants TO authenticated;

-- …and the rows themselves.
DROP POLICY IF EXISTS bgb_play_session_participants_select_self
  ON public.boardgamebuddy_play_session_participants;
CREATE POLICY bgb_play_session_participants_select_self
  ON public.boardgamebuddy_play_session_participants
  FOR SELECT TO authenticated USING (
    user_id = (select auth.uid())
  );

COMMIT;
