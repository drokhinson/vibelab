-- 069_prev_owned_status.sql — "Previously owned": a third persisted collection
-- status for a game you sold, gifted or donated.
--
-- Until now boardgamebuddy_collections.status was ('owned', 'wishlist') and the
-- only way to record that a game had left your shelf was to DELETE the row —
-- which throws away the fact that you ever owned it. `prev_owned` keeps the row
-- and says what happened to it. It is a SUBSET OF OWNED for display and NOT
-- OWNED for counting:
--
--   * The Collection spoke's Owned grid lists prev_owned rows alongside owned
--     ones, in their alphabetical place, dimmed and stamped by the client.
--   * Every count of owned games EXCLUDES it — the Owned tab count, the profile
--     "Owned Games" stat, owned-expansion counts, the Shelf of Shame.
--
-- That second half is why this is a third status value rather than a flag on
-- the owned row: every `c.status = 'owned'` predicate in this schema — the
-- stats functions, the expansion-count blocks, bgb_game_detail_bundle,
-- bgb_user_stats_detail's shelf block — already gives the right answer once
-- prev_owned is its own value, and none of them are touched here. Only the two
-- functions that deliberately BUILD the Owned grid widen to the set.
--
-- Three functions are replaced, each for one line of reason:
--   1. bgb_collection_status_map (was 050) — emit prev_owned in the status map.
--   2. bgb_collection_shelf      (was 055) — p_status='owned' returns both
--      statuses, plus a parted_total so the client can subtract for display.
--   3. bgb_profile_bundle        (was 064) — owned_page returns both statuses
--      (it is the Collection spoke's first-frame seed and must contain the same
--      rows the shelf will); owned_total stays owned-only and is joined by a
--      new owned_parted_total.
--
-- Deliberately NOT replaced, because their existing owned-only predicate is the
-- behaviour we want: bgb_user_stats / bgb_user_stats_detail (owned_games,
-- owned_expansions, Shelf of Shame), bgb_game_detail_bundle (its viewer_status
-- already reads c.status and so returns prev_owned for free; its owned-
-- expansion count correctly skips it), bgb_search_games (collection_status is
-- a pass-through), bgb_bootstrap (delegates to bgb_profile_bundle).
--
-- bootstrap_version is NOT bumped. Every added key is additive, and a cached
-- pre-069 bundle simply lacks owned_parted_total — which the client reads as
-- zero, i.e. exactly the pre-069 behaviour — so a cache wipe would cost every
-- user a cold boot to publish a key they do not yet have any prev_owned rows
-- for.

BEGIN;

-- ── The constraint ─────────────────────────────────────────────────────────
-- Mirrors 010_drop_played_status.sql, which is where this list last moved.
-- No index changes: idx_bgb_collections_user_status and
-- idx_bgb_collections_user_status_name are both (user_id, status, …) and serve
-- the new value as they stand.
ALTER TABLE public.boardgamebuddy_collections
  DROP CONSTRAINT IF EXISTS boardgamebuddy_collections_status_check;
ALTER TABLE public.boardgamebuddy_collections
  ADD CONSTRAINT boardgamebuddy_collections_status_check
  CHECK (status IN ('owned', 'wishlist', 'prev_owned'));

