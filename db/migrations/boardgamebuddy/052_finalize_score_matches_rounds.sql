-- 052_finalize_score_matches_rounds.sql — stop the wrap-up from writing a play
-- whose total disagrees with its own round breakdown.
--
-- bgb_finalize_session (042) overlays the joiners' live scoring onto the host's
-- payload. It did that by replacing `score` for every authed player who had ANY
-- row in boardgamebuddy_play_session_scores with SUM(score) over that whole
-- table — while `round_scores`, the per-round array shown under the total in
-- the play-detail popup, rode through from the payload untouched. Three ways
-- that lands a play whose maths visibly doesn't work:
--
--   1. A host edit that never reached the scores table (flaky link, Realtime
--      asleep) is in round_scores but not in the SUM. The recorded total is
--      lower than the rounds printed beneath it.
--   2. A removed round whose DELETE didn't land is in the SUM but not in
--      round_scores. The recorded total is higher.
--   3. A player who has only the null placeholder row the host writes on
--      "+ Round" matches the join, so their host-typed score is replaced by
--      SUM(NULL) → 0. Their column empties out on save.
--
-- The client now folds the live overlay into its own grid before building the
-- payload (play-flow-view._commitResolvedScores), and PlayerEntry re-derives
-- `score` from `round_scores` on the way in, so a payload that carries a round
-- breakdown is already the scoreboard the host was looking at. This migration
-- makes the RPC respect that: the live overlay is now a FALLBACK for players
-- the payload has no per-round detail for, not an override of the detail it
-- does have. Rows whose score IS NULL no longer make a player look "live
-- scored", so case 3 can't fire either.
--
-- Function body only — no schema change, no data backfill. Plays already
-- written with a mismatched total keep it; the round_scores column records
-- what actually happened round by round.

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
  v_merged  JSONB;
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

  -- Overlay live scoring onto the host's payload, for the players it can
  -- legitimately speak for:
  --
  --   * a player whose payload entry carries a round_scores array is left
  --     alone — that array is the grid, and `score` is already its sum;
  --   * a guest (user_id IS NULL) is never in the scores table, so their
  --     host-typed score rides through as it always has;
  --   * an authed player with no round breakdown takes the sum of the rounds
  --     joiners streamed in during phase='play'.
  --
  -- `WHERE sc.score IS NOT NULL` keeps the placeholder rows "+ Round" writes
  -- from counting as live scoring: a player with nothing but placeholders
  -- drops out of `totals` entirely and keeps whatever the host typed, instead
  -- of being overwritten with 0.
  WITH totals AS (
    SELECT sc.player_user_id, SUM(sc.score)::INT AS total
      FROM boardgamebuddy_play_session_scores sc
     WHERE sc.session_id = v_session.id
       AND sc.score IS NOT NULL
     GROUP BY sc.player_user_id
  )
  SELECT COALESCE(jsonb_agg(
           CASE
             WHEN t.player_user_id IS NOT NULL
               THEN jsonb_set(pl.value, '{score}', to_jsonb(t.total))
             ELSE pl.value
           END ORDER BY pl.ord
         ), '[]'::JSONB)
    INTO v_merged
    FROM jsonb_array_elements(COALESCE(p_payload->'players', '[]'::JSONB))
           WITH ORDINALITY AS pl(value, ord)
    LEFT JOIN totals t
           ON pl.value->>'user_id' IS NOT NULL
          AND jsonb_typeof(COALESCE(pl.value->'round_scores', 'null'::JSONB)) <> 'array'
          AND t.player_user_id = (pl.value->>'user_id')::UUID;

  v_play := bgb_log_play(p_host, jsonb_set(p_payload, '{players}', v_merged));

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
