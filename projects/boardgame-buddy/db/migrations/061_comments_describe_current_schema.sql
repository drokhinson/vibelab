-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy 061 — database comments only where they clarify
--
-- A COMMENT ON is kept only where an object's name leaves its use unclear: a
-- misnamed column, a sentinel value, a JSON shape, a visibility rule, a column
-- nothing uses. 34 comments are set to that short text and the other 40
-- are cleared. Then 19 functions are re-issued with CREATE OR REPLACE whose
-- bodies differ from the live definitions in `--` comments only, which no
-- longer cite migrations. No signature, body, grant or behaviour changes;
-- CREATE OR REPLACE keeps each function's ACL.
--
-- Safe on production and on a fresh
-- database built from the baseline, which already holds this end state; a
-- second run changes nothing.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Comments that stay ───────────────────────────────────────────────────────
COMMENT ON TABLE public.boardgamebuddy_affiliate_partners IS 'A partner renders only when enabled AND it has a tracking_tag or a wrapper_template.';
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.url_template IS 'Store URL with {query} (the game name, URL-encoded) and optionally {tag} (tracking_tag).';
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.wrapper_template IS 'Optional network redirect around the store URL; {url} is that URL, percent-encoded.';
COMMENT ON TABLE public.boardgamebuddy_bgg_hot_snapshots IS 'BGG''s hot list, one row per (refresh, game). captured_at identifies the refresh: every row of one run shares it.';
COMMENT ON TABLE public.boardgamebuddy_bgg_thumb_cache IS 'Thumbnails for BGG search results. A game here is not in the catalog.';
COMMENT ON COLUMN public.boardgamebuddy_games.rulebook_url IS 'Unused: nothing reads or writes it. A game''s rulebook link is an approved layout=''rulebook_link'' chapter. Kept only because many RPCs select it.';
COMMENT ON COLUMN public.boardgamebuddy_games.publishers IS '''{}'' = BGG credits no publisher; NULL = not read from BGG yet. Readers treat both as an empty list.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_meta_synced_at IS 'Last read of the game''s BGG record. NULL with a non-null bgg_id = queued for the metadata backfill.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_images_synced_at IS 'Last read of the game''s BGG image URLs. NULL with a non-null bgg_id = queued for the image-links backfill.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_family IS 'The BGG family rank list the game ranks highest in (strategygames, familygames, …). Decides the category it is ranked in.';
COMMENT ON TABLE public.boardgamebuddy_affiliate_clicks IS 'One row per tap on a partner link. No user column, by design: usage records carry no account identifier.';
COMMENT ON COLUMN public.boardgamebuddy_profiles.avatar IS 'Badge config {icon, iconColor, bgColor}; icon is "initials" or an icon key. NULL = the default badge.';
COMMENT ON COLUMN public.boardgamebuddy_profiles.link_notifications_seen_at IS 'Read watermark for the whole notification bell (play links, buddy requests, accepted requests), despite the name.';
COMMENT ON COLUMN public.boardgamebuddy_profiles.push_tier IS 'none | actionable | all. Each tier includes the one before it.';
COMMENT ON COLUMN public.boardgamebuddy_profiles.bga_password_enc IS 'Encrypted with BGA_CREDENTIAL_KEY, a key separate from the BGG one.';
COMMENT ON TABLE public.boardgamebuddy_bga_player_links IS 'A Board Game Arena handle mapped by the owner to a person, used to pre-seat that handle on later imports.';
COMMENT ON COLUMN public.boardgamebuddy_buddy_edges.alias_by_a IS 'Private nickname user_a gave user_b. Shown only to user_a.';
COMMENT ON COLUMN public.boardgamebuddy_buddy_edges.alias_by_b IS 'Private nickname user_b gave user_a. Shown only to user_b.';
COMMENT ON COLUMN public.boardgamebuddy_collections.played_before_at IS 'The played mark: played somewhere without logging it here. Never counted as a play. A game on no shelf carries it on a status ''played'' row.';
COMMENT ON TABLE public.boardgamebuddy_game_ranks IS 'Per player and category: tier love | good | not, position dense from 0 within a tier. Write only through bgb_rank_game / bgb_unrank_game.';
COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.grid IS 'Rows of a layout=''scoring_grid'' chapter: {"v":1,"mode":…,"rows":[{"label":…,"color":…,"note":…}]}. color is a palette slug, never a hex.';
COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.moderation_status IS 'Rulebook links only. approved: everyone sees it; unlisted and pending: the author and their accepted buddies; denied: the author. pending also means it is in the admin queue.';
COMMENT ON COLUMN public.boardgamebuddy_plays.client_key IS 'Client-generated idempotency key for plays queued offline.';
COMMENT ON COLUMN public.boardgamebuddy_plays.scoring_template IS 'Snapshot of the scoring grid the play was scored with. Deliberately not a foreign key: editing or deleting the chapter never relabels an old play.';
COMMENT ON COLUMN public.boardgamebuddy_plays.inherited_at IS 'Set when the play passed to its current owner because the account that logged it was deleted. When set, user_id is not the author.';
COMMENT ON COLUMN public.boardgamebuddy_play_players.round_scores IS 'Per-round scores as a JSON array of nullable ints; score holds the total.';
COMMENT ON COLUMN public.boardgamebuddy_play_players.team IS 'Free-text side, as the host typed it. Compared case-insensitively after trimming.';
COMMENT ON TABLE public.boardgamebuddy_play_reactions IS 'One tap on a night''s footer writes a row for every play of that night, all sharing one reaction_group_id.';
COMMENT ON COLUMN public.boardgamebuddy_play_sessions.play_mode IS 'How this table is being scored (competitive | coop | team); NULL = competitive. Can differ from boardgamebuddy_games.play_mode, which is what the box suggests.';
COMMENT ON COLUMN public.boardgamebuddy_play_session_participants.team IS 'Free-text side, as the host typed it. Compared case-insensitively after trimming.';
COMMENT ON TABLE public.boardgamebuddy_rank_deferrals IS 'Games a player chose to rank after their next play. bgb_rank_deferrals_active says which still hold.';
COMMENT ON COLUMN public.boardgamebuddy_release_notices.published_at IS 'NULL = draft.';
COMMENT ON COLUMN public.boardgamebuddy_user_chapters.state IS 'kept = in the viewer''s guide; disliked = turned down, and left out of their chapter pool.';
COMMENT ON FUNCTION public.bgb_app_uid() IS 'The UUID the app knows the caller by: the app_uid JWT claim, else a UUID-shaped sub, else NULL.';

-- ── Comments cleared ────────────────────────────────────────────────────────
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.tracking_tag IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.disclosure IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.notes IS NULL;
COMMENT ON TABLE public.boardgamebuddy_countries IS NULL;
COMMENT ON TABLE public.boardgamebuddy_feedback_topics IS NULL;
COMMENT ON TABLE public.boardgamebuddy_feedback_types IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_rating IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_rank IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_weight IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_owned_count IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_stats_synced_at IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_image_url IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_thumbnail_url IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_profiles.needs_setup IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_profiles.app_installed_at IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_profiles.bgg_last_check_started_at IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_profiles.release_notices_seen_at IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_profiles.bga_session_cookies IS NULL;
COMMENT ON TABLE public.boardgamebuddy_buddy_suggestion_dismissals IS NULL;
COMMENT ON TABLE public.boardgamebuddy_feedback IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_feedback.resolved_by IS NULL;
COMMENT ON TABLE public.boardgamebuddy_feedback_likes IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.link_url IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.moderated_by IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_plays.bgg_play_id IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_plays.country_code IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_plays.bga_table_id IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_plays.inherited_from_name IS NULL;
COMMENT ON INDEX public.uq_bgb_play_players_play_user IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_play_sessions.scoring_template IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_play_session_participants.position IS NULL;
COMMENT ON TABLE public.boardgamebuddy_push_subscriptions IS NULL;
COMMENT ON TABLE public.boardgamebuddy_release_notices IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_release_notices.body_md IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_release_notices.link_route IS NULL;
COMMENT ON COLUMN public.boardgamebuddy_release_notices.created_by IS NULL;
COMMENT ON FUNCTION public.bgb_rank_deferrals_active(p_viewer uuid) IS NULL;
COMMENT ON FUNCTION public.bgb_rank_game(p_user uuid, p_game uuid, p_category text, p_tier text, p_index integer) IS NULL;
COMMENT ON FUNCTION public.bgb_unrank_game(p_user uuid, p_game uuid) IS NULL;
COMMENT ON FUNCTION public.bgb_admin_usage_stats(p_exclude_admins boolean) IS NULL;

-- ── Function bodies: comments only ──────────────────────────────────────────

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

CREATE OR REPLACE FUNCTION public.bgb_admin_usage_stats(p_exclude_admins boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH
-- The accounts to leave out: every admin when asked, nobody otherwise.
excluded AS (
  SELECT id FROM boardgamebuddy_profiles WHERE p_exclude_admins AND is_admin
),
excluded_txt AS (
  SELECT id::text AS id FROM excluded
),
-- ── Accounts ────────────────────────────────────────────────────────────────
user_counts AS (
  SELECT jsonb_build_object(
    'total',        COUNT(*) FILTER (WHERE NOT kept_out),
    'new_24h',      COUNT(*) FILTER (WHERE NOT kept_out AND created_at >= now() - interval '24 hours'),
    'new_7d',       COUNT(*) FILTER (WHERE NOT kept_out AND created_at >= now() - interval '7 days'),
    'new_30d',      COUNT(*) FILTER (WHERE NOT kept_out AND created_at >= now() - interval '30 days'),
    -- Always the full count, filtered or not: it is how the screen says how
    -- many accounts the filter left out.
    'admins',       COUNT(*) FILTER (WHERE is_admin),
    'bgg_linked',   COUNT(*) FILTER (WHERE NOT kept_out AND bgg_username IS NOT NULL),
    'first_signup', MIN(created_at) FILTER (WHERE NOT kept_out)
  ) AS j
  FROM (
    SELECT p.*, (p_exclude_admins AND p.is_admin) AS kept_out
    FROM boardgamebuddy_profiles p
  ) prof
),
push AS (
  SELECT COUNT(DISTINCT user_id) AS n FROM boardgamebuddy_push_subscriptions
  WHERE user_id NOT IN (SELECT id FROM excluded)
),
-- ── Active accounts, from the request log ───────────────────────────────────
-- Scoped to this app: api_logs is cross-app.
logs AS (
  SELECT user_id, sent_at
  FROM api_logs
  WHERE app = 'boardgame-buddy' AND user_id IS NOT NULL
    AND user_id::text NOT IN (SELECT id FROM excluded_txt)
),
active AS (
  SELECT jsonb_build_object(
    'dau', COUNT(DISTINCT user_id::text) FILTER (WHERE sent_at >= now() - interval '24 hours'),
    'wau', COUNT(DISTINCT user_id::text) FILTER (WHERE sent_at >= now() - interval '7 days'),
    'mau', COUNT(DISTINCT user_id::text) FILTER (WHERE sent_at >= now() - interval '30 days')
  ) AS j
  FROM logs
),
-- The oldest row in the WHOLE app's log, not just the authenticated slice:
-- it dates the instrumentation, which is what stops a short history reading
-- as low usage.
sample AS (
  SELECT MIN(sent_at) AS oldest FROM api_logs WHERE app = 'boardgame-buddy'
),
-- A row per calendar day for the strip chart. generate_series so a day with
-- nobody on it is a zero rather than a missing bar — a gap would draw as a
-- narrower chart, not as a quiet Tuesday.
days AS (
  SELECT (now()::date - offs) AS day
  FROM generate_series(0, 29) AS g(offs)
),
daily AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object('day', d.day, 'users', c.n) ORDER BY d.day), '[]'::jsonb) AS j
  FROM days d
  LEFT JOIN LATERAL (
    SELECT COUNT(DISTINCT l.user_id::text) AS n
    FROM logs l
    WHERE l.sent_at >= d.day::timestamptz
      AND l.sent_at <  (d.day + 1)::timestamptz
  ) c ON TRUE
),
-- ── Postgres footprint ──────────────────────────────────────────────────────
tbl AS (
  SELECT
    c.relname::text                  AS table_name,
    pg_total_relation_size(c.oid)    AS total_bytes,
    GREATEST(c.reltuples, 0)::bigint AS row_estimate
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND (c.relname LIKE 'boardgamebuddy\_%' OR c.relname IN ('analytics_events', 'api_logs'))
),
db_size AS (
  SELECT jsonb_build_object(
    'total_bytes', COALESCE(SUM(total_bytes), 0),
    'tables', COALESCE(jsonb_agg(
      jsonb_build_object(
        'table_name',   table_name,
        'total_bytes',  total_bytes,
        'row_estimate', row_estimate
      ) ORDER BY total_bytes DESC
    ), '[]'::jsonb)
  ) AS j
  FROM tbl
),
-- ── Screens and the rest of the event mix ───────────────────────────────────
ev AS (
  SELECT event, created_at FROM analytics_events
  WHERE app = 'boardgame-buddy'
    -- metadata.admin is stamped by the client (web/domain/api.js); a row
    -- without the stamp is always counted.
    AND NOT (p_exclude_admins AND COALESCE(metadata->>'admin', '') = 'true')
),
ev_rolled AS (
  SELECT
    event,
    COUNT(*)                                                               AS all_time,
    COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')       AS last_30d,
    COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')        AS last_7d,
    COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')      AS last_24h
  FROM ev
  GROUP BY event
),
screens AS (
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      -- The route name, not the raw event: the UI titles it, and 'view:' on
      -- every row is twelve wasted characters of a 480px column.
      'screen',   substring(event from 6),
      'all_time', all_time, 'last_30d', last_30d,
      'last_7d',  last_7d,  'last_24h', last_24h
    ) ORDER BY all_time DESC
  ), '[]'::jsonb) AS j
  FROM ev_rolled WHERE event LIKE 'view:%'
),
event_mix AS (
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'event',    event,
      'all_time', all_time, 'last_30d', last_30d,
      'last_7d',  last_7d,  'last_24h', last_24h
    ) ORDER BY all_time DESC
  ), '[]'::jsonb) AS j
  FROM ev_rolled WHERE event NOT LIKE 'view:%'
),
-- ── What people actually make ───────────────────────────────────────────────
-- One row per feature, each counted over the same four windows, so the UI
-- renders them as one table and the segmented control only switches column.
--
-- EVERY FEATURE NAMES ITS OWN CLOCK COLUMN. Three of these tables have no
-- created_at at all — a session seat has joined_at, a shelf entry added_at, an
-- achievement unlocked_at — and a buddy link's accepted_at is NULL until it is
-- accepted, which is exactly the filter "links made" wants, so it needs no
-- guess at the status vocabulary. Ghost claims are counted as RAISED
-- (created_at) rather than resolved, for the same reason.
--
-- The clock is when somebody used the app, never the domain date: plays are
-- counted by created_at, not played_at, or a play logged today about last
-- Christmas would land in no window anybody is looking at.
--
-- The features list is a VALUES join rather than a GROUP BY alone so a feature
-- nobody has used yet renders as a zero instead of vanishing from the table.
domain_counts AS (
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'feature',  f.feature,
      'all_time', COALESCE(c.all_time, 0), 'last_30d', COALESCE(c.last_30d, 0),
      'last_7d',  COALESCE(c.last_7d, 0),  'last_24h', COALESCE(c.last_24h, 0)
    ) ORDER BY f.ord
  ), '[]'::jsonb) AS j
  FROM (VALUES
    ( 1, 'Plays logged'),
    ( 2, 'Plays with a photo'),
    ( 3, 'Live sessions hosted'),
    ( 4, 'Seats at a live session'),
    ( 5, 'Guide chapters written'),
    ( 6, 'Chapters saved to a guide'),
    ( 7, 'Reactions'),
    ( 8, 'Shelf entries'),
    ( 9, 'Buddy links accepted'),
    (10, 'Ghost claims raised'),
    (11, 'Achievements unlocked'),
    (12, 'Feedback posted'),
    (13, 'Games added to the catalog')
  ) AS f(ord, feature)
  LEFT JOIN (
    SELECT
      ord,
      COUNT(*)                                                             AS all_time,
      COUNT(*) FILTER (WHERE happened_at >= now() - interval '30 days')    AS last_30d,
      COUNT(*) FILTER (WHERE happened_at >= now() - interval '7 days')     AS last_7d,
      COUNT(*) FILTER (WHERE happened_at >= now() - interval '24 hours')   AS last_24h
    FROM (
                SELECT  1 AS ord, created_at  AS happened_at, user_id      AS who FROM boardgamebuddy_plays
      UNION ALL SELECT  2,        created_at,               user_id             FROM boardgamebuddy_plays WHERE photo_url IS NOT NULL
      UNION ALL SELECT  3,        created_at,               host_user_id        FROM boardgamebuddy_play_sessions
      UNION ALL SELECT  4,        joined_at,                user_id             FROM boardgamebuddy_play_session_participants
      UNION ALL SELECT  5,        created_at,               created_by          FROM boardgamebuddy_guide_chapters
      UNION ALL SELECT  6,        created_at,               user_id             FROM boardgamebuddy_user_chapters
      UNION ALL SELECT  7,        created_at,               user_id             FROM boardgamebuddy_play_reactions
      UNION ALL SELECT  8,        added_at,                 user_id             FROM boardgamebuddy_collections
      UNION ALL SELECT  9,        accepted_at,              accepted_by         FROM boardgamebuddy_buddy_edges WHERE accepted_at IS NOT NULL
      UNION ALL SELECT 10,        created_at,               claimant_id         FROM boardgamebuddy_ghost_claims
      UNION ALL SELECT 11,        unlocked_at,              user_id             FROM boardgamebuddy_user_achievements
      UNION ALL SELECT 12,        created_at,               user_id             FROM boardgamebuddy_feedback
      -- No column says who added a game, so the catalog count is never filtered.
      UNION ALL SELECT 13,        created_at,               NULL::uuid          FROM boardgamebuddy_games
    ) src
    -- NULL `who` (a guest seat, an ownerless chapter, a game) is never an
    -- admin, and NOT IN against a NULL would drop it, hence the IS NULL arm.
    WHERE who IS NULL OR who NOT IN (SELECT id FROM excluded)
    GROUP BY ord
  ) c ON c.ord = f.ord
),
-- ── Where plays come from ───────────────────────────────────────────────────
-- Derived, and THE ORDER MATTERS: there is no source column on
-- boardgamebuddy_plays, and a BGG- or BGA-imported play carries an
-- import_batch_id too, so the batch test has to come last or it would swallow
-- both integrations.
origins AS (
  SELECT
    CASE
      WHEN bgg_play_id     IS NOT NULL THEN 1
      WHEN bga_table_id    IS NOT NULL THEN 2
      WHEN import_batch_id IS NOT NULL THEN 3
      ELSE 4
    END AS ord,
    created_at
  FROM boardgamebuddy_plays
  WHERE user_id NOT IN (SELECT id FROM excluded)
),
play_origins AS (
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'origin',   o.origin,
      'all_time', COALESCE(c.all_time, 0), 'last_30d', COALESCE(c.last_30d, 0),
      'last_7d',  COALESCE(c.last_7d, 0),  'last_24h', COALESCE(c.last_24h, 0)
    ) ORDER BY o.ord
  ), '[]'::jsonb) AS j
  FROM (VALUES
    (1, 'BoardGameGeek'),
    (2, 'Board Game Arena'),
    (3, 'Notes or photos import'),
    (4, 'Logged by hand')
  ) AS o(ord, origin)
  LEFT JOIN (
    SELECT ord,
           COUNT(*)                                                           AS all_time,
           COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')    AS last_30d,
           COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')     AS last_7d,
           COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')   AS last_24h
    FROM origins GROUP BY ord
  ) c ON c.ord = o.ord
)
SELECT jsonb_build_object(
  'generated_at',  now(),
  'exclude_admins', p_exclude_admins,
  'users',         (SELECT j FROM user_counts) || jsonb_build_object('push_enabled', (SELECT n FROM push)),
  'active',        (SELECT j FROM active)
                     || jsonb_build_object('daily', (SELECT j FROM daily))
                     || jsonb_build_object('oldest_sample_at', (SELECT oldest FROM sample)),
  'database',      (SELECT j FROM db_size),
  'screens',       (SELECT j FROM screens),
  'events',        (SELECT j FROM event_mix),
  'domain',        (SELECT j FROM domain_counts),
  'play_origins',  (SELECT j FROM play_origins)
);
$function$;

CREATE OR REPLACE FUNCTION public.bgb_feed_plays(viewer uuid, before_played_at date DEFAULT NULL::date, before_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, lim integer DEFAULT 20)
 RETURNS TABLE(play_id uuid, play_user_id uuid, play_user_name text, play_user_avatar jsonb, game_id uuid, game_name text, game_image_url text, game_thumbnail_url text, played_at date, created_at timestamp with time zone, notes text, photo_url text, play_mode text, winner_display_name text, participant_count integer, participants jsonb, group_count integer, import_group_id uuid, players jsonb, expansions jsonb, country_code text, reaction_count integer, viewer_reacted boolean, reactors jsonb, import_batch_id uuid, scoring_template jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Dynamic SQL for one reason: `lim` is interpolated as a literal instead of
  -- being bound as a parameter. With BOTH `viewer` and `lim` opaque, the
  -- planner has no idea the `page` CTE yields ~20 rows, so it plans the roster
  -- lookup as if `page` were huge and reads the whole play_players table —
  -- measured 555 ms versus 12 ms with the limit visible. Interpolating just
  -- the limit restores the estimate; viewer/cursor stay bound via USING, which
  -- is enough for a good plan. Injection-safe because `lim` is typed INT, so
  -- it cannot carry SQL, and it's clamped to a sane range below.
  --
  -- EXECUTE also sidesteps plpgsql's substitution of RETURNS TABLE column
  -- names (play_id, played_at, notes, participants, players, …) into the query
  -- body: the string is handed to the SQL engine untouched. The shadowed
  -- names include `players`, `expansions`, `reactors`, `import_batch_id` and
  -- `scoring_template` —
  -- all of which `page` selects by name from the plays table, so the shadowing
  -- would be a live bug rather than a theoretical one. One more reason this
  -- stays EXECUTE.
  RETURN QUERY EXECUTE format($q$
  WITH visible AS (
    SELECT $1::uuid AS uid
    UNION
    SELECT CASE WHEN be.user_a = $1::uuid THEN be.user_b ELSE be.user_a END AS uid
    FROM public.boardgamebuddy_buddy_edges be
    WHERE be.status = 'accepted'
      AND $1::uuid IN (be.user_a, be.user_b)
  ),
  -- Plays the viewer themselves attended — used to widen the roster
  -- filter so non-buddy participants are exposed on cards for plays
  -- the viewer was at.
  viewer_was_at AS (
    SELECT DISTINCT pp.play_id
    FROM public.boardgamebuddy_play_players pp
    WHERE pp.player_user_id = $1::uuid
  ),
  -- Plays where at least one visible user (viewer or any accepted buddy)
  -- appears in play_players. This is the "main" visibility branch.
  attended AS (
    SELECT DISTINCT pp.play_id
    FROM public.boardgamebuddy_play_players pp
    WHERE pp.player_user_id IN (SELECT uid FROM visible)
  ),
  -- Final candidate set: legacy "logger ∈ visible" UNION attended. The
  -- legacy branch is technically subsumed by `attended` when the logger
  -- is always tagged as a participant (the standard log_play flow does
  -- this), but we keep it as a belt-and-suspenders cover for any
  -- historical rows where it isn't.
  visible_plays AS (
    SELECT p.id
    FROM public.boardgamebuddy_plays p
    JOIN visible v ON v.uid = p.user_id
    UNION
    SELECT play_id FROM attended
  ),
  -- Resolve the page BEFORE touching play_players. This is the whole point of
  -- the rewrite: the roster lookup below runs per page row, so it reads at
  -- most `lim` plays' worth of play_players instead of the entire table.
  page AS (
    SELECT p.id, p.user_id, p.game_id, p.played_at, p.created_at,
           p.notes, p.photo_url, p.play_mode, p.import_group_id,
           -- Free: `page` already reads this row, and the column
           -- is a plain uuid on it.
           p.import_batch_id,
           -- Free for the same reason — a jsonb column on the row
           -- `page` already selects from.
           p.scoring_template,
           p.country_code,
           -- How many plays this row stands for. 1 for everything the app has
           -- ever logged live; the run's size for an imported group.
           CASE WHEN p.import_group_id IS NULL THEN 1
                ELSE (SELECT COUNT(*)::INT
                        FROM public.boardgamebuddy_plays q
                       WHERE q.import_group_id = p.import_group_id)
           END AS group_count
    FROM public.boardgamebuddy_plays p
    JOIN visible_plays vp ON vp.id = p.id
    WHERE (
      $2::date IS NULL
      OR $3::timestamptz IS NULL
      OR (p.played_at, p.created_at) < ($2::date, $3::timestamptz)
    )
      -- One representative row per imported run: the lowest id
      -- in the run, so the choice is stable and deleting the representative
      -- just promotes the next row rather than losing the group.
      --
      -- ORDER BY ... LIMIT 1 rather than MIN(): Postgres has no MIN aggregate
      -- for uuid, though the type orders fine in an index.
      --
      -- This sits INSIDE `page`, before the LIMIT, on purpose: that is what
      -- makes a page 20 CARDS rather than 20 rows of which 19 are the same
      -- run. A 106-play import used to consume five pages of everyone's feed
      -- before anything else could appear.
      --
      -- Deliberately a correlated lookup on the partial index rather than a
      -- window function over the viewer's visible plays: the window is the
      -- slower shape (105 ms vs 5 ms on a 30k-play fixture),
      -- and it would make every feed call pay for grouping that almost no row
      -- needs. Both subqueries are short-circuited by the NULL check for every
      -- play that was not imported, which is all of them but a handful.
      AND (
        p.import_group_id IS NULL
        OR p.id = (SELECT q.id
                     FROM public.boardgamebuddy_plays q
                    WHERE q.import_group_id = p.import_group_id
                    ORDER BY q.id
                    LIMIT 1)
      )
    ORDER BY p.played_at DESC, p.created_at DESC, p.id
    LIMIT %s
  )
  -- Roster + winners, resolved per page row via LATERAL rather than as
  -- page-filtered CTEs. This matters: `lim` is a function parameter, so the
  -- planner has no idea `page` yields ~20 rows. Given `pp.play_id IN (SELECT
  -- id FROM page)` it assumes `page` is large and picks a hash semi-join over
  -- the whole play_players table — twice — which measured ~8x SLOWER than the
  -- original. A LATERAL keyed on p.id is an index lookup on
  -- idx_bgb_play_players_play per page row, so the work stays bounded by `lim`
  -- no matter what the planner estimates.
  SELECT
    p.id,
    p.user_id,
    prof.display_name,
    prof.avatar,
    g.id,
    g.name,
    g.image_url,
    g.thumbnail_url,
    p.played_at,
    p.created_at,
    p.notes,
    p.photo_url,
    p.play_mode,
    roster.winner_display_name,
    COALESCE(roster.participant_count, 0),
    COALESCE(roster.participants, '[]'::jsonb),
    p.group_count,
    p.import_group_id,
    COALESCE(roster.players, '[]'::jsonb),
    COALESCE(exp.expansions, '[]'::jsonb),
    p.country_code,
    COALESCE(rx.reaction_count, 0),
    COALESCE(rx.viewer_reacted, false),
    COALESCE(rx.reactors, '[]'::jsonb),
    p.import_batch_id,
    p.scoring_template
  FROM page p
  JOIN public.boardgamebuddy_profiles prof ON prof.id = p.user_id
  JOIN public.boardgamebuddy_games g       ON g.id = p.game_id
  LEFT JOIN LATERAL (
    SELECT
      string_agg(
        COALESCE(pprof.display_name, pp.player_display_name), ', '
        ORDER BY COALESCE(pprof.display_name, pp.player_display_name)
      ) FILTER (WHERE pp.is_winner = true) AS winner_display_name,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'user_id',      pp.player_user_id::text,
            'display_name', COALESCE(pprof.display_name, pp.player_display_name)
          )
          ORDER BY COALESCE(pprof.display_name, pp.player_display_name)
        ) FILTER (
          WHERE pp.player_user_id IS NOT NULL
            AND (
              pp.player_user_id IN (SELECT uid FROM visible)
              OR p.id IN (SELECT play_id FROM viewer_was_at)
            )
        ),
        '[]'::jsonb
      ) AS participants,
      -- The scorecard. UNFILTERED, unlike `participants`: this
      -- is the roster the back of the card and the detail popup draw, and both
      -- have always shown every seat — ghosts included — because that is what
      -- GET /plays/{id} returns them today.
      --
      -- Ordered by is_winner then score, both DESC NULLS LAST, so the array
      -- arrives in the order the scoreboard wants and the client's sort is a
      -- no-op on well-formed data rather than the thing that makes it correct.
      -- Field names mirror PlayPlayerResponse exactly (name, not display_name)
      -- so the FE adapter is a pass-through.
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'user_id',      pp.player_user_id::text,
            'name',         COALESCE(pprof.display_name, pp.player_display_name),
            'avatar',       pprof.avatar,
            'is_winner',    COALESCE(pp.is_winner, false),
            'score',        pp.score,
            'round_scores', pp.round_scores,
            -- Required, not optional: Play.fromFeedCard passes
            -- this array straight into the detail popup's seed and the popup
            -- paints from it in the same frame as the tap. Without it a play
            -- opened from the feed would show an ungrouped roster that then
            -- reshuffled into sides when GET /plays/{id} landed.
            'team',         pp.team
          )
          ORDER BY COALESCE(pp.is_winner, false) DESC, pp.score DESC NULLS LAST
        ),
        '[]'::jsonb
      ) AS players,
      COUNT(*)::INT AS participant_count
    FROM public.boardgamebuddy_play_players pp
    LEFT JOIN public.boardgamebuddy_profiles pprof ON pprof.id = pp.player_user_id
    WHERE pp.play_id = p.id
  ) roster ON true
  -- Expansions. Same LATERAL shape as the roster so it
  -- inherits the same bounded-by-`lim` property: an index lookup per page row
  -- on the (play_id, expansion_game_id) primary key. Most plays have no
  -- expansions and the aggregate collapses to NULL -> '[]'.
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
             jsonb_build_object(
               'expansion_game_id', pe.expansion_game_id::text,
               'name',              eg.name,
               'color',             eg.theme_color
             )
             ORDER BY eg.name
           ) AS expansions
    FROM public.boardgamebuddy_play_expansions pe
    JOIN public.boardgamebuddy_games eg ON eg.id = pe.expansion_game_id
    WHERE pe.play_id = p.id
  ) exp ON true
  -- Reactions. Same bounded-by-`lim` LATERAL shape as the two
  -- above: an index lookup per page row on the (play_id, user_id) primary key.
  --
  -- `reactors` is capped at 8 and newest-first because the footer only ever
  -- draws three avatars; the exact total rides in `reaction_count`, so the cap
  -- never makes the number wrong. The viewer's own row is answered by an EXISTS
  -- rather than by scanning the capped array, which would go wrong the moment a
  -- ninth person reacted.
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::int AS reaction_count,
      bool_or(r.user_id = $1::uuid) AS viewer_reacted,
      COALESCE(
        (SELECT jsonb_agg(x)
           FROM (SELECT jsonb_build_object(
                          'user_id',      r2.user_id::text,
                          'display_name', rprof.display_name,
                          'avatar',       rprof.avatar
                        ) AS x
                   FROM public.boardgamebuddy_play_reactions r2
                   LEFT JOIN public.boardgamebuddy_profiles rprof ON rprof.id = r2.user_id
                  WHERE r2.play_id = p.id
                  ORDER BY r2.created_at DESC
                  LIMIT 8) capped),
        '[]'::jsonb
      ) AS reactors
    FROM public.boardgamebuddy_play_reactions r
    WHERE r.play_id = p.id
  ) rx ON true
  ORDER BY p.played_at DESC, p.created_at DESC, p.id
  -- The clamp bounds what a caller can interpolate. The ceiling must stay
  -- ABOVE every caller's own cap, because feed_service derives next_cursor
  -- from `len(rows) == limit` — if this silently returned fewer rows than
  -- asked for, pagination would stop early. Today /feed is capped at 50
  -- (feed_routes.py) and bootstrap asks for 20, so 100 has margin.
  $q$, LEAST(GREATEST(COALESCE(lim, 20), 1), 100))
  USING viewer, before_played_at, before_created_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.bgb_notifications(p_viewer uuid, p_limit integer DEFAULT 20, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_key text DEFAULT NULL::text)
 RETURNS TABLE(entry_key text, kind text, occurred_at timestamp with time zone, is_unread boolean, actor_id uuid, actor_display_name text, actor_username text, actor_avatar jsonb, play_group text, play_id uuid, play_ids uuid[], group_count integer, game_count integer, played_from date, played_to date, game_id uuid, game_name text, game_thumbnail_url text, import_batch_id uuid, edge_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_seen TIMESTAMPTZ;
  v_lim  INT := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
BEGIN
  SELECT pr.link_notifications_seen_at INTO v_seen
  FROM boardgamebuddy_profiles pr WHERE pr.id = p_viewer;

  RETURN QUERY
  WITH seats AS (
    -- The viewer's own seats on plays SOMEBODY ELSE logged, carrying their
    -- grouping key and nothing more. This is also the whole visibility rule:
    -- every row is a play the viewer is a player in, so there is nothing to
    -- leak and no buddy-graph check to run.
    --
    -- to_char at UTC rather than l_at::text: the key is the
    -- paging tiebreak and travels to the client and back, so it has to mean the
    -- same thing on both ends of that trip regardless of the session's TimeZone
    -- and DateStyle.
    SELECT pp.play_id   AS p_id,
           pp.linked_at AS l_at,
           p.user_id    AS o_id,
           CASE
             WHEN p.import_batch_id IS NOT NULL THEN 'b:' || p.import_batch_id::text
             WHEN p.import_group_id IS NOT NULL THEN 'g:' || p.import_group_id::text
             ELSE 'a:' || p.user_id::text || ':'
                  || to_char(pp.linked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
           END AS k,
           CASE
             WHEN p.import_batch_id IS NOT NULL THEN 'batch'
             WHEN p.import_group_id IS NOT NULL THEN 'run'
             ELSE 'act'
           END AS kd
    FROM boardgamebuddy_play_players pp
    JOIN boardgamebuddy_plays p ON p.id = pp.play_id
    WHERE pp.player_user_id = p_viewer
      AND p.user_id <> p_viewer
  ),
  page_keys AS (
    -- Which entries are on this page. MAX is the only aggregate here, and the
    -- ORDER BY / LIMIT are the ones the final SELECT would have applied anyway
    -- — just applied before the expensive work instead of after it.
    SELECT s.k AS k, s.kd AS kd, s.o_id AS o_id, MAX(s.l_at) AS l_at
    FROM seats s
    GROUP BY s.k, s.kd, s.o_id
    HAVING p_before IS NULL
        OR (MAX(s.l_at), s.k) < (p_before, COALESCE(p_before_key, ''))
    ORDER BY MAX(s.l_at) DESC, s.k DESC
    LIMIT v_lim
  ),
  members AS (
    -- Every seat belonging to a chosen entry, now with the wide columns. The
    -- join to plays is by primary key and runs for these rows only.
    SELECT pk.k AS k, pk.kd AS kd, pk.o_id AS o_id, s.l_at AS l_at,
           p.id AS p_id, p.game_id AS g_id, p.played_at AS p_at,
           p.game_name AS g_name, p.game_thumbnail_url AS g_thumb,
           p.import_batch_id AS b_id
    FROM seats s
    JOIN page_keys pk ON pk.k = s.k AND pk.kd = s.kd AND pk.o_id = s.o_id
    JOIN boardgamebuddy_plays p ON p.id = s.p_id
  ),
  entries AS (
    SELECT m.k AS k, m.kd AS kd, m.o_id AS o_id,
           MAX(m.l_at)                    AS l_at,
           COUNT(*)::int                  AS n_plays,
           COUNT(DISTINCT m.g_id)::int    AS n_games,
           MIN(m.p_at)                    AS from_at,
           MAX(m.p_at)                    AS to_at,
           array_agg(m.p_id ORDER BY m.p_at DESC NULLS LAST, m.p_id) AS ids,
           -- No MIN()/MAX() aggregate exists for uuid, so the representative is
           -- picked by ordering rather than aggregated. It is the most recent
           -- play in the entry — the one the card names and opens.
           (array_agg(m.p_id    ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep,
           (array_agg(m.g_id    ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep_game,
           (array_agg(m.g_name  ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep_name,
           (array_agg(m.g_thumb ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep_thumb,
           (array_agg(m.b_id    ORDER BY m.p_at DESC NULLS LAST, m.p_id))[1] AS rep_batch
    FROM members m
    GROUP BY m.k, m.kd, m.o_id
  ),
  -- Each source is normalised to the SAME wide row inside its own CTE, so the
  -- NULL casts are written once per branch rather than smeared through a union
  -- of bare SELECTs, and the cursor, the order and the limit are applied
  -- exactly once at the end over the merge.
  play_rows AS (
    SELECT e.k                                   AS ekey,
           'play_link'::text                     AS nkind,
           e.l_at                                AS occ,
           e.o_id                                AS act_id,
           NULL::text                            AS act_name,
           e.kd                                  AS pgroup,
           e.rep                                 AS rep_play,
           e.ids                                 AS rep_plays,
           e.n_plays                             AS n_plays,
           e.n_games                             AS n_games,
           e.from_at                             AS from_at,
           e.to_at                               AS to_at,
           e.rep_game                            AS rep_game,
           -- game_name / game_thumbnail_url are denormalized and null on
           -- older rows, so fall back to the catalog
           -- the same way bgb_collection_shelf does.
           COALESCE(e.rep_name, g.name)          AS rep_name,
           COALESCE(e.rep_thumb, g.thumbnail_url) AS rep_thumb,
           e.rep_batch                           AS rep_batch,
           NULL::uuid                            AS e_id
    FROM entries e
    LEFT JOIN boardgamebuddy_games g ON g.id = e.rep_game
  ),
  -- Somebody asked to be your buddy and you have not answered. Accept flips the
  -- edge to 'accepted' and both Decline and Cancel DELETE it, so this row
  -- leaves the feed the instant it is acted on, from either side and with no
  -- bookkeeping — the same self-healing the play source gets from being derived.
  request_rows AS (
    SELECT 'req:' || be.id::text  AS ekey,
           'buddy_request'::text  AS nkind,
           be.created_at          AS occ,
           be.requested_by        AS act_id,
           NULL::text   AS act_name,
           NULL::text   AS pgroup,    NULL::uuid AS rep_play,
           NULL::uuid[] AS rep_plays,  NULL::int  AS n_plays,
           NULL::int    AS n_games,    NULL::date AS from_at,
           NULL::date   AS to_at,      NULL::uuid AS rep_game,
           NULL::text   AS rep_name,   NULL::text AS rep_thumb,
           NULL::uuid   AS rep_batch,
           be.id                  AS e_id
    FROM boardgamebuddy_buddy_edges be
    WHERE be.status = 'pending'
      AND be.requested_by <> p_viewer
      AND (be.user_a = p_viewer OR be.user_b = p_viewer)
  ),
  -- Somebody said yes. Keyed on accepted_by, never on requested_by: a QR
  -- scan writes an edge born accepted with requested_by = the scanner, so a
  -- requested_by rule would tell the scanner about a request they never sent.
  -- `accepted_by <> p_viewer` is what stops the feed announcing an act the
  -- viewer performed themselves.
  accepted_rows AS (
    SELECT 'acc:' || be.id::text  AS ekey,
           'buddy_accepted'::text AS nkind,
           be.accepted_at         AS occ,
           be.accepted_by         AS act_id,
           NULL::text   AS act_name,
           NULL::text   AS pgroup,    NULL::uuid AS rep_play,
           NULL::uuid[] AS rep_plays,  NULL::int  AS n_plays,
           NULL::int    AS n_games,    NULL::date AS from_at,
           NULL::date   AS to_at,      NULL::uuid AS rep_game,
           NULL::text   AS rep_name,   NULL::text AS rep_thumb,
           NULL::uuid   AS rep_batch,
           be.id                  AS e_id
    FROM boardgamebuddy_buddy_edges be
    WHERE be.status = 'accepted'
      AND be.accepted_at IS NOT NULL
      AND be.accepted_by IS NOT NULL
      AND be.accepted_by <> p_viewer
      AND (be.user_a = p_viewer OR be.user_b = p_viewer)
  ),
  -- A play that passed to the viewer because the account that logged it was
  -- deleted. The fourth kind, and the only one with no actor to join to
  -- — the person IS the actor and their profile row is gone, which is the
  -- whole event. So the name rides up the union in act_name and the final
  -- SELECT coalesces it against the join that is going to miss. That is what
  -- keeps RETURNS TABLE unchanged and this a REPLACE rather than a DROP.
  --
  -- One row per play and no grouping, deliberately: the import groupings that
  -- play_link uses answer "these twelve arrived together", and a handover is
  -- not a batch — the plays it moves need have nothing to do with each other
  -- beyond the person who is gone.
  inherited_rows AS (
    SELECT 'inh:' || p.id::text     AS ekey,
           'play_inherited'::text   AS nkind,
           p.inherited_at           AS occ,
           NULL::uuid               AS act_id,
           p.inherited_from_name    AS act_name,
           NULL::text               AS pgroup,
           p.id                     AS rep_play,
           ARRAY[p.id]::uuid[]      AS rep_plays,
           1::int                   AS n_plays,
           1::int                   AS n_games,
           p.played_at              AS from_at,
           p.played_at              AS to_at,
           p.game_id                AS rep_game,
           -- Same catalog fallback play_rows uses: the denormalized pair is
           -- null on older rows.
           COALESCE(p.game_name, g.name)                    AS rep_name,
           COALESCE(p.game_thumbnail_url, g.thumbnail_url)  AS rep_thumb,
           NULL::uuid               AS rep_batch,
           NULL::uuid               AS e_id
    FROM boardgamebuddy_plays p
    LEFT JOIN boardgamebuddy_games g ON g.id = p.game_id
    WHERE p.user_id = p_viewer
      AND p.inherited_at IS NOT NULL
  ),
  merged AS (
    SELECT * FROM play_rows
    UNION ALL SELECT * FROM request_rows
    UNION ALL SELECT * FROM accepted_rows
    UNION ALL SELECT * FROM inherited_rows
  )
  SELECT m.ekey, m.nkind, m.occ,
         (m.occ > COALESCE(v_seen, '-infinity'::timestamptz)),
         -- The coalesce is for play_inherited alone: every other kind has a
         -- live profile behind act_id, and that arm has no act_id at all.
         m.act_id, COALESCE(pr.display_name, m.act_name), pr.username, pr.avatar,
         m.pgroup, m.rep_play, m.rep_plays, m.n_plays, m.n_games,
         m.from_at, m.to_at, m.rep_game, m.rep_name, m.rep_thumb, m.rep_batch,
         m.e_id
  FROM merged m
  LEFT JOIN boardgamebuddy_profiles pr ON pr.id = m.act_id
  -- Keyset, not OFFSET: rows vanish from under the cursor as the user unlinks
  -- and as requests are answered, and an offset would skip whatever slid up
  -- into the gap. Still applied here over the whole union — page_keys has
  -- already applied the identical predicate to the play arm, which is a
  -- redundancy on that arm and the only filter the two buddy arms get.
  WHERE p_before IS NULL
     OR (m.occ, m.ekey) < (p_before, COALESCE(p_before_key, ''))
  ORDER BY m.occ DESC, m.ekey DESC
  LIMIT v_lim;
END;
$function$;

CREATE OR REPLACE FUNCTION public.bgb_notifications_unread(p_viewer uuid)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_seen TIMESTAMPTZ;
  v_n    INT;
BEGIN
  SELECT pr.link_notifications_seen_at INTO v_seen
  FROM boardgamebuddy_profiles pr WHERE pr.id = p_viewer;
  -- Both a NULL column and a missing profile row mean "has read nothing".
  v_seen := COALESCE(v_seen, '-infinity'::timestamptz);

  SELECT
      -- Play ENTRIES, not plays: a badge reading 214 over a list showing one
      -- row is a bug that only appears on the accounts that most need this
      -- feature. Same key expression bgb_notifications groups by, below.
      (SELECT COUNT(*)::int FROM (
         SELECT 1
         FROM boardgamebuddy_play_players pp
         JOIN boardgamebuddy_plays p ON p.id = pp.play_id
         WHERE pp.player_user_id = p_viewer
           AND pp.linked_at > v_seen
           AND p.user_id <> p_viewer
         GROUP BY CASE
                    WHEN p.import_batch_id IS NOT NULL THEN 'b:' || p.import_batch_id::text
                    WHEN p.import_group_id IS NOT NULL THEN 'g:' || p.import_group_id::text
                    ELSE 'a:' || p.user_id::text || ':'
                         || to_char(pp.linked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
                  END
       ) e)
      -- The two buddy terms are plain row counts: an edge is already one row
      -- per event. One account's pending and accepted sets are small, which is
      -- why they have no index of their own.
    + (SELECT COUNT(*)::int
         FROM boardgamebuddy_buddy_edges be
        WHERE be.status = 'pending'
          AND be.requested_by <> p_viewer
          AND (be.user_a = p_viewer OR be.user_b = p_viewer)
          AND be.created_at > v_seen)
    + (SELECT COUNT(*)::int
         FROM boardgamebuddy_buddy_edges be
        WHERE be.status = 'accepted'
          AND be.accepted_at IS NOT NULL
          AND be.accepted_by IS NOT NULL
          AND be.accepted_by <> p_viewer
          AND (be.user_a = p_viewer OR be.user_b = p_viewer)
          AND be.accepted_at > v_seen)
      -- A play handed over by a deleted account. One row per play, no
      -- grouping: a handover is not a batch and two of them are two events.
      -- Rides idx_bgb_plays_inherited, so an account that has never inherited
      -- anything — which is almost all of them — scans nothing.
    + (SELECT COUNT(*)::int
         FROM boardgamebuddy_plays p
        WHERE p.user_id = p_viewer
          AND p.inherited_at IS NOT NULL
          AND p.inherited_at > v_seen)
    INTO v_n;

  RETURN v_n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.bgb_onboarding_buddy_suggestions(uid uuid, lim integer DEFAULT 12, active_window_days integer DEFAULT 90)
 RETURNS TABLE(user_id uuid, mutual_count bigint, play_count bigint, pending_mutual_count bigint, via_user_id uuid, source text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH my_edges AS (
    SELECT be.user_a, be.user_b, be.status, be.requested_by
      FROM public.boardgamebuddy_buddy_edges be
     WHERE uid IN (be.user_a, be.user_b)
  ),
  connected AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS other_id
      FROM my_edges me
  ),
  -- NEW here — see bgb_suggested_buddies above.
  dismissed AS (
    SELECT d.dismissed_user_id AS other_id
      FROM public.boardgamebuddy_buddy_suggestion_dismissals d
     WHERE d.user_id = uid
  ),
  my_buddies AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS friend_id
      FROM my_edges me
     WHERE me.status = 'accepted'
  ),
  my_requested AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS target_id
      FROM my_edges me
     WHERE me.status = 'pending' AND me.requested_by = uid
  ),
  fof AS (
    SELECT
      CASE WHEN be.user_a = mb.friend_id THEN be.user_b ELSE be.user_a END AS candidate,
      mb.friend_id
    FROM my_buddies mb
    JOIN public.boardgamebuddy_buddy_edges be
      ON be.status = 'accepted'
     AND mb.friend_id IN (be.user_a, be.user_b)
  ),
  mutuals AS (
    SELECT fof.candidate,
           COUNT(DISTINCT fof.friend_id)::BIGINT AS n,
           -- Postgres has no min(uuid); array_agg + [1] is the deterministic
           -- "pick one" and reads as the choice it is.
           (ARRAY_AGG(fof.friend_id ORDER BY fof.friend_id))[1] AS via_any
      FROM fof
     GROUP BY fof.candidate
  ),
  fof_pending AS (
    SELECT
      CASE WHEN be.user_a = mr.target_id THEN be.user_b ELSE be.user_a END AS candidate,
      mr.target_id AS via
    FROM my_requested mr
    JOIN public.boardgamebuddy_buddy_edges be
      ON be.status = 'accepted'
     AND mr.target_id IN (be.user_a, be.user_b)
  ),
  pending_mutuals AS (
    SELECT fof_pending.candidate,
           COUNT(DISTINCT fof_pending.via)::BIGINT AS n,
           (ARRAY_AGG(fof_pending.via ORDER BY fof_pending.via))[1] AS via_any
      FROM fof_pending
     GROUP BY fof_pending.candidate
  ),
  -- Same visibility rule as bgb_suggested_buddies / bgb_play_partners: plays
  -- the viewer logged, plus plays the viewer was a player in.
  visible_plays AS (
    SELECT p.id FROM public.boardgamebuddy_plays p WHERE p.user_id = uid
    UNION
    SELECT pp.play_id
      FROM public.boardgamebuddy_play_players pp
     WHERE pp.player_user_id = uid
  ),
  played_with AS (
    SELECT pp.player_user_id AS candidate, COUNT(*)::BIGINT AS n
      FROM public.boardgamebuddy_play_players pp
      JOIN visible_plays v ON v.id = pp.play_id
     WHERE pp.player_user_id IS NOT NULL
     GROUP BY pp.player_user_id
  ),
  candidate_ids AS (
    SELECT candidate FROM mutuals
    UNION
    SELECT candidate FROM pending_mutuals
    UNION
    SELECT candidate FROM played_with
  ),
  graph AS (
    SELECT
      ci.candidate,
      COALESCE(m.n, 0)  AS mutuals,
      COALESCE(w.n, 0)  AS plays,
      COALESCE(pm.n, 0) AS pending_mutuals,
      COALESCE(m.via_any, pm.via_any) AS via_user_id
    FROM candidate_ids ci
    LEFT JOIN mutuals         m  ON m.candidate  = ci.candidate
    LEFT JOIN pending_mutuals pm ON pm.candidate = ci.candidate
    LEFT JOIN played_with     w  ON w.candidate  = ci.candidate
  ),
  -- Suggestable at all: a real, set-up profile that is neither the viewer,
  -- already connected to them, nor someone they have dismissed. Both tiers
  -- below draw from this.
  eligible AS (
    SELECT pr.id, pr.created_at
      FROM public.boardgamebuddy_profiles pr
     WHERE pr.id <> uid
       AND pr.needs_setup IS NOT TRUE
       AND pr.id NOT IN (SELECT c.other_id FROM connected c)
       AND pr.id NOT IN (SELECT d.other_id FROM dismissed d)   -- suggestions the viewer dismissed
  ),
  tier_graph AS (
    SELECT
      e.id                AS user_id,
      g.mutuals           AS mutual_count,
      g.plays             AS play_count,
      g.pending_mutuals   AS pending_mutual_count,
      g.via_user_id       AS via_user_id,
      'graph'::TEXT       AS source,
      0                   AS tier,
      -- Played-with outranks a graph path, most plays first; a request
      -- nobody has answered yet sorts under both.
      ROW_NUMBER() OVER (
        ORDER BY (g.plays > 0) DESC, g.plays DESC, g.mutuals DESC,
                 g.pending_mutuals DESC, e.id
      )                   AS rank_in_tier
    FROM graph g
    JOIN eligible e ON e.id = g.candidate
    WHERE g.mutuals > 0 OR g.plays > 0 OR g.pending_mutuals > 0
  ),
  -- Plays LOGGED in the window, by whoever logged them. Deliberately not the
  -- participated-in union used above: this is "who is running game nights",
  -- and a play counts once for the account that put it in the app.
  recent_activity AS (
    SELECT p.user_id AS candidate, COUNT(*)::BIGINT AS n
      FROM public.boardgamebuddy_plays p
     WHERE p.created_at >= now() - make_interval(days => GREATEST(active_window_days, 1))
     GROUP BY p.user_id
  ),
  tier_active AS (
    SELECT
      e.id                          AS user_id,
      0::BIGINT                     AS mutual_count,
      0::BIGINT                     AS play_count,
      0::BIGINT                     AS pending_mutual_count,
      NULL::UUID                    AS via_user_id,
      'active'::TEXT                AS source,
      1                             AS tier,
      -- Most active first; newest accounts break ties, so a quiet community
      -- still surfaces the people who just arrived rather than the same
      -- alphabetical head every time.
      ROW_NUMBER() OVER (
        ORDER BY COALESCE(ra.n, 0) DESC, e.created_at DESC, e.id
      )                             AS rank_in_tier
    FROM eligible e
    LEFT JOIN recent_activity ra ON ra.candidate = e.id
    WHERE e.id NOT IN (SELECT tg.user_id FROM tier_graph tg)
  )
  SELECT t.user_id, t.mutual_count, t.play_count,
         t.pending_mutual_count, t.via_user_id, t.source
    FROM (
      SELECT * FROM tier_graph
      UNION ALL
      SELECT * FROM tier_active
    ) t
   ORDER BY t.tier, t.rank_in_tier
   LIMIT lim;
$function$;

CREATE OR REPLACE FUNCTION public.bgb_onboarding_suggestion_network(uid uuid, seed_ids uuid[], per_seed integer DEFAULT 6, lim integer DEFAULT 48)
 RETURNS TABLE(via_user_id uuid, user_id uuid, buddy_count bigint, rank_in_seed integer)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH seeds AS (
    SELECT DISTINCT s.seed_id
      FROM unnest(COALESCE(seed_ids, ARRAY[]::UUID[])) AS s(seed_id)
     WHERE s.seed_id IS NOT NULL
  ),
  connected AS (
    SELECT CASE WHEN be.user_a = uid THEN be.user_b ELSE be.user_a END AS other_id
      FROM public.boardgamebuddy_buddy_edges be
     WHERE uid IN (be.user_a, be.user_b)
  ),
  -- NEW here — see bgb_suggested_buddies above.
  dismissed AS (
    SELECT d.dismissed_user_id AS other_id
      FROM public.boardgamebuddy_buddy_suggestion_dismissals d
     WHERE d.user_id = uid
  ),
  -- One row per (seed, person the seed has accepted).
  hops AS (
    SELECT
      s.seed_id AS via,
      CASE WHEN be.user_a = s.seed_id THEN be.user_b ELSE be.user_a END AS candidate
    FROM seeds s
    JOIN public.boardgamebuddy_buddy_edges be
      ON be.status = 'accepted'
     AND s.seed_id IN (be.user_a, be.user_b)
  ),
  -- How connected each candidate is in their own right — the rank inside a
  -- seed, and a number the client can show if it ever wants to. Counted off
  -- the DISTINCT candidate set: a person reachable from three seeds appears
  -- three times in hops, and counting from there would treble their edges.
  hop_candidates AS (
    SELECT DISTINCT h.candidate FROM hops h
  ),
  buddy_counts AS (
    SELECT hc.candidate, COUNT(*)::BIGINT AS n
      FROM hop_candidates hc
      JOIN public.boardgamebuddy_buddy_edges be
        ON be.status = 'accepted'
       AND hc.candidate IN (be.user_a, be.user_b)
     GROUP BY hc.candidate
  ),
  ranked AS (
    SELECT
      h.via,
      h.candidate,
      COALESCE(bc.n, 0) AS n,
      ROW_NUMBER() OVER (
        PARTITION BY h.via
        ORDER BY COALESCE(bc.n, 0) DESC, h.candidate
      )::INT AS rank_in_seed
    FROM hops h
    JOIN public.boardgamebuddy_profiles pr ON pr.id = h.candidate
    LEFT JOIN buddy_counts bc ON bc.candidate = h.candidate
    WHERE h.candidate <> uid
      AND pr.needs_setup IS NOT TRUE
      AND h.candidate NOT IN (SELECT c.other_id FROM connected c)
      AND h.candidate NOT IN (SELECT d.other_id FROM dismissed d)   -- suggestions the viewer dismissed
      AND h.candidate NOT IN (SELECT s.seed_id FROM seeds s)
  )
  SELECT r.via, r.candidate, r.n, r.rank_in_seed
    FROM ranked r
   WHERE r.rank_in_seed <= GREATEST(per_seed, 1)
   ORDER BY r.rank_in_seed, r.n DESC, r.via, r.candidate
   LIMIT lim;
$function$;

CREATE OR REPLACE FUNCTION public.bgb_play_partners(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_accounts JSONB;
  v_pending JSONB;
  v_ghosts JSONB;
  v_recent JSONB;
BEGIN
  -- accounts: accepted mutual edges, from the viewer's side.
  SELECT COALESCE(jsonb_agg(a ORDER BY a_sort), '[]'::jsonb)
    INTO v_accounts
    FROM (
      SELECT jsonb_build_object(
               'id', e.id,
               'other_user_id', pr.id,
               'other_display_name', pr.display_name,
               'other_username', pr.username,
               'other_avatar', pr.avatar,
               -- The viewer's own private alias for this buddy, off
               -- whichever side of the canonical row the viewer sits on. NULL
               -- for the other party by construction — a per-viewer
               -- projection, not a property of the edge.
               'other_alias',
                 CASE WHEN e.user_a = p_viewer THEN e.alias_by_a ELSE e.alias_by_b END,
               'accepted_at', e.accepted_at,
               'created_at', e.created_at
             ) AS a,
             lower(pr.display_name) AS a_sort
        FROM boardgamebuddy_buddy_edges e
        JOIN boardgamebuddy_profiles pr
          ON pr.id = CASE WHEN e.user_a = p_viewer THEN e.user_b ELSE e.user_a END
       WHERE e.status = 'accepted'
         AND (e.user_a = p_viewer OR e.user_b = p_viewer)
    ) s;

  -- pending: live requests either way, newest first — a request
  -- made minutes ago is likelier to be the person in front of you than one
  -- that has been sitting for a fortnight, which is the opposite of the
  -- alphabetical order `accounts` wants (that list is browsed; this one is a
  -- short "oh, them" list at the top of a picker).
  --
  -- A rejected or cancelled request is a DELETED row (buddy_service.reject_request
  -- / cancel_request), not a status, so "pending" here means genuinely waiting.
  -- 'blocked' edges are excluded by the same test.
  SELECT COALESCE(jsonb_agg(q ORDER BY q_sort DESC NULLS LAST, q_name), '[]'::jsonb)
    INTO v_pending
    FROM (
      SELECT jsonb_build_object(
               'id', e.id,
               'other_user_id', pr.id,
               'other_display_name', pr.display_name,
               'other_username', pr.username,
               'other_avatar', pr.avatar,
               'direction',
                 CASE WHEN e.requested_by = p_viewer THEN 'outgoing' ELSE 'incoming' END,
               'created_at', e.created_at
             ) AS q,
             e.created_at AS q_sort,
             lower(pr.display_name) AS q_name
        FROM boardgamebuddy_buddy_edges e
        JOIN boardgamebuddy_profiles pr
          ON pr.id = CASE WHEN e.user_a = p_viewer THEN e.user_b ELSE e.user_a END
       WHERE e.status = 'pending'
         AND (e.user_a = p_viewer OR e.user_b = p_viewer)
    ) s;

  -- ghosts: free-text names from the viewer's OWN plays, grouped
  -- case-sensitively on the trimmed name.
  SELECT COALESCE(jsonb_agg(g ORDER BY g_count DESC, g_sort), '[]'::jsonb)
    INTO v_ghosts
    FROM (
      SELECT jsonb_build_object(
               'display_name', btrim(pp.player_display_name),
               'play_count', COUNT(*),
               'last_played_at', MAX(p.played_at)
             ) AS g,
             COUNT(*) AS g_count,
             lower(btrim(pp.player_display_name)) AS g_sort
        FROM boardgamebuddy_plays p
        JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
       WHERE p.user_id = p_viewer
         AND pp.player_user_id IS NULL
         AND btrim(COALESCE(pp.player_display_name, '')) <> ''
       GROUP BY btrim(pp.player_display_name)
    ) s;

  -- recent: real accounts sharing a play with the viewer, ranked by how many.
  -- Visibility matches bgb_play_stats — plays the viewer logged, plus plays
  -- they appear in. Relation flags come from the same pass rather than the
  -- second query _relations_for_viewer used to run.
  WITH visible_plays AS (
    SELECT p.id FROM boardgamebuddy_plays p WHERE p.user_id = p_viewer
    UNION
    SELECT pp.play_id
      FROM boardgamebuddy_play_players pp
     WHERE pp.player_user_id = p_viewer
  ),
  counts AS (
    SELECT pp.player_user_id AS uid, COUNT(*) AS play_count
      FROM boardgamebuddy_play_players pp
      JOIN visible_plays v ON v.id = pp.play_id
     WHERE pp.player_user_id IS NOT NULL
       AND pp.player_user_id <> p_viewer
     GROUP BY pp.player_user_id
  )
  SELECT COALESCE(jsonb_agg(r ORDER BY r_count DESC, r_sort), '[]'::jsonb)
    INTO v_recent
    FROM (
      SELECT jsonb_build_object(
               'user_id', pr.id,
               'display_name', pr.display_name,
               'avatar', pr.avatar,
               'play_count', c.play_count,
               'is_buddy', COALESCE(e.status = 'accepted', FALSE),
               'has_pending_request', COALESCE(e.status = 'pending', FALSE),
               'pending_request_direction',
                 CASE WHEN e.status = 'pending'
                      THEN CASE WHEN e.requested_by = p_viewer THEN 'outgoing' ELSE 'incoming' END
                 END,
               -- The edge id, so the row can cancel an outgoing
               -- request (or accept an incoming one) without first fetching
               -- /buddies/requests to look it up by other_user_id.
               'pending_request_id',
                 CASE WHEN e.status = 'pending' THEN e.id END
             ) AS r,
             c.play_count AS r_count,
             lower(pr.display_name) AS r_sort
        FROM counts c
        -- Inner join: a co-player with no profile row is dropped, as the
        -- Python did when the profile lookup came back empty.
        JOIN boardgamebuddy_profiles pr ON pr.id = c.uid
        LEFT JOIN boardgamebuddy_buddy_edges e
          ON ((e.user_a = p_viewer AND e.user_b = c.uid)
           OR (e.user_b = p_viewer AND e.user_a = c.uid))
         AND e.status IN ('accepted', 'pending')
    ) s;

  RETURN jsonb_build_object(
    'accounts', v_accounts,
    'pending', v_pending,
    'ghosts', v_ghosts,
    'recent', v_recent
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bgb_plays_page(p_target uuid, p_page integer DEFAULT 1, p_per_page integer DEFAULT 20, p_game uuid DEFAULT NULL::uuid, p_buddy uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_own_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_search TEXT := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_total BIGINT;
  v_plays JSONB;
BEGIN
  WITH filtered AS (
    SELECT p.*
    FROM boardgamebuddy_plays p
    WHERE (
        p.user_id = p_target
        OR (NOT p_own_only AND EXISTS (
              SELECT 1 FROM boardgamebuddy_play_players pp
              WHERE pp.play_id = p.id AND pp.player_user_id = p_target))
      )
      AND (p_own_only IS FALSE OR p.user_id = p_target)
      AND (p_game IS NULL OR p.game_id = p_game)
      AND (p_buddy IS NULL OR EXISTS (
            SELECT 1 FROM boardgamebuddy_play_players pp
            WHERE pp.play_id = p.id AND pp.player_user_id = p_buddy))
      AND (v_search IS NULL
           OR p.game_name ILIKE '%' || v_search || '%'
           OR EXISTS (
                SELECT 1 FROM boardgamebuddy_play_players pp
                WHERE pp.play_id = p.id
                  AND pp.player_display_name ILIKE '%' || v_search || '%'))
      -- One row per imported run, same representative rule as
      -- bgb_feed_plays. It sits in `filtered` rather than in `page` so
      -- `counted` totals CARDS — a pager reading 106 over a six-row list would
      -- send the reader to five empty pages.
      AND (
        p.import_group_id IS NULL
        OR p.id = (SELECT q.id
                     FROM boardgamebuddy_plays q
                    WHERE q.import_group_id = p.import_group_id
                    ORDER BY q.id
                    LIMIT 1)
      )
  ),
  counted AS (SELECT count(*) AS total FROM filtered),
  page AS (
    SELECT f.*
    FROM filtered f
    ORDER BY f.played_at DESC, f.created_at DESC
    LIMIT p_per_page OFFSET GREATEST(p_page - 1, 0) * p_per_page
  )
  SELECT
    (SELECT total FROM counted),
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', pg.id,
      'game_id', pg.game_id,
      'game_name', pg.game_name,
      'game_thumbnail', pg.game_thumbnail_url,
      'played_at', pg.played_at,
      'notes', pg.notes,
      'photo_url', pg.photo_url,
      'created_at', pg.created_at,
      'play_mode', COALESCE(pg.play_mode, 'competitive'),
      'country_code', pg.country_code,
      'scoring_template', pg.scoring_template,
      'group_count', CASE WHEN pg.import_group_id IS NULL THEN 1
                          ELSE (SELECT COUNT(*)::INT
                                  FROM boardgamebuddy_plays q
                                 WHERE q.import_group_id = pg.import_group_id)
                     END,
      'logged_by_id', pg.user_id,
      'logged_by_name', COALESCE(lp.display_name, 'Unknown'),
      'is_own', (pg.user_id = p_target),
      'players', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'user_id', pp.player_user_id,
          'name', COALESCE(ppr.display_name, pp.player_display_name, 'Unknown'),
          'avatar', ppr.avatar,
          'is_winner', COALESCE(pp.is_winner, false),
          'score', pp.score,
          'round_scores', pp.round_scores,
          'team', pp.team
        ))
        FROM boardgamebuddy_play_players pp
        LEFT JOIN boardgamebuddy_profiles ppr ON ppr.id = pp.player_user_id
        WHERE pp.play_id = pg.id
      ), '[]'::jsonb),
      'expansions', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'expansion_game_id', pe.expansion_game_id,
          'name', COALESCE(eg.name, 'Unknown'),
          'color', eg.expansion_color
        ))
        FROM boardgamebuddy_play_expansions pe
        LEFT JOIN boardgamebuddy_games eg ON eg.id = pe.expansion_game_id
        WHERE pe.play_id = pg.id
      ), '[]'::jsonb)
    ) ORDER BY pg.played_at DESC, pg.created_at DESC), '[]'::jsonb)
    INTO v_total, v_plays
  FROM page pg
  LEFT JOIN boardgamebuddy_profiles lp ON lp.id = pg.user_id;

  RETURN jsonb_build_object('plays', v_plays, 'total', COALESCE(v_total, 0));
END;
$function$;

CREATE OR REPLACE FUNCTION public.bgb_suggested_buddies(uid uuid, lim integer DEFAULT 5)
 RETURNS TABLE(user_id uuid, mutual_count bigint, play_count bigint, pending_mutual_count bigint, via_user_id uuid)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH my_edges AS (
    SELECT be.user_a, be.user_b, be.status, be.requested_by
      FROM public.boardgamebuddy_buddy_edges be
     WHERE uid IN (be.user_a, be.user_b)
  ),
  -- Anyone already linked to the viewer in any way: accepted, pending in
  -- either direction, or blocked. None of them are suggestable.
  connected AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS other_id
      FROM my_edges me
  ),
  -- NEW here. People the viewer has said "not interested" about. A separate
  -- CTE from `connected` on purpose: they are not connected, they are refused,
  -- and folding the two would make the exclusion above read as something it is
  -- not the next time somebody changes it.
  dismissed AS (
    SELECT d.dismissed_user_id AS other_id
      FROM public.boardgamebuddy_buddy_suggestion_dismissals d
     WHERE d.user_id = uid
  ),
  my_buddies AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS friend_id
      FROM my_edges me
     WHERE me.status = 'accepted'
  ),
  -- The people the viewer has ASKED and who have not answered. An incoming
  -- request is not in here: someone else's interest in the viewer says
  -- nothing about who the viewer knows.
  my_requested AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS target_id
      FROM my_edges me
     WHERE me.status = 'pending' AND me.requested_by = uid
  ),
  fof AS (
    SELECT
      CASE WHEN be.user_a = mb.friend_id THEN be.user_b ELSE be.user_a END AS candidate,
      mb.friend_id
    FROM my_buddies mb
    JOIN public.boardgamebuddy_buddy_edges be
      ON be.status = 'accepted'
     AND mb.friend_id IN (be.user_a, be.user_b)
  ),
  mutuals AS (
    SELECT fof.candidate,
           COUNT(DISTINCT fof.friend_id)::BIGINT AS n,
           -- Postgres has no min(uuid); array_agg + [1] is the deterministic
           -- "pick one" and reads as the choice it is.
           (ARRAY_AGG(fof.friend_id ORDER BY fof.friend_id))[1] AS via_any
      FROM fof
     GROUP BY fof.candidate
  ),
  -- The same hop, one status weaker on the first leg only.
  fof_pending AS (
    SELECT
      CASE WHEN be.user_a = mr.target_id THEN be.user_b ELSE be.user_a END AS candidate,
      mr.target_id AS via
    FROM my_requested mr
    JOIN public.boardgamebuddy_buddy_edges be
      ON be.status = 'accepted'
     AND mr.target_id IN (be.user_a, be.user_b)
  ),
  pending_mutuals AS (
    SELECT fof_pending.candidate,
           COUNT(DISTINCT fof_pending.via)::BIGINT AS n,
           (ARRAY_AGG(fof_pending.via ORDER BY fof_pending.via))[1] AS via_any
      FROM fof_pending
     GROUP BY fof_pending.candidate
  ),
  -- Same visibility rule as bgb_play_partners / bgb_play_stats: plays the
  -- viewer logged, plus plays the viewer was a player in.
  visible_plays AS (
    SELECT p.id FROM public.boardgamebuddy_plays p WHERE p.user_id = uid
    UNION
    SELECT pp.play_id
      FROM public.boardgamebuddy_play_players pp
     WHERE pp.player_user_id = uid
  ),
  played_with AS (
    SELECT pp.player_user_id AS candidate, COUNT(*)::BIGINT AS n
      FROM public.boardgamebuddy_play_players pp
      JOIN visible_plays v ON v.id = pp.play_id
     WHERE pp.player_user_id IS NOT NULL
     GROUP BY pp.player_user_id
  ),
  -- Three sources, so candidates are a union of ids with the counts hung
  -- off it.
  candidate_ids AS (
    SELECT candidate FROM mutuals
    UNION
    SELECT candidate FROM pending_mutuals
    UNION
    SELECT candidate FROM played_with
  ),
  candidates AS (
    SELECT
      ci.candidate,
      COALESCE(m.n, 0)  AS mutuals,
      COALESCE(w.n, 0)  AS plays,
      COALESCE(pm.n, 0) AS pending_mutuals,
      -- An accepted link explains the suggestion better than a pending one.
      COALESCE(m.via_any, pm.via_any) AS via_user_id
    FROM candidate_ids ci
    LEFT JOIN mutuals         m  ON m.candidate  = ci.candidate
    LEFT JOIN pending_mutuals pm ON pm.candidate = ci.candidate
    LEFT JOIN played_with     w  ON w.candidate  = ci.candidate
  )
  SELECT c.candidate, c.mutuals, c.plays, c.pending_mutuals, c.via_user_id
    FROM candidates c
    JOIN public.boardgamebuddy_profiles pr ON pr.id = c.candidate
   WHERE c.candidate <> uid
     AND pr.needs_setup IS NOT TRUE          -- no unfinished profiles
     AND c.candidate NOT IN (SELECT x.other_id FROM connected x)
     AND c.candidate NOT IN (SELECT x.other_id FROM dismissed x)   -- suggestions the viewer dismissed
     AND (c.mutuals > 0 OR c.plays > 0 OR c.pending_mutuals > 0)
   -- Earned signals keep their order; the new one sorts below both, because a
   -- request nobody has answered is the weakest thing in the list.
   ORDER BY (c.plays > 0) DESC, c.plays DESC, c.mutuals DESC,
            c.pending_mutuals DESC, c.candidate
   LIMIT lim;
$function$;

CREATE OR REPLACE FUNCTION public.bgb_sync_achievements(uid uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  m       JSONB;
  payload JSONB;
BEGIN
  -- ── 1. Every metric, in one pass ──────────────────────────────────────────
  -- country_code rides along. It is on the play, so both
  -- legs carry it and the UNION still dedupes on the id.
  WITH my_plays AS (
    SELECT p.id, p.game_id, p.country_code, p.play_mode
    FROM public.boardgamebuddy_plays p
    WHERE p.user_id = uid
    UNION
    SELECT p.id, p.game_id, p.country_code, p.play_mode
    FROM public.boardgamebuddy_plays p
    JOIN public.boardgamebuddy_play_players pp ON pp.play_id = p.id
    WHERE pp.player_user_id = uid
  ),
  -- Head count per play. Ghost players (a free-text name, no account) are
  -- people at the table too, so every player row counts — "five around the
  -- board" is about the board, not about who has signed up.
  table_sizes AS (
    SELECT mp.id, COUNT(pp.id) AS players
    FROM my_plays mp
    JOIN public.boardgamebuddy_play_players pp ON pp.play_id = mp.id
    GROUP BY mp.id
  )
  SELECT jsonb_build_object(
    'plays_logged', (SELECT COUNT(*) FROM my_plays),
    'wins', (
      SELECT COUNT(*)
      FROM my_plays mp
      JOIN public.boardgamebuddy_play_players pp
        ON pp.play_id = mp.id AND pp.player_user_id = uid
      WHERE pp.is_winner
    ),
    -- ── Wins by mode ───────────────────────────────────────────────────────
    -- The same win, narrowed to the mode the table was playing in. Both are
    -- SUBSETS of `wins` above, which counts every win in every mode and is
    -- deliberately left alone: Crowned / King of the Hill / Dynasty are about
    -- how often you come first, whoever or whatever you came first against.
    --
    -- `play_mode` is NOT NULL DEFAULT 'competitive' on boardgamebuddy_plays,
    -- so a plain equality is exact here and no COALESCE is needed — unlike
    -- bgb_user_stats_detail, which reads the column off CTEs that can widen it
    -- to NULL. It lives on the PLAY, not the game: a co-op game played in a
    -- competitive variant is logged as what the table actually did.
    'team_wins', (
      SELECT COUNT(*)
      FROM my_plays mp
      JOIN public.boardgamebuddy_play_players pp
        ON pp.play_id = mp.id AND pp.player_user_id = uid
      WHERE pp.is_winner AND mp.play_mode = 'team'
    ),
    -- A co-op win is the whole table's win — every seat carries is_winner or
    -- none does (see the co-op record in bgb_user_stats_detail) — so reading
    -- the user's own seat is reading the table's result, and a play they sat
    -- at but did not log counts exactly as much as one they did.
    'coop_wins', (
      SELECT COUNT(*)
      FROM my_plays mp
      JOIN public.boardgamebuddy_play_players pp
        ON pp.play_id = mp.id AND pp.player_user_id = uid
      WHERE pp.is_winner AND mp.play_mode = 'coop'
    ),
    'biggest_table', COALESCE((SELECT MAX(players) FROM table_sizes), 0),
    -- Duelist: a game the BOX is built for two, not an evening that happened
    -- to seat two. `max_players = 2` is the test — a game that can never
    -- seat a third — which keeps 1-2 player games (Patchwork, Watergate) in:
    -- they are duels the moment a second person sits down, and excluding them
    -- on min_players would be a stricter reading than anyone means by "a
    -- two-player game". This is the one metric that has to reach the games
    -- table: plays carry a denormalized name and thumbnail, never the player
    -- counts.
    'two_player_games', (
      SELECT COUNT(DISTINCT mp.game_id)
      FROM my_plays mp
      JOIN public.boardgamebuddy_games g ON g.id = mp.game_id
      WHERE g.max_players = 2
    ),
    'buddies', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_buddy_edges e
      WHERE e.status = 'accepted' AND (e.user_a = uid OR e.user_b = uid)
    ),
    'guide_chapters', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_user_chapters uc
      WHERE uc.user_id = uid
        AND uc.state = 'kept'   -- disliked chapters are not kept
    ),
    -- Chapters this user WROTE that somebody else keeps in their own guide.
    -- Distinct on the chapter: one popular chapter kept by nine people is one
    -- chapter, and the badge only needs the first.
    'chapters_borrowed', (
      SELECT COUNT(DISTINCT uc.chapter_id)
      FROM public.boardgamebuddy_user_chapters uc
      JOIN public.boardgamebuddy_guide_chapters gc ON gc.id = uc.chapter_id
      WHERE gc.created_by = uid AND uc.user_id <> uid
        AND uc.state = 'kept'   -- disliked chapters are not kept
    ),
    -- Notes are written by whoever logged the play, so this counts the user's
    -- own rows rather than my_plays.
    'plays_with_notes', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_plays p
      WHERE p.user_id = uid AND COALESCE(BTRIM(p.notes), '') <> ''
    ),
    'bgg_linked', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_profiles pr
      WHERE pr.id = uid AND COALESCE(BTRIM(pr.bgg_username), '') <> ''
    ),
    'app_installed', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_profiles pr
      WHERE pr.id = uid AND pr.app_installed_at IS NOT NULL
    ),
    -- ── Countries and continents ───────────────────────────────────────────
    -- Distinct countries. COUNT(DISTINCT …) already skips NULLs, so the
    -- plays that have no country simply do not participate;
    -- the WHERE is there to say so out loud rather than to change the answer.
    'countries', (
      SELECT COUNT(DISTINCT mp.country_code)
      FROM my_plays mp
      WHERE mp.country_code IS NOT NULL
    ),
    -- Distinct continents. The JOIN is inner ON PURPOSE. bgb_log_play accepts
    -- any well-formed ^[A-Z]{2}$ from any client — the native app, an offline
    -- outbox flush, a future integration — so a code the lookup has never
    -- heard of is possible. Such a play still counts toward `countries` and
    -- contributes no continent: the badge under-reports by one, which is a far
    -- better failure than the whole Achievements screen erroring out because
    -- somebody's browser reported a country tzdata has since retired.
    'continents', (
      SELECT COUNT(DISTINCT c.continent)
      FROM my_plays mp
      JOIN public.boardgamebuddy_countries c ON c.code = mp.country_code
    ),
    -- ── Scoring grids ──────────────────────────────────────────────────────
    -- Plays this user LOGGED on a custom scoring grid, not every play they sat
    -- at. Applying a template is something the person keeping score does, so
    -- this reads p.user_id rather than my_plays — the same reasoning, and the
    -- same shape, as plays_with_notes above.
    'plays_with_grid', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_plays p
      WHERE p.user_id = uid AND p.scoring_template IS NOT NULL
    ),
    -- The BEST single scoring grid this user wrote, measured by how many OTHER
    -- people keep it. A MAX rather than a SUM on purpose: "gold standard" means
    -- one grid everybody uses, and summing would hand the badge to someone who
    -- wrote ten grids that one person each took — the opposite of what the name
    -- claims. Note this differs from chapters_borrowed above, which counts
    -- DISTINCT chapters and only ever needs to reach one.
    --
    -- `uc.user_id <> uid` drops the author's own row: create_chapter adds every
    -- new chapter to its creator's guide, so without it every grid would start
    -- life at 1.
    --
    -- The subquery returns no rows when the user has written no grids (or none
    -- has been adopted), and MAX over zero rows is NULL — hence the COALESCE,
    -- without which the metric would be absent from the JSONB and the progress
    -- bar would read as 0 by accident rather than by intent.
    'grid_adopters', COALESCE((
      SELECT MAX(t.adopters) FROM (
        SELECT COUNT(DISTINCT uc.user_id) AS adopters
        FROM public.boardgamebuddy_guide_chapters gc
        JOIN public.boardgamebuddy_user_chapters uc ON uc.chapter_id = gc.id
        WHERE gc.created_by = uid
          AND gc.layout = 'scoring_grid'
          AND uc.user_id <> uid
          AND uc.state = 'kept'   -- disliked chapters are not kept
        GROUP BY gc.id
      ) t
    ), 0)
  )
  INTO m;

  -- ── 2. Pin the unlock date for anything newly earned ──────────────────────
  INSERT INTO public.boardgamebuddy_user_achievements (user_id, achievement_id)
  SELECT uid, a.id
  FROM public.boardgamebuddy_achievements a
  WHERE COALESCE((m ->> a.metric)::NUMERIC, 0) >= a.threshold
  ON CONFLICT (user_id, achievement_id) DO NOTHING;

  -- ── 3. The screen ─────────────────────────────────────────────────────────
  -- `earned` reads the unlock row, not the metric: step 2 has already written
  -- a row for everything currently clearing its bar, and keeping the row is
  -- what makes a badge permanent when a play is later deleted.
  SELECT jsonb_build_object(
    'total', COUNT(*),
    'earned_count', COUNT(*) FILTER (WHERE ua.user_id IS NOT NULL),
    'metrics', m,
    'groups', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', g.id, 'label', g.label, 'blurb', g.blurb
             ) ORDER BY g.display_order), '[]'::JSONB)
      FROM public.boardgamebuddy_achievement_groups g
    ),
    'achievements', COALESCE(jsonb_agg(jsonb_build_object(
        'id',          a.id,
        'group_id',    a.group_id,
        'name',        a.name,
        'tagline',     a.tagline,
        'requirement', a.requirement,
        'icon',        a.icon,
        'metric',      a.metric,
        'threshold',   a.threshold,
        -- Clamped for the progress bar; `metrics` above carries the raw value
        -- for anything that wants to print "312 plays".
        'progress',    LEAST(COALESCE((m ->> a.metric)::NUMERIC, 0), a.threshold)::INT,
        'earned',      ua.user_id IS NOT NULL,
        'unlocked_at', ua.unlocked_at
      ) ORDER BY a.display_order), '[]'::JSONB)
  )
  INTO payload
  FROM public.boardgamebuddy_achievements a
  LEFT JOIN public.boardgamebuddy_user_achievements ua
    ON ua.achievement_id = a.id AND ua.user_id = uid;

  RETURN payload;
END;
$function$;

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
  -- predicate: a prev_owned row (sold, gifted, donated) is on the Owned
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
    -- the target logged by its player count. Matches bgb_play_stats.
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
  SELECT COUNT(*) INTO v_played_total
    FROM played_not_owned pno
    JOIN boardgamebuddy_games g ON g.id = pno.game_id
    WHERE g.is_expansion = false;

  WITH played_games AS (
    -- EXISTS, not a LEFT JOIN onto play_players: the join fans one play out
    -- to one row per participant, so COUNT(*) over it multiplied every play
    -- the target logged by its player count. Matches bgb_play_stats.
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

  -- No status filter, so prev_owned reaches the map unaided — which is
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

  -- Owned-only on purpose: an expansion you sold is no longer clutter on
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
    -- denormalized play columns, with boardgamebuddy_games filling in
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

    -- Ghost claims waiting on the viewer. Same shape and same
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