-- ── bgb_collection_status_map ─ was 050_ghost_rpcs_and_status_map.sql ──────
-- The viewer's status map + owned-expansion counts, in one read.
CREATE OR REPLACE FUNCTION public.bgb_collection_status_map(p_viewer UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status_map JSONB;
  v_expansion_counts JSONB;
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

  RETURN jsonb_build_object(
    'status_map', v_status_map,
    'expansion_counts', v_expansion_counts
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.bgb_collection_status_map(UUID) TO boardgamebuddy_role;

-- ── bgb_collection_shelf ─ was 055_hi_res_tile_art.sql ─────────────────────
CREATE OR REPLACE FUNCTION public.bgb_collection_shelf(
  viewer UUID,
  target UUID,
  p_status TEXT DEFAULT 'owned',
  p_exclude_expansions BOOLEAN DEFAULT true,
  p_limit INT DEFAULT 1000
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
    -- No denormalized columns available here — there is no collection row —
    -- so this branch does join boardgamebuddy_games.
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
    )
    SELECT COUNT(*) INTO v_total
      FROM played_games pg
      JOIN boardgamebuddy_games g ON g.id = pg.game_id
      WHERE NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_collections c
              WHERE c.user_id = target AND c.game_id = pg.game_id
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
    ),
    played_not_owned AS (
      SELECT pg.*
      FROM played_games pg
      WHERE NOT EXISTS (
        SELECT 1 FROM boardgamebuddy_collections c
        WHERE c.user_id = target AND c.game_id = pg.game_id
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
            'added_at', pno.last_played_at::TEXT || 'T00:00:00+00:00',
            'last_played_at', pno.last_played_at,
            'play_count', COALESCE(pno.play_count, 0),
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
$$;

GRANT EXECUTE ON FUNCTION public.bgb_collection_shelf(UUID, UUID, TEXT, BOOLEAN, INT)
  TO boardgamebuddy_role;

-- ── bgb_profile_bundle ─ was 064_profile_bundle_buddy_blocks.sql ────────
CREATE OR REPLACE FUNCTION public.bgb_profile_bundle(
  viewer UUID,
  target UUID,
  col_per_page INT DEFAULT 12,
  plays_per_page INT DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
      p.game_id,
      MAX(p.played_at) AS last_played_at,
      COUNT(*)::INT AS play_count
    FROM boardgamebuddy_plays p
    WHERE p.user_id = target
       OR EXISTS (
            SELECT 1 FROM boardgamebuddy_play_players pp
            WHERE pp.play_id = p.id AND pp.player_user_id = target
          )
    GROUP BY p.game_id
  ),
  played_not_owned AS (
    SELECT pg.*
    FROM played_games pg
    WHERE NOT EXISTS (
      SELECT 1 FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.game_id = pg.game_id
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
      p.game_id,
      MAX(p.played_at) AS last_played_at,
      COUNT(*)::INT AS play_count
    FROM boardgamebuddy_plays p
    WHERE p.user_id = target
       OR EXISTS (
            SELECT 1 FROM boardgamebuddy_play_players pp
            WHERE pp.play_id = p.id AND pp.player_user_id = target
          )
    GROUP BY p.game_id
  ),
  played_not_owned AS (
    SELECT pg.*
    FROM played_games pg
    WHERE NOT EXISTS (
      SELECT 1 FROM boardgamebuddy_collections c
      WHERE c.user_id = target AND c.game_id = pg.game_id
    )
  )
  SELECT COALESCE(jsonb_agg(row_jsonb ORDER BY sort_order DESC), '[]'::jsonb)
    INTO v_played_page
    FROM (
      SELECT
        pno.last_played_at AS sort_order,
        jsonb_build_object(
          'id', 'derived-' || pno.game_id::text,
          'game_id', pno.game_id,
          'status', 'played',
          'added_at', (pno.last_played_at::text || 'T00:00:00+00:00'),
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
    FROM boardgamebuddy_plays p
    WHERE p.user_id = target
       OR EXISTS (
         SELECT 1 FROM boardgamebuddy_play_players pp
         WHERE pp.play_id = p.id AND pp.player_user_id = target
       );

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
        FROM boardgamebuddy_plays p
        LEFT JOIN boardgamebuddy_profiles pr ON pr.id = p.user_id
        WHERE p.user_id = target
           OR EXISTS (
             SELECT 1 FROM boardgamebuddy_play_players pp
             WHERE pp.play_id = p.id AND pp.player_user_id = target
           )
        ORDER BY p.played_at DESC, p.created_at DESC
        LIMIT plays_per_page
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
            p.game_id,
            MAX(p.game_name) AS name,
            MAX(p.game_thumbnail_url) AS thumbnail_url,
            MAX(p.played_at) AS last_played_at,
            COUNT(*)::INT AS plays
          FROM boardgamebuddy_plays p
          WHERE p.user_id = target
             OR EXISTS (
               SELECT 1 FROM boardgamebuddy_play_players pp
               WHERE pp.play_id = p.id AND pp.player_user_id = target
             )
          GROUP BY p.game_id
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
  ELSE
    v_buddies := NULL;
    v_buddy_incoming := NULL;
    v_buddy_outgoing := NULL;
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
    'buddy_requests_outgoing', v_buddy_outgoing
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.bgb_profile_bundle(UUID, UUID, INT, INT)
  TO boardgamebuddy_role;

COMMIT;
