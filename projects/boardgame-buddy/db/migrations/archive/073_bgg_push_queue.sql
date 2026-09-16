-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy 073 — BgB → BGG collection push
--
-- Adds the outbound half of the BoardGameGeek integration. Until now sync was
-- one-way: POST /bgg/sync pulled a collection down and every local shelf edit
-- stayed local, so the two views diverged the moment anyone curated in BgB.
--
-- Three objects:
--   1. boardgamebuddy_bgg_push_queue — one row per planned change, drained by
--      a BackgroundTask. State lives here, not in memory, so a Railway restart
--      mid-push resumes instead of replaying.
--   2. profiles.bgg_last_push_started_at — the session stamp the status RPC
--      counts from, mirroring bgg_last_sync_started_at.
--   3. bgb_bgg_push_status(uuid) — the polled endpoint, one round trip.
--
-- Plus one widening: pending_imports.kind gains 'catalog', for a game that
-- must enter the game CATALOG without landing on anyone's shelf.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── 1. Catalog-only imports ─────────────────────────────────────────────────
-- POST /bgg/check finds games on the user's BGG shelf that BgB has never seen.
-- Left alone they would appear in the comparison as bare numeric ids, so they
-- are queued for import — but as kind='catalog', which materializes the game
-- row and nothing else. A shelf row would silently reverse the mirror: the
-- game would stop reading as "only on BGG" and the push would no longer offer
-- to clear it.
ALTER TABLE public.boardgamebuddy_bgg_pending_imports
  DROP CONSTRAINT IF EXISTS boardgamebuddy_bgg_pending_imports_kind_check;
ALTER TABLE public.boardgamebuddy_bgg_pending_imports
  ADD CONSTRAINT boardgamebuddy_bgg_pending_imports_kind_check
  CHECK (kind IN ('collection', 'play', 'catalog'));

-- ─── 2. Session stamp ────────────────────────────────────────────────────────
ALTER TABLE public.boardgamebuddy_profiles
  ADD COLUMN IF NOT EXISTS bgg_last_push_started_at TIMESTAMPTZ;

-- ─── 3. The push queue ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_bgg_push_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  bgg_id INTEGER NOT NULL,
  -- Denormalized at plan time so the status RPC never joins games — and so a
  -- 'clear' row, which by definition has no local game, still has a name to
  -- show in the progress log.
  game_name TEXT NOT NULL,
  -- BGG's collection-row id. NULL is the ONLY case that creates a row on BGG
  -- rather than editing one, and the payload branches on this rather than on
  -- `change`: a game flagged only fortrade is invisible to the status sweep,
  -- so an 'add' can still turn out to have an existing collection row. Sending
  -- no collid for one of those would create a duplicate and orphan the user's
  -- rating and comment on the original.
  bgg_collid BIGINT,
  change TEXT NOT NULL CHECK (change IN ('add', 'update', 'clear')),
  target_status TEXT CHECK (target_status IN ('owned', 'wishlist', 'prev_owned')),
  -- The complete form field set, frozen at plan time: the flags BgB owns at
  -- their target values PLUS every other <status> attribute echoed back
  -- verbatim. Frozen rather than recomputed per row so the worker never
  -- re-reads BGG, and so editing your shelf mid-push cannot produce a
  -- half-old, half-new write set.
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'error')),
  attempts INT NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT bgb_push_change_status CHECK (
    (change IN ('add', 'update') AND target_status IS NOT NULL) OR
    (change = 'clear' AND target_status IS NULL)
  ),
  -- One planned change per game per user. Re-planning upserts on this.
  UNIQUE (user_id, bgg_id)
);
ALTER TABLE public.boardgamebuddy_bgg_push_queue ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_bgg_push_queue TO boardgamebuddy_role;

CREATE INDEX IF NOT EXISTS idx_bgb_push_queue_user_pending
  ON public.boardgamebuddy_bgg_push_queue (user_id, status)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_bgb_push_queue_user_created
  ON public.boardgamebuddy_bgg_push_queue (user_id, created_at);

