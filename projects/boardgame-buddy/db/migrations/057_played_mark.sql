-- ─────────────────────────────────────────────────────────────────────────────
-- 057_played_mark.sql — one "played it, didn't log it" mark, on any game
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The mark is boardgamebuddy_collections.played_before_at. It says "I have
-- played this, somewhere I did not log it here", and it is the one mechanism
-- behind two surfaces: the Stats Shelf of Shame's switch and the collection
-- sheet's switch flip the same column (PATCH /collection/{id}/played-before).
--
-- It sits on a row of ANY status — owned, prev_owned, wishlist — and is
-- independent of it: changing a shelf status leaves it alone, and removing a
-- game from the collection keeps it. A game on no shelf carries it on a row
-- with status 'played', which this migration admits to the status CHECK; that
-- row exists only to hold the mark and goes when the mark is cleared.
--
-- It is never a play: no play count, stat or achievement reads it. Everywhere
-- else a marked game reads as one with logged plays in the same shelf state:
--
--   * the Played shelf is every game with a play the target can see plus the
--     'played' rows, each once, marks last (bgb_collection_shelf,
--     bgb_collection_page, bgb_profile_bundle's played page and total). A
--     'played' row is not a shelf row, so it does not hide a game from that
--     set the way an owned or wishlisted row does;
--   * shelf items carry `played_before`, so the client's Most played order
--     takes a marked game as it takes a logged one;
--   * the status map reads 'played' for a 'played' row, as it does for a game
--     with plays and no row, and lists every mark as played_marks — the map
--     alone cannot tell a mark from plays, nor see one on a shelf row;
--   * search (boardgamebuddy_search_games) treats a 'played' row as no row,
--     so a mark-only game is a catalog hit like a logged-only one;
--   * the Shelf of Shame (bgb_user_stats_detail) reads owned rows'
--     played_before_at, and the rank queue (services/rank_service.queue)
--     offers any row carrying it — both unchanged here.
--
-- Every owned, prev-owned and wishlist reader filters on its own status, so a
-- 'played' row is invisible to them. The BoardGameGeek push compares only the
-- statuses BGG tracks (services/bgg_compare_service.py drops 'played' rows),
-- and boardgamebuddy_bgg_push_queue's target_status CHECK is left as it is.
--
-- Deploy order: run this before the API. The API's mark write creates
-- 'played' rows, which the old CHECK refuses; its reads accept the new
-- shapes either way (CollectionStatus.PLAYED already exists).

ALTER TABLE public.boardgamebuddy_collections
  DROP CONSTRAINT boardgamebuddy_collections_status_check;
ALTER TABLE public.boardgamebuddy_collections
  ADD CONSTRAINT boardgamebuddy_collections_status_check
  CHECK ((status = ANY (ARRAY['owned'::text, 'wishlist'::text, 'prev_owned'::text, 'played'::text])));

COMMENT ON COLUMN public.boardgamebuddy_collections.played_before_at IS 'The played mark: set when the user says they played this game somewhere they did not log it. On a row of any status, independent of it; a game on no shelf carries it on a status ''played'' row (057). Read by the Played shelf, the status map''s played_marks, the Shelf of Shame block of bgb_user_stats_detail and the rank queue. It is not a play and must never be counted as one.';

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
  -- bgb_play_stats (039) and fixed across the board in 045: a play counts when
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
  -- columns (migration 020), so no join to boardgamebuddy_games at all.
  -- Identical to bgb_profile_bundle's expansion_counts block (045:359-369).
  --
  -- `= 'owned'` here is deliberate and NOT widened to prev_owned (069): an
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

  -- Every game the viewer marked played without a logged play (057), on
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
GRANT EXECUTE ON FUNCTION public.bgb_collection_status_map(p_viewer uuid) TO boardgamebuddy_role;

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
  -- donated — migration 069) is still on your Owned shelf, just dimmed and
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
    -- Mirrors collection_routes.py:335-404 and 045's played_not_owned CTE.
    -- No denormalized columns available here — a played game has no
    -- collection row, or only a 'played' one — so this branch joins
    -- boardgamebuddy_games.
    WITH played_games AS (
      -- EXISTS, not a LEFT JOIN onto play_players: the join fans one play out
      -- to one row per participant, which would multiply play_count. Matches
      -- bgb_play_stats (039) and the 045 fix.
      SELECT p.game_id
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
         OR EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = target
            )
      GROUP BY p.game_id
      UNION ALL
      -- Played but never logged here (status 'played', migration 057).
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
      -- Played but never logged here (status 'played', migration 057).
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
            -- The played mark (057), so an unlogged but marked game can join
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
GRANT EXECUTE ON FUNCTION public.bgb_collection_shelf(viewer uuid, target uuid, p_status text, p_exclude_expansions boolean, p_limit integer) TO boardgamebuddy_role;

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
      UNION ALL
      -- Played but never logged here (status 'played', migration 057).
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

