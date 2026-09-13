-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — split bgb_session_scores_write so SELECT has one policy
--
-- Clears Supabase's multiple_permissive_policies warning:
--
--   Table public.boardgamebuddy_play_session_scores has multiple permissive
--   policies for role authenticated for action SELECT. Policies include
--   {bgb_session_scores_select, bgb_session_scores_write}
--
-- WHY IT FIRES
--   bgb_session_scores_write (025) is declared FOR ALL, and FOR ALL includes
--   SELECT. So every read of this table evaluates two permissive policies and
--   ORs them, and neither can short-circuit the other: Postgres has to run
--   both subplans per row. This table is read on the hot path — the live-score
--   grid backfills it on open and re-reads it on every poll tick
--   (web/domain/live-scores.js) — so the duplicated check is paid constantly.
--
-- WHY THE FIX IS FREE
--   The write policy contributes nothing to SELECT that the read policy does
--   not already allow. Compare the two conditions:
--
--     _select : session s WHERE s.id = session_id
--                 AND (s.host_user_id = uid OR participant OR viewer)
--     _write  : session s WHERE s.id = session_id
--                 AND s.phase = 'play' AND s.host_user_id = uid
--
--   Any row the write policy admits has s.host_user_id = uid, which the read
--   policy's first arm already admits — without the phase test, so it is
--   strictly wider. The write policy's SELECT arm is a strict subset and
--   therefore dead weight. Dropping it cannot change what anyone can read;
--   that is asserted row-by-row in the verification at the bottom.
--
-- WHAT REPLACES IT
--   The same condition, restated as the three write verbs the client actually
--   uses. The host edits live scores straight from the browser through
--   supabase-js, so all three are load-bearing (web/domain/live-scores.js):
--     INSERT + UPDATE — _sendRows() upserts cells with onConflict on
--                       (session_id, participant_id, round_index)
--     DELETE          — removeRoundAt() drops the tail before rewriting it
--
--   FOR ALL applied USING to SELECT/UPDATE/DELETE and WITH CHECK to
--   INSERT/UPDATE, so the split below reproduces it exactly, minus SELECT.
--
--   Both halves of the condition stay load-bearing: without the phase test a
--   host could rewrite scores after finalizing (archive/053), and after
--   finalize the host can still READ the grid — that comes from
--   bgb_session_scores_select, which has no phase test and is unchanged.
--
-- Idempotent: safe to re-run.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DROP POLICY IF EXISTS bgb_session_scores_write  ON public.boardgamebuddy_play_session_scores;
DROP POLICY IF EXISTS bgb_session_scores_insert ON public.boardgamebuddy_play_session_scores;
DROP POLICY IF EXISTS bgb_session_scores_update ON public.boardgamebuddy_play_session_scores;
DROP POLICY IF EXISTS bgb_session_scores_delete ON public.boardgamebuddy_play_session_scores;

-- INSERT — new cells. FOR ALL gave INSERT only a WITH CHECK.
CREATE POLICY bgb_session_scores_insert ON public.boardgamebuddy_play_session_scores
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_sessions s
      WHERE s.id = boardgamebuddy_play_session_scores.session_id
        AND s.phase = 'play'
        AND s.host_user_id = (select auth.uid())
    )
  );

-- UPDATE — the ON CONFLICT arm of the upsert. Needs both: USING picks the
-- rows that may be rewritten, WITH CHECK constrains what they may become.
CREATE POLICY bgb_session_scores_update ON public.boardgamebuddy_play_session_scores
  FOR UPDATE TO authenticated USING (
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

-- DELETE — removeRoundAt()'s tail drop.
CREATE POLICY bgb_session_scores_delete ON public.boardgamebuddy_play_session_scores
  FOR DELETE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_sessions s
      WHERE s.id = boardgamebuddy_play_session_scores.session_id
        AND s.phase = 'play'
        AND s.host_user_id = (select auth.uid())
    )
  );

-- bgb_session_scores_select is deliberately untouched: it is now the only
-- permissive policy on SELECT, which is the point.

COMMIT;


-- ── Verification ────────────────────────────────────────────────────────────
-- 1) No action on this table has two permissive policies for one role.
--    Must return zero rows:
--
--   WITH x AS (
--     SELECT p.tablename, r.role, a.act, p.policyname
--       FROM pg_policies p
--       CROSS JOIN LATERAL unnest(p.roles) AS r(role)
--       CROSS JOIN LATERAL unnest(CASE WHEN p.cmd = 'ALL'
--                                 THEN ARRAY['SELECT','INSERT','UPDATE','DELETE']
--                                 ELSE ARRAY[p.cmd] END) AS a(act)
--      WHERE p.schemaname = 'public'
--        AND p.permissive = 'PERMISSIVE'
--        AND p.tablename = 'boardgamebuddy_play_session_scores'
--        AND (p.cmd <> 'INSERT' OR a.act <> 'SELECT')
--   )
--   SELECT tablename, role, act, array_agg(policyname ORDER BY policyname)
--     FROM x GROUP BY tablename, role, act HAVING count(*) > 1;
--
-- 2) The four policies are there, one per action:
--
--   SELECT policyname, cmd, roles FROM pg_policies
--    WHERE schemaname = 'public'
--      AND tablename = 'boardgamebuddy_play_session_scores'
--    ORDER BY cmd, policyname;
