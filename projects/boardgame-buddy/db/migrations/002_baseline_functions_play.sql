-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — baseline: play functions
--
-- Run on an empty database in this order: 001_baseline_tables.sql,
--   002_baseline_functions_play.sql (this file),
--   003_baseline_functions_social.sql, 004_seed.sql
-- then every later NNN_*.sql in this directory, in number order.
--
-- Generated on 2026-09-29 by .claude/skills/squash-migrations/squash.py from
-- the 58 migrations in archive/2026-09-28/ and
-- 059_comments_describe_current_schema.sql: they were replayed into an empty
-- database and these files were read back out of its catalog. A database built
-- from them diffs clean against that replay.
--
-- FRESH-DB ONLY. Production reaches this state through the migrations it was
-- generated from. Never run these files there.
--
-- Needs these first, for the cross-app tables it reads:
-- _shared/001_analytics.sql, _shared/004_api_logs.sql,
-- _shared/005_api_sessions.sql, _shared/006_drop_api_sessions.sql.
--
-- Games and the table: logging and importing plays, live sessions, ghost
-- players and claims, the catalog, collection shelves, ranks, discover and BGG
-- sync. 51 functions, callees first, so the file runs top to bottom. Bodies
-- are pg_get_functiondef() output: the server's normalized rendering.
--
-- Grants are the difference from Supabase's defaults, which give anon,
-- authenticated and service_role everything on a new table or function (and
-- EXECUTE to PUBLIC). An object with no GRANT/REVOKE lines keeps them.
-- ─────────────────────────────────────────────────────────────────────────────