GRANT EXECUTE ON FUNCTION public.bgb_collection_page(viewer uuid, target uuid, p_status text, p_search text, p_players integer, p_playtime_min integer, p_playtime_max integer, p_play_mode text, p_exclude_expansions boolean, p_sort text, p_prioritize_exact_players boolean, p_page integer, p_per_page integer) TO boardgamebuddy_role;

CREATE OR REPLACE FUNCTION public.bgb_profile_bundle(viewer uuid, target uuid, col_per_page integer DEFAULT 12, plays_per_page integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_stats JSONB;
  v_owned_page JSONB;
  v_owned_total BIGINT;
  v_owned_parted_total BIGINT;
  v_wishlist_page JSONB;
  v_wishlist_total BIGINT;
  v_played_page JSONB;
  v_played_total BIGINT;
  v_recent_plays JSONB;
  v_recent_plays_total BIGINT;
  v_status_map JSONB;
  v_expansion_counts JSONB;
  v_buddies JSONB;
  v_buddy_incoming JSONB;
  v_buddy_outgoing JSONB;
  v_ghost_claims_incoming JSONB;
  v_together JSONB;
  v_top_games JSONB;
  v_is_self BOOLEAN := (viewer = target);
  v_is_buddy BOOLEAN := false;
BEGIN
  -- Edges are canonical (user_a < user_b), so match the pair either way round.
  IF NOT v_is_self THEN
    SELECT EXISTS (
      SELECT 1 FROM boardgamebuddy_buddy_edges be
      WHERE be.status = 'accepted'
        AND ((be.user_a = viewer AND be.user_b = target)
          OR (be.user_a = target AND be.user_b = viewer))
    ) INTO v_is_buddy;
  END IF;

  SELECT jsonb_build_object(
    'total_plays', COALESCE(s.total_plays, 0),
    'unique_games', COALESCE(s.unique_games, 0),
    'win_count', COALESCE(s.win_count, 0),
    'last_played_at', s.last_played_at,
    'hours_played', COALESCE(s.hours_played, 0)::FLOAT,
    'owned_games', COALESCE(s.owned_games, 0),
    'owned_expansions', COALESCE(s.owned_expansions, 0),
    'favorite_game', CASE
      WHEN s.favorite_game_id IS NOT NULL THEN jsonb_build_object(
        'game_id', s.favorite_game_id,
        'name', s.favorite_game_name,
        'play_count', COALESCE(s.favorite_play_count, 0)
      )
      ELSE NULL
    END
  ) INTO v_stats
  FROM bgb_user_stats(target) s;
  v_stats := COALESCE(v_stats, jsonb_build_object(
    'total_plays', 0, 'unique_games', 0, 'win_count', 0,
    'last_played_at', NULL, 'hours_played', 0,
    'owned_games', 0, 'owned_expansions', 0, 'favorite_game', NULL
  ));

  -- owned_total is games you actually OWN, so it keeps the bare 'owned'
  -- predicate: a prev_owned row (sold, gifted, donated — 069) is on the Owned
  -- shelf for display only and is counted separately, in owned_parted_total.
  -- owned_page below returns BOTH, because it is the Collection spoke's
  -- first-frame seed and has to hold the same rows bgb_collection_shelf will.
  SELECT
    COUNT(*) FILTER (WHERE c.status = 'owned'),
    COUNT(*) FILTER (WHERE c.status = 'prev_owned')
    INTO v_owned_total, v_owned_parted_total
    FROM boardgamebuddy_collections c
    WHERE c.user_id = target AND c.status IN ('owned', 'prev_owned')
      AND COALESCE(c.game_is_expansion, false) = false;

  SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY sort_order_a DESC NULLS LAST, sort_order_b DESC), '[]'::jsonb)
    INTO v_owned_page
    FROM (
      SELECT
        ps.last_played_at AS sort_order_a,
        c.added_at AS sort_order_b,
        jsonb_build_object(
          'id', c.id,
          'game_id', c.game_id,
          'status', c.status,
          'added_at', c.added_at,
          'last_played_at', ps.last_played_at,
          'play_count', COALESCE(ps.play_count, 0),
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
            'expansion_count', 0
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
      WHERE c.user_id = target AND c.status IN ('owned', 'prev_owned')
        AND COALESCE(c.game_is_expansion, false) = false
      ORDER BY ps.last_played_at DESC NULLS LAST, c.added_at DESC
      LIMIT col_per_page
    ) p;

  SELECT COUNT(*) INTO v_wishlist_total
    FROM boardgamebuddy_collections c
    WHERE c.user_id = target AND c.status = 'wishlist'
      AND COALESCE(c.game_is_expansion, false) = false;

  SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY added_at DESC), '[]'::jsonb)
    INTO v_wishlist_page
    FROM (
      SELECT
        c.added_at,
        jsonb_build_object(
          'id', c.id,
          'game_id', c.game_id,
          'status', c.status,
          'added_at', c.added_at,
          'last_played_at', ps.last_played_at,
          'play_count', COALESCE(ps.play_count, 0),
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
            'expansion_count', 0
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
      WHERE c.user_id = target AND c.status = 'wishlist'
        AND COALESCE(c.game_is_expansion, false) = false
      ORDER BY c.added_at DESC
      LIMIT col_per_page
    ) p;

  WITH played_games AS (
    -- EXISTS, not a LEFT JOIN onto play_players: the join fans one play out
    -- to one row per participant, so COUNT(*) over it multiplied every play
    -- the target logged by its player count. Matches bgb_play_stats (039).
    SELECT
      mp.game_id,
      MAX(mp.played_at) AS last_played_at,
      COUNT(*)::INT AS play_count
    FROM (
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
      UNION
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE pp.player_user_id = target
    ) mp
    GROUP BY mp.game_id
    UNION ALL
    -- Played but never logged here (status 'played', migration 057).
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
  SELECT COUNT(*) INTO v_played_total
    FROM played_not_owned pno
    JOIN boardgamebuddy_games g ON g.id = pno.game_id
    WHERE g.is_expansion = false;

  WITH played_games AS (
    -- EXISTS, not a LEFT JOIN onto play_players: the join fans one play out
    -- to one row per participant, so COUNT(*) over it multiplied every play
    -- the target logged by its player count. Matches bgb_play_stats (039).
    SELECT
      mp.game_id,
      MAX(mp.played_at) AS last_played_at,
      COUNT(*)::INT AS play_count
    FROM (
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
      UNION
      SELECT p.id, p.game_id, p.played_at
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE pp.player_user_id = target
    ) mp
    GROUP BY mp.game_id
    UNION ALL
    -- Played but never logged here (status 'played', migration 057).
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
  SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY sort_order DESC NULLS LAST), '[]'::jsonb)
    INTO v_played_page
    FROM (
      SELECT
        pno.last_played_at AS sort_order,
        jsonb_build_object(
          'id', 'derived-' || pno.game_id::text,
          'game_id', pno.game_id,
          'status', 'played',
          'added_at', COALESCE(pno.last_played_at::TEXT || 'T00:00:00+00:00', (SELECT to_jsonb(c.added_at) #>> '{}' FROM boardgamebuddy_collections c WHERE c.user_id = target AND c.game_id = pno.game_id)),
          'last_played_at', pno.last_played_at,
          'play_count', pno.play_count,
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
            'is_expansion', g.is_expansion,
            'base_game_bgg_id', g.base_game_bgg_id,
            'expansion_color', g.expansion_color,
            'play_mode', g.play_mode,
            'expansion_count', 0
          ),
          'expansions', '[]'::jsonb
        ) AS row_jsonb
      FROM played_not_owned pno
      JOIN boardgamebuddy_games g ON g.id = pno.game_id
      WHERE g.is_expansion = false
      ORDER BY pno.last_played_at DESC
      LIMIT col_per_page
    ) p;

  -- The total is a general stat and stays visible to everyone; only the log
  -- below it is buddies-only.
  SELECT COUNT(*) INTO v_recent_plays_total
    FROM (
      SELECT p.id
      FROM boardgamebuddy_plays p
      WHERE p.user_id = target
      UNION
      SELECT p.id
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE pp.player_user_id = target
    ) mp;

  IF v_is_self OR v_is_buddy THEN
    SELECT COALESCE(jsonb_agg(play_row ORDER BY played_at DESC, created_at DESC), '[]'::jsonb)
      INTO v_recent_plays
      FROM (
        SELECT
          p.played_at, p.created_at,
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
                'score', pp.score,
                'avatar', pp_pr.avatar
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
        FROM (
          SELECT p.id, p.played_at, p.created_at
          FROM boardgamebuddy_plays p
          WHERE p.user_id = target
          UNION
          SELECT p.id, p.played_at, p.created_at
          FROM boardgamebuddy_plays p
          JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
          WHERE pp.player_user_id = target
          ORDER BY played_at DESC, created_at DESC
          LIMIT plays_per_page
        ) mp
        JOIN boardgamebuddy_plays p ON p.id = mp.id
        LEFT JOIN boardgamebuddy_profiles pr ON pr.id = p.user_id
        ORDER BY p.played_at DESC, p.created_at DESC
      ) r;
  ELSE
    -- NULL, not '[]': an empty array is the honest answer for "this person has
    -- never logged a play", and the screen says exactly that under it. A
    -- stranger must not be told that.
    v_recent_plays := NULL;
  END IF;

  -- No status filter, so prev_owned (069) reaches the map unaided — which is
  -- what the status tag and its picker sheet read to know which row to check.
  SELECT COALESCE(jsonb_object_agg(game_id, status), '{}'::jsonb)
    INTO v_status_map
    FROM (
      SELECT c.game_id, c.status
      FROM boardgamebuddy_collections c
      WHERE c.user_id = viewer
      UNION ALL
      SELECT DISTINCT p.game_id, 'played'::TEXT AS status
      FROM boardgamebuddy_plays p
      LEFT JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
      WHERE (p.user_id = viewer OR pp.player_user_id = viewer)
        AND NOT EXISTS (
          SELECT 1 FROM boardgamebuddy_collections c2
          WHERE c2.user_id = viewer AND c2.game_id = p.game_id
        )
    ) m;

  -- Owned-only on purpose (069): an expansion you sold is no longer clutter on
  -- the base game's shelf. Mirrors bgb_collection_status_map's block exactly.
  SELECT COALESCE(jsonb_object_agg(base_bgg, cnt), '{}'::jsonb)
    INTO v_expansion_counts
    FROM (
      SELECT c.game_base_game_bgg_id AS base_bgg, COUNT(*)::INT AS cnt
      FROM boardgamebuddy_collections c
      WHERE c.user_id = viewer
        AND c.status = 'owned'
        AND COALESCE(c.game_is_expansion, false) = true
        AND c.game_base_game_bgg_id IS NOT NULL
      GROUP BY c.game_base_game_bgg_id
    ) e;

  -- ── Buddy-only blocks ──────────────────────────────────────────────────
  IF v_is_buddy THEN
    -- Shared record. Both sides must have a player row on the play — see the
    -- header on why the logger alone does not count and why co-op is out.
    -- GROUP BY p.id collapses the two joins back to one row per play, so a
    -- duplicated participant row cannot inflate the count.
    WITH shared AS (
      SELECT
        p.id AS play_id,
        p.played_at,
        COALESCE(BOOL_OR(vp.is_winner), false) AS you_won,
        COALESCE(BOOL_OR(tp.is_winner), false) AS they_won
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players vp
        ON vp.play_id = p.id AND vp.player_user_id = viewer
      JOIN boardgamebuddy_play_players tp
        ON tp.play_id = p.id AND tp.player_user_id = target
      WHERE COALESCE(p.play_mode, 'competitive') <> 'coop'
        -- Only plays that recorded a result. shared_plays is the denominator
        -- your_wins and their_wins are read against, so a play nobody won and
        -- nobody scored would show up as a game you both somehow lost.
        AND EXISTS (
          SELECT 1 FROM boardgamebuddy_play_players d
           WHERE d.play_id = p.id AND (d.is_winner OR d.score IS NOT NULL)
        )
      GROUP BY p.id, p.played_at
    )
    SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE jsonb_build_object(
      'shared_plays', COUNT(*)::INT,
      'your_wins', COUNT(*) FILTER (WHERE you_won)::INT,
      'their_wins', COUNT(*) FILTER (WHERE they_won)::INT,
      'last_played_at', MAX(played_at)
    ) END INTO v_together FROM shared;

    -- Target's three most-played games, over the same "logged it or sat at the
    -- table" set every other block here uses. Name and thumbnail come off the
    -- denormalized play columns (020), with boardgamebuddy_games filling in
    -- full-size art the plays table never carried.
    SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY plays DESC, name), '[]'::jsonb)
      INTO v_top_games
      FROM (
        SELECT
          tg.plays,
          tg.name,
          jsonb_build_object(
            'game_id', tg.game_id,
            'name', tg.name,
            'thumbnail_url', COALESCE(g.thumbnail_url, tg.thumbnail_url),
            'image_url', g.image_url,
            'play_count', tg.plays,
            'last_played_at', tg.last_played_at
          ) AS row_jsonb
        FROM (
          SELECT
            mp.game_id,
            MAX(mp.game_name) AS name,
            MAX(mp.game_thumbnail_url) AS thumbnail_url,
            MAX(mp.played_at) AS last_played_at,
            COUNT(*)::INT AS plays
          FROM (
            SELECT p.id, p.game_id, p.game_name, p.game_thumbnail_url, p.played_at
            FROM boardgamebuddy_plays p
            WHERE p.user_id = target
            UNION
            SELECT p.id, p.game_id, p.game_name, p.game_thumbnail_url, p.played_at
            FROM boardgamebuddy_plays p
            JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
            WHERE pp.player_user_id = target
          ) mp
          GROUP BY mp.game_id
          ORDER BY plays DESC, name
          LIMIT 3
        ) tg
        LEFT JOIN boardgamebuddy_games g ON g.id = tg.game_id
      ) t;
  ELSE
    v_together := NULL;
    v_top_games := NULL;
  END IF;

  IF v_is_self THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', be.id,
      'other_user_id', CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END,
      'other_display_name', pr.display_name,
      'other_avatar', pr.avatar,
      'accepted_at', be.accepted_at,
      'created_at', be.created_at
    ) ORDER BY pr.display_name), '[]'::jsonb)
      INTO v_buddies
      FROM boardgamebuddy_buddy_edges be
      JOIN boardgamebuddy_profiles pr
        ON pr.id = (CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END)
      WHERE (be.user_a = viewer OR be.user_b = viewer) AND be.status = 'accepted';

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', be.id,
      'direction', 'incoming',
      'other_user_id', CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END,
      'other_display_name', pr.display_name,
      'other_avatar', pr.avatar,
      'created_at', be.created_at
    ) ORDER BY be.created_at DESC), '[]'::jsonb)
      INTO v_buddy_incoming
      FROM boardgamebuddy_buddy_edges be
      JOIN boardgamebuddy_profiles pr
        ON pr.id = (CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END)
      WHERE (be.user_a = viewer OR be.user_b = viewer)
        AND be.status = 'pending'
        AND be.requested_by <> viewer;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', be.id,
      'direction', 'outgoing',
      'other_user_id', CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END,
      'other_display_name', pr.display_name,
      'other_avatar', pr.avatar,
      'created_at', be.created_at
    ) ORDER BY be.created_at DESC), '[]'::jsonb)
      INTO v_buddy_outgoing
      FROM boardgamebuddy_buddy_edges be
      JOIN boardgamebuddy_profiles pr
        ON pr.id = (CASE WHEN be.user_a = viewer THEN be.user_b ELSE be.user_a END)
      WHERE (be.user_a = viewer OR be.user_b = viewer)
        AND be.status = 'pending'
        AND be.requested_by = viewer;

    -- Ghost claims waiting on the viewer (migration 070). Same shape and same
    -- reason as buddy_requests_incoming: the Profile tab's dot and the Buddies
    -- card's count both have to be right on FIRST PAINT, and /bootstrap
    -- already carries this bundle. A separate fetch would put a round trip on
    -- the app's slowest path to publish one integer.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', gc.id,
      'direction', 'incoming',
      'other_user_id', pr.id,
      'other_display_name', pr.display_name,
      'other_avatar', pr.avatar,
      'ghost_display_name', gc.ghost_display_name,
      'created_at', gc.created_at
    ) ORDER BY gc.created_at DESC), '[]'::jsonb)
      INTO v_ghost_claims_incoming
      FROM boardgamebuddy_ghost_claims gc
      JOIN boardgamebuddy_profiles pr ON pr.id = gc.claimant_id
     WHERE gc.owner_id = viewer AND gc.status = 'pending';
  ELSE
    v_buddies := NULL;
    v_buddy_incoming := NULL;
    v_buddy_outgoing := NULL;
    v_ghost_claims_incoming := NULL;
  END IF;

  RETURN jsonb_build_object(
    'is_buddy', v_is_buddy,
    'stats', v_stats,
    'owned_page', v_owned_page,
    'owned_total', v_owned_total,
    'owned_parted_total', v_owned_parted_total,
    'wishlist_page', v_wishlist_page,
    'wishlist_total', v_wishlist_total,
    'played_page', v_played_page,
    'played_total', v_played_total,
    'recent_plays', v_recent_plays,
    'recent_plays_total', v_recent_plays_total,
    'together', v_together,
    'top_games', v_top_games,
    'status_map', v_status_map,
    'expansion_counts', v_expansion_counts,
    'buddies', v_buddies,
    'buddy_requests_incoming', v_buddy_incoming,
    'buddy_requests_outgoing', v_buddy_outgoing,
    'ghost_claims_incoming', v_ghost_claims_incoming
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_profile_bundle(viewer uuid, target uuid, col_per_page integer, plays_per_page integer) TO boardgamebuddy_role;

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
  -- A mark-only 'played' row (057) is not a shelf: the game is a catalog hit,
  -- as one with only logged plays is.
  LEFT JOIN public.boardgamebuddy_collections c
    ON c.game_id = g.id AND c.user_id = p_viewer AND c.status <> 'played'
  WHERE g.name ILIKE '%' || COALESCE(p_query, '') || '%'
    AND (COALESCE(p_include_expansions, false) OR NOT g.is_expansion)
  ORDER BY (c.user_id IS NOT NULL) DESC, g.name
  LIMIT GREATEST(COALESCE(p_limit, 20), 0);
$function$;
GRANT EXECUTE ON FUNCTION public.boardgamebuddy_search_games(p_viewer uuid, p_query text, p_limit integer, p_include_expansions boolean) TO boardgamebuddy_role;
