-- 037_app_uid_claim.sql — RLS reads the app's user id from a claim, not `sub`.
--
-- WHY. Every user-id column here is `uuid` (35 of them, 20 tables) and every
-- RLS predicate compared them to `auth.uid()`, which is the token's `sub` cast
-- to uuid. That held only because the 23 accounts migrated from Supabase kept
-- their original UUIDs as their Identity Platform uid. The first brand-new
-- account got a Firebase-generated uid instead — 28 characters, no dashes —
-- and every query naming that user died on `invalid input syntax for type
-- uuid`. The API answered 500 on literally every authenticated endpoint, and
-- `auth.uid()` in a policy would have raised the same cast error.
--
-- The blocking function in `projects/boardgame-buddy/functions/` now resolves
-- the id at sign-in and puts it in the `app_uid` claim: the uid unchanged when
-- it is already a UUID, otherwise a deterministic uuid5 of it. This migration
-- teaches the policies to read that claim.
--
-- WHAT THIS DOES NOT DO. Not one column changes type and not one RPC
-- signature changes. The alternative — widening 35 columns to TEXT and
-- re-signing 58 RPC parameters — was considered and rejected as a much larger
-- migration for the same outcome.
--
-- Read `Docs/RUNBOOK_AUTH_ROLE_CLAIM.md` before changing any of this. The
-- claim only exists because that function runs on every sign-in; delete it and
-- everything below starts failing closed.

BEGIN;

-- ── The resolver ────────────────────────────────────────────────────────────
-- SECURITY INVOKER (the default) on purpose: it reads only the caller's own
-- token and must never see more than the caller does, so it needs no elevated
-- rights and none of the REVOKE ceremony a DEFINER function does
-- (.claude/rules/database-supabase.md).
--
-- THE REGEX GUARD IS THE WHOLE POINT. `::uuid` on a Firebase uid RAISES, and
-- an exception inside a policy fails the query rather than the row — so a
-- COALESCE straight onto `auth.uid()` would turn a denied read into a 500.
-- Matching the shape first means an unusable id yields NULL, every `= NULL`
-- comparison is false, and the caller is simply denied.
--
-- The `sub` arm is TRANSITIONAL. A token minted before the blocking function
-- was deployed carries no `app_uid`, and every one of those belongs to a
-- migrated account whose `sub` is a UUID — so honouring a UUID-shaped `sub`
-- keeps live sessions working across the rollout instead of locking everyone
-- out of the session tables for up to an hour. It cannot rescue a new account:
-- a Firebase uid does not match the pattern. Drop the arm once no
-- pre-rollout token can still be valid.
CREATE OR REPLACE FUNCTION public.bgb_app_uid()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE
           WHEN coalesce(auth.jwt() ->> 'app_uid', '') ~*
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN (auth.jwt() ->> 'app_uid')::uuid
           WHEN coalesce(auth.jwt() ->> 'sub', '') ~*
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN (auth.jwt() ->> 'sub')::uuid
           ELSE NULL
         END
$function$;

COMMENT ON FUNCTION public.bgb_app_uid() IS
  'The UUID the app knows this caller by: the app_uid claim, else a UUID-shaped sub, else NULL. See db/migrations/037_app_uid_claim.sql.';

GRANT EXECUTE ON FUNCTION public.bgb_app_uid() TO authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_app_uid() TO boardgamebuddy_role;

-- ── The policies, verbatim apart from the identity ──────────────────────────
-- Each is its current definition with `(select auth.uid())` replaced by
-- `(select public.bgb_app_uid())`. The scalar subquery wrapping is preserved
-- deliberately: migration 025 added it so the identity is evaluated once per
-- statement rather than once per row.

-- From 026.
DROP POLICY IF EXISTS bgb_play_session_participants_select_self
  ON public.boardgamebuddy_play_session_participants;
CREATE POLICY bgb_play_session_participants_select_self
  ON public.boardgamebuddy_play_session_participants
  FOR SELECT TO authenticated USING (
    user_id = (select public.bgb_app_uid())
  );

-- From 027.
DROP POLICY IF EXISTS bgb_play_session_viewers_select_self
  ON public.boardgamebuddy_play_session_viewers;
CREATE POLICY bgb_play_session_viewers_select_self
  ON public.boardgamebuddy_play_session_viewers
  FOR SELECT TO authenticated USING (
    user_id = (select public.bgb_app_uid())
  );

-- From 027: host OR seated player OR watcher.
DROP POLICY IF EXISTS bgb_play_sessions_select ON public.boardgamebuddy_play_sessions;
CREATE POLICY bgb_play_sessions_select ON public.boardgamebuddy_play_sessions
  FOR SELECT TO authenticated USING (
    host_user_id = (select public.bgb_app_uid())
    OR EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_session_participants p
      WHERE p.session_id = boardgamebuddy_play_sessions.id
        AND p.user_id = (select public.bgb_app_uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_session_viewers v
      WHERE v.session_id = boardgamebuddy_play_sessions.id
        AND v.user_id = (select public.bgb_app_uid())
    )
  );

-- From 027.
DROP POLICY IF EXISTS bgb_session_scores_select ON public.boardgamebuddy_play_session_scores;
CREATE POLICY bgb_session_scores_select ON public.boardgamebuddy_play_session_scores
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_sessions s
      WHERE s.id = boardgamebuddy_play_session_scores.session_id
        AND (
          s.host_user_id = (select public.bgb_app_uid())
          OR EXISTS (
            SELECT 1 FROM public.boardgamebuddy_play_session_participants p
            WHERE p.session_id = s.id AND p.user_id = (select public.bgb_app_uid())
          )
          OR EXISTS (
            SELECT 1 FROM public.boardgamebuddy_play_session_viewers v
            WHERE v.session_id = s.id AND v.user_id = (select public.bgb_app_uid())
          )
        )
    )
  );

-- From 029: the host's pencil, split three ways so SELECT has one policy.
DROP POLICY IF EXISTS bgb_session_scores_insert ON public.boardgamebuddy_play_session_scores;
CREATE POLICY bgb_session_scores_insert ON public.boardgamebuddy_play_session_scores
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_sessions s
      WHERE s.id = boardgamebuddy_play_session_scores.session_id
        AND s.phase = 'play'
        AND s.host_user_id = (select public.bgb_app_uid())
    )
  );

DROP POLICY IF EXISTS bgb_session_scores_update ON public.boardgamebuddy_play_session_scores;
CREATE POLICY bgb_session_scores_update ON public.boardgamebuddy_play_session_scores
  FOR UPDATE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_sessions s
      WHERE s.id = boardgamebuddy_play_session_scores.session_id
        AND s.phase = 'play'
        AND s.host_user_id = (select public.bgb_app_uid())
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_sessions s
      WHERE s.id = boardgamebuddy_play_session_scores.session_id
        AND s.phase = 'play'
        AND s.host_user_id = (select public.bgb_app_uid())
    )
  );

DROP POLICY IF EXISTS bgb_session_scores_delete ON public.boardgamebuddy_play_session_scores;
CREATE POLICY bgb_session_scores_delete ON public.boardgamebuddy_play_session_scores
  FOR DELETE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_sessions s
      WHERE s.id = boardgamebuddy_play_session_scores.session_id
        AND s.phase = 'play'
        AND s.host_user_id = (select public.bgb_app_uid())
    )
  );

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- No policy should mention auth.uid() any more. Must return zero rows:
--
--   SELECT policyname, tablename FROM pg_policies
--    WHERE schemaname = 'public'
--      AND (qual LIKE '%auth.uid()%' OR with_check LIKE '%auth.uid()%');