-- bgb_bgg_hot_latest()
CREATE OR REPLACE FUNCTION public.bgb_bgg_hot_latest()
 RETURNS TABLE(bgg_id integer, rank integer, name text, year_published integer, thumbnail_url text, prev_rank integer, rank_delta integer, is_new boolean, captured_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH latest AS (
  SELECT MAX(s.captured_at) AS at FROM public.boardgamebuddy_bgg_hot_snapshots s
),
prev AS (
  SELECT MAX(s.captured_at) AS at
    FROM public.boardgamebuddy_bgg_hot_snapshots s, latest
   WHERE s.captured_at <= latest.at - INTERVAL '20 hours'
)
SELECT cur.bgg_id,
       cur.rank,
       cur.name,
       cur.year_published,
       cur.thumbnail_url,
       p.rank                                            AS prev_rank,
       CASE WHEN p.rank IS NULL THEN NULL ELSE p.rank - cur.rank END AS rank_delta,
       (prev.at IS NOT NULL AND p.rank IS NULL)          AS is_new,
       cur.captured_at
  FROM public.boardgamebuddy_bgg_hot_snapshots cur
  JOIN latest ON cur.captured_at = latest.at
  CROSS JOIN prev
  LEFT JOIN public.boardgamebuddy_bgg_hot_snapshots p
         ON p.captured_at = prev.at AND p.bgg_id = cur.bgg_id
 ORDER BY cur.rank, cur.bgg_id;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_bgg_hot_latest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_bgg_hot_latest() TO boardgamebuddy_role;

-- bgb_bgg_push_status(p_user uuid)
CREATE OR REPLACE FUNCTION public.bgb_bgg_push_status(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_bgg_push_status(p_user uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_bgg_push_status(p_user uuid) TO boardgamebuddy_role;

-- bgb_bgg_sync_status(p_user uuid)
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
        AND kind <> 'catalog'          -- a check is not an import
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
REVOKE EXECUTE ON FUNCTION public.bgb_bgg_sync_status(p_user uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_bgg_sync_status(p_user uuid) TO boardgamebuddy_role;

-- bgb_collection_page(viewer uuid, target uuid, p_status text, p_search text, p_players integer, p_playtime_min integer, p_playtime_max integer, p_play_mode text, p_exclude_expansions boolean, p_sort text, p_prioritize_exact_players boolean, p_page integer, p_per_page integer)
CREATE OR REPLACE FUNCTION public.bgb_collection_page(viewer uuid, target uuid, p_status text DEFAULT 'owned'::text, p_search text DEFAULT NULL::text, p_players integer DEFAULT NULL::integer, p_playtime_min integer DEFAULT NULL::integer, p_playtime_max integer DEFAULT NULL::integer, p_play_mode text DEFAULT NULL::text, p_exclude_expansions boolean DEFAULT true, p_sort text DEFAULT 'last_played'::text, p_prioritize_exact_players boolean DEFAULT false, p_page integer DEFAULT 1, p_per_page integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- A blank search is no search. btrim first so a lone space does not filter
  -- the whole shelf away.
  v_search TEXT := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_excl BOOLEAN := COALESCE(p_exclude_expansions, true);
  -- Clamped to the same bounds FastAPI validates, so a direct caller cannot
  -- ask for a 10,000-row page.
  v_per_page INT := LEAST(GREATEST(COALESCE(p_per_page, 12), 1), 100);
  v_offset INT := GREATEST(COALESCE(p_page, 1) - 1, 0) * LEAST(GREATEST(COALESCE(p_per_page, 12), 1), 100);
  v_sort TEXT := COALESCE(p_sort, 'last_played');
  -- The exact-players bucket is opt-in AND needs a player count to be exact
  -- about; without one it is off, exactly as the Python guard had it.
  v_exact BOOLEAN := COALESCE(p_prioritize_exact_players, false) AND p_players IS NOT NULL;
  -- A game you sold is still on your Owned shelf, dimmed. Has to agree with
  -- bgb_collection_shelf's widening because the client falls back from
  -- one endpoint to the other mid scroll.
  v_statuses TEXT[] := CASE
    WHEN p_status = 'owned' THEN ARRAY['owned', 'prev_owned']
    ELSE ARRAY[p_status]
  END;
  v_total BIGINT := 0;
  v_parted BIGINT := 0;
  v_items JSONB;
BEGIN
  -- A wishlist is private to its owner. Same gate bgb_collection_shelf and
  -- bgb_profile_bundle apply, and IS DISTINCT FROM so a NULL viewer is not a
  -- match. Owned and played shelves are public.
  IF p_status = 'wishlist' AND viewer IS DISTINCT FROM target THEN
    RETURN jsonb_build_object('items', '[]'::jsonb, 'total', 0, 'parted_total', 0);
  END IF;

  IF p_status = 'played' THEN
    -- Played-not-owned: every game the target has a play for that has NO row
    -- on their collection table at all (owned AND wishlist both live there).
    --
    -- This branch ignores p_sort and p_prioritize_exact_players, which is what
    -- the Python did: the shelf is defined by recency, and it returned before
    -- reaching either. Kept rather than quietly widened.
    WITH played_games AS (
      -- EXISTS, never a join onto play_players: a join fans one play out to
      -- one row per participant, which multiplies play_count. Same visibility
      -- rule as bgb_play_stats — logged by them, or seated on it.
      SELECT p.game_id,
             MAX(p.played_at) AS last_played_at,
             COUNT(*)::INT    AS play_count
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
         OR EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = target
            )
      GROUP BY p.game_id
      UNION ALL
      -- Played but never logged here (status 'played').
      -- A game with a play is already above, so only the rest join.
      SELECT c.game_id, NULL, 0
      FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.status = 'played'
        AND NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_plays p2
              WHERE p2.game_id = c.game_id
                AND (p2.user_id = target OR EXISTS (
                      SELECT 1 FROM boardgamebuddy_play_players pp2
                      WHERE pp2.play_id = p2.id AND pp2.player_user_id = target))
            )
    ),
    filtered AS (
      SELECT pg.last_played_at, pg.play_count, g.*
      FROM played_games pg
      JOIN boardgamebuddy_games g ON g.id = pg.game_id
      WHERE NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_collections c
              WHERE c.user_id = target AND c.game_id = pg.game_id AND c.status <> 'played'
            )
        AND (NOT v_excl OR NOT g.is_expansion)
        -- A plain case-insensitive substring, not ILIKE: a user who types a %
        -- means a percent sign, not a wildcard.
        AND (v_search IS NULL OR strpos(lower(g.name), lower(v_search)) > 0)
        -- NULL bounds are permissive: a game that does not say how many can
        -- play is never filtered out by a player count.
        AND (p_players IS NULL OR g.max_players IS NULL OR g.max_players >= p_players)
        -- At six or more, the lower bound is dropped entirely, so a big-group
        -- search surfaces everything that can reach the table.
        AND (p_players IS NULL OR p_players >= 6 OR g.min_players IS NULL OR g.min_players <= p_players)
        -- Unknown playtime counts as zero, so a minimum excludes it and a
        -- maximum keeps it.
        AND (p_playtime_min IS NULL OR COALESCE(g.playing_time, 0) >= p_playtime_min)
        AND (p_playtime_max IS NULL OR COALESCE(g.playing_time, 0) <= p_playtime_max)
        AND (p_play_mode IS NULL OR g.play_mode = p_play_mode)
    ),
    page AS (
      SELECT f.*
      FROM filtered f
      ORDER BY f.last_played_at DESC NULLS LAST, f.id
      LIMIT v_per_page OFFSET v_offset
    )
    SELECT
      (SELECT COUNT(*) FROM filtered),
      COALESCE(jsonb_agg(jsonb_build_object(
        -- The synthetic id and date the Python minted. There is no collection
        -- row to take them from, and the client keys tiles on both.
        'id', 'played-' || q.id::TEXT,
        'game_id', q.id,
        'status', 'played',
        'added_at', COALESCE(q.last_played_at::TEXT || 'T00:00:00+00:00', (SELECT to_jsonb(c.added_at) #>> '{}' FROM boardgamebuddy_collections c WHERE c.user_id = target AND c.game_id = q.id)),
        'last_played_at', q.last_played_at,
        'play_count', COALESCE(q.play_count, 0),
        'game', jsonb_build_object(
          'id', q.id,
          'bgg_id', q.bgg_id,
          'name', q.name,
          'year_published', q.year_published,
          'min_players', q.min_players,
          'max_players', q.max_players,
          'playing_time', q.playing_time,
          'thumbnail_url', q.thumbnail_url,
          'image_url', q.image_url,
          'theme_color', q.theme_color,
          'is_expansion', q.is_expansion,
          'base_game_bgg_id', q.base_game_bgg_id,
          'expansion_color', q.expansion_color,
          'rulebook_url', q.rulebook_url,
          'play_mode', q.play_mode,
          'expansion_count', COALESCE(xc.n, 0)
        )
      -- jsonb_agg does not inherit the subquery's order, so the ordering is
      -- restated here as well as on the LIMIT that chose the page.
      ) ORDER BY q.last_played_at DESC NULLS LAST, q.id), '[]'::jsonb)
      INTO v_total, v_items
      FROM page q
      LEFT JOIN LATERAL (
        -- Catalog-wide, not the viewer's own expansions: the tile badge says
        -- how many exist for this game. An expansion scores 0 by the first
        -- predicate. This is the third round trip the endpoint used to make.
        SELECT COUNT(*)::INT AS n
        FROM boardgamebuddy_games e
        WHERE NOT q.is_expansion
          AND q.bgg_id IS NOT NULL
          AND e.is_expansion = true
          AND e.base_game_bgg_id = q.bgg_id
      ) xc ON true;

  ELSE
    -- Owned (widened to prev_owned) and wishlist.
    --
    -- An INNER join, because the Python skipped any collection row whose game
    -- row had gone. The join is also where every filter reads from: the grid
    -- has always filtered on the catalog row rather than the denormalized
    -- game_* columns, and rulebook_url is only on the catalog row.
    WITH filtered AS (
      SELECT c.id AS collection_id, c.status, c.added_at, g.*
      FROM boardgamebuddy_collections c
      JOIN boardgamebuddy_games g ON g.id = c.game_id
      WHERE c.user_id = target
        AND c.status = ANY(v_statuses)
        AND (NOT v_excl OR NOT g.is_expansion)
        AND (v_search IS NULL OR strpos(lower(g.name), lower(v_search)) > 0)
        AND (p_players IS NULL OR g.max_players IS NULL OR g.max_players >= p_players)
        AND (p_players IS NULL OR p_players >= 6 OR g.min_players IS NULL OR g.min_players <= p_players)
        AND (p_playtime_min IS NULL OR COALESCE(g.playing_time, 0) >= p_playtime_min)
        AND (p_playtime_max IS NULL OR COALESCE(g.playing_time, 0) <= p_playtime_max)
        AND (p_play_mode IS NULL OR g.play_mode = p_play_mode)
    ),
    counted AS (
      -- Both counts are over the FILTERED shelf, not the page: the client
      -- subtracts parted_total from a count that describes the whole shelf.
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE f.status = 'prev_owned') AS parted
      FROM filtered f
    ),
    page AS (
      SELECT f.*, ps.last_played_at, ps.play_count
      FROM filtered f
      LEFT JOIN LATERAL (
        -- Same visibility rule as bgb_play_stats. Per surviving row, and
        -- before the LIMIT when the sort reads it — nothing materialises a
        -- last_played_at on the collection row to sort by instead.
        SELECT MAX(p.played_at) AS last_played_at, COUNT(*)::INT AS play_count
        FROM boardgamebuddy_plays p
        WHERE p.game_id = f.id
          AND (
            p.user_id = target
            OR EXISTS (
                 SELECT 1 FROM boardgamebuddy_play_players pp
                 WHERE pp.play_id = p.id AND pp.player_user_id = target
               )
          )
      ) ps ON true
      ORDER BY
        -- Opt-in bucket first, so an exact fit leads without disturbing the
        -- chosen sort inside either bucket.
        CASE WHEN v_exact AND f.max_players = p_players THEN 0 ELSE 1 END,
        CASE WHEN v_sort = 'last_played' THEN ps.last_played_at END DESC NULLS LAST,
        CASE WHEN v_sort = 'alphabetical' THEN lower(f.name) END ASC NULLS LAST,
        CASE WHEN v_sort <> 'alphabetical' THEN f.added_at END DESC NULLS LAST,
        -- DELIBERATELY NOT PARITY. The Python left ties in whatever order
        -- PostgREST returned them, which is a paging hazard: a tied row can
        -- show up on two pages, or on none. A unique key makes the order total.
        f.id
      LIMIT v_per_page OFFSET v_offset
    )
    SELECT
      (SELECT total FROM counted),
      (SELECT parted FROM counted),
      COALESCE(jsonb_agg(jsonb_build_object(
        'id', q.collection_id,
        'game_id', q.id,
        'status', q.status,
        'added_at', q.added_at,
        'last_played_at', q.last_played_at,
        'play_count', COALESCE(q.play_count, 0),
        'game', jsonb_build_object(
          'id', q.id,
          'bgg_id', q.bgg_id,
          'name', q.name,
          'year_published', q.year_published,
          'min_players', q.min_players,
          'max_players', q.max_players,
          'playing_time', q.playing_time,
          'thumbnail_url', q.thumbnail_url,
          'image_url', q.image_url,
          'theme_color', q.theme_color,
          'is_expansion', q.is_expansion,
          'base_game_bgg_id', q.base_game_bgg_id,
          'expansion_color', q.expansion_color,
          'rulebook_url', q.rulebook_url,
          'play_mode', q.play_mode,
          'expansion_count', COALESCE(xc.n, 0)
        )
      ) ORDER BY
        CASE WHEN v_exact AND q.max_players = p_players THEN 0 ELSE 1 END,
        CASE WHEN v_sort = 'last_played' THEN q.last_played_at END DESC NULLS LAST,
        CASE WHEN v_sort = 'alphabetical' THEN lower(q.name) END ASC NULLS LAST,
        CASE WHEN v_sort <> 'alphabetical' THEN q.added_at END DESC NULLS LAST,
        q.id
      ), '[]'::jsonb)
      INTO v_total, v_parted, v_items
      FROM page q
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::INT AS n
        FROM boardgamebuddy_games e
        WHERE NOT q.is_expansion
          AND q.bgg_id IS NOT NULL
          AND e.is_expansion = true
          AND e.base_game_bgg_id = q.bgg_id
      ) xc ON true;
  END IF;

  RETURN jsonb_build_object(
    'items', COALESCE(v_items, '[]'::jsonb),
    'total', COALESCE(v_total, 0),
    'parted_total', COALESCE(v_parted, 0)
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_collection_page(viewer uuid, target uuid, p_status text, p_search text, p_players integer, p_playtime_min integer, p_playtime_max integer, p_play_mode text, p_exclude_expansions boolean, p_sort text, p_prioritize_exact_players boolean, p_page integer, p_per_page integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_collection_page(viewer uuid, target uuid, p_status text, p_search text, p_players integer, p_playtime_min integer, p_playtime_max integer, p_play_mode text, p_exclude_expansions boolean, p_sort text, p_prioritize_exact_players boolean, p_page integer, p_per_page integer) TO boardgamebuddy_role;

-- bgb_collection_shelf(viewer uuid, target uuid, p_status text, p_exclude_expansions boolean, p_limit integer)
CREATE OR REPLACE FUNCTION public.bgb_collection_shelf(viewer uuid, target uuid, p_status text DEFAULT 'owned'::text, p_exclude_expansions boolean DEFAULT true, p_limit integer DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_items JSONB;
  v_total BIGINT := 0;
  v_parted BIGINT := 0;
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 5000);
  v_excl BOOLEAN := COALESCE(p_exclude_expansions, true);
  -- 'owned' is a SET of statuses, not one: a prev_owned game (sold, gifted,
  -- donated) is still on your Owned shelf, just dimmed and
  -- stamped by the client. It is excluded from every owned COUNT, which is why
  -- v_parted comes back alongside v_total for the caller to subtract. Every
  -- other status is its own single-element set.
  v_statuses TEXT[] := CASE
    WHEN p_status = 'owned' THEN ARRAY['owned', 'prev_owned']
    ELSE ARRAY[p_status]
  END;
BEGIN
  -- Wishlist is private to its owner (bgb_profile_bundle gates it the same way).
  IF p_status = 'wishlist' AND viewer IS DISTINCT FROM target THEN
    RETURN jsonb_build_object(
      'items', '[]'::jsonb, 'total', 0, 'parted_total', 0, 'truncated', false
    );
  END IF;

  IF p_status = 'played' THEN
    -- Played-not-owned: every game the target has a play for that has NO row
    -- on their collection table at all (owned AND wishlist both live there).
    -- Mirrors collection_routes.py:335-404 and bgb_profile_bundle's played_not_owned CTE.
    -- No denormalized columns available here — a played game has no
    -- collection row, or only a 'played' one — so this branch joins
    -- boardgamebuddy_games.
    WITH played_games AS (
      -- EXISTS, not a LEFT JOIN onto play_players: the join fans one play out
      -- to one row per participant, which would multiply play_count. Matches
      -- bgb_play_stats.
      SELECT p.game_id
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
         OR EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = target
            )
      GROUP BY p.game_id
      UNION ALL
      -- Played but never logged here (status 'played').
      -- A game with a play is already above, so only the rest join.
      SELECT c.game_id
      FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.status = 'played'
        AND NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_plays p2
              WHERE p2.game_id = c.game_id
                AND (p2.user_id = target OR EXISTS (
                      SELECT 1 FROM boardgamebuddy_play_players pp2
                      WHERE pp2.play_id = p2.id AND pp2.player_user_id = target))
            )
    )
    SELECT COUNT(*) INTO v_total
      FROM played_games pg
      JOIN boardgamebuddy_games g ON g.id = pg.game_id
      WHERE NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_collections c
              WHERE c.user_id = target AND c.game_id = pg.game_id AND c.status <> 'played'
            )
        AND (NOT v_excl OR COALESCE(g.is_expansion, false) = false);

    WITH played_games AS (
      SELECT p.game_id,
             MAX(p.played_at) AS last_played_at,
             COUNT(*)::INT    AS play_count
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
         OR EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = target
            )
      GROUP BY p.game_id
      UNION ALL
      -- Played but never logged here (status 'played').
      -- A game with a play is already above, so only the rest join.
      SELECT c.game_id, NULL, 0
      FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.status = 'played'
        AND NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_plays p2
              WHERE p2.game_id = c.game_id
                AND (p2.user_id = target OR EXISTS (
                      SELECT 1 FROM boardgamebuddy_play_players pp2
                      WHERE pp2.play_id = p2.id AND pp2.player_user_id = target))
            )
    ),
    played_not_owned AS (
      SELECT pg.*
      FROM played_games pg
      WHERE NOT EXISTS (
        SELECT 1 FROM boardgamebuddy_collections c
        WHERE c.user_id = target AND c.game_id = pg.game_id AND c.status <> 'played'
      )
    )
    SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY sort_a DESC NULLS LAST), '[]'::jsonb)
      INTO v_items
      FROM (
        SELECT
          pno.last_played_at AS sort_a,
          jsonb_build_object(
            -- Matches the synthetic id the Python branch minted so the client
            -- can key tiles identically across both endpoints.
            'id', 'played-' || g.id::TEXT,
            'game_id', g.id,
            'status', 'played',
            'added_at', COALESCE(pno.last_played_at::TEXT || 'T00:00:00+00:00', (SELECT to_jsonb(c.added_at) #>> '{}' FROM boardgamebuddy_collections c WHERE c.user_id = target AND c.game_id = pno.game_id)),
            'last_played_at', pno.last_played_at,
            'play_count', COALESCE(pno.play_count, 0),
            'played_before', EXISTS (
              SELECT 1 FROM boardgamebuddy_collections c
              WHERE c.user_id = target AND c.game_id = pno.game_id
                AND c.played_before_at IS NOT NULL),
            'game', jsonb_build_object(
              'id', g.id,
              'bgg_id', g.bgg_id,
              'name', g.name,
              'year_published', g.year_published,
              'min_players', g.min_players,
              'max_players', g.max_players,
              'playing_time', g.playing_time,
              'thumbnail_url', g.thumbnail_url,
              'image_url', g.image_url,
              'theme_color', g.theme_color,
              'is_expansion', COALESCE(g.is_expansion, false),
              'base_game_bgg_id', g.base_game_bgg_id,
              'expansion_color', g.expansion_color,
              'play_mode', COALESCE(g.play_mode, 'competitive'),
              'expansion_count', COALESCE(xc.n, 0)
            ),
            'expansions', '[]'::jsonb
          ) AS row_jsonb
        FROM played_not_owned pno
        JOIN boardgamebuddy_games g ON g.id = pno.game_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::INT AS n
          FROM boardgamebuddy_games e
          WHERE COALESCE(g.is_expansion, false) = false
            AND g.bgg_id IS NOT NULL
            AND e.is_expansion = true
            AND e.base_game_bgg_id = g.bgg_id
        ) xc ON true
        WHERE (NOT v_excl OR COALESCE(g.is_expansion, false) = false)
        ORDER BY pno.last_played_at DESC NULLS LAST
        LIMIT v_limit
      ) q;

  ELSE
    -- owned / wishlist: served entirely from the denormalized c.game_* columns.
    -- v_total counts every row the items array can draw from, prev_owned
    -- included, because `truncated` below has to be about the rows on offer.
    -- v_parted is how many of those the client must not count as owned.
    SELECT COUNT(*), COUNT(*) FILTER (WHERE c.status = 'prev_owned')
      INTO v_total, v_parted
      FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.status = ANY(v_statuses)
        AND (NOT v_excl OR COALESCE(c.game_is_expansion, false) = false);

    SELECT COALESCE(
             jsonb_agg(row_jsonb ORDER BY sort_a DESC NULLS LAST, sort_b DESC),
             '[]'::jsonb
           )
      INTO v_items
      FROM (
        SELECT
          -- Wishlist sorts on added_at alone (matching bgb_profile_bundle and
          -- the Python grid); collapsing sort_a to NULL makes the shared
          -- ORDER BY above degrade to `added_at DESC` for it.
          CASE WHEN p_status = 'wishlist' THEN NULL ELSE ps.last_played_at END AS sort_a,
          c.added_at AS sort_b,
          jsonb_build_object(
            'id', c.id,
            'game_id', c.game_id,
            'status', c.status,
            'added_at', c.added_at,
            'last_played_at', ps.last_played_at,
            'play_count', COALESCE(ps.play_count, 0),
            -- The played mark, so an unlogged but marked game can join
            -- the client's Most played order as a logged one does.
            'played_before', c.played_before_at IS NOT NULL,
            'game', jsonb_build_object(
              'id', c.game_id,
              'bgg_id', c.game_bgg_id,
              'name', c.game_name,
              'year_published', c.game_year_published,
              'min_players', c.game_min_players,
              'max_players', c.game_max_players,
              'playing_time', c.game_playing_time,
              'thumbnail_url', c.game_thumbnail_url,
              'image_url', gi.image_url,
              'theme_color', c.game_theme_color,
              'is_expansion', COALESCE(c.game_is_expansion, false),
              'base_game_bgg_id', c.game_base_game_bgg_id,
              'expansion_color', c.game_expansion_color,
              'play_mode', COALESCE(c.game_play_mode, 'competitive'),
              'expansion_count', COALESCE(xc.n, 0)
            ),
            'expansions', '[]'::jsonb
          ) AS row_jsonb
        FROM boardgamebuddy_collections c
        LEFT JOIN boardgamebuddy_games gi ON gi.id = c.game_id
        -- image_url only — see the header. Every other game field stays denorm.
        LEFT JOIN LATERAL (
          SELECT MAX(p.played_at) AS last_played_at, COUNT(*)::INT AS play_count
          FROM boardgamebuddy_plays p
          WHERE p.game_id = c.game_id
            AND (
              p.user_id = target
              OR EXISTS (
                   SELECT 1 FROM boardgamebuddy_play_players pp
                   WHERE pp.play_id = p.id AND pp.player_user_id = target
                 )
            )
        ) ps ON true
        LEFT JOIN LATERAL (
          -- CATALOG-wide expansion count, not the viewer's owned ones — the
          -- same number the game page's "Expansions (N)" heading shows.
          -- _attach_page_expansion_counts (collection_routes.py:238-251) is
          -- explicit about this: expansions arrive via the import popup
          -- without touching anyone's collection, so an owned-only count
          -- reads as zero for a game that plainly has eleven of them.
          -- Only base games get a count; expansion rows stay at 0.
          SELECT COUNT(*)::INT AS n
          FROM boardgamebuddy_games e
          WHERE COALESCE(c.game_is_expansion, false) = false
            AND c.game_bgg_id IS NOT NULL
            AND e.is_expansion = true
            AND e.base_game_bgg_id = c.game_bgg_id
        ) xc ON true
        WHERE c.user_id = target AND c.status = ANY(v_statuses)
          AND (NOT v_excl OR COALESCE(c.game_is_expansion, false) = false)
        ORDER BY
          CASE WHEN p_status = 'wishlist' THEN NULL ELSE ps.last_played_at END
            DESC NULLS LAST,
          c.added_at DESC
        LIMIT v_limit
      ) q;
  END IF;

  RETURN jsonb_build_object(
    'items', COALESCE(v_items, '[]'::jsonb),
    'total', v_total,
    -- Zero on every branch but owned/wishlist, and always zero for wishlist.
    'parted_total', v_parted,
    'truncated', v_total > v_limit
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_collection_shelf(viewer uuid, target uuid, p_status text, p_exclude_expansions boolean, p_limit integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_collection_shelf(viewer uuid, target uuid, p_status text, p_exclude_expansions boolean, p_limit integer) TO boardgamebuddy_role;

-- bgb_collection_status_map(p_viewer uuid)
CREATE OR REPLACE FUNCTION public.bgb_collection_status_map(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status_map JSONB;
  v_expansion_counts JSONB;
  v_played_marks JSONB;
BEGIN
  -- Collection rows first, then a derived 'played' entry for every game the
  -- viewer has a play for and no collection row on. Matches GET /collection's
  -- semantics: there, owned/wishlist rows come from the table and played rows
  -- are synthesized for games with plays but no owned row.
  --
  -- The visibility rule for "has a play" is the participated-in one shared by
  -- bgb_play_stats and every other play count: a play counts when
  -- the viewer logged it OR appears on it as a participant. EXISTS rather than
  -- a join, so a multi-player play can't fan out.
  SELECT COALESCE(jsonb_object_agg(game_id, status), '{}'::jsonb)
    INTO v_status_map
    FROM (
      SELECT c.game_id::TEXT AS game_id, c.status AS status
      FROM boardgamebuddy_collections c
      WHERE c.user_id = p_viewer
        AND c.status IN ('owned', 'wishlist', 'played', 'prev_owned')
      UNION
      SELECT DISTINCT p.game_id::TEXT, 'played'::TEXT
      FROM boardgamebuddy_plays p
      WHERE (
              p.user_id = p_viewer
              OR EXISTS (
                   SELECT 1 FROM boardgamebuddy_play_players pp
                   WHERE pp.play_id = p.id AND pp.player_user_id = p_viewer
                 )
            )
        AND NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_collections c2
              WHERE c2.user_id = p_viewer AND c2.game_id = p.game_id
            )
    ) m;

  -- Owned expansions per base game's bgg_id. Reads the denormalized game_*
  -- columns, so no join to boardgamebuddy_games at all.
  -- Identical to bgb_profile_bundle's expansion_counts block.
  --
  -- `= 'owned'` here is deliberate and NOT widened to prev_owned: an
  -- expansion you sold is not clutter on your shelf any more, and this number
  -- is what the tile's expansion badge counts.
  SELECT COALESCE(jsonb_object_agg(base_bgg, cnt), '{}'::jsonb)
    INTO v_expansion_counts
    FROM (
      SELECT c.game_base_game_bgg_id AS base_bgg, COUNT(*)::INT AS cnt
      FROM boardgamebuddy_collections c
      WHERE c.user_id = p_viewer
        AND c.status = 'owned'
        AND COALESCE(c.game_is_expansion, false) = true
        AND c.game_base_game_bgg_id IS NOT NULL
      GROUP BY c.game_base_game_bgg_id
    ) e;

  -- Every game the viewer marked played without a logged play, on
  -- a row of any status. The map alone cannot say: it reads 'played' for a
  -- mark and for logged plays alike, and a shelf status for a marked
  -- owned or wishlisted game. This is what the sheet's switch shows.
  SELECT COALESCE(jsonb_agg(c.game_id::TEXT), '[]'::jsonb)
    INTO v_played_marks
    FROM boardgamebuddy_collections c
    WHERE c.user_id = p_viewer AND c.played_before_at IS NOT NULL;

  RETURN jsonb_build_object(
    'status_map', v_status_map,
    'expansion_counts', v_expansion_counts,
    'played_marks', v_played_marks
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_collection_status_map(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_collection_status_map(p_viewer uuid) TO boardgamebuddy_role;

-- bgb_delete_import_batch(p_user uuid, p_batch uuid)
CREATE OR REPLACE FUNCTION public.bgb_delete_import_batch(p_user uuid, p_batch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted INT;
BEGIN
  IF p_batch IS NULL THEN
    RETURN jsonb_build_object('deleted', 0);
  END IF;

  WITH gone AS (
    DELETE FROM public.boardgamebuddy_plays
     WHERE user_id = p_user
       AND import_batch_id = p_batch
    RETURNING 1
  )
  SELECT COUNT(*)::INT INTO v_deleted FROM gone;

  RETURN jsonb_build_object('deleted', v_deleted);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_delete_import_batch(p_user uuid, p_batch uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_delete_import_batch(p_user uuid, p_batch uuid) TO boardgamebuddy_role;

-- bgb_delete_import_group(p_user uuid, p_group uuid)
CREATE OR REPLACE FUNCTION public.bgb_delete_import_group(p_user uuid, p_group uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted INT;
BEGIN
  IF p_group IS NULL THEN
    RETURN jsonb_build_object('deleted', 0);
  END IF;

  WITH gone AS (
    DELETE FROM public.boardgamebuddy_plays
     WHERE user_id = p_user
       AND import_group_id = p_group
    RETURNING 1
  )
  SELECT COUNT(*)::INT INTO v_deleted FROM gone;

  RETURN jsonb_build_object('deleted', v_deleted);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_delete_import_group(p_user uuid, p_group uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_delete_import_group(p_user uuid, p_group uuid) TO boardgamebuddy_role;

-- bgb_discover_recommendations(uid uuid, lim integer)
CREATE OR REPLACE FUNCTION public.bgb_discover_recommendations(uid uuid, lim integer DEFAULT 12)
 RETURNS TABLE(game_id uuid, score numeric, reason_kind text, reason_game_id uuid, reason_game_name text, shared_mechanics text[], shared_categories text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH
-- Own plays and plays the viewer was seated in, once each — the same UNION
-- bgb_user_stats uses, so "played" means the same thing here as on Stats.
my_plays AS (
  SELECT p.id, p.game_id, p.played_at
    FROM public.boardgamebuddy_plays p
   WHERE p.user_id = uid
  UNION
  SELECT p.id, p.game_id, p.played_at
    FROM public.boardgamebuddy_plays p
    JOIN public.boardgamebuddy_play_players pp ON pp.play_id = p.id
   WHERE pp.player_user_id = uid
),
play_counts AS (
  SELECT mp.game_id,
         COUNT(*)::INT AS plays,
         COUNT(*) FILTER (WHERE mp.played_at >= CURRENT_DATE - 90)::INT AS recent_plays
    FROM my_plays mp
   GROUP BY mp.game_id
),
-- Expansions are not seeds: their tags duplicate the base game's and would
-- count it twice.
seed_games AS (
  SELECT g.id AS game_id, g.name, g.mechanics, g.categories,
         ( CASE c.status WHEN 'owned' THEN 1.0 WHEN 'wishlist' THEN 0.6 WHEN 'prev_owned' THEN 0.25 ELSE 0 END
           + LN(1 + COALESCE(pc.plays, 0))
           + 1.5 * LN(1 + COALESCE(pc.recent_plays, 0)) )::NUMERIC AS w
    FROM public.boardgamebuddy_games g
    LEFT JOIN play_counts pc ON pc.game_id = g.id
    LEFT JOIN public.boardgamebuddy_collections c ON c.game_id = g.id AND c.user_id = uid
   WHERE (pc.game_id IS NOT NULL OR c.id IS NOT NULL)
     AND NOT g.is_expansion
),
mech_w AS (
  SELECT m AS mechanic, SUM(s.w) AS w
    FROM seed_games s CROSS JOIN LATERAL unnest(COALESCE(s.mechanics, '{}')) AS m
   WHERE m <> ''
   GROUP BY m
),
cat_w AS (
  SELECT c AS category, SUM(s.w) AS w
    FROM seed_games s CROSS JOIN LATERAL unnest(COALESCE(s.categories, '{}')) AS c
   WHERE c <> ''
   GROUP BY c
),
totals AS (
  SELECT (SELECT COUNT(*) FROM seed_games) AS seed_count
),
-- The viewer's typical table. Seats counted off the roster, minutes off the
-- game's listed playing time.
table_profile AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY seats.n)        AS median_seats,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY g.playing_time) AS median_minutes
    FROM my_plays mp
    JOIN public.boardgamebuddy_games g ON g.id = mp.game_id
    JOIN LATERAL (
      SELECT COUNT(*)::INT AS n
        FROM public.boardgamebuddy_play_players pp
       WHERE pp.play_id = mp.id
    ) seats ON true
),
-- Anything on the shelf in any status, or ever played, is not a discovery.
excluded AS (
  SELECT mp.game_id FROM my_plays mp
  UNION
  SELECT c.game_id FROM public.boardgamebuddy_collections c WHERE c.user_id = uid
),
candidates AS (
  SELECT g.id, g.name, g.mechanics, g.categories, g.min_players, g.max_players,
         g.playing_time, g.bgg_rating,
         COALESCE((SELECT SUM(mw.w) FROM unnest(COALESCE(g.mechanics, '{}')) m JOIN mech_w mw ON mw.mechanic = m), 0)
           / sqrt(GREATEST(1, cardinality(COALESCE(g.mechanics, '{}'))))  AS mech_score,
         COALESCE((SELECT SUM(cw.w) FROM unnest(COALESCE(g.categories, '{}')) c JOIN cat_w cw ON cw.category = c), 0)
           / sqrt(GREATEST(1, cardinality(COALESCE(g.categories, '{}')))) AS cat_score,
         ARRAY(SELECT mw.mechanic FROM unnest(COALESCE(g.mechanics, '{}')) m JOIN mech_w mw ON mw.mechanic = m
                ORDER BY mw.w DESC, mw.mechanic LIMIT 3) AS shared_m,
         ARRAY(SELECT cw.category FROM unnest(COALESCE(g.categories, '{}')) c JOIN cat_w cw ON cw.category = c
                ORDER BY cw.w DESC, cw.category LIMIT 3) AS shared_c
    FROM public.boardgamebuddy_games g
   WHERE NOT g.is_expansion
     AND NOT EXISTS (SELECT 1 FROM excluded e WHERE e.game_id = g.id)
),
scored AS (
  SELECT c.*,
         c.mech_score / NULLIF(MAX(c.mech_score) OVER (), 0) AS mech_norm,
         c.cat_score  / NULLIF(MAX(c.cat_score)  OVER (), 0) AS cat_norm,
         CASE WHEN tp.median_seats IS NOT NULL
               AND c.min_players IS NOT NULL AND c.max_players IS NOT NULL
               AND tp.median_seats BETWEEN c.min_players AND c.max_players THEN 1 ELSE 0 END AS seat_fit,
         COALESCE(
           CASE WHEN tp.median_minutes IS NULL OR c.playing_time IS NULL THEN 0.5
                ELSE 1 - LEAST(1, ABS(c.playing_time - tp.median_minutes) / NULLIF(tp.median_minutes, 0)) END,
           0.5) AS time_fit,
         -- 5.5 is BGG's centre of mass; 9 maps to +1, NULL (unsynced) to 0.
         COALESCE((c.bgg_rating - 5.5) / 3.5, 0) AS quality
    FROM candidates c
    CROSS JOIN table_profile tp
),
weighted AS (
  SELECT s.*,
         ( 0.45 * COALESCE(s.mech_norm, 0)
         + 0.20 * COALESCE(s.cat_norm, 0)
         + 0.15 * s.seat_fit
         + 0.10 * s.time_fit
         + 0.10 * s.quality )::NUMERIC(6,4) AS score
    FROM scored s
),
-- The single seed that explains this candidate best: most shared mechanics,
-- ties broken by the seed's own weight.
explained AS (
  SELECT w.*, bs.game_id AS seed_id, bs.name AS seed_name, bs.shared AS seed_shared
    FROM weighted w
    LEFT JOIN LATERAL (
      SELECT s.game_id, s.name,
             cardinality(ARRAY(SELECT unnest(s.mechanics) INTERSECT SELECT unnest(w.mechanics))) AS shared
        FROM seed_games s
       WHERE s.mechanics && w.mechanics
       ORDER BY 3 DESC, s.w DESC, s.game_id
       LIMIT 1
    ) bs ON true
),
labelled AS (
  SELECT e.id, e.score,
         CASE
           WHEN COALESCE(e.seed_shared, 0) >= 2               THEN 'because_you_play'
           WHEN cardinality(e.shared_m) >= 1                  THEN 'shared_mechanics'
           WHEN cardinality(e.shared_c) >= 1                  THEN 'shared_categories'
           WHEN e.seat_fit = 1 AND e.time_fit >= 0.7          THEN 'fits_your_table'
           ELSE 'highly_rated'
         END AS reason_kind,
         CASE WHEN COALESCE(e.seed_shared, 0) >= 2 THEN e.seed_id   END AS reason_game_id,
         CASE WHEN COALESCE(e.seed_shared, 0) >= 2 THEN e.seed_name END AS reason_game_name,
         e.shared_m, e.shared_c,
         ROW_NUMBER() OVER (
           PARTITION BY CASE WHEN COALESCE(e.seed_shared, 0) >= 2 THEN e.seed_id END
           ORDER BY e.score DESC, e.id
         ) AS per_seed_rank
    FROM explained e
   WHERE e.score > 0
)
SELECT l.id, l.score, l.reason_kind, l.reason_game_id, l.reason_game_name, l.shared_m, l.shared_c
  FROM labelled l
 CROSS JOIN totals t
 WHERE t.seed_count > 0
   AND (l.reason_game_id IS NULL OR l.per_seed_rank <= 3)
 ORDER BY l.score DESC, l.id
 LIMIT lim;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_discover_recommendations(uid uuid, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_discover_recommendations(uid uuid, lim integer) TO boardgamebuddy_role;

-- bgb_distinct_mechanics()
CREATE OR REPLACE FUNCTION public.bgb_distinct_mechanics()
 RETURNS TABLE(mechanic text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT DISTINCT m
  FROM public.boardgamebuddy_games,
       LATERAL unnest(COALESCE(mechanics, ARRAY[]::TEXT[])) AS m
  WHERE m IS NOT NULL AND m <> ''
  ORDER BY m;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_distinct_mechanics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_distinct_mechanics() TO boardgamebuddy_role;

-- bgb_dormant_collection(uid uuid, days_since integer, lim integer)
CREATE OR REPLACE FUNCTION public.bgb_dormant_collection(uid uuid, days_since integer DEFAULT 60, lim integer DEFAULT 5)
 RETURNS TABLE(game_id uuid, last_played_at date)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    c.game_id,
    (
      SELECT MAX(p.played_at)
      FROM public.boardgamebuddy_plays p
      WHERE p.game_id = c.game_id
        AND (
          p.user_id = uid
          OR EXISTS (
               SELECT 1 FROM public.boardgamebuddy_play_players pp
               WHERE pp.play_id = p.id AND pp.player_user_id = uid
             )
        )
    ) AS last_played_at
  FROM public.boardgamebuddy_collections c
  WHERE c.user_id = uid
    AND c.status = 'owned'
    AND COALESCE(
          (
            SELECT MAX(p.played_at)
            FROM public.boardgamebuddy_plays p
            WHERE p.game_id = c.game_id
              AND (
                p.user_id = uid
                OR EXISTS (
                     SELECT 1 FROM public.boardgamebuddy_play_players pp
                     WHERE pp.play_id = p.id AND pp.player_user_id = uid
                   )
              )
          ),
          '-infinity'::DATE
        ) < (CURRENT_DATE - (days_since || ' days')::INTERVAL)
  ORDER BY last_played_at NULLS FIRST, c.game_id
  LIMIT lim;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_dormant_collection(uid uuid, days_since integer, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_dormant_collection(uid uuid, days_since integer, lim integer) TO boardgamebuddy_role;

-- bgb_game_detail_bundle(game_uuid uuid, viewer uuid, plays_limit integer)
CREATE OR REPLACE FUNCTION public.bgb_game_detail_bundle(game_uuid uuid, viewer uuid, plays_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_game JSONB;
  v_base JSONB;
  v_status TEXT;
  v_plays JSONB;
  v_expansions JSONB;
  v_exp_count_viewer INT;
  v_is_expansion BOOLEAN;
  v_base_bgg_id INT;
  v_bgg_id INT;
  v_viewer_stats JSONB;
BEGIN
  SELECT to_jsonb(g.*), g.is_expansion, g.base_game_bgg_id, g.bgg_id
    INTO v_game, v_is_expansion, v_base_bgg_id, v_bgg_id
    FROM boardgamebuddy_games g WHERE g.id = game_uuid;
  IF v_game IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_is_expansion AND v_base_bgg_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'id', g.id,
      'name', g.name,
      'thumbnail_url', g.thumbnail_url
    ) INTO v_base
    FROM boardgamebuddy_games g
    WHERE g.bgg_id = v_base_bgg_id
    LIMIT 1;
  END IF;

  -- Viewer's pill: collection row wins; otherwise fall through to 'played'
  -- when the viewer has any visible play (own or as a participant) so the
  -- played-not-owned case paints the purple Played banner instead of the
  -- bare "+ Add" picker.
  SELECT status INTO v_status
    FROM boardgamebuddy_collections
    WHERE user_id = viewer AND game_id = game_uuid;
  IF v_status IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM boardgamebuddy_plays p
      WHERE p.game_id = game_uuid
        AND (
          p.user_id = viewer
          OR EXISTS (
            SELECT 1 FROM boardgamebuddy_play_players pp
            WHERE pp.play_id = p.id AND pp.player_user_id = viewer
          )
        )
    ) THEN
      v_status := 'played';
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(play_row ORDER BY played_at DESC, created_at DESC), '[]'::jsonb)
    INTO v_plays
    FROM (
      SELECT
        p.played_at,
        p.created_at,
        jsonb_build_object(
          'id', p.id,
          'game_id', p.game_id,
          'game_name', p.game_name,
          'game_thumbnail', p.game_thumbnail_url,
          'played_at', p.played_at,
          'notes', p.notes,
          'photo_url', p.photo_url,
          'play_mode', COALESCE(p.play_mode, 'competitive'),
          'created_at', p.created_at,
          'logged_by_id', p.user_id,
          'logged_by_name', COALESCE(pr.display_name, 'Unknown'),
          'is_own', p.user_id = viewer,
          'players', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'user_id', pp.player_user_id,
              'name', COALESCE(pp_pr.display_name, pp.player_display_name, 'Unknown'),
              'is_winner', COALESCE(pp.is_winner, false),
              'score', pp.score
            ) ORDER BY pp.id)
            FROM boardgamebuddy_play_players pp
            LEFT JOIN boardgamebuddy_profiles pp_pr ON pp_pr.id = pp.player_user_id
            WHERE pp.play_id = p.id
          ), '[]'::jsonb),
          'expansions', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'expansion_game_id', pe.expansion_game_id,
              'name', eg.name,
              'color', eg.expansion_color
            ))
            FROM boardgamebuddy_play_expansions pe
            JOIN boardgamebuddy_games eg ON eg.id = pe.expansion_game_id
            WHERE pe.play_id = p.id
          ), '[]'::jsonb)
        ) AS play_row
      FROM boardgamebuddy_plays p
      LEFT JOIN boardgamebuddy_profiles pr ON pr.id = p.user_id
      WHERE p.game_id = game_uuid
        AND (
          p.user_id = viewer
          OR EXISTS (
            SELECT 1 FROM boardgamebuddy_play_players pl
            WHERE pl.play_id = p.id AND pl.player_user_id = viewer
          )
        )
      ORDER BY p.played_at DESC, p.created_at DESC
      LIMIT plays_limit
    ) ranked;

  IF NOT v_is_expansion AND v_bgg_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'expansion_game_id', g.id,
      'bgg_id', g.bgg_id,
      'name', g.name,
      'thumbnail_url', g.thumbnail_url,
      -- Full-size art for the expansion reel's polaroids: at 132x110 with
      -- object-fit: cover, BGG's ~200px thumbnail was being upscaled.
      'image_url', g.image_url,
      'color', g.expansion_color,
      'is_enabled', EXISTS (
        SELECT 1 FROM boardgamebuddy_user_expansions ue
        WHERE ue.user_id = viewer AND ue.expansion_game_id = g.id
      ),
      'rulebook_url', g.rulebook_url
    ) ORDER BY g.name), '[]'::jsonb)
      INTO v_expansions
      FROM boardgamebuddy_games g
      WHERE g.is_expansion = true AND g.base_game_bgg_id = v_bgg_id;

    SELECT COUNT(*) INTO v_exp_count_viewer
      FROM boardgamebuddy_games g
      JOIN boardgamebuddy_collections c
        ON c.game_id = g.id
       AND c.user_id = viewer
       AND c.status = 'owned'
      WHERE g.is_expansion = true AND g.base_game_bgg_id = v_bgg_id;
  ELSE
    v_expansions := '[]'::jsonb;
    v_exp_count_viewer := 0;
  END IF;

  -- ── Viewer's record with this game ──────────────────────────────────────
  WITH my_plays AS (
    SELECT p.id, p.played_at
      FROM boardgamebuddy_plays p
     WHERE p.game_id = game_uuid
       AND (
         p.user_id = viewer
         OR EXISTS (
           SELECT 1 FROM boardgamebuddy_play_players pp
            WHERE pp.play_id = p.id AND pp.player_user_id = viewer
         )
       )
  ),
  -- The viewer's own seat on each of those plays. A play they logged but sat
  -- out has no row here, so it has no result and no score.
  mine AS (
    SELECT mp.id AS play_id, pp.is_winner, pp.score,
           EXISTS (
             SELECT 1 FROM boardgamebuddy_play_players d
              WHERE d.play_id = mp.id
                AND (d.is_winner OR d.score IS NOT NULL)
           ) AS decided
      FROM my_plays mp
      JOIN boardgamebuddy_play_players pp
        ON pp.play_id = mp.id AND pp.player_user_id = viewer
  ),
  winner_scores AS (
    SELECT w.play_id, w.score
      FROM boardgamebuddy_play_players w
      JOIN my_plays mp ON mp.id = w.play_id
     WHERE w.is_winner AND w.score IS NOT NULL
  )
  SELECT CASE WHEN (SELECT COUNT(*) FROM my_plays) = 0 THEN NULL ELSE
    jsonb_build_object(
      'game_id',           game_uuid,
      'play_mode',         COALESCE(v_game->>'play_mode', 'competitive'),
      'plays',             (SELECT COUNT(*)::INT FROM my_plays),
      'wins',              (SELECT COUNT(*)::INT FROM mine WHERE is_winner),
      'decided_plays',     (SELECT COUNT(*)::INT FROM mine WHERE decided),
      'scored_plays',      (SELECT COUNT(DISTINCT play_id)::INT FROM winner_scores),
      'avg_winning_score', (SELECT ROUND(AVG(score))::INT FROM winner_scores),
      'your_avg_score',    (SELECT ROUND(AVG(score))::INT FROM mine WHERE score IS NOT NULL),
      'your_best_score',   (SELECT MAX(score) FROM mine),
      'first_played_at',   (SELECT MIN(played_at) FROM my_plays),
      'last_played_at',    (SELECT MAX(played_at) FROM my_plays)
    )
  END INTO v_viewer_stats;

  RETURN jsonb_build_object(
    'game', v_game,
    'base_game', v_base,
    'viewer_status', v_status,
    'recent_plays', v_plays,
    'expansions', v_expansions,
    'expansion_count_for_viewer', v_exp_count_viewer,
    'viewer_stats', v_viewer_stats
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_game_detail_bundle(game_uuid uuid, viewer uuid, plays_limit integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_game_detail_bundle(game_uuid uuid, viewer uuid, plays_limit integer) TO boardgamebuddy_role;

-- bgb_game_bundles(viewer uuid, owned_plays_limit integer, max_bundles integer)
CREATE OR REPLACE FUNCTION public.bgb_game_bundles(viewer uuid, owned_plays_limit integer DEFAULT 5, max_bundles integer DEFAULT 250)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_game_bundles JSONB;
  v_owned_count INT;
BEGIN
  -- Base games only — expansions are surfaced via the base game's
  -- bundle.expansions block.
  SELECT COUNT(*) INTO v_owned_count
    FROM boardgamebuddy_collections c
    WHERE c.user_id = viewer
      AND c.status = 'owned'
      AND COALESCE(c.game_is_expansion, false) = false;

  WITH owned AS (
    SELECT c.game_id
    FROM boardgamebuddy_collections c
    WHERE c.user_id = viewer
      AND c.status = 'owned'
      AND COALESCE(c.game_is_expansion, false) = false
    ORDER BY c.added_at DESC
    LIMIT max_bundles
  )
  SELECT COALESCE(jsonb_object_agg(o.game_id::text, bgb_game_detail_bundle(o.game_id, viewer, owned_plays_limit)), '{}'::jsonb)
    INTO v_game_bundles
    FROM owned o;

  RETURN jsonb_build_object(
    'game_detail_bundles', v_game_bundles,
    'owned_count', v_owned_count,
    'truncated', v_owned_count > max_bundles
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_game_bundles(viewer uuid, owned_plays_limit integer, max_bundles integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_game_bundles(viewer uuid, owned_plays_limit integer, max_bundles integer) TO boardgamebuddy_role;

-- bgb_game_summary(p_game_id uuid)
CREATE OR REPLACE FUNCTION public.bgb_game_summary(p_game_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
           'id', g.id,
           'bgg_id', g.bgg_id,
           'name', g.name,
           'year_published', g.year_published,
           'min_players', g.min_players,
           'max_players', g.max_players,
           'playing_time', g.playing_time,
           'thumbnail_url', g.thumbnail_url,
           'image_url', g.image_url,
           'theme_color', g.theme_color,
           'is_expansion', COALESCE(g.is_expansion, false),
           'base_game_bgg_id', g.base_game_bgg_id,
           'expansion_color', g.expansion_color,
           'rulebook_url', g.rulebook_url,
           'play_mode', COALESCE(g.play_mode, 'competitive')
         )
    FROM boardgamebuddy_games g
    WHERE g.id = p_game_id;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_game_summary(p_game_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_game_summary(p_game_id uuid) TO boardgamebuddy_role;

-- bgb_ghost_claim_suggestions(p_viewer uuid, p_limit integer, p_threshold real)
CREATE OR REPLACE FUNCTION public.bgb_ghost_claim_suggestions(p_viewer uuid, p_limit integer DEFAULT 10, p_threshold real DEFAULT 0.35)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_out JSONB;
BEGIN
  WITH me AS (
    SELECT lower(btrim(display_name)) AS dn, username
      FROM boardgamebuddy_profiles
     WHERE id = p_viewer
  ),
  owners AS (
    SELECT CASE WHEN be.user_a = p_viewer THEN be.user_b ELSE be.user_a END AS owner_id
      FROM boardgamebuddy_buddy_edges be
     WHERE be.status = 'accepted'
       AND p_viewer IN (be.user_a, be.user_b)
  ),
  ghost_rows AS (
    SELECT p.user_id AS owner_id,
           lower(btrim(pp.player_display_name)) AS name_key,
           btrim(pp.player_display_name) AS name_raw,
           p.played_at,
           p.game_name,
           EXISTS (
             SELECT 1 FROM boardgamebuddy_play_players s
              WHERE s.play_id = p.id AND s.player_user_id = p_viewer
           ) AS seats_viewer
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
     WHERE p.user_id IN (SELECT owner_id FROM owners)
       AND pp.player_user_id IS NULL
       AND btrim(COALESCE(pp.player_display_name, '')) <> ''
  ),
  grouped AS (
    SELECT owner_id,
           name_key,
           mode() WITHIN GROUP (ORDER BY name_raw) AS ghost_display_name,
           COUNT(*)::INT AS play_count,
           MAX(played_at) AS last_played_at,
           (array_agg(game_name ORDER BY played_at DESC))[1] AS last_game_name,
           bool_or(seats_viewer) AS collides
      FROM ghost_rows
     GROUP BY owner_id, name_key
  ),
  scored AS (
    SELECT g.*, m.score, m.is_match
      FROM grouped g, me, LATERAL (
        SELECT GREATEST(
                 extensions.similarity(g.name_key, me.dn),
                 extensions.similarity(g.name_key, me.username)
               ) AS score,
               (
                    extensions.similarity(g.name_key, me.dn) >= p_threshold
                 OR extensions.similarity(g.name_key, me.username) >= p_threshold
                 OR (
                      char_length(g.name_key) >= 3
                      AND position(' ' IN g.name_key) = 0
                      AND (
                           starts_with(me.dn, g.name_key)
                        OR starts_with(me.username, g.name_key)
                        OR g.name_key = split_part(me.dn, ' ', 1)
                      )
                    )
               ) AS is_match
      ) m
     -- A ghost the viewer is already seated beside is almost certainly not
     -- the viewer. Dropped whole, never partially — see bgb_create_ghost_claim.
     WHERE NOT g.collides
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY s_score DESC, s_count DESC, s_last DESC NULLS LAST), '[]'::jsonb)
    INTO v_out
    FROM (
      SELECT jsonb_build_object(
               'owner_user_id',      s.owner_id,
               'owner_display_name', pr.display_name,
               'owner_username',     pr.username,
               'owner_avatar',       pr.avatar,
               'ghost_display_name', s.ghost_display_name,
               'ghost_name_key',     s.name_key,
               'play_count',         s.play_count,
               'last_played_at',     s.last_played_at,
               'last_game_name',     s.last_game_name,
               'match_score',        round(s.score::numeric, 3),
               'claim_status',       c.status,
               'claim_id',           c.id
             ) AS x,
             s.score AS s_score,
             s.play_count AS s_count,
             s.last_played_at AS s_last
        FROM scored s
        JOIN boardgamebuddy_profiles pr ON pr.id = s.owner_id
        LEFT JOIN boardgamebuddy_ghost_claims c
               ON c.owner_id = s.owner_id
              AND c.ghost_name_key = s.name_key
              AND c.claimant_id = p_viewer
       WHERE s.is_match
         -- A PENDING claim is kept, and surfaced with claim_status so the row
         -- shows a disabled "Requested" chip instead of vanishing out from
         -- under the finger that just tapped it. Every other status means
         -- this ghost is settled and must stop appearing.
         AND (c.id IS NULL OR c.status = 'pending')
       ORDER BY s.score DESC, s.play_count DESC, s.last_played_at DESC NULLS LAST
       LIMIT GREATEST(p_limit, 0)
    ) q;

  RETURN COALESCE(v_out, '[]'::jsonb);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_claim_suggestions(p_viewer uuid, p_limit integer, p_threshold real) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claim_suggestions(p_viewer uuid, p_limit integer, p_threshold real) TO boardgamebuddy_role;

-- bgb_ghost_claims(p_viewer uuid)
CREATE OR REPLACE FUNCTION public.bgb_ghost_claims(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_incoming JSONB;
  v_outgoing JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(x ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_incoming
    FROM (
      SELECT jsonb_build_object(
               'id',                 c.id,
               'direction',          'incoming',
               'other_user_id',      pr.id,
               'other_display_name', pr.display_name,
               'other_username',     pr.username,
               'other_avatar',       pr.avatar,
               'ghost_display_name', c.ghost_display_name,
               'play_count',         COALESCE(st.play_count, 0),
               'last_played_at',     st.last_played_at,
               'created_at',         c.created_at
             ) AS x,
             c.created_at
        FROM boardgamebuddy_ghost_claims c
        JOIN boardgamebuddy_profiles pr ON pr.id = c.claimant_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::INT AS play_count, MAX(p.played_at) AS last_played_at
            FROM boardgamebuddy_plays p
            JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
           WHERE p.user_id = c.owner_id
             AND pp.player_user_id IS NULL
             AND lower(btrim(COALESCE(pp.player_display_name, ''))) = c.ghost_name_key
        ) st ON TRUE
       WHERE c.owner_id = p_viewer AND c.status = 'pending'
    ) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_outgoing
    FROM (
      SELECT jsonb_build_object(
               'id',                 c.id,
               'direction',          'outgoing',
               'other_user_id',      pr.id,
               'other_display_name', pr.display_name,
               'other_username',     pr.username,
               'other_avatar',       pr.avatar,
               'ghost_display_name', c.ghost_display_name,
               'play_count',         COALESCE(st.play_count, 0),
               'last_played_at',     st.last_played_at,
               'created_at',         c.created_at
             ) AS x,
             c.created_at
        FROM boardgamebuddy_ghost_claims c
        JOIN boardgamebuddy_profiles pr ON pr.id = c.owner_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::INT AS play_count, MAX(p.played_at) AS last_played_at
            FROM boardgamebuddy_plays p
            JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
           WHERE p.user_id = c.owner_id
             AND pp.player_user_id IS NULL
             AND lower(btrim(COALESCE(pp.player_display_name, ''))) = c.ghost_name_key
        ) st ON TRUE
       WHERE c.claimant_id = p_viewer AND c.status = 'pending'
    ) s;

  RETURN jsonb_build_object('incoming', v_incoming, 'outgoing', v_outgoing);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_claims(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claims(p_viewer uuid) TO boardgamebuddy_role;

-- bgb_ghost_out_of_plays(p_viewer uuid, p_play_ids uuid[], p_group_ids uuid[], p_batch_ids uuid[])
CREATE OR REPLACE FUNCTION public.bgb_ghost_out_of_plays(p_viewer uuid, p_play_ids uuid[] DEFAULT '{}'::uuid[], p_group_ids uuid[] DEFAULT '{}'::uuid[], p_batch_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name    TEXT;
  v_plays   UUID[] := COALESCE(p_play_ids,  '{}'::uuid[]);
  v_groups  UUID[] := COALESCE(p_group_ids, '{}'::uuid[]);
  v_batches UUID[] := COALESCE(p_batch_ids, '{}'::uuid[]);
  v_updated INT;
BEGIN
  IF array_length(v_plays, 1) IS NULL
     AND array_length(v_groups, 1) IS NULL
     AND array_length(v_batches, 1) IS NULL THEN
    RETURN 0;
  END IF;

  SELECT display_name INTO v_name
  FROM boardgamebuddy_profiles WHERE id = p_viewer;

  -- The COALESCE is a defensive backfill: bgb_play_players_identity_chk needs
  -- one of (player_user_id, player_display_name), so nulling the first on a row
  -- that never carried the second would abort the whole statement. Rows written
  -- by _write_play_players always carry a name, so this normally changes
  -- nothing — but "normally" is not a constraint. NULLIF catches a name that is
  -- present but blank, which the CHECK accepts and a reader would not.
  UPDATE boardgamebuddy_play_players pp
     SET player_display_name =
           COALESCE(NULLIF(btrim(COALESCE(pp.player_display_name, '')), ''), v_name, 'Player'),
         player_user_id = NULL
    FROM boardgamebuddy_plays p
   WHERE p.id = pp.play_id
     AND pp.player_user_id = p_viewer
     AND p.user_id <> p_viewer
     AND (
           p.id = ANY(v_plays)
        OR (p.import_group_id IS NOT NULL AND p.import_group_id = ANY(v_groups))
        OR (p.import_batch_id IS NOT NULL AND p.import_batch_id = ANY(v_batches))
     );

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_out_of_plays(p_viewer uuid, p_play_ids uuid[], p_group_ids uuid[], p_batch_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_out_of_plays(p_viewer uuid, p_play_ids uuid[], p_group_ids uuid[], p_batch_ids uuid[]) TO boardgamebuddy_role;

-- bgb_ghost_summary(p_viewer uuid, p_owner uuid, p_name_key text)
CREATE OR REPLACE FUNCTION public.bgb_ghost_summary(p_viewer uuid, p_owner uuid, p_name_key text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH visible AS (
    SELECT p_viewer AS uid
    UNION
    SELECT CASE WHEN be.user_a = p_viewer THEN be.user_b ELSE be.user_a END
      FROM boardgamebuddy_buddy_edges be
     WHERE be.status = 'accepted'
       AND p_viewer IN (be.user_a, be.user_b)
  ),
  g_rows AS (
    SELECT p.played_at,
           p.game_name,
           btrim(pp.player_display_name) AS name_raw,
           EXISTS (
             SELECT 1 FROM boardgamebuddy_play_players s
              WHERE s.play_id = p.id AND s.player_user_id = p_viewer
           ) AS seats_viewer,
           (
             p.user_id IN (SELECT uid FROM visible)
             OR EXISTS (
               SELECT 1 FROM boardgamebuddy_play_players v
                WHERE v.play_id = p.id
                  AND v.player_user_id IN (SELECT uid FROM visible)
             )
           ) AS is_visible
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
     WHERE p.user_id = p_owner
       AND pp.player_user_id IS NULL
       AND lower(btrim(COALESCE(pp.player_display_name, ''))) = p_name_key
  )
  SELECT jsonb_build_object(
           'exists',             COUNT(*) > 0,
           'play_count',         COUNT(*)::INT,
           'last_played_at',     MAX(played_at),
           'last_game_name',     (array_agg(game_name ORDER BY played_at DESC))[1],
           'ghost_display_name', mode() WITHIN GROUP (ORDER BY name_raw),
           'collides',           COALESCE(bool_or(seats_viewer), false),
           'visible',            COALESCE(bool_or(is_visible), false)
         )
    FROM g_rows;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_summary(p_viewer uuid, p_owner uuid, p_name_key text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_summary(p_viewer uuid, p_owner uuid, p_name_key text) TO boardgamebuddy_role;

-- bgb_create_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text)
CREATE OR REPLACE FUNCTION public.bgb_create_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key   TEXT := lower(btrim(COALESCE(p_display_name, '')));
  v_sum   JSONB;
  v_claim RECORD;
  v_has_claim BOOLEAN := false;
  v_id    UUID;
  v_out   JSONB;
BEGIN
  IF v_key = '' THEN
    RETURN jsonb_build_object('error', 'display_name_required');
  END IF;
  IF p_owner = p_claimant THEN
    -- Their own roster. POST /ghost-players/link is the tool for that.
    RETURN jsonb_build_object('error', 'own_roster');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_profiles WHERE id = p_owner) THEN
    RETURN jsonb_build_object('error', 'claim_not_found');
  END IF;

  SELECT * INTO v_claim
    FROM boardgamebuddy_ghost_claims
   WHERE owner_id = p_owner AND ghost_name_key = v_key AND claimant_id = p_claimant
     FOR UPDATE;
  v_has_claim := FOUND;

  -- Checked BEFORE the ghost lookup, and only for this claimant: once a claim
  -- is accepted the ghost rows no longer exist (they are the claimant's own
  -- rows now), so an exists-first order would answer a re-tap with the
  -- technically-true but useless "ghost_gone" instead of "that is already
  -- linked to your account".
  IF v_has_claim AND v_claim.status = 'accepted' THEN
    RETURN jsonb_build_object('error', 'already_linked');
  END IF;

  v_sum := bgb_ghost_summary(p_claimant, p_owner, v_key);

  IF NOT (v_sum->>'exists')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'ghost_gone');
  END IF;
  IF NOT (v_sum->>'visible')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'not_visible');
  END IF;
  IF (v_sum->>'collides')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'already_seated');
  END IF;

  IF v_has_claim THEN
    IF v_claim.status = 'pending' THEN
      -- Idempotent, matching buddy_service.send_request: asking twice is one ask.
      v_id := v_claim.id;
    ELSIF v_claim.reject_count >= 2 THEN
      RETURN jsonb_build_object('error', 'declined_twice');
    ELSE
      -- rejected (once), dismissed, or superseded: re-ask is allowed. The
      -- strike counter is NOT reset — that is what makes two strikes stick.
      UPDATE boardgamebuddy_ghost_claims
         SET status = 'pending',
             resolved_at = NULL,
             created_at = now(),
             ghost_display_name = COALESCE(v_sum->>'ghost_display_name', ghost_display_name)
       WHERE id = v_claim.id
       RETURNING id INTO v_id;
    END IF;
  ELSE
    INSERT INTO boardgamebuddy_ghost_claims
           (owner_id, ghost_name_key, ghost_display_name, claimant_id, status)
    VALUES (p_owner, v_key,
            COALESCE(v_sum->>'ghost_display_name', btrim(p_display_name)),
            p_claimant, 'pending')
    RETURNING id INTO v_id;
  END IF;

  SELECT jsonb_build_object(
           'id',                 c.id,
           'direction',          'outgoing',
           'other_user_id',      pr.id,
           'other_display_name', pr.display_name,
           'other_username',     pr.username,
           'other_avatar',       pr.avatar,
           'ghost_display_name', c.ghost_display_name,
           'play_count',         (v_sum->>'play_count')::INT,
           'last_played_at',     v_sum->'last_played_at',
           'created_at',         c.created_at
         )
    INTO v_out
    FROM boardgamebuddy_ghost_claims c
    JOIN boardgamebuddy_profiles pr ON pr.id = c.owner_id
   WHERE c.id = v_id;

  RETURN v_out;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_create_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_create_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text) TO boardgamebuddy_role;

-- bgb_dismiss_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text)
CREATE OR REPLACE FUNCTION public.bgb_dismiss_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key TEXT := lower(btrim(COALESCE(p_display_name, '')));
  v_sum JSONB;
BEGIN
  IF v_key = '' THEN
    RETURN jsonb_build_object('error', 'display_name_required');
  END IF;
  IF p_owner = p_claimant THEN
    RETURN jsonb_build_object('error', 'own_roster');
  END IF;

  v_sum := bgb_ghost_summary(p_claimant, p_owner, v_key);

  INSERT INTO boardgamebuddy_ghost_claims
         (owner_id, ghost_name_key, ghost_display_name, claimant_id, status, resolved_at)
  VALUES (p_owner, v_key,
          COALESCE(v_sum->>'ghost_display_name', btrim(p_display_name)),
          p_claimant, 'dismissed', now())
  ON CONFLICT (owner_id, ghost_name_key, claimant_id) DO UPDATE
     SET status = 'dismissed', resolved_at = now()
   -- An accepted link is not a suggestion and must not be trampled by a
   -- stale "Not me" tap on a list rendered before the accept landed.
   WHERE boardgamebuddy_ghost_claims.status <> 'accepted';

  RETURN jsonb_build_object('dismissed', true);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_dismiss_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_dismiss_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text) TO boardgamebuddy_role;

-- bgb_ghost_claim_detail(p_viewer uuid, p_play_id uuid, p_display_name text)
CREATE OR REPLACE FUNCTION public.bgb_ghost_claim_detail(p_viewer uuid, p_play_id uuid, p_display_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key    TEXT := lower(btrim(COALESCE(p_display_name, '')));
  v_owner  UUID;
  v_sum    JSONB;
  v_claim  RECORD;
  v_has_claim BOOLEAN := false;
  v_reason TEXT := NULL;
  v_owner_row RECORD;
BEGIN
  IF v_key = '' THEN
    RETURN jsonb_build_object('error', 'display_name_required');
  END IF;

  SELECT user_id INTO v_owner FROM boardgamebuddy_plays WHERE id = p_play_id;
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('error', 'claim_not_found');
  END IF;

  v_sum := bgb_ghost_summary(p_viewer, v_owner, v_key);

  IF NOT (v_sum->>'exists')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'ghost_gone');
  END IF;
  IF NOT (v_sum->>'visible')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'not_visible');
  END IF;

  SELECT * INTO v_claim
    FROM boardgamebuddy_ghost_claims
   WHERE owner_id = v_owner AND ghost_name_key = v_key AND claimant_id = p_viewer;
  -- Latch it: every later SELECT INTO reassigns FOUND.
  v_has_claim := FOUND;

  IF v_owner = p_viewer THEN
    v_reason := 'own_roster';
  ELSIF (v_sum->>'collides')::BOOLEAN THEN
    v_reason := 'already_seated';
  ELSIF v_has_claim AND v_claim.status = 'accepted' THEN
    v_reason := 'already_linked';
  ELSIF v_has_claim AND v_claim.status = 'pending' THEN
    v_reason := 'pending';
  ELSIF v_has_claim AND v_claim.reject_count >= 2 THEN
    v_reason := 'declined_twice';
  END IF;

  SELECT display_name, username, avatar INTO v_owner_row
    FROM boardgamebuddy_profiles WHERE id = v_owner;

  RETURN jsonb_build_object(
    'owner_user_id',      v_owner,
    'owner_display_name', v_owner_row.display_name,
    'owner_username',     v_owner_row.username,
    'owner_avatar',       v_owner_row.avatar,
    'ghost_display_name', v_sum->>'ghost_display_name',
    'ghost_name_key',     v_key,
    'play_count',         (v_sum->>'play_count')::INT,
    'last_played_at',     v_sum->'last_played_at',
    'last_game_name',     v_sum->>'last_game_name',
    'match_score',        NULL::NUMERIC,
    'claim_status',       CASE WHEN v_has_claim THEN v_claim.status ELSE NULL END,
    'claim_id',           CASE WHEN v_has_claim THEN v_claim.id ELSE NULL END,
    'can_claim',          v_reason IS NULL,
    'blocked_reason',     v_reason
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_claim_detail(p_viewer uuid, p_play_id uuid, p_display_name text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claim_detail(p_viewer uuid, p_play_id uuid, p_display_name text) TO boardgamebuddy_role;

-- bgb_hot_games(window_days integer, lim integer)
CREATE OR REPLACE FUNCTION public.bgb_hot_games(window_days integer DEFAULT 7, lim integer DEFAULT 10)
 RETURNS TABLE(game_id uuid, play_count bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.game_id, COUNT(*)::BIGINT AS play_count
  FROM public.boardgamebuddy_plays p
  WHERE p.played_at >= (CURRENT_DATE - (window_days || ' days')::INTERVAL)
    AND p.import_batch_id IS NULL
    AND p.import_group_id IS NULL
  GROUP BY p.game_id
  ORDER BY play_count DESC, p.game_id
  LIMIT lim;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_hot_games(window_days integer, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_hot_games(window_days integer, lim integer) TO boardgamebuddy_role;

-- bgb_joinable_sessions(p_viewer uuid)
CREATE OR REPLACE FUNCTION public.bgb_joinable_sessions(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_out JSONB;
BEGIN
  WITH buddies AS (
    SELECT CASE WHEN e.user_a = p_viewer THEN e.user_b ELSE e.user_a END AS buddy_id
    FROM boardgamebuddy_buddy_edges e
    WHERE e.status = 'accepted'
      AND (e.user_a = p_viewer OR e.user_b = p_viewer)
  ),
  visible AS (
    SELECT
      s.id,
      s.code,
      s.host_user_id,
      s.game_id,
      COALESCE(s.phase, 'gather') AS phase,
      s.created_at,
      (SELECT count(*)
         FROM boardgamebuddy_play_session_participants pp
         WHERE pp.session_id = s.id) AS participant_count,
      EXISTS (SELECT 1
                FROM boardgamebuddy_play_session_participants pp
                WHERE pp.session_id = s.id
                  AND pp.user_id = p_viewer) AS is_participant,
      s.host_user_id IN (SELECT buddy_id FROM buddies) AS is_host_buddy
    FROM boardgamebuddy_play_sessions s
    WHERE s.status = 'open'
      AND COALESCE(s.phase, 'gather') IN ('gather', 'play', 'settle')
      AND s.expires_at > now()
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', v.id,
           'code', v.code,
           'host_user_id', v.host_user_id,
           'host_display_name', COALESCE(pr.display_name, 'Host'),
           'host_avatar', pr.avatar,
           'game', bgb_game_summary(v.game_id),
           'phase', v.phase,
           'participant_count', v.participant_count,
           'is_participant', v.is_participant,
           'is_host_buddy', v.is_host_buddy,
           'created_at', v.created_at
         ) ORDER BY v.created_at DESC), '[]'::jsonb)
    INTO v_out
    FROM visible v
    LEFT JOIN boardgamebuddy_profiles pr ON pr.id = v.host_user_id
    WHERE v.is_participant
       OR v.host_user_id = p_viewer
       OR v.is_host_buddy;

  RETURN v_out;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_joinable_sessions(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_joinable_sessions(p_viewer uuid) TO boardgamebuddy_role;

-- bgb_link_ghost_rows(p_owner uuid, p_name_key text, p_target uuid)
CREATE OR REPLACE FUNCTION public.bgb_link_ghost_rows(p_owner uuid, p_name_key text, p_target uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated INT;
BEGIN
  -- Scoped to plays the owner logged, so a caller can never touch someone
  -- else's roster.
  UPDATE boardgamebuddy_play_players pp
     SET player_user_id = p_target
   WHERE pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_owner
         )
     AND pp.player_user_id IS NULL
     AND lower(btrim(COALESCE(pp.player_display_name, ''))) = p_name_key;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_link_ghost_rows(p_owner uuid, p_name_key text, p_target uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_link_ghost_rows(p_owner uuid, p_name_key text, p_target uuid) TO boardgamebuddy_role;

-- bgb_accept_ghost_claim(p_owner uuid, p_claim_id uuid)
CREATE OR REPLACE FUNCTION public.bgb_accept_ghost_claim(p_owner uuid, p_claim_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_claim   RECORD;
  v_sum     JSONB;
  v_updated INT;
  v_out     JSONB;
BEGIN
  SELECT * INTO v_claim
    FROM boardgamebuddy_ghost_claims
   WHERE id = p_claim_id
     FOR UPDATE;

  -- 404 rather than 403 for a non-owner: do not confirm the claim exists.
  -- Same rule as buddy_service.reject_request.
  IF NOT FOUND OR v_claim.owner_id <> p_owner THEN
    RETURN jsonb_build_object('error', 'claim_not_found');
  END IF;
  IF v_claim.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'not_pending');
  END IF;

  v_sum := bgb_ghost_summary(v_claim.claimant_id, v_claim.owner_id, v_claim.ghost_name_key);
  IF (v_sum->>'collides')::BOOLEAN THEN
    RETURN jsonb_build_object('error', 'already_seated');
  END IF;

  v_updated := bgb_link_ghost_rows(v_claim.owner_id, v_claim.ghost_name_key, v_claim.claimant_id);

  IF v_updated = 0 THEN
    -- The ghost was renamed or its plays deleted between request and accept.
    -- The claim can never succeed now; retire it rather than leaving an
    -- Accept button that only ever errors.
    UPDATE boardgamebuddy_ghost_claims
       SET status = 'superseded', resolved_at = now()
     WHERE id = v_claim.id;
    RETURN jsonb_build_object('error', 'ghost_gone');
  END IF;

  UPDATE boardgamebuddy_ghost_claims
     SET status = 'accepted', resolved_at = now(), rows_merged = v_updated
   WHERE id = v_claim.id;

  -- Anyone else waiting on this same ghost is now waiting on rows that no
  -- longer exist. Retire their claims too, or the owner is left with Accept
  -- buttons that can only return ghost_gone.
  UPDATE boardgamebuddy_ghost_claims
     SET status = 'superseded', resolved_at = now()
   WHERE owner_id = v_claim.owner_id
     AND ghost_name_key = v_claim.ghost_name_key
     AND id <> v_claim.id
     AND status = 'pending';

  SELECT jsonb_build_object(
           'id',                 c.id,
           'direction',          'incoming',
           'other_user_id',      pr.id,
           'other_display_name', pr.display_name,
           'other_username',     pr.username,
           'other_avatar',       pr.avatar,
           'ghost_display_name', c.ghost_display_name,
           'play_count',         c.rows_merged,
           'last_played_at',     NULL::DATE,
           'created_at',         c.created_at
         )
    INTO v_out
    FROM boardgamebuddy_ghost_claims c
    JOIN boardgamebuddy_profiles pr ON pr.id = c.claimant_id
   WHERE c.id = v_claim.id;

  RETURN jsonb_build_object('updated', v_updated, 'claim', v_out);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_accept_ghost_claim(p_owner uuid, p_claim_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_accept_ghost_claim(p_owner uuid, p_claim_id uuid) TO boardgamebuddy_role;

-- bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid)
CREATE OR REPLACE FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key TEXT := lower(btrim(COALESCE(p_display_name, '')));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_profiles WHERE id = p_target) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- One statement, so every row moved by one act of linking shares one
  -- timestamp — which is also what lets the notification list collapse a
  -- retroactive link across forty old plays into a single entry.
  UPDATE boardgamebuddy_play_players pp
     SET linked_at = now()
   WHERE pp.player_user_id IS NULL
     AND lower(btrim(COALESCE(pp.player_display_name, ''))) = v_key
     AND pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_viewer
         );

  RETURN jsonb_build_object(
    'updated',
    bgb_link_ghost_rows(p_viewer, v_key, p_target)
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid) TO boardgamebuddy_role;

-- bgb_list_imports(p_user uuid)
CREATE OR REPLACE FUNCTION public.bgb_list_imports(p_user uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(row_to_json(b) ORDER BY b.imported_at DESC NULLS LAST), '[]'::jsonb)
  FROM (
    SELECT
      p.import_batch_id                        AS batch_id,
      MIN(p.imported_at)                       AS imported_at,
      COUNT(*)::INT                            AS play_count,
      COUNT(DISTINCT p.game_id)::INT           AS game_count,
      -- Capped: a batch spanning fifteen games would otherwise push a
      -- paragraph into a settings row. The count beside it stays exact.
      (ARRAY_AGG(DISTINCT p.game_name ORDER BY p.game_name))[1:4] AS game_names,
      MIN(p.played_at)                         AS first_played_at,
      MAX(p.played_at)                         AS last_played_at
    FROM public.boardgamebuddy_plays p
    WHERE p.user_id = p_user
      AND p.import_batch_id IS NOT NULL
    GROUP BY p.import_batch_id
  ) b;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_list_imports(p_user uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_list_imports(p_user uuid) TO boardgamebuddy_role;

-- bgb_log_play(p_user uuid, p_payload jsonb)
CREATE OR REPLACE FUNCTION public.bgb_log_play(p_user uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_game        RECORD;
  v_mode        TEXT;
  v_play        RECORD;
  v_logged_name TEXT;
  v_roster      JSONB;
  v_players     JSONB;
  v_expansions  JSONB;
  v_client_key  UUID;
  v_existing    UUID;
  v_country     TEXT;
  v_group       UUID;
  v_batch       UUID;
  v_template    JSONB;
  v_bga_table   BIGINT;
  v_bgg_play_id BIGINT;
BEGIN
  -- Empty string and absent both mean "no key" — the client omits the field
  -- entirely for live writes, but a serializer that emits "" must not be read
  -- as a key shared by every unkeyed play.
  v_client_key := NULLIF(p_payload->>'client_key', '')::UUID;

  -- Set only by the Settings play importer, and only on plays
  -- it judged identical to at least one other in the same import: same game,
  -- same date, same players, same winner, and no score or note on either. The
  -- feed and the plays log show one card per group; every counter still sees
  -- the individual rows, which is the whole reason this is a tag rather than
  -- a row multiplier.
  v_group := NULLIF(p_payload->>'import_group_id', '')::UUID;

  -- One id per IMPORT, where the group above is one per RUN.
  -- Both are set only by the importer; a live log has neither, and neither is
  -- read by anything that counts plays.
  v_batch := NULLIF(p_payload->>'import_batch_id', '')::UUID;

  -- The scoring grid this play was scored on, snapshotted.
  -- jsonb 'null' and absent both mean "no template": the client sends an
  -- explicit null for a play scored on the plain R1..Rn grid.
  v_template := NULLIF(p_payload->'scoring_template', 'null'::jsonb);

  -- The BGA table this play came from, if any.
  v_bga_table := NULLIF(p_payload->>'bga_table_id', '')::BIGINT;

  -- The BoardGameGeek play this row came from, set only by the
  -- importer's BoardGameGeek source. Same empty-string rule as the two keys
  -- above.
  v_bgg_play_id := NULLIF(p_payload->>'bgg_play_id', '')::BIGINT;

  IF v_client_key IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.client_key = v_client_key;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- Same envelope, different key: a table already imported is
  -- not a failure, it is the answer "you already have this one".
  IF v_bga_table IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.bga_table_id = v_bga_table;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- The third key, and the only one that can see the plays the
  -- RETIRED POST /bgg/sync write path landed: those rows carry a bgg_play_id
  -- and no client_key at all, so nothing derived from the importer's own draft
  -- ids could ever recognise them. This is what makes re-importing from
  -- BoardGameGeek a no-op rather than a duplicate.
  IF v_bgg_play_id IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.bgg_play_id = v_bgg_play_id;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- The roster gate, before anything is written.
  SELECT COALESCE(jsonb_agg(kept.seat ORDER BY kept.ord), '[]'::JSONB)
    INTO v_roster
    FROM (
      SELECT s.seat, s.ord
        FROM jsonb_array_elements(COALESCE(p_payload->'players', '[]'::JSONB))
               WITH ORDINALITY AS s(seat, ord)
       WHERE NULLIF(btrim(COALESCE(s.seat->>'user_id', '')), '') IS NOT NULL
          OR NULLIF(btrim(COALESCE(s.seat->>'name', '')), '') IS NOT NULL
    ) kept;

  IF jsonb_array_length(v_roster) = 0 THEN
    RETURN jsonb_build_object('error', 'no_players');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_roster) AS s(seat)
     WHERE NULLIF(btrim(COALESCE(s.seat->>'user_id', '')), '') IS NOT NULL
     GROUP BY NULLIF(btrim(s.seat->>'user_id'), '')::UUID
    HAVING count(*) > 1
  ) THEN
    RETURN jsonb_build_object('error', 'duplicate_player');
  END IF;

  -- Unresolvable / malformed becomes NULL — "we don't know
  -- where this was played" is a legitimate row and a rejected save is not.
  v_country := upper(NULLIF(btrim(COALESCE(p_payload->>'country_code', '')), ''));
  IF v_country IS NOT NULL AND v_country !~ '^[A-Z]{2}$' THEN
    v_country := NULL;
  END IF;

  SELECT g.id, g.name, g.thumbnail_url, g.play_mode
    INTO v_game
    FROM boardgamebuddy_games g
   WHERE g.id = (p_payload->>'game_id')::UUID;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'game_not_found');
  END IF;

  -- Explicit override wins; otherwise inherit the game's intrinsic mode.
  v_mode := COALESCE(
    NULLIF(p_payload->>'play_mode', ''),
    v_game.play_mode,
    'competitive'
  );

  BEGIN
    INSERT INTO boardgamebuddy_plays (
      user_id, game_id, played_at, notes, photo_url, play_mode,
      game_name, game_thumbnail_url, client_key, country_code,
      import_group_id, import_batch_id, imported_at, scoring_template,
      bga_table_id, bgg_play_id
    )
    VALUES (
      p_user,
      v_game.id,
      (p_payload->>'played_at')::DATE,
      p_payload->>'notes',
      p_payload->>'photo_url',
      v_mode,
      v_game.name,
      v_game.thumbnail_url,
      v_client_key,
      v_country,
      v_group,
      v_batch,
      -- Stamped server-side, and only for an import: a client clock is the one
      -- thing here nobody should have to trust, and the Settings list orders by
      -- this value.
      CASE WHEN v_batch IS NULL THEN NULL ELSE now() END,
      v_template,
      v_bga_table,
      v_bgg_play_id
    )
    RETURNING id, created_at INTO v_play;
  EXCEPTION WHEN unique_violation THEN
    -- Lost the race against a concurrent flush of the same queued play, or
    -- against a concurrent import of the same BGA table. The winner's row is
    -- the canonical one; hand its id back on the same duplicate envelope the
    -- pre-checks use.
    --
    -- EVERY key, not just client_key: there are
    -- three unique indexes a play can violate now, and resolving on the wrong
    -- one returns id: null — a wrong answer that raises nothing and looks like
    -- success. The BGG arm also covers the pending-imports worker still
    -- draining legacy kind='play' rows, which writes a bgg_play_id and no
    -- client_key, so no other arm could resolve that race.
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user
       AND ((v_client_key  IS NOT NULL AND p.client_key   = v_client_key)
         OR (v_bga_table   IS NOT NULL AND p.bga_table_id = v_bga_table)
         OR (v_bgg_play_id IS NOT NULL AND p.bgg_play_id  = v_bgg_play_id));
    RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
  END;

  INSERT INTO boardgamebuddy_play_players (
    play_id, player_user_id, player_display_name, is_winner, score, round_scores,
    team
  )
  SELECT
    v_play.id,
    pl.user_id,
    pl.name,
    COALESCE(pl.is_winner, false),
    pl.score,
    pl.round_scores,
    -- '' is the COMMON case, not an edge one: the client seeds every seat with
    -- team:"" and writes "" back when a tag is cleared. Stored as NULL, or
    -- every untagged seat in the app would share one anonymous side.
    NULLIF(btrim(pl.team), '')
  FROM jsonb_to_recordset(v_roster)
         AS pl(name TEXT, is_winner BOOLEAN, score INTEGER,
               user_id UUID, round_scores JSONB, team TEXT);

  -- DISTINCT guards the (play_id, expansion_game_id) primary key against a
  -- payload that repeats an id.
  INSERT INTO boardgamebuddy_play_expansions (play_id, expansion_game_id)
  SELECT DISTINCT v_play.id, eid::UUID
    FROM jsonb_array_elements_text(
           COALESCE(p_payload->'expansion_ids', '[]'::JSONB)
         ) AS eid
   WHERE COALESCE(eid, '') <> '';

  SELECT pr.display_name INTO v_logged_name
    FROM boardgamebuddy_profiles pr
   WHERE pr.id = p_user;

  -- Response blocks are built from the NORMALIZED roster (plus the profile/game
  -- joins they need), not by reading the rows back — the values are identical
  -- and WITH ORDINALITY keeps the player list in the order the host entered it,
  -- which a RETURNING or a re-SELECT wouldn't guarantee.
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'user_id',      pl.user_id,
             'name',         COALESCE(prof.display_name, pl.name, 'Unknown'),
             'avatar',       prof.avatar,
             'is_winner',    COALESCE(pl.is_winner, false),
             'score',        pl.score,
             'round_scores', pl.round_scores,
             -- Echoed from the same NULLIF the INSERT used, for the reason
             -- country_code is echoed from its normalized local below: the
             -- client has to read back the value that actually landed.
             'team',         NULLIF(btrim(pl.team), '')
           ) ORDER BY pl.ord
         ), '[]'::JSONB)
    INTO v_players
    FROM ROWS FROM (
           jsonb_to_recordset(v_roster)
             AS (name TEXT, is_winner BOOLEAN, score INTEGER,
                 user_id UUID, round_scores JSONB, team TEXT)
         ) WITH ORDINALITY AS pl(name, is_winner, score, user_id, round_scores,
                                 team, ord)
    LEFT JOIN boardgamebuddy_profiles prof ON prof.id = pl.user_id;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'expansion_game_id', eg.id,
             'name',              eg.name,
             'color',             eg.expansion_color
           ) ORDER BY eg.name
         ), '[]'::JSONB)
    INTO v_expansions
    FROM (
      SELECT DISTINCT eid::UUID AS id
        FROM jsonb_array_elements_text(
               COALESCE(p_payload->'expansion_ids', '[]'::JSONB)
             ) AS eid
       WHERE COALESCE(eid, '') <> ''
    ) picked
    JOIN boardgamebuddy_games eg ON eg.id = picked.id;

  -- country_code is echoed from the NORMALIZED local, not from the payload:
  -- the client has to see the value that actually landed, or a "gb" it sent
  -- would read back as "gb" while the row holds "GB". scoring_template is
  -- echoed from its local for the same reason (an absent key vs. an explicit
  -- null must read back identically).
  RETURN jsonb_build_object(
    'id',               v_play.id,
    'game_id',          v_game.id,
    'game_name',        v_game.name,
    'game_thumbnail',   v_game.thumbnail_url,
    'played_at',        (p_payload->>'played_at')::DATE,
    'notes',            p_payload->>'notes',
    'players',          v_players,
    'photo_url',        p_payload->>'photo_url',
    'expansions',       v_expansions,
    'created_at',       v_play.created_at,
    'play_mode',        v_mode,
    'country_code',     v_country,
    'scoring_template', v_template,
    'group_count',      1,
    'logged_by_id',     p_user,
    'logged_by_name',   COALESCE(v_logged_name, ''),
    'is_own',           true
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_log_play(p_user uuid, p_payload jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_log_play(p_user uuid, p_payload jsonb) TO boardgamebuddy_role;

-- bgb_finalize_session(p_host uuid, p_code text, p_payload jsonb)
CREATE OR REPLACE FUNCTION public.bgb_finalize_session(p_host uuid, p_code text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_finalize_session(p_host uuid, p_code text, p_payload jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_finalize_session(p_host uuid, p_code text, p_payload jsonb) TO boardgamebuddy_role;

-- bgb_import_plays(p_user uuid, p_payload jsonb)
CREATE OR REPLACE FUNCTION public.bgb_import_plays(p_user uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item     JSONB;
  v_result   JSONB;
  v_results  JSONB := '[]'::JSONB;
  v_index    INT := 0;
  v_imported INT := 0;
  v_dupes    INT := 0;
  v_failed   INT := 0;
BEGIN
  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'plays', '[]'::JSONB))
  LOOP
    v_result := public.bgb_log_play(p_user, v_item);

    IF v_result ? 'error' THEN
      v_failed := v_failed + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', v_index, 'id', NULL, 'duplicate', false,
        'error', v_result->>'error'
      ));
    ELSIF COALESCE((v_result->>'duplicate')::BOOLEAN, false) THEN
      -- A client_key this user already holds a play for. The importer stamps
      -- one UUID per expanded play and re-sends it on a retry, so this is the
      -- branch that makes re-running a half-finished import safe.
      v_dupes := v_dupes + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', v_index, 'id', v_result->>'id', 'duplicate', true, 'error', NULL
      ));
    ELSE
      v_imported := v_imported + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', v_index, 'id', v_result->>'id', 'duplicate', false, 'error', NULL
      ));
    END IF;

    v_index := v_index + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'imported',  v_imported,
    'duplicate', v_dupes,
    'failed',    v_failed,
    'results',   v_results
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_import_plays(p_user uuid, p_payload jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_import_plays(p_user uuid, p_payload jsonb) TO boardgamebuddy_role;

-- bgb_merge_ghosts(p_viewer uuid, p_source text, p_target text)
CREATE OR REPLACE FUNCTION public.bgb_merge_ghosts(p_viewer uuid, p_source text, p_target text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated INT;
BEGIN
  UPDATE boardgamebuddy_play_players pp
     SET player_display_name = p_target
   WHERE pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_viewer
         )
     AND pp.player_display_name ILIKE p_source
     AND pp.player_user_id IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_updated);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_merge_ghosts(p_viewer uuid, p_source text, p_target text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_merge_ghosts(p_viewer uuid, p_source text, p_target text) TO boardgamebuddy_role;

-- bgb_push_note_failure(p_id uuid)
CREATE OR REPLACE FUNCTION public.bgb_push_note_failure(p_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE boardgamebuddy_push_subscriptions
     SET failure_count = failure_count + 1
   WHERE id = p_id;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_push_note_failure(p_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_push_note_failure(p_id uuid) TO boardgamebuddy_role;

-- bgb_rank_deferrals_active(p_viewer uuid)
CREATE OR REPLACE FUNCTION public.bgb_rank_deferrals_active(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(d.game_id), '[]'::jsonb)
  FROM boardgamebuddy_rank_deferrals d
  WHERE d.user_id = p_viewer
    AND NOT EXISTS (
      SELECT 1 FROM boardgamebuddy_plays p
      WHERE p.game_id = d.game_id
        AND p.created_at > d.deferred_at
        AND p.played_at >= d.deferred_at::date
        AND (p.user_id = p_viewer
             OR EXISTS (
                  SELECT 1 FROM boardgamebuddy_play_players pp
                  WHERE pp.play_id = p.id AND pp.player_user_id = p_viewer)));
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_rank_deferrals_active(p_viewer uuid) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.bgb_rank_deferrals_active(p_viewer uuid) IS 'The game ids p_viewer parked with "Rank after next play" and has not played since, as a JSONB array. Called by GET /api/v1/boardgame_buddy/ranks/queue.';

-- bgb_rank_game(p_user uuid, p_game uuid, p_category text, p_tier text, p_index integer)
CREATE OR REPLACE FUNCTION public.bgb_rank_game(p_user uuid, p_game uuid, p_category text, p_tier text, p_index integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old   boardgamebuddy_game_ranks%ROWTYPE;
  v_count integer;
  v_pos   integer;
BEGIN
  IF p_tier NOT IN ('love', 'good', 'not') THEN
    RETURN jsonb_build_object('error', 'invalid_tier');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_games WHERE id = p_game) THEN
    RETURN jsonb_build_object('error', 'game_not_found');
  END IF;

  -- Re-ranking: take it out of wherever it was first, closing the gap.
  DELETE FROM boardgamebuddy_game_ranks
   WHERE user_id = p_user AND game_id = p_game
  RETURNING * INTO v_old;
  IF FOUND THEN
    UPDATE boardgamebuddy_game_ranks
       SET position = position - 1
     WHERE user_id = p_user AND category = v_old.category AND tier = v_old.tier
       AND position > v_old.position;
  END IF;

  -- The client computed p_index against the list it was shown. Clamped, so a
  -- list that shrank since (a rank removed in another tab) cannot open a hole.
  SELECT count(*) INTO v_count
    FROM boardgamebuddy_game_ranks
   WHERE user_id = p_user AND category = p_category AND tier = p_tier;
  v_pos := LEAST(GREATEST(COALESCE(p_index, v_count), 0), v_count);

  UPDATE boardgamebuddy_game_ranks
     SET position = position + 1
   WHERE user_id = p_user AND category = p_category AND tier = p_tier
     AND position >= v_pos;

  INSERT INTO boardgamebuddy_game_ranks (user_id, game_id, category, tier, position)
  VALUES (p_user, p_game, p_category, p_tier, v_pos);

  RETURN jsonb_build_object('category', p_category, 'tier', p_tier, 'position', v_pos);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_rank_game(p_user uuid, p_game uuid, p_category text, p_tier text, p_index integer) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.bgb_rank_game(p_user uuid, p_game uuid, p_category text, p_tier text, p_index integer) IS 'Insert (or move) a game into a player''s ranking at p_index within p_category/p_tier, keeping positions dense. Returns {category, tier, position} or {error}. Called by PUT /api/v1/boardgame_buddy/ranks/games/{game_id}.';

-- bgb_reject_ghost_claim(p_owner uuid, p_claim_id uuid)
CREATE OR REPLACE FUNCTION public.bgb_reject_ghost_claim(p_owner uuid, p_claim_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_claim RECORD;
BEGIN
  SELECT * INTO v_claim
    FROM boardgamebuddy_ghost_claims
   WHERE id = p_claim_id
     FOR UPDATE;

  IF NOT FOUND OR v_claim.owner_id <> p_owner THEN
    RETURN jsonb_build_object('error', 'claim_not_found');
  END IF;
  IF v_claim.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'not_pending');
  END IF;

  UPDATE boardgamebuddy_ghost_claims
     SET status = 'rejected',
         resolved_at = now(),
         reject_count = reject_count + 1
   WHERE id = v_claim.id;

  RETURN jsonb_build_object('rejected', true);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_reject_ghost_claim(p_owner uuid, p_claim_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_reject_ghost_claim(p_owner uuid, p_claim_id uuid) TO boardgamebuddy_role;

-- bgb_session_bundle(p_session_id uuid)
CREATE OR REPLACE FUNCTION public.bgb_session_bundle(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session JSONB;
  v_game_id UUID;
  v_phase TEXT;
  v_participants JSONB;
  v_scores JSONB := '[]'::jsonb;
BEGIN
  SELECT jsonb_build_object(
           'id', s.id,
           'code', s.code,
           'status', s.status,
           'phase', COALESCE(s.phase, 'gather'),
           'host_user_id', s.host_user_id,
           'game_id', s.game_id,
           'created_at', s.created_at,
           'expires_at', s.expires_at,
           'finalized_play_id', s.finalized_play_id,
           'scoring_template', s.scoring_template,
           'play_mode', s.play_mode
         ),
         s.game_id,
         COALESCE(s.phase, 'gather')
    INTO v_session, v_game_id, v_phase
    FROM boardgamebuddy_play_sessions s
    WHERE s.id = p_session_id;

  IF v_session IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', pp.id,
           'user_id', pp.user_id,
           'display_name', pp.display_name,
           'joined_at', pp.joined_at,
           'avatar', pr.avatar,
           'team', pp.team
         ) ORDER BY pp.position NULLS LAST, pp.joined_at), '[]'::jsonb)
    INTO v_participants
    FROM boardgamebuddy_play_session_participants pp
    LEFT JOIN boardgamebuddy_profiles pr ON pr.id = pp.user_id
    WHERE pp.session_id = p_session_id;

  IF v_phase = 'play' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'participant_id', sc.participant_id,
             'round_index', sc.round_index,
             'score', sc.score
           ) ORDER BY sc.round_index), '[]'::jsonb)
      INTO v_scores
      FROM boardgamebuddy_play_session_scores sc
      WHERE sc.session_id = p_session_id;
  END IF;

  RETURN v_session || jsonb_build_object(
    'participants', v_participants,
    'game', bgb_game_summary(v_game_id),
    'scores', v_scores
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_session_bundle(p_session_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_session_bundle(p_session_id uuid) TO boardgamebuddy_role;

-- bgb_create_session(p_host uuid, p_host_display_name text, p_game uuid)
CREATE OR REPLACE FUNCTION public.bgb_create_session(p_host uuid, p_host_display_name text, p_game uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- Crockford base32, mirrors PLAY_SESSION_CODE_ALPHABET / _LENGTH in
  -- shared-backend/routes/boardgame_buddy/constants.py — keep in step.
  v_alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_code_len CONSTANT INT := 5;
  v_max_attempts CONSTANT INT := 6;
  v_bytes BYTEA;
  v_code TEXT;
  v_session_id UUID;
BEGIN
  -- The Log Play tab always opens a fresh session on entry to Gather; a
  -- host who navigated away would otherwise leave orphan open rows.
  UPDATE boardgamebuddy_play_sessions
     SET status = 'abandoned', phase = 'abandoned'
   WHERE host_user_id = p_host
     AND status = 'open';

  FOR attempt IN 1..v_max_attempts LOOP
    -- One v4 UUID per attempt as the entropy source. 256 % 32 = 0, so a
    -- random byte mod 32 is uniform over the alphabet.
    v_bytes := uuid_send(gen_random_uuid());
    v_code := '';
    FOR i IN 1..v_code_len LOOP
      v_code := v_code
        || substr(v_alphabet, 1 + (get_byte(v_bytes, i - 1) % 32), 1);
    END LOOP;
    BEGIN
      INSERT INTO boardgamebuddy_play_sessions
        (code, host_user_id, game_id, status, phase)
      VALUES (v_code, p_host, p_game, 'open', 'gather')
      RETURNING id INTO v_session_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_session_id := NULL;
    END;
  END LOOP;

  IF v_session_id IS NULL THEN
    RETURN jsonb_build_object('error', 'code_allocation_failed');
  END IF;

  -- Position 0, not NULL. The host is player[0] in their own Gather list
  -- (_ensureSelfIncluded), and once bgb_add_participant hands every other
  -- player a real position a NULL here would sort the host LAST on every
  -- spectator's screen and last in the grid.
  INSERT INTO boardgamebuddy_play_session_participants
    (session_id, user_id, display_name, position)
  VALUES (v_session_id, p_host, p_host_display_name, 0);

  RETURN bgb_session_bundle(v_session_id);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_create_session(p_host uuid, p_host_display_name text, p_game uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_create_session(p_host uuid, p_host_display_name text, p_game uuid) TO boardgamebuddy_role;

-- bgb_get_session(p_code text)
CREATE OR REPLACE FUNCTION public.bgb_get_session(p_code text)
 RETURNS jsonb
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

  RETURN bgb_session_bundle(v_id);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_get_session(p_code text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_get_session(p_code text) TO boardgamebuddy_role;

-- bgb_join_session(p_code text, p_user uuid, p_user_display_name text, p_guest_display_name text)
CREATE OR REPLACE FUNCTION public.bgb_join_session(p_code text, p_user uuid DEFAULT NULL::uuid, p_user_display_name text DEFAULT NULL::text, p_guest_display_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
  v_expires TIMESTAMPTZ;
  v_phase TEXT;
  v_guest_name TEXT;
BEGIN
  SELECT s.id, s.expires_at, COALESCE(s.phase, 'gather')
    INTO v_id, v_expires, v_phase
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

  IF v_phase = 'gather' THEN
    IF p_user IS NOT NULL THEN
      INSERT INTO boardgamebuddy_play_session_participants
        (session_id, user_id, display_name)
      SELECT v_id, p_user, COALESCE(p_user_display_name, 'Player')
      WHERE NOT EXISTS (
        SELECT 1 FROM boardgamebuddy_play_session_participants
        WHERE session_id = v_id AND user_id = p_user
      );
    ELSE
      v_guest_name := btrim(COALESCE(p_guest_display_name, ''));
      IF v_guest_name = '' THEN
        RETURN jsonb_build_object('error', 'guest_name_required');
      END IF;
      INSERT INTO boardgamebuddy_play_session_participants
        (session_id, display_name)
      SELECT v_id, v_guest_name
      WHERE NOT EXISTS (
        SELECT 1 FROM boardgamebuddy_play_session_participants
        WHERE session_id = v_id
          AND lower(display_name) = lower(v_guest_name)
      );
    END IF;
  END IF;

  RETURN bgb_session_bundle(v_id);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_join_session(p_code text, p_user uuid, p_user_display_name text, p_guest_display_name text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_join_session(p_code text, p_user uuid, p_user_display_name text, p_guest_display_name text) TO boardgamebuddy_role;

-- bgb_session_gate(p_code text, p_host uuid, p_require_gather boolean)
CREATE OR REPLACE FUNCTION public.bgb_session_gate(p_code text, p_host uuid, p_require_gather boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row RECORD;
BEGIN
  SELECT s.id, s.host_user_id, s.game_id, s.expires_at, COALESCE(s.phase, 'gather') AS phase
    INTO v_row
    FROM boardgamebuddy_play_sessions s
   WHERE s.code = upper(p_code)
     AND s.status = 'open';

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_row.expires_at < now() THEN
    -- Status only — phase is left alone, exactly as the Python gate and
    -- bgb_get_session do.
    UPDATE boardgamebuddy_play_sessions
       SET status = 'abandoned'
     WHERE id = v_row.id;
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  IF v_row.host_user_id <> p_host THEN
    RETURN jsonb_build_object('error', 'host_only');
  END IF;

  IF p_require_gather AND v_row.phase <> 'gather' THEN
    RETURN jsonb_build_object('error', 'roster_locked');
  END IF;

  RETURN jsonb_build_object(
    'session_id', v_row.id,
    'host_user_id', v_row.host_user_id,
    'game_id', v_row.game_id,
    'phase', v_row.phase
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_session_gate(p_code text, p_host uuid, p_require_gather boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_session_gate(p_code text, p_host uuid, p_require_gather boolean) TO boardgamebuddy_role;

-- bgb_abandon_session(p_host uuid, p_code text)
CREATE OR REPLACE FUNCTION public.bgb_abandon_session(p_host uuid, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate JSONB;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, FALSE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;

  UPDATE boardgamebuddy_play_sessions
     SET status = 'abandoned', phase = 'abandoned'
   WHERE id = (v_gate ->> 'session_id')::UUID;

  RETURN jsonb_build_object('ok', TRUE);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_abandon_session(p_host uuid, p_code text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_abandon_session(p_host uuid, p_code text) TO boardgamebuddy_role;

-- bgb_add_participant(p_host uuid, p_code text, p_user uuid, p_display_name text)
CREATE OR REPLACE FUNCTION public.bgb_add_participant(p_host uuid, p_code text, p_user uuid, p_display_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate JSONB;
  v_session UUID;
  v_name TEXT;
  v_next SMALLINT;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, TRUE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  v_name := btrim(COALESCE(p_display_name, ''));
  IF v_name = '' THEN
    RETURN jsonb_build_object('error', 'display_name_required');
  END IF;

  SELECT (COALESCE(max(position), -1) + 1)::SMALLINT
    INTO v_next
    FROM boardgamebuddy_play_session_participants
   WHERE session_id = v_session;

  BEGIN
    IF p_user IS NOT NULL THEN
      INSERT INTO boardgamebuddy_play_session_participants (session_id, user_id, display_name, position)
      SELECT v_session, p_user, v_name, v_next
       WHERE NOT EXISTS (
         SELECT 1 FROM boardgamebuddy_play_session_participants
          WHERE session_id = v_session AND user_id = p_user
       );
    ELSE
      INSERT INTO boardgamebuddy_play_session_participants (session_id, display_name, position)
      SELECT v_session, v_name, v_next
       WHERE NOT EXISTS (
         SELECT 1 FROM boardgamebuddy_play_session_participants
          WHERE session_id = v_session
            AND user_id IS NULL
            AND lower(display_name) = lower(v_name)
       );
    END IF;
  EXCEPTION WHEN unique_violation THEN
    NULL;   -- already seated; the bundle below reflects reality either way
  END;

  RETURN bgb_session_bundle(v_session);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_add_participant(p_host uuid, p_code text, p_user uuid, p_display_name text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_add_participant(p_host uuid, p_code text, p_user uuid, p_display_name text) TO boardgamebuddy_role;

-- bgb_advance_phase(p_host uuid, p_code text, p_phase text, p_transitions jsonb)
CREATE OR REPLACE FUNCTION public.bgb_advance_phase(p_host uuid, p_code text, p_phase text, p_transitions jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate JSONB;
  v_session UUID;
  v_current TEXT;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, FALSE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;
  v_current := v_gate ->> 'phase';

  -- Idempotent: re-asserting the current phase is a no-op, not an error.
  IF p_phase = v_current THEN
    RETURN bgb_session_bundle(v_session);
  END IF;

  IF NOT (COALESCE(p_transitions -> v_current, '[]'::jsonb) ? p_phase) THEN
    RETURN jsonb_build_object(
      'error', 'invalid_transition', 'from', v_current, 'to', p_phase
    );
  END IF;

  UPDATE boardgamebuddy_play_sessions
     SET phase = p_phase,
         -- Keep status in step for the abandoned shortcut (mirrors
         -- abandon_session). `finalized` is set later by mark_finalized, once
         -- the play row exists.
         status = CASE WHEN p_phase = 'abandoned' THEN 'abandoned' ELSE status END
   WHERE id = v_session;

  RETURN bgb_session_bundle(v_session);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_advance_phase(p_host uuid, p_code text, p_phase text, p_transitions jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_advance_phase(p_host uuid, p_code text, p_phase text, p_transitions jsonb) TO boardgamebuddy_role;

-- bgb_remove_participant(p_host uuid, p_code text, p_participant uuid)
CREATE OR REPLACE FUNCTION public.bgb_remove_participant(p_host uuid, p_code text, p_participant uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate JSONB;
  v_session UUID;
  v_user UUID;
  v_found BOOLEAN;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, TRUE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  SELECT TRUE, pp.user_id
    INTO v_found, v_user
    FROM boardgamebuddy_play_session_participants pp
   WHERE pp.id = p_participant
     AND pp.session_id = v_session;

  IF NOT COALESCE(v_found, FALSE) THEN
    RETURN jsonb_build_object('error', 'participant_not_found');
  END IF;

  IF v_user IS NOT NULL AND v_user = (v_gate ->> 'host_user_id')::UUID THEN
    RETURN jsonb_build_object('error', 'cannot_remove_host');
  END IF;

  DELETE FROM boardgamebuddy_play_session_participants
   WHERE id = p_participant AND session_id = v_session;

  RETURN bgb_session_bundle(v_session);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_remove_participant(p_host uuid, p_code text, p_participant uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_remove_participant(p_host uuid, p_code text, p_participant uuid) TO boardgamebuddy_role;

-- bgb_reorder_participants(p_host uuid, p_code text, p_order uuid[])
CREATE OR REPLACE FUNCTION public.bgb_reorder_participants(p_host uuid, p_code text, p_order uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate    JSONB;
  v_session UUID;
  v_listed  INT;
BEGIN
  -- require_gather = TRUE: same gate, same error vocabulary (not_found /
  -- expired / host_only / roster_locked) as add and remove.
  v_gate := bgb_session_gate(p_code, p_host, TRUE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  v_listed := COALESCE(array_length(p_order, 1), 0);

  UPDATE boardgamebuddy_play_session_participants pp
     SET position = ord.idx
    FROM (
      SELECT t.id, (t.ordinality - 1)::SMALLINT AS idx
        FROM unnest(p_order) WITH ORDINALITY AS t(id, ordinality)
    ) ord
   WHERE pp.id = ord.id
     AND pp.session_id = v_session;

  UPDATE boardgamebuddy_play_session_participants pp
     SET position = (v_listed + rest.rn)::SMALLINT
    FROM (
      SELECT id, (row_number() OVER (ORDER BY joined_at) - 1) AS rn
        FROM boardgamebuddy_play_session_participants
       WHERE session_id = v_session
         AND NOT (id = ANY (COALESCE(p_order, ARRAY[]::UUID[])))
    ) rest
   WHERE pp.id = rest.id;

  RETURN bgb_session_bundle(v_session);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_reorder_participants(p_host uuid, p_code text, p_order uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_reorder_participants(p_host uuid, p_code text, p_order uuid[]) TO boardgamebuddy_role;

-- bgb_set_session_scoring(p_host uuid, p_code text, p_template jsonb)
CREATE OR REPLACE FUNCTION public.bgb_set_session_scoring(p_host uuid, p_code text, p_template jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate JSONB;
  v_session UUID;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, FALSE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  UPDATE boardgamebuddy_play_sessions
     SET scoring_template = NULLIF(p_template, 'null'::jsonb)
   WHERE id = v_session;

  RETURN bgb_session_bundle(v_session);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_set_session_scoring(p_host uuid, p_code text, p_template jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_set_session_scoring(p_host uuid, p_code text, p_template jsonb) TO boardgamebuddy_role;

-- bgb_set_session_teams(p_host uuid, p_code text, p_mode text, p_teams jsonb)
CREATE OR REPLACE FUNCTION public.bgb_set_session_teams(p_host uuid, p_code text, p_mode text, p_teams jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate    JSONB;
  v_session UUID;
  v_map     JSONB;
BEGIN
  -- require_gather = FALSE: a tag never renumbers a column — the one reason
  -- add / remove / reorder are frozen — and a debounced write can outrun the
  -- phase PATCH of a host rolling back to Gather to name a side. Same error
  -- vocabulary as every other host write, minus roster_locked.
  v_gate := bgb_session_gate(p_code, p_host, FALSE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;

  -- A JSON null, a missing argument and an empty object all mean "no seat
  -- carries a side", which is a legitimate write: it is what clearing the last
  -- tag sends, and what a host switching back to a competitive game sends.
  v_map := COALESCE(NULLIF(p_teams, 'null'::jsonb), '{}'::jsonb);
  IF jsonb_typeof(v_map) <> 'object' THEN
    RETURN jsonb_build_object('error', 'invalid_teams');
  END IF;

  -- Left alone when the caller says nothing, so a client that only knows how
  -- to publish tags cannot silently un-say the mode.
  IF p_mode = ANY (ARRAY['competitive', 'coop', 'team']) THEN
    UPDATE boardgamebuddy_play_sessions
       SET play_mode = p_mode
     WHERE id = v_session
       AND play_mode IS DISTINCT FROM p_mode;
  END IF;

  UPDATE boardgamebuddy_play_session_participants pp
     SET team = NULLIF(left(btrim(v_map ->> pp.id::TEXT), 16), '')
   WHERE pp.session_id = v_session
     AND pp.team IS DISTINCT FROM NULLIF(left(btrim(v_map ->> pp.id::TEXT), 16), '');

  RETURN bgb_session_bundle(v_session);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_set_session_teams(p_host uuid, p_code text, p_mode text, p_teams jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_set_session_teams(p_host uuid, p_code text, p_mode text, p_teams jsonb) TO boardgamebuddy_role;

-- bgb_unrank_game(p_user uuid, p_game uuid)
CREATE OR REPLACE FUNCTION public.bgb_unrank_game(p_user uuid, p_game uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old boardgamebuddy_game_ranks%ROWTYPE;
BEGIN
  DELETE FROM boardgamebuddy_game_ranks
   WHERE user_id = p_user AND game_id = p_game
  RETURNING * INTO v_old;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('removed', false);
  END IF;
  UPDATE boardgamebuddy_game_ranks
     SET position = position - 1
   WHERE user_id = p_user AND category = v_old.category AND tier = v_old.tier
     AND position > v_old.position;
  RETURN jsonb_build_object('removed', true);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_unrank_game(p_user uuid, p_game uuid) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.bgb_unrank_game(p_user uuid, p_game uuid) IS 'Remove a game from a player''s ranking, closing the gap in its tier. Returns {removed}. Called by DELETE /api/v1/boardgame_buddy/ranks/games/{game_id}.';

-- bgb_update_session_game(p_host uuid, p_code text, p_game uuid)
CREATE OR REPLACE FUNCTION public.bgb_update_session_game(p_host uuid, p_code text, p_game uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gate JSONB;
  v_session UUID;
  v_current UUID;
BEGIN
  v_gate := bgb_session_gate(p_code, p_host, FALSE);
  IF v_gate ? 'error' THEN RETURN v_gate; END IF;
  v_session := (v_gate ->> 'session_id')::UUID;
  v_current := (v_gate ->> 'game_id')::UUID;

  IF v_current IS DISTINCT FROM p_game THEN
    UPDATE boardgamebuddy_play_sessions SET game_id = p_game WHERE id = v_session;
  END IF;

  RETURN bgb_session_bundle(v_session);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_update_session_game(p_host uuid, p_code text, p_game uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_update_session_game(p_host uuid, p_code text, p_game uuid) TO boardgamebuddy_role;

-- bgb_watch_session(p_code text, p_viewer uuid)
CREATE OR REPLACE FUNCTION public.bgb_watch_session(p_code text, p_viewer uuid)
 RETURNS jsonb
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
REVOKE EXECUTE ON FUNCTION public.bgb_watch_session(p_code text, p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_watch_session(p_code text, p_viewer uuid) TO boardgamebuddy_role;

-- boardgamebuddy_search_games(p_viewer uuid, p_query text, p_limit integer, p_include_expansions boolean)
CREATE OR REPLACE FUNCTION public.boardgamebuddy_search_games(p_viewer uuid, p_query text, p_limit integer DEFAULT 20, p_include_expansions boolean DEFAULT false)
 RETURNS TABLE(id uuid, bgg_id integer, name text, year_published integer, min_players integer, max_players integer, playing_time integer, thumbnail_url text, image_url text, theme_color text, is_expansion boolean, base_game_bgg_id integer, expansion_color text, rulebook_url text, play_mode text, collection_status text, in_collection boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    g.id,
    g.bgg_id,
    g.name,
    g.year_published,
    g.min_players,
    g.max_players,
    g.playing_time,
    g.thumbnail_url,
    g.image_url,
    g.theme_color,
    g.is_expansion,
    g.base_game_bgg_id,
    g.expansion_color,
    g.rulebook_url,
    g.play_mode,
    c.status                 AS collection_status,
    (c.user_id IS NOT NULL)  AS in_collection
  FROM public.boardgamebuddy_games g
  -- A mark-only 'played' row is not a shelf: the game is a catalog hit,
  -- as one with only logged plays is.
  LEFT JOIN public.boardgamebuddy_collections c
    ON c.game_id = g.id AND c.user_id = p_viewer AND c.status <> 'played'
  WHERE g.name ILIKE '%' || COALESCE(p_query, '') || '%'
    AND (COALESCE(p_include_expansions, false) OR NOT g.is_expansion)
  ORDER BY (c.user_id IS NOT NULL) DESC, g.name
  LIMIT GREATEST(COALESCE(p_limit, 20), 0);
$function$;
REVOKE EXECUTE ON FUNCTION public.boardgamebuddy_search_games(p_viewer uuid, p_query text, p_limit integer, p_include_expansions boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.boardgamebuddy_search_games(p_viewer uuid, p_query text, p_limit integer, p_include_expansions boolean) TO boardgamebuddy_role;
