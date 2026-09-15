-- 006_bgg_check_session.sql
--
-- Give POST /bgg/check its own session anchor, and stop its rows being counted
-- as part of the last import.
--
-- THE BUG. A check queues kind='catalog' rows into
-- boardgamebuddy_bgg_pending_imports so it can name games BgB has never seen.
-- bgb_bgg_sync_status's session roll-up filtered only on
-- `created_at >= bgg_last_sync_started_at` with no kind filter, so those rows
-- landed inside the last IMPORT's window. Two consequences, both visible:
--
--   * Run a sync, then a check, then reopen Settings: the finished import reads
--     as unfinished, because the check's rows inflated session_total and the
--     FE's exit condition is (done + errored) >= total.
--   * A user who has never synced has bgg_last_sync_started_at IS NULL, so
--     session_total is 0, Bgg.importDrained() returns true immediately, and the
--     "still naming games" poll exits while the worker is still running.
--
-- THE FIX, in two halves:
--   1. `AND kind <> 'catalog'` on the import roll-up, so an import session
--      counts only import rows.
--   2. A second roll-up over kind='catalog' anchored on a new
--      profiles.bgg_last_check_started_at, returned as catalog_session_*.
--
-- Extended in place rather than added as a second RPC because a check 409s
-- while an import is running (and vice versa), so the two can never overlap,
-- and the FE already polls this endpoint.

-- ── 1. The check's own session anchor ────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_profiles
  ADD COLUMN IF NOT EXISTS bgg_last_check_started_at TIMESTAMPTZ;

COMMENT ON COLUMN public.boardgamebuddy_profiles.bgg_last_check_started_at IS
  'Stamped at the top of POST /bgg/check. Anchors the catalog_session_* '
  'counters on bgb_bgg_sync_status, which count kind=''catalog'' rows only.';

-- ── 2. The status RPC ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bgb_bgg_sync_status(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_username TEXT;
  v_has_creds BOOLEAN;
  v_session_start TIMESTAMPTZ;
  v_check_start TIMESTAMPTZ;
  v_pending BIGINT;
  v_errored BIGINT;
  v_last_completed TIMESTAMPTZ;
  v_session_total BIGINT := 0;
  v_session_done BIGINT := 0;
  v_session_errored BIGINT := 0;
  v_names JSONB := '[]'::jsonb;
  v_cat_total BIGINT := 0;
  v_cat_done BIGINT := 0;
  v_cat_errored BIGINT := 0;
  v_cat_names JSONB := '[]'::jsonb;
BEGIN
  SELECT pr.bgg_username,
         (COALESCE(pr.bgg_username, '') <> '' AND COALESCE(pr.bgg_password_enc, '') <> ''),
         pr.bgg_last_sync_started_at,
         pr.bgg_last_check_started_at
    INTO v_username, v_has_creds, v_session_start, v_check_start
    FROM boardgamebuddy_profiles pr
    WHERE pr.id = p_user;

  -- Lifetime counters, unchanged: they back the Settings header copy and are
  -- deliberately NOT the poll's exit condition.
  SELECT count(*) FILTER (WHERE status = 'pending'),
         count(*) FILTER (WHERE status = 'error'),
         max(completed_at) FILTER (WHERE status = 'done')
    INTO v_pending, v_errored, v_last_completed
    FROM boardgamebuddy_bgg_pending_imports
    WHERE user_id = p_user;

  IF v_session_start IS NOT NULL THEN
    WITH roll AS (
      SELECT bgg_id,
             CASE WHEN bool_or(status = 'pending') THEN 'pending'
                  WHEN bool_or(status = 'error') THEN 'error'
                  ELSE 'done' END AS st
      FROM boardgamebuddy_bgg_pending_imports
      WHERE user_id = p_user
        AND created_at >= v_session_start
        AND kind <> 'catalog'          -- migration 006: a check is not an import
        AND bgg_id IS NOT NULL
        AND status IS NOT NULL
      GROUP BY bgg_id
    )
    SELECT count(*),
           count(*) FILTER (WHERE st = 'done'),
           count(*) FILTER (WHERE st = 'error')
      INTO v_session_total, v_session_done, v_session_errored
      FROM roll;

    IF v_session_done > 0 THEN
      WITH roll AS (
        SELECT bgg_id,
               CASE WHEN bool_or(status = 'pending') THEN 'pending'
                    WHEN bool_or(status = 'error') THEN 'error'
                    ELSE 'done' END AS st
        FROM boardgamebuddy_bgg_pending_imports
        WHERE user_id = p_user
          AND created_at >= v_session_start
          AND kind <> 'catalog'
          AND bgg_id IS NOT NULL
          AND status IS NOT NULL
        GROUP BY bgg_id
      ),
      -- Most recent all-time completed_at per session-done bgg_id (the
      -- Python path queried done rows for those ids without the session
      -- filter), newest 20 first.
      latest AS (
        SELECT DISTINCT ON (pi.bgg_id) pi.bgg_id, pi.completed_at
        FROM boardgamebuddy_bgg_pending_imports pi
        JOIN roll r ON r.bgg_id = pi.bgg_id AND r.st = 'done'
        WHERE pi.user_id = p_user AND pi.status = 'done'
        ORDER BY pi.bgg_id, pi.completed_at DESC
      ),
      top20 AS (
        SELECT bgg_id, completed_at
        FROM latest
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 20
      )
      SELECT COALESCE(jsonb_agg(g.name ORDER BY t.completed_at DESC NULLS LAST), '[]'::jsonb)
        INTO v_names
        FROM top20 t
        JOIN boardgamebuddy_games g ON g.bgg_id = t.bgg_id
        WHERE g.name IS NOT NULL;
    END IF;
  END IF;

  -- ── The catalog fill a check kicked off ───────────────────────────────────
  -- No bgg_id roll-up here: a catalog row is one game by construction
  -- (unique on user_id, bgg_id, kind), so count(*) is already per-game.
  IF v_check_start IS NOT NULL THEN
    SELECT count(*),
           count(*) FILTER (WHERE status = 'done'),
           count(*) FILTER (WHERE status = 'error')
      INTO v_cat_total, v_cat_done, v_cat_errored
      FROM boardgamebuddy_bgg_pending_imports
      WHERE user_id = p_user
        AND kind = 'catalog'
        AND created_at >= v_check_start;

    IF v_cat_done > 0 THEN
      SELECT COALESCE(jsonb_agg(g.name ORDER BY t.completed_at DESC NULLS LAST), '[]'::jsonb)
        INTO v_cat_names
        FROM (
          SELECT pi.bgg_id, pi.completed_at
          FROM boardgamebuddy_bgg_pending_imports pi
          WHERE pi.user_id = p_user
            AND pi.kind = 'catalog'
            AND pi.created_at >= v_check_start
            AND pi.status = 'done'
          ORDER BY pi.completed_at DESC NULLS LAST
          LIMIT 20
        ) t
        JOIN boardgamebuddy_games g ON g.bgg_id = t.bgg_id
        WHERE g.name IS NOT NULL;
    END IF;
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
    'catalog_session_started_at', v_check_start,
    'catalog_session_total', COALESCE(v_cat_total, 0),
    'catalog_session_done', COALESCE(v_cat_done, 0),
    'catalog_session_errored', COALESCE(v_cat_errored, 0),
    'catalog_session_game_names', v_cat_names
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.bgb_bgg_sync_status(p_user uuid) TO boardgamebuddy_role;
