-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Cascading three-screen play flow
--
-- Two additions support the new Gather → Play → Settle Up flow:
--   1. boardgamebuddy_play_sessions.phase — host-driven cursor through the
--      three screens. The existing `status` column stays (drives expiry +
--      finalize bookkeeping); `phase` is what joiners watch via Realtime
--      so they auto-advance when the host moves forward.
--   2. boardgamebuddy_play_session_scores — per-player, per-round live
--      scoring table. Authed joiners write their own column straight from
--      the browser (RLS-gated); the host can write any participant's row.
--      Supabase Realtime fanout means both sides see the cell update
--      within ~1s of the write.
--
-- Realtime publication is opened on both tables. The browser uses the
-- anon key + RLS to read/write; the FastAPI layer keeps using the service
-- role key for the regular session CRUD endpoints.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. phase column on play_sessions ─────────────────────────────────────────
ALTER TABLE public.boardgamebuddy_play_sessions
  ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'gather'
    CHECK (phase IN ('gather', 'play', 'settle', 'finalized', 'abandoned'));

-- Backfill: any session that's already finalized or abandoned takes its
-- corresponding phase; everything else (status='open') starts at gather.
UPDATE public.boardgamebuddy_play_sessions
  SET phase = CASE
    WHEN status = 'finalized' THEN 'finalized'
    WHEN status = 'abandoned' THEN 'abandoned'
    ELSE 'gather'
  END
  WHERE phase = 'gather';

CREATE INDEX IF NOT EXISTS idx_bgb_play_sessions_code_phase
  ON public.boardgamebuddy_play_sessions (code, phase);

-- ── 2. live-scores table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_session_scores (
  session_id     UUID NOT NULL
                   REFERENCES public.boardgamebuddy_play_sessions(id)
                   ON DELETE CASCADE,
  player_user_id UUID NOT NULL
                   REFERENCES public.boardgamebuddy_profiles(id)
                   ON DELETE CASCADE,
  -- Round numbers are 0-indexed. Cap at 64 so a stuck client can't blow up
  -- the table; the longest real-world round counts (e.g. Catan turn logs)
  -- stay comfortably under this.
  round_index    SMALLINT NOT NULL CHECK (round_index >= 0 AND round_index < 64),
  score          INTEGER,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, player_user_id, round_index)
);
ALTER TABLE public.boardgamebuddy_play_session_scores ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_play_session_scores TO boardgamebuddy_role;

CREATE INDEX IF NOT EXISTS idx_bgb_play_session_scores_session
  ON public.boardgamebuddy_play_session_scores (session_id, round_index);

-- ── 3. RLS policies ──────────────────────────────────────────────────────────
-- play_sessions: limited SELECT so the Realtime channel filter can resolve
-- when the joiner's anon-key client subscribes to phase updates. Scoped to
-- host + participants only — leaking a session row to an unrelated authed
-- user would expose host_user_id + game_id with no upside.
DROP POLICY IF EXISTS bgb_play_sessions_select ON public.boardgamebuddy_play_sessions;
CREATE POLICY bgb_play_sessions_select ON public.boardgamebuddy_play_sessions
  FOR SELECT TO authenticated
  USING (
    host_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_session_participants p
      WHERE p.session_id = boardgamebuddy_play_sessions.id
        AND p.user_id = auth.uid()
    )
  );

-- play_session_scores: read = anyone in the session (host or participant).
DROP POLICY IF EXISTS bgb_session_scores_select ON public.boardgamebuddy_play_session_scores;
CREATE POLICY bgb_session_scores_select ON public.boardgamebuddy_play_session_scores
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_sessions s
      WHERE s.id = session_id
        AND (
          s.host_user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.boardgamebuddy_play_session_participants p
            WHERE p.session_id = s.id AND p.user_id = auth.uid()
          )
        )
    )
  );

-- play_session_scores: write = own row OR host-of-session, only while
-- the session is in phase='play'. After the host advances to 'settle' the
-- live grid freezes — late edits would race with finalize.
DROP POLICY IF EXISTS bgb_session_scores_write ON public.boardgamebuddy_play_session_scores;
CREATE POLICY bgb_session_scores_write ON public.boardgamebuddy_play_session_scores
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_sessions s
      WHERE s.id = session_id
        AND s.phase = 'play'
        AND (s.host_user_id = auth.uid() OR player_user_id = auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_sessions s
      WHERE s.id = session_id
        AND s.phase = 'play'
        AND (s.host_user_id = auth.uid() OR player_user_id = auth.uid())
    )
  );

-- ── 4. Realtime publication ──────────────────────────────────────────────────
-- The publication may already include these tables on re-run; wrap in a DO
-- block so the migration is idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'boardgamebuddy_play_sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime
      ADD TABLE public.boardgamebuddy_play_sessions;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'boardgamebuddy_play_session_scores'
  ) THEN
    ALTER PUBLICATION supabase_realtime
      ADD TABLE public.boardgamebuddy_play_session_scores;
  END IF;
END $$;