-- ─── 4. The polled status ────────────────────────────────────────────────────
-- Modelled on bgb_bgg_sync_status (039) but simpler: UNIQUE(user_id, bgg_id)
-- means one row per game, so there is no per-id roll-up and no games join.
--
-- session_errors has no counterpart on the import RPC, and is the reason this
-- is not just a copy. A half-failed import can be re-run and idempotency
-- cleans up; a half-failed push has left flags on a third-party account in an
-- unknown state, so the user has to be told WHICH games.
--
-- Why a separate table rather than kind='push' on pending_imports:
-- bgb_bgg_sync_status counts every row for the user with no kind filter, so a
-- queued push would inflate the IMPORT poll's pending_count and pin it open
-- forever.
CREATE OR REPLACE FUNCTION public.bgb_bgg_push_status(p_user UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_username TEXT;
  v_has_creds BOOLEAN;
  v_session_start TIMESTAMPTZ;
  v_pending BIGINT;
  v_errored BIGINT;
  v_last_completed TIMESTAMPTZ;
  v_session_total BIGINT := 0;
  v_session_done BIGINT := 0;
  v_session_errored BIGINT := 0;
  v_names JSONB := '[]'::jsonb;
  v_errors JSONB := '[]'::jsonb;
BEGIN
  -- Same expression as bgb_bgg_sync_status so the route derives auth_state
  -- identically without the encrypted secret crossing the JSONB boundary.
  SELECT pr.bgg_username,
         (COALESCE(pr.bgg_username, '') <> '' AND COALESCE(pr.bgg_password_enc, '') <> ''),
         pr.bgg_last_push_started_at
    INTO v_username, v_has_creds, v_session_start
    FROM boardgamebuddy_profiles pr
    WHERE pr.id = p_user;

  SELECT count(*) FILTER (WHERE status = 'pending'),
         count(*) FILTER (WHERE status = 'error'),
         max(completed_at) FILTER (WHERE status = 'done')
    INTO v_pending, v_errored, v_last_completed
    FROM boardgamebuddy_bgg_push_queue
    WHERE user_id = p_user;

  IF v_session_start IS NOT NULL THEN
    SELECT count(*),
           count(*) FILTER (WHERE status = 'done'),
           count(*) FILTER (WHERE status = 'error')
      INTO v_session_total, v_session_done, v_session_errored
      FROM boardgamebuddy_bgg_push_queue
      WHERE user_id = p_user AND created_at >= v_session_start;

    SELECT COALESCE(jsonb_agg(name ORDER BY completed_at DESC NULLS LAST), '[]'::jsonb)
      INTO v_names
      FROM (
        SELECT game_name AS name, completed_at
        FROM boardgamebuddy_bgg_push_queue
        WHERE user_id = p_user
          AND created_at >= v_session_start
          AND status = 'done'
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 20
      ) done20;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'game_name', game_name, 'message', COALESCE(error_message, 'Unknown error')
           )), '[]'::jsonb)
      INTO v_errors
      FROM (
        SELECT game_name, error_message
        FROM boardgamebuddy_bgg_push_queue
        WHERE user_id = p_user
          AND created_at >= v_session_start
          AND status = 'error'
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 20
      ) err20;
  END IF;

  RETURN jsonb_build_object(
    'bgg_username', v_username,
    'has_credentials', COALESCE(v_has_creds, false),
    'pending_count', COALESCE(v_pending, 0),
    'errored_count', COALESCE(v_errored, 0),
    'last_completed_at', v_last_completed,
    'session_started_at', v_session_start,
    'session_total', COALESCE(v_session_total, 0),
    'session_done', COALESCE(v_session_done, 0),
    'session_errored', COALESCE(v_session_errored, 0),
    'session_game_names', v_names,
    'session_errors', v_errors
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.bgb_bgg_push_status(UUID) TO boardgamebuddy_role;

COMMIT;
