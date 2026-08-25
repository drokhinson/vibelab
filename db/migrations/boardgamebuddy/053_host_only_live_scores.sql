-- 053_host_only_live_scores.sql — the host is the only person who scores.
--
-- Until now the live Play phase was co-editable: the host owned the whole grid
-- and each authenticated joiner owned exactly one column (their own). That
-- split is what migration 052 had to reconcile at finalize time, and it left
-- guests (roster rows with no account) unrepresentable — the scores table was
-- keyed by player_user_id, so a guest's cells never reached anyone else's
-- screen.
--
-- The model is now: the host types every cell, and everybody else watches.
-- Three consequences, all in this migration:
--
--   1. The scores table is keyed by PARTICIPANT, not by user. A guest has a
--      participant row like anyone else, so their column streams too.
--   2. RLS write access narrows to the host of the session.
--   3. bgb_finalize_session stops overlaying live scores onto the host's
--      payload — under host-only editing the payload IS the grid, so the
--      overlay could only ever disagree with it.
--
-- Plus one latent bug: migration 034 granted SELECT/INSERT/UPDATE but not
-- DELETE, while LiveScores.removeRoundAt() has always issued a .delete().
-- Removing a round therefore never cleared its rows, and every spectator kept
-- rendering a phantom trailing round (their grid is sized from the highest
-- round_index in the table). Safe to grant now that only the host can write.


-- ── 1. Re-key boardgamebuddy_play_session_scores by participant ──────────────
ALTER TABLE public.boardgamebuddy_play_session_scores
  ADD COLUMN IF NOT EXISTS participant_id UUID
    REFERENCES public.boardgamebuddy_play_session_participants(id)
    ON DELETE CASCADE;

UPDATE public.boardgamebuddy_play_session_scores sc
   SET participant_id = p.id
  FROM public.boardgamebuddy_play_session_participants p
 WHERE p.session_id = sc.session_id
   AND p.user_id    = sc.player_user_id
   AND sc.participant_id IS NULL;

-- A score row whose participant row is gone cannot be re-keyed. Sessions carry
-- a 2h expires_at and these rows only live for the duration of one Play phase,
-- so this is a handful of in-flight cells at most.
DELETE FROM public.boardgamebuddy_play_session_scores
 WHERE participant_id IS NULL;

ALTER TABLE public.boardgamebuddy_play_session_scores
  ALTER COLUMN participant_id SET NOT NULL;

ALTER TABLE public.boardgamebuddy_play_session_scores
  DROP CONSTRAINT IF EXISTS boardgamebuddy_play_session_scores_pkey;
ALTER TABLE public.boardgamebuddy_play_session_scores
  ADD PRIMARY KEY (session_id, participant_id, round_index);

-- Nothing reads player_user_id after step 3 below (bgb_finalize_session was
-- its only server-side reader, and both clients now key by participant). A
-- denormalized copy of the participant's user would only invite drift.
ALTER TABLE public.boardgamebuddy_play_session_scores
  DROP COLUMN IF EXISTS player_user_id;


-- ── 2. RLS: writes are host-only ─────────────────────────────────────────────
-- Replaces the two-principal policy from migration 026, which also allowed
-- `player_user_id = auth.uid()`. Still gated on phase='play' — after the host
-- advances to 'settle' the live grid freezes so late writes can't race the
-- finalize. bgb_session_scores_select (host OR participant) is unchanged.
DROP POLICY IF EXISTS bgb_session_scores_write
  ON public.boardgamebuddy_play_session_scores;
CREATE POLICY bgb_session_scores_write ON public.boardgamebuddy_play_session_scores
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_sessions s
      WHERE s.id = session_id
        AND s.phase = 'play'
        AND s.host_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.boardgamebuddy_play_sessions s
      WHERE s.id = session_id
        AND s.phase = 'play'
        AND s.host_user_id = auth.uid()
    )
  );

-- Round removal deletes the tail and rewrites it from the shifted map; without
-- this grant the DELETE half has been 403-ing into a best-effort try/catch.
GRANT DELETE ON public.boardgamebuddy_play_session_scores TO authenticated;


-- ── 3. bgb_finalize_session: the host's payload is the grid ──────────────────
-- Migration 042 introduced a live-score overlay here and 052 narrowed it to a
-- fallback for authed players whose payload entry carried no round breakdown.
-- That case existed because a joiner could author cells the host's draft had
-- never seen. It cannot happen any more: the host types everything, and
-- play-flow-view._commitResolvedScores folds the live overlay into the draft
-- before building the payload. Keeping the overlay would only reintroduce the
-- class of bug 052 was written to fix, so it goes.
CREATE OR REPLACE FUNCTION public.bgb_finalize_session(
  p_host    UUID,
  p_code    TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  v_play := bgb_log_play(p_host, p_payload);

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
$$;
