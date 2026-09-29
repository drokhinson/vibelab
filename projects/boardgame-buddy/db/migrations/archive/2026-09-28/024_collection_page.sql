-- ─────────────────────────────────────────────────────────────────────────────
-- 024 — The collection grid filters, sorts and pages in Postgres
-- ─────────────────────────────────────────────────────────────────────────────
-- GET /collection/grid read a user's WHOLE shelf on every page turn, hydrated
-- every game on it, then filtered, sorted and sliced twelve tiles out of the
-- result in Python. Four things followed, and the endpoint's own comments
-- already named three of them:
--
--   * A page turn cost what the whole shelf costs. Page 9 read exactly what
--     page 1 read.
--   * PostgREST silently caps an unbounded select at 1000 rows, and the filter
--     ran AFTER that truncation. On a shelf past the cap a game that matches
--     the search could be missing because it sat past row 1000 before anything
--     was filtered. That is not a slow page, it is a wrong one.
--   * Three round trips per page: the collection+games join, bgb_play_stats,
--     then a third query tallying expansion counts for the page.
--   * The grid and bgb_collection_shelf are the same shelf written twice, in
--     two languages. The client falls back from the shelf to the grid mid
--     scroll when a shelf outgrows the shelf endpoint's row cap, and the two
--     orderings have to agree row for row or the grid reshuffles under the
--     reader.
--
-- WHY A NEW FUNCTION AND NOT PARAMETERS ON bgb_collection_shelf. Adding
-- defaulted parameters to that function would not replace it — CREATE OR
-- REPLACE cannot change a signature, so it would create a second overload that
-- the defaults make ambiguous ("function is not unique"). The shelf's contract
-- is also deliberate: it takes no search, filter or page parameters so the
-- client can cache one entry per shelf and derive everything locally. This is
-- the paginated, server-filtered sibling, and the two stay separate.
--
-- NO SCHEMA CHANGE. No table, no column, no index. The existing
-- idx_bgb_collections_user_status covers the (user_id, status) scan, and the
-- remaining predicates are row filters over one user's shelf, which is bounded
-- by how many games a person owns. Deliberately no trigram index for the name
-- search: it filters rows the status index already fetched.
--
-- EQUIVALENCE. The Python this replaces is `_passes_grid_filters` and the sort
-- blocks in collection_routes.py. Four of its rules are easy to lose, so each
-- one is called out at the predicate that carries it: NULL player bounds are
-- permissive, a 6+ player search drops the lower bound, NULL playtime counts
-- as zero, and the search is a plain substring rather than a LIKE pattern.
-- One deliberate DIFFERENCE, noted at the ORDER BY: every ordering now ends in
-- a unique tiebreak.


-- ── The function ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bgb_collection_page(
  viewer uuid,
  target uuid,
  p_status text DEFAULT 'owned',
  p_search text DEFAULT NULL,
  p_players integer DEFAULT NULL,
  p_playtime_min integer DEFAULT NULL,
  p_playtime_max integer DEFAULT NULL,
  p_play_mode text DEFAULT NULL,
  p_exclude_expansions boolean DEFAULT true,
  p_sort text DEFAULT 'last_played',
  p_prioritize_exact_players boolean DEFAULT false,
  p_page integer DEFAULT 1,
  p_per_page integer DEFAULT 12
)
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
  -- bgb_collection_shelf's widening (069) because the client falls back from
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
    ),
    filtered AS (
      SELECT pg.last_played_at, pg.play_count, g.*
      FROM played_games pg
      JOIN boardgamebuddy_games g ON g.id = pg.game_id
      WHERE NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_collections c
              WHERE c.user_id = target AND c.game_id = pg.game_id
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
        'added_at', q.last_played_at::TEXT || 'T00:00:00+00:00',
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

GRANT EXECUTE ON FUNCTION public.bgb_collection_page(viewer uuid, target uuid, p_status text, p_search text, p_players integer, p_playtime_min integer, p_playtime_max integer, p_play_mode text, p_exclude_expansions boolean, p_sort text, p_prioritize_exact_players boolean, p_page integer, p_per_page integer) TO boardgamebuddy_role;
