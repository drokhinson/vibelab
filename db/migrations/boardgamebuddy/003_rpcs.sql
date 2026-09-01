-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy 003 — RPC functions
--
-- Every callable function the app has, collapsed from the 73-file history now
-- in archive/. 48 functions, each at its final definition: the archive defines
-- them 91 times between them, because several were rewritten repeatedly
-- (bgb_profile_bundle and bgb_feed_plays eight times each). Only the last
-- definition of each survives here.
--
-- FRESH-DB ONLY. Production is already at this state. Do not run on existing DB.
--
-- Run last, after 001_baseline.sql and 002_seed.sql — every function here
-- reads tables from 001, and bgb_sync_achievements reads the catalog from 002.
--
-- Bodies are reproduced verbatim from a replay of all 73 archived migrations
-- into an empty database, read back with pg_get_functiondef(), so they are the
-- server's own normalized rendering rather than a hand-merge. That is why
-- keywords and whitespace look uniform and unlike the archive's hand-written
-- style, and why no DROP FUNCTION guards appear: the archive needs them where
-- a signature changed, a fresh database has nothing to drop.
--
-- Each function carries the archive file its surviving definition came from,
-- which is where to read WHY it looks the way it does — the archive comments
-- are the design record and were not copied here.
--
-- Ordering: helpers that other RPCs call come first, then by domain. Within
-- the file a function is always defined after everything it calls, so the file
-- runs top to bottom on an empty database.
--
-- Grants: EXECUTE to boardgamebuddy_role, the per-project read-only login role.
-- db/migrations/_shared/003_project_roles.sql runs after this and tightens
-- PUBLIC. The backend calls these with the service role key.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Shared helpers ────────────────────────────────────────────────────────────
-- Called by the RPCs below rather than by the backend, so they are defined first.

-- bgb_game_summary
--   from archive/037_joinable_sessions_rpc.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_game_summary(p_game_id uuid) TO boardgamebuddy_role;

-- bgb_session_gate
--   from archive/046_session_write_rpcs.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_session_gate(p_code text, p_host uuid, p_require_gather boolean) TO boardgamebuddy_role;

-- bgb_session_bundle
--   from archive/056_participant_order.sql
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
           'finalized_play_id', s.finalized_play_id
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
           'avatar', pr.avatar
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
GRANT EXECUTE ON FUNCTION public.bgb_session_bundle(p_session_id uuid) TO boardgamebuddy_role;

-- bgb_ghost_summary
--   from archive/070_ghost_claims.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_ghost_summary(p_viewer uuid, p_owner uuid, p_name_key text) TO boardgamebuddy_role;

-- bgb_link_ghost_rows
--   from archive/070_ghost_claims.sql
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
  -- else's roster (the invariant migration 050 established).
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
GRANT EXECUTE ON FUNCTION public.bgb_link_ghost_rows(p_owner uuid, p_name_key text, p_target uuid) TO boardgamebuddy_role;

-- ── Bootstrap ─────────────────────────────────────────────────────────────────
-- The two calls the app makes on cold start.

-- bgb_bootstrap
--   from archive/043_feed_perf_and_bootstrap_split.sql
CREATE OR REPLACE FUNCTION public.bgb_bootstrap(viewer uuid, owned_plays_limit integer DEFAULT 5, max_game_bundles integer DEFAULT 250)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current_user JSONB;
  v_profile_bundle JSONB;
  v_game_bundles JSONB := '{}'::jsonb;
  v_owned_count INT;
  v_truncated BOOLEAN := false;
BEGIN
  -- Current user row.
  SELECT to_jsonb(p.*) INTO v_current_user
    FROM boardgamebuddy_profiles p
    WHERE p.id = viewer;

  -- Profile bundle (stats, shelves, recent plays, status map, buddies,
  -- requests) for the viewer looking at themselves.
  v_profile_bundle := bgb_profile_bundle(viewer, viewer, 12, 10);

  -- Owned-game count. Base games only — expansions are surfaced via the base
  -- game's bundle.expansions block.
  SELECT COUNT(*) INTO v_owned_count
    FROM boardgamebuddy_collections c
    WHERE c.user_id = viewer
      AND c.status = 'owned'
      AND COALESCE(c.game_is_expansion, false) = false;

  IF max_game_bundles > 0 THEN
    v_truncated := v_owned_count > max_game_bundles;

    WITH owned AS (
      SELECT c.game_id
      FROM boardgamebuddy_collections c
      WHERE c.user_id = viewer
        AND c.status = 'owned'
        AND COALESCE(c.game_is_expansion, false) = false
      ORDER BY c.added_at DESC
      LIMIT max_game_bundles
    )
    SELECT COALESCE(jsonb_object_agg(o.game_id::text, bgb_game_detail_bundle(o.game_id, viewer, owned_plays_limit)), '{}'::jsonb)
      INTO v_game_bundles
      FROM owned o;
  END IF;

  RETURN jsonb_build_object(
    'bootstrap_version', 2,
    'generated_at', now(),
    'current_user', v_current_user,
    'profile_bundle', v_profile_bundle,
    'game_detail_bundles', v_game_bundles,
    'owned_count', v_owned_count,
    'truncated', v_truncated
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_bootstrap(viewer uuid, owned_plays_limit integer, max_game_bundles integer) TO boardgamebuddy_role;

-- bgb_game_bundles
--   from archive/043_feed_perf_and_bootstrap_split.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_game_bundles(viewer uuid, owned_plays_limit integer, max_bundles integer) TO boardgamebuddy_role;

-- ── Feed ──────────────────────────────────────────────────────────────────────
-- The home feed and its cards.

-- bgb_feed_plays
--   from archive/043_feed_perf_and_bootstrap_split.sql
CREATE OR REPLACE FUNCTION public.bgb_feed_plays(viewer uuid, before_played_at date DEFAULT NULL::date, before_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, lim integer DEFAULT 20)
 RETURNS TABLE(play_id uuid, play_user_id uuid, play_user_name text, play_user_avatar jsonb, game_id uuid, game_name text, game_image_url text, game_thumbnail_url text, played_at date, created_at timestamp with time zone, notes text, photo_url text, play_mode text, winner_display_name text, participant_count integer, participants jsonb)
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
  -- names (play_id, played_at, notes, participants, …) into the query body:
  -- the string is handed to the SQL engine untouched.
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
           p.notes, p.photo_url, p.play_mode
    FROM public.boardgamebuddy_plays p
    JOIN visible_plays vp ON vp.id = p.id
    WHERE (
      $2::date IS NULL
      OR $3::timestamptz IS NULL
      OR (p.played_at, p.created_at) < ($2::date, $3::timestamptz)
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
    COALESCE(roster.participants, '[]'::jsonb)
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
      COUNT(*)::INT AS participant_count
    FROM public.boardgamebuddy_play_players pp
    LEFT JOIN public.boardgamebuddy_profiles pprof ON pprof.id = pp.player_user_id
    WHERE pp.play_id = p.id
  ) roster ON true
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
GRANT EXECUTE ON FUNCTION public.bgb_feed_plays(viewer uuid, before_played_at date, before_created_at timestamp with time zone, lim integer) TO boardgamebuddy_role;

-- bgb_hot_games
--   from archive/012_rpcs_feed_and_stats.sql
CREATE OR REPLACE FUNCTION public.bgb_hot_games(window_days integer DEFAULT 7, lim integer DEFAULT 10)
 RETURNS TABLE(game_id uuid, play_count bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.game_id, COUNT(*)::BIGINT AS play_count
  FROM public.boardgamebuddy_plays p
  WHERE p.played_at >= (CURRENT_DATE - (window_days || ' days')::INTERVAL)
  GROUP BY p.game_id
  ORDER BY play_count DESC, p.game_id
  LIMIT lim;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_hot_games(window_days integer, lim integer) TO boardgamebuddy_role;

-- ── Profile & stats ───────────────────────────────────────────────────────────
-- The profile hub and the stats spoke.

-- bgb_profile_bundle
--   from archive/071_profile_bundle_ghost_claims.sql
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

-- bgb_user_stats
--   from archive/015_user_stats_with_favorite.sql
CREATE OR REPLACE FUNCTION public.bgb_user_stats(uid uuid)
 RETURNS TABLE(total_plays bigint, unique_games bigint, win_count bigint, last_played_at date, hours_played numeric, owned_games bigint, owned_expansions bigint, favorite_game_id uuid, favorite_game_name text, favorite_play_count bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH my_plays AS (
    SELECT p.id, p.game_id, p.played_at
    FROM public.boardgamebuddy_plays p
    WHERE p.user_id = uid
    UNION
    SELECT p.id, p.game_id, p.played_at
    FROM public.boardgamebuddy_plays p
    JOIN public.boardgamebuddy_play_players pp ON pp.play_id = p.id
    WHERE pp.player_user_id = uid
  ),
  game_counts AS (
    SELECT game_id, COUNT(*)::BIGINT AS n
    FROM my_plays
    GROUP BY game_id
  ),
  favorite AS (
    SELECT gc.game_id, gc.n, g.name
    FROM game_counts gc
    LEFT JOIN public.boardgamebuddy_games g ON g.id = gc.game_id
    ORDER BY gc.n DESC, g.name
    LIMIT 1
  )
  SELECT
    (SELECT COUNT(*)::BIGINT FROM my_plays)                                      AS total_plays,
    (SELECT COUNT(DISTINCT game_id)::BIGINT FROM my_plays)                       AS unique_games,
    (SELECT COUNT(*)::BIGINT
       FROM public.boardgamebuddy_play_players pp
       WHERE pp.player_user_id = uid AND pp.is_winner = true)                    AS win_count,
    (SELECT MAX(played_at) FROM my_plays)                                        AS last_played_at,
    COALESCE(
      (SELECT SUM(g.playing_time)::NUMERIC / 60.0
         FROM my_plays mp
         LEFT JOIN public.boardgamebuddy_games g ON g.id = mp.game_id),
      0
    )                                                                            AS hours_played,
    -- Owned BASE games only — what the user thinks of as "my games".
    (SELECT COUNT(*)::BIGINT
       FROM public.boardgamebuddy_collections c
       JOIN public.boardgamebuddy_games g ON g.id = c.game_id
       WHERE c.user_id = uid
         AND c.status = 'owned'
         AND COALESCE(g.is_expansion, false) = false)                            AS owned_games,
    -- Owned expansions — surfaced as a secondary counter on the Profile.
    (SELECT COUNT(*)::BIGINT
       FROM public.boardgamebuddy_collections c
       JOIN public.boardgamebuddy_games g ON g.id = c.game_id
       WHERE c.user_id = uid
         AND c.status = 'owned'
         AND g.is_expansion = true)                                              AS owned_expansions,
    (SELECT game_id FROM favorite)                                               AS favorite_game_id,
    (SELECT name     FROM favorite)                                              AS favorite_game_name,
    (SELECT n        FROM favorite)                                              AS favorite_play_count;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_user_stats(uid uuid) TO boardgamebuddy_role;

-- bgb_user_stats_detail
--   from archive/059_shelf_played_before.sql
CREATE OR REPLACE FUNCTION public.bgb_user_stats_detail(uid uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH
-- ── The play set every block below reads ──────────────────────────────────
my_plays AS (
  SELECT p.id, p.game_id, p.played_at, p.play_mode, p.game_name
  FROM public.boardgamebuddy_plays p
  WHERE p.user_id = uid
  UNION
  SELECT p.id, p.game_id, p.played_at, p.play_mode, p.game_name
  FROM public.boardgamebuddy_plays p
  JOIN public.boardgamebuddy_play_players pp ON pp.play_id = p.id
  WHERE pp.player_user_id = uid
),
-- My own player row on each of those plays. The gap between this and my_plays
-- is the one the header comment describes: a play I logged but sat out has no
-- row here, so it has no result, no score and no side in a co-op record.
mine AS (
  SELECT mp.id AS play_id, mp.game_id, mp.played_at, mp.play_mode,
         pp.is_winner, pp.score, pp.round_scores
  FROM my_plays mp
  JOIN public.boardgamebuddy_play_players pp
    ON pp.play_id = mp.id AND pp.player_user_id = uid
),
by_game AS (
  SELECT mp.game_id,
         COALESCE(MAX(g.name), MAX(mp.game_name))    AS name,
         MAX(g.thumbnail_url)                        AS thumbnail_url,
         COALESCE(MAX(g.play_mode), 'competitive')   AS play_mode,
         COUNT(*)::INT                               AS plays,
         MAX(mp.played_at)                           AS last_played_at
  FROM my_plays mp
  LEFT JOIN public.boardgamebuddy_games g ON g.id = mp.game_id
  GROUP BY mp.game_id
),

-- ── Per-game breakdown (drives the picker) ────────────────────────────────
-- avg_winning_score averages the WINNER's score across my plays of that game —
-- the bar to clear, carried alongside my own average rather than in place of
-- it. Both are NULL when nobody logged a score (co-op games, and any table that
-- just called a winner), which is what the screen's "no scores" state reads.
winner_scores AS (
  SELECT mp.game_id, w.play_id, w.score
  FROM public.boardgamebuddy_play_players w
  JOIN my_plays mp ON mp.id = w.play_id
  WHERE w.is_winner AND w.score IS NOT NULL
),
game_rows AS (
  SELECT
    bg.game_id, bg.name, bg.thumbnail_url, bg.play_mode, bg.plays, bg.last_played_at,
    (SELECT COUNT(*)::INT FROM mine m
      WHERE m.game_id = bg.game_id AND m.is_winner)                       AS wins,
    (SELECT COUNT(DISTINCT ws.play_id)::INT FROM winner_scores ws
      WHERE ws.game_id = bg.game_id)                                      AS scored_plays,
    (SELECT ROUND(AVG(ws.score))::INT FROM winner_scores ws
      WHERE ws.game_id = bg.game_id)                                      AS avg_winning_score,
    (SELECT ROUND(AVG(m.score))::INT FROM mine m
      WHERE m.game_id = bg.game_id AND m.score IS NOT NULL)               AS your_avg_score,
    (SELECT MAX(m.score) FROM mine m WHERE m.game_id = bg.game_id)        AS your_best_score
  FROM by_game bg
  ORDER BY bg.plays DESC, bg.name
  LIMIT 100
),

-- ── Nemesis ───────────────────────────────────────────────────────────────
-- The account that has beaten me most across COMPETITIVE plays we both sat in.
-- Ranked by their wins, then by how often we've played; a 3-play floor keeps
-- one lucky evening from crowning anyone. Ghost players (no player_user_id)
-- can't be a nemesis — there is no profile to name or badge.
--
-- Co-op plays are excluded, and not just because "who beat whom" is meaningless
-- when you are on the same side: in co-op EVERY seat at the table wins or loses
-- together, so counting them made your_wins and their_wins both fire on the
-- same play. That double-count is visible, not academic — the screen draws
-- you/them/someone-else as one split bar, and with co-op folded in the segments
-- summed past the total.
opponents AS (
  SELECT o.play_id, o.player_user_id, o.is_winner
  FROM public.boardgamebuddy_play_players o
  JOIN mine m ON m.play_id = o.play_id
  WHERE o.player_user_id IS NOT NULL
    AND o.player_user_id <> uid
    AND COALESCE(m.play_mode, 'competitive') <> 'coop'
),
nemesis_row AS (
  SELECT
    op.player_user_id                                    AS user_id,
    pr.display_name,
    pr.avatar,
    COUNT(DISTINCT op.play_id)::INT                      AS shared_plays,
    COUNT(*) FILTER (WHERE op.is_winner)::INT            AS their_wins,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM mine m2 WHERE m2.play_id = op.play_id AND m2.is_winner
    ))::INT                                              AS your_wins
  FROM opponents op
  JOIN public.boardgamebuddy_profiles pr ON pr.id = op.player_user_id
  GROUP BY op.player_user_id, pr.display_name, pr.avatar
  HAVING COUNT(DISTINCT op.play_id) >= 3
  ORDER BY their_wins DESC, shared_plays DESC
  LIMIT 1
),

-- ── Play rhythm ───────────────────────────────────────────────────────────
-- 26 weeks of buckets for the heatmap, plus streaks over ALL history — the
-- longest streak predates the window more often than not.
week_buckets AS (
  SELECT date_trunc('week', mp.played_at)::DATE AS wk, COUNT(*)::INT AS n
  FROM my_plays mp
  GROUP BY 1
),
heat AS (
  SELECT s.wk::DATE AS wk, COALESCE(wb.n, 0) AS n
  FROM generate_series(
         date_trunc('week', CURRENT_DATE) - INTERVAL '25 weeks',
         date_trunc('week', CURRENT_DATE),
         INTERVAL '1 week') AS s(wk)
  LEFT JOIN week_buckets wb ON wb.wk = s.wk::DATE
),
-- Gaps-and-islands: consecutive weeks share (wk - row_number * 7).
streak_runs AS (
  SELECT COUNT(*)::INT AS len, MAX(wk) AS last_wk
  FROM (
    SELECT wk, wk - (ROW_NUMBER() OVER (ORDER BY wk))::INT * 7 AS grp
    FROM week_buckets
  ) g
  GROUP BY grp
),
weekday AS (
  SELECT EXTRACT(DOW FROM mp.played_at)::INT AS dow, COUNT(*)::INT AS plays
  FROM my_plays mp
  GROUP BY 1
  ORDER BY 2 DESC, 1
  LIMIT 1
),

-- ── Table size ────────────────────────────────────────────────────────────
-- Buckets cap at 5+; the tail past six players is one thin bar nobody reads.
-- Plays with no roster at all (a bare BGG import) are excluded so they can't
-- drag the average toward zero.
roster AS (
  SELECT mp.id AS play_id,
         (SELECT COUNT(*)::INT FROM public.boardgamebuddy_play_players pp
           WHERE pp.play_id = mp.id) AS n
  FROM my_plays mp
),

-- ── Comeback kid ──────────────────────────────────────────────────────────
-- Plays I won after trailing at the halfway round. Only computable because
-- round_scores stores the round-by-round breakdown; every other surface in the
-- app can see a play's result but not its shape.
tracked AS (
  SELECT pp.play_id, pp.player_user_id, pp.is_winner, pp.round_scores,
         jsonb_array_length(pp.round_scores) AS n
  FROM public.boardgamebuddy_play_players pp
  JOIN my_plays mp ON mp.id = pp.play_id
  WHERE pp.round_scores IS NOT NULL
    AND jsonb_typeof(pp.round_scores) = 'array'
    AND jsonb_array_length(pp.round_scores) >= 2
),
half AS (
  -- Cumulative score through the midpoint. A round cell holds null until it is
  -- entered, so anything that isn't a JSON number counts as zero rather than
  -- failing the whole call on a cast.
  SELECT t.play_id, t.player_user_id, t.is_winner,
         (SELECT COALESCE(SUM(CASE WHEN jsonb_typeof(e.value) = 'number'
                                   THEN (e.value #>> '{}')::NUMERIC
                                   ELSE 0 END), 0)
            FROM jsonb_array_elements(t.round_scores) WITH ORDINALITY AS e(value, idx)
           WHERE e.idx <= GREATEST(1, t.n / 2)) AS half_score
  FROM tracked t
),
half_lead AS (
  SELECT play_id, MAX(half_score) AS best_half FROM half GROUP BY play_id
),

-- ── Personal bests ────────────────────────────────────────────────────────
-- Ordered by how much I play the game, not by score: 168 at Brass and 94 at
-- Wingspan are not comparable numbers, so the useful ordering is "the records
-- you would actually try to beat".
best_rows AS (
  SELECT bg.game_id, bg.name, bg.plays, b.score, b.played_at
  FROM by_game bg
  JOIN LATERAL (
    SELECT m.score, m.played_at
    FROM mine m
    WHERE m.game_id = bg.game_id AND m.score IS NOT NULL
    ORDER BY m.score DESC, m.played_at DESC
    LIMIT 1
  ) b ON true
  ORDER BY bg.plays DESC, bg.name
  LIMIT 5
)

SELECT jsonb_build_object(
  -- career.win_rate is left to the caller: it divides rated_wins by
  -- rated_plays, never win_count by total_plays. A co-op win is the table
  -- beating the game and belongs in its own block, and a play I logged but sat
  -- out has no result at all.
  'career', jsonb_build_object(
    'total_plays',     (SELECT COUNT(*)::INT FROM my_plays),
    'unique_games',    (SELECT COUNT(DISTINCT game_id)::INT FROM my_plays),
    'win_count',       (SELECT COUNT(*)::INT FROM mine WHERE is_winner),
    'rated_plays',     (SELECT COUNT(*)::INT FROM mine WHERE COALESCE(play_mode, 'competitive') <> 'coop'),
    'rated_wins',      (SELECT COUNT(*)::INT FROM mine WHERE COALESCE(play_mode, 'competitive') <> 'coop' AND is_winner),
    'first_played_at', (SELECT MIN(played_at) FROM my_plays),
    'last_played_at',  (SELECT MAX(played_at) FROM my_plays),
    'hours_played',    COALESCE((
      SELECT ROUND(SUM(g.playing_time)::NUMERIC / 60.0)
      FROM my_plays mp LEFT JOIN public.boardgamebuddy_games g ON g.id = mp.game_id
    ), 0)::FLOAT
  ),

  'podium', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'game_id', game_id, 'name', name,
             'thumbnail_url', thumbnail_url, 'plays', plays)
             ORDER BY plays DESC, name)
    FROM (SELECT * FROM game_rows ORDER BY plays DESC, name LIMIT 3) p
  ), '[]'::JSONB),

  'games', COALESCE((SELECT jsonb_agg(to_jsonb(gr) ORDER BY gr.plays DESC, gr.name)
                       FROM game_rows gr), '[]'::JSONB),

  'nemesis', (SELECT to_jsonb(n) FROM nemesis_row n),

  'rhythm', jsonb_build_object(
    'weeks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('week_start', wk, 'plays', n) ORDER BY wk)
      FROM heat
    ), '[]'::JSONB),
    'longest_streak_weeks', COALESCE((SELECT MAX(len) FROM streak_runs), 0),
    -- The run that is still alive must reach this week or last week. Requiring
    -- the current week would reset every streak each Monday morning, before
    -- that week's game night has happened.
    'current_streak_weeks', COALESCE((
      SELECT MAX(len) FROM streak_runs
      WHERE last_wk >= (date_trunc('week', CURRENT_DATE)::DATE - 7)
    ), 0),
    'busiest_weekday', (SELECT to_jsonb(w) FROM weekday w)
  ),

  -- Owned BASE games only, matching what bgb_user_stats calls owned_games — an
  -- unplayed expansion is not a guilt trip, it is a box on a shelf.
  --
  -- 'played' counts a game the viewer has plays for OR has hand-marked as
  -- played before they joined (played_before_at). The mark is deliberately
  -- scoped to THIS block: it creates no play row, so every other aggregate on
  -- this screen — the podium, the rhythm heatmap, personal bests, career
  -- totals — is untouched by it, and so is the collection's status map.
  --
  -- 'games' is the list the Stats spoke's shelf sheet renders: every owned
  -- base game with NO logged plays, marked or not. A game with real plays is
  -- not a shelf-of-shame candidate and has no mark to undo, so it never needs
  -- to be in here. Capped, because a BGG import can be four figures.
  'shelf', (
    WITH owned_base AS (
      SELECT c.game_id, c.game_name, c.game_thumbnail_url, c.game_year_published,
             c.played_before_at,
             EXISTS (SELECT 1 FROM my_plays mp WHERE mp.game_id = c.game_id) AS has_plays
      FROM public.boardgamebuddy_collections c
      JOIN public.boardgamebuddy_games g ON g.id = c.game_id
      WHERE c.user_id = uid AND c.status = 'owned'
        AND COALESCE(g.is_expansion, false) = false
    )
    SELECT jsonb_build_object(
      'owned',    COUNT(*)::INT,
      'played',   COUNT(*) FILTER (WHERE has_plays OR played_before_at IS NOT NULL)::INT,
      'unplayed', COUNT(*) FILTER (WHERE NOT has_plays AND played_before_at IS NULL)::INT,
      'marked',   COUNT(*) FILTER (WHERE NOT has_plays AND played_before_at IS NOT NULL)::INT,
      'games', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'game_id',        t.game_id,
                 'name',           t.game_name,
                 'thumbnail_url',  t.game_thumbnail_url,
                 'year_published', t.game_year_published,
                 'played_before',  t.played_before_at IS NOT NULL
               ) ORDER BY t.game_name)
        FROM (
          SELECT * FROM owned_base WHERE NOT has_plays
          ORDER BY game_name LIMIT 300
        ) t
      ), '[]'::JSONB),
      'games_truncated',
        (SELECT COUNT(*) FROM owned_base WHERE NOT has_plays) > 300
    )
    FROM owned_base
  ),

  'table_size', jsonb_build_object(
    'avg', (SELECT ROUND(AVG(n)::NUMERIC, 1)::FLOAT FROM roster WHERE n > 0),
    'buckets', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('size', size, 'plays', plays) ORDER BY size)
      FROM (
        SELECT LEAST(n, 5) AS size, COUNT(*)::INT AS plays
        FROM roster WHERE n > 0 GROUP BY 1
      ) b
    ), '[]'::JSONB)
  ),

  -- Weighted by plays, not by what is on the shelf: this answers "what do you
  -- actually put on the table", which the collection cannot.
  'taste', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('name', cat, 'plays', n) ORDER BY n DESC, cat)
    FROM (
      SELECT cat, COUNT(*)::INT AS n
      FROM my_plays mp
      JOIN public.boardgamebuddy_games g ON g.id = mp.game_id
      CROSS JOIN LATERAL unnest(COALESCE(g.categories, '{}')) AS cat
      WHERE cat IS NOT NULL AND cat <> ''
      GROUP BY cat
      ORDER BY n DESC, cat
      LIMIT 6
    ) q
  ), '[]'::JSONB),

  'comeback', jsonb_build_object(
    'wins_from_behind', (
      SELECT COUNT(*)::INT
      FROM half h JOIN half_lead hl ON hl.play_id = h.play_id
      WHERE h.player_user_id = uid AND h.is_winner AND h.half_score < hl.best_half
    ),
    'tracked_plays', (
      SELECT COUNT(DISTINCT h.play_id)::INT FROM half h WHERE h.player_user_id = uid
    )
  ),

  -- Kept out of the competitive win rate on purpose: folding co-op in would
  -- quietly inflate a number people read as head-to-head.
  'coop', (
    SELECT jsonb_build_object(
      'wins',   COUNT(*) FILTER (WHERE is_winner)::INT,
      'losses', COUNT(*) FILTER (WHERE NOT COALESCE(is_winner, false))::INT
    )
    FROM mine WHERE play_mode = 'coop'
  ),

  'personal_bests', COALESCE((SELECT jsonb_agg(to_jsonb(br) ORDER BY br.plays DESC, br.name)
                               FROM best_rows br), '[]'::JSONB)
);
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_user_stats_detail(uid uuid) TO boardgamebuddy_role;

-- ── Collection & games ────────────────────────────────────────────────────────
-- Shelves, the game detail screen, search and browse.

-- bgb_collection_shelf
--   from archive/069_prev_owned_status.sql
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
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_collection_shelf(viewer uuid, target uuid, p_status text, p_exclude_expansions boolean, p_limit integer) TO boardgamebuddy_role;

-- bgb_collection_status_map
--   from archive/069_prev_owned_status.sql
CREATE OR REPLACE FUNCTION public.bgb_collection_status_map(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_collection_status_map(p_viewer uuid) TO boardgamebuddy_role;

-- bgb_game_detail_bundle
--   from archive/055_hi_res_tile_art.sql
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

  RETURN jsonb_build_object(
    'game', v_game,
    'base_game', v_base,
    'viewer_status', v_status,
    'recent_plays', v_plays,
    'expansions', v_expansions,
    'expansion_count_for_viewer', v_exp_count_viewer
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_game_detail_bundle(game_uuid uuid, viewer uuid, plays_limit integer) TO boardgamebuddy_role;

-- boardgamebuddy_search_games
--   from archive/041_search_exclude_expansions.sql
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
  LEFT JOIN public.boardgamebuddy_collections c
    ON c.game_id = g.id AND c.user_id = p_viewer
  WHERE g.name ILIKE '%' || COALESCE(p_query, '') || '%'
    AND (COALESCE(p_include_expansions, false) OR NOT g.is_expansion)
  ORDER BY (c.user_id IS NOT NULL) DESC, g.name
  LIMIT GREATEST(COALESCE(p_limit, 20), 0);
$function$;
GRANT EXECUTE ON FUNCTION public.boardgamebuddy_search_games(p_viewer uuid, p_query text, p_limit integer, p_include_expansions boolean) TO boardgamebuddy_role;

-- bgb_distinct_mechanics
--   from archive/019_perf_indexes.sql
-- NOTE: no caller in shared-backend/, web/ or app/ as of this collapse.
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
GRANT EXECUTE ON FUNCTION public.bgb_distinct_mechanics() TO boardgamebuddy_role;

-- bgb_dormant_collection
--   from archive/045_participated_play_stats.sql
-- NOTE: no caller in shared-backend/, web/ or app/ as of this collapse.
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
GRANT EXECUTE ON FUNCTION public.bgb_dormant_collection(uid uuid, days_since integer, lim integer) TO boardgamebuddy_role;

-- ── Plays ─────────────────────────────────────────────────────────────────────
-- Logging a play and paging through logged plays.

-- bgb_log_play
--   from archive/065_play_country.sql
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
  v_players     JSONB;
  v_expansions  JSONB;
  v_client_key  UUID;
  v_existing    UUID;
  v_country     TEXT;
BEGIN
  -- Empty string and absent both mean "no key" — the client omits the field
  -- entirely for live writes, but a serializer that emits "" must not be read
  -- as a key shared by every unkeyed play.
  v_client_key := NULLIF(p_payload->>'client_key', '')::UUID;

  IF v_client_key IS NOT NULL THEN
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.client_key = v_client_key;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
    END IF;
  END IF;

  -- Migration 060. Unresolvable / malformed becomes NULL — "we don't know
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
      game_name, game_thumbnail_url, client_key, country_code
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
      v_country
    )
    RETURNING id, created_at INTO v_play;
  EXCEPTION WHEN unique_violation THEN
    -- Lost the race against a concurrent flush of the same queued play. The
    -- winner's row is the canonical one; hand its id back on the same
    -- duplicate envelope the pre-check uses.
    SELECT p.id INTO v_existing
      FROM boardgamebuddy_plays p
     WHERE p.user_id = p_user AND p.client_key = v_client_key;
    RETURN jsonb_build_object('duplicate', true, 'id', v_existing);
  END;

  INSERT INTO boardgamebuddy_play_players (
    play_id, player_user_id, player_display_name, is_winner, score, round_scores
  )
  SELECT
    v_play.id,
    pl.user_id,
    pl.name,
    COALESCE(pl.is_winner, false),
    pl.score,
    pl.round_scores
  FROM jsonb_to_recordset(COALESCE(p_payload->'players', '[]'::JSONB))
         AS pl(name TEXT, is_winner BOOLEAN, score INTEGER,
               user_id UUID, round_scores JSONB);

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

  -- Response blocks are built from the payload (plus the profile/game joins
  -- they need), not by reading the rows back — the values are identical and
  -- WITH ORDINALITY keeps the player list in the order the host entered it,
  -- which a RETURNING or a re-SELECT wouldn't guarantee.
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'user_id',      pl.user_id,
             'name',         COALESCE(prof.display_name, pl.name, 'Unknown'),
             'avatar',       prof.avatar,
             'is_winner',    COALESCE(pl.is_winner, false),
             'score',        pl.score,
             'round_scores', pl.round_scores
           ) ORDER BY pl.ord
         ), '[]'::JSONB)
    INTO v_players
    FROM ROWS FROM (
           jsonb_to_recordset(COALESCE(p_payload->'players', '[]'::JSONB))
             AS (name TEXT, is_winner BOOLEAN, score INTEGER,
                 user_id UUID, round_scores JSONB)
         ) WITH ORDINALITY AS pl(name, is_winner, score, user_id, round_scores, ord)
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
  -- would read back as "gb" while the row holds "GB".
  RETURN jsonb_build_object(
    'id',              v_play.id,
    'game_id',         v_game.id,
    'game_name',       v_game.name,
    'game_thumbnail',  v_game.thumbnail_url,
    'played_at',       (p_payload->>'played_at')::DATE,
    'notes',           p_payload->>'notes',
    'players',         v_players,
    'photo_url',       p_payload->>'photo_url',
    'expansions',      v_expansions,
    'created_at',      v_play.created_at,
    'play_mode',       v_mode,
    'country_code',    v_country,
    'logged_by_id',    p_user,
    'logged_by_name',  COALESCE(v_logged_name, ''),
    'is_own',          true
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_log_play(p_user uuid, p_payload jsonb) TO boardgamebuddy_role;

-- bgb_plays_page
--   from archive/065_play_country.sql
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
          'round_scores', pp.round_scores
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
GRANT EXECUTE ON FUNCTION public.bgb_plays_page(p_target uuid, p_page integer, p_per_page integer, p_game uuid, p_buddy uuid, p_search text, p_own_only boolean) TO boardgamebuddy_role;

-- bgb_play_stats
--   from archive/039_perf_rpcs_and_indexes.sql
CREATE OR REPLACE FUNCTION public.bgb_play_stats(p_viewer uuid, p_game_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'game_id', s.game_id,
           'play_count', s.play_count,
           'last_played_at', s.last_played_at
         )), '[]'::jsonb)
  FROM (
    SELECT p.game_id, count(*) AS play_count, max(p.played_at) AS last_played_at
    FROM boardgamebuddy_plays p
    WHERE (p.user_id = p_viewer
           OR EXISTS (
                SELECT 1 FROM boardgamebuddy_play_players pp
                WHERE pp.play_id = p.id AND pp.player_user_id = p_viewer))
      AND (p_game_ids IS NULL OR p.game_id = ANY (p_game_ids))
    GROUP BY p.game_id
  ) s;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_play_stats(p_viewer uuid, p_game_ids uuid[]) TO boardgamebuddy_role;

-- bgb_play_partners
--   from archive/061_play_partners_pending_request_id.sql
CREATE OR REPLACE FUNCTION public.bgb_play_partners(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_accounts JSONB;
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
               -- NEW in 060: the edge id, so the row can cancel an outgoing
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
    'ghosts', v_ghosts,
    'recent', v_recent
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_play_partners(p_viewer uuid) TO boardgamebuddy_role;

-- ── Live sessions ─────────────────────────────────────────────────────────────
-- The at-the-table session flow: create, join, score, finalize.

-- bgb_create_session
--   from archive/056_participant_order.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_create_session(p_host uuid, p_host_display_name text, p_game uuid) TO boardgamebuddy_role;

-- bgb_get_session
--   from archive/036_session_rpcs.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_get_session(p_code text) TO boardgamebuddy_role;

-- bgb_join_session
--   from archive/036_session_rpcs.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_join_session(p_code text, p_user uuid, p_user_display_name text, p_guest_display_name text) TO boardgamebuddy_role;

-- bgb_joinable_sessions
--   from archive/037_joinable_sessions_rpc.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_joinable_sessions(p_viewer uuid) TO boardgamebuddy_role;

-- bgb_add_participant
--   from archive/056_participant_order.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_add_participant(p_host uuid, p_code text, p_user uuid, p_display_name text) TO boardgamebuddy_role;

-- bgb_remove_participant
--   from archive/046_session_write_rpcs.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_remove_participant(p_host uuid, p_code text, p_participant uuid) TO boardgamebuddy_role;

-- bgb_reorder_participants
--   from archive/056_participant_order.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_reorder_participants(p_host uuid, p_code text, p_order uuid[]) TO boardgamebuddy_role;

-- bgb_update_session_game
--   from archive/046_session_write_rpcs.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_update_session_game(p_host uuid, p_code text, p_game uuid) TO boardgamebuddy_role;

-- bgb_advance_phase
--   from archive/046_session_write_rpcs.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_advance_phase(p_host uuid, p_code text, p_phase text, p_transitions jsonb) TO boardgamebuddy_role;

-- bgb_finalize_session
--   from archive/053_host_only_live_scores.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_finalize_session(p_host uuid, p_code text, p_payload jsonb) TO boardgamebuddy_role;

-- bgb_abandon_session
--   from archive/046_session_write_rpcs.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_abandon_session(p_host uuid, p_code text) TO boardgamebuddy_role;

-- ── Buddies & suggestions ─────────────────────────────────────────────────────
-- Who you play with, and who you might.

-- bgb_suggested_buddies
--   from archive/072_suggestions_from_sent_requests.sql
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
  -- Three sources now, so the FULL OUTER JOIN 057 used becomes a union of ids
  -- with the counts hung off it. Same result for the two it used to join.
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
     AND pr.needs_setup IS NOT TRUE          -- added in 066
     AND c.candidate NOT IN (SELECT x.other_id FROM connected x)
     AND (c.mutuals > 0 OR c.plays > 0 OR c.pending_mutuals > 0)
   -- Earned signals keep their order; the new one sorts below both, because a
   -- request nobody has answered is the weakest thing in the list.
   ORDER BY (c.plays > 0) DESC, c.plays DESC, c.mutuals DESC,
            c.pending_mutuals DESC, c.candidate
   LIMIT lim;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_suggested_buddies(uid uuid, lim integer) TO boardgamebuddy_role;

-- bgb_onboarding_buddy_suggestions
--   from archive/072_suggestions_from_sent_requests.sql
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
  -- Suggestable at all: a real, set-up profile that is neither the viewer nor
  -- already connected to them. Both tiers below draw from this.
  eligible AS (
    SELECT pr.id, pr.created_at
      FROM public.boardgamebuddy_profiles pr
     WHERE pr.id <> uid
       AND pr.needs_setup IS NOT TRUE
       AND pr.id NOT IN (SELECT c.other_id FROM connected c)
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
      -- Played-with outranks a graph path, most plays first (057's rule);
      -- a request nobody has answered yet sorts under both (072's).
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
GRANT EXECUTE ON FUNCTION public.bgb_onboarding_buddy_suggestions(uid uuid, lim integer, active_window_days integer) TO boardgamebuddy_role;

-- bgb_onboarding_suggestion_network
--   from archive/072_suggestions_from_sent_requests.sql
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
      AND h.candidate NOT IN (SELECT s.seed_id FROM seeds s)
  )
  SELECT r.via, r.candidate, r.n, r.rank_in_seed
    FROM ranked r
   WHERE r.rank_in_seed <= GREATEST(per_seed, 1)
   ORDER BY r.rank_in_seed, r.n DESC, r.via, r.candidate
   LIMIT lim;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_onboarding_suggestion_network(uid uuid, seed_ids uuid[], per_seed integer, lim integer) TO boardgamebuddy_role;

-- ── Ghost players & claims ────────────────────────────────────────────────────
-- Free-text player names, and turning them into real accounts.

-- bgb_link_ghost
--   from archive/070_ghost_claims.sql
CREATE OR REPLACE FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_profiles WHERE id = p_target) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object(
    'updated',
    bgb_link_ghost_rows(p_viewer, lower(btrim(COALESCE(p_display_name, ''))), p_target)
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_link_ghost(p_viewer uuid, p_display_name text, p_target uuid) TO boardgamebuddy_role;

-- bgb_merge_ghosts
--   from archive/050_ghost_rpcs_and_status_map.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_merge_ghosts(p_viewer uuid, p_source text, p_target text) TO boardgamebuddy_role;

-- bgb_ghost_claims
--   from archive/070_ghost_claims.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claims(p_viewer uuid) TO boardgamebuddy_role;

-- bgb_ghost_claim_suggestions
--   from archive/070_ghost_claims.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claim_suggestions(p_viewer uuid, p_limit integer, p_threshold real) TO boardgamebuddy_role;

-- bgb_ghost_claim_detail
--   from archive/070_ghost_claims.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_ghost_claim_detail(p_viewer uuid, p_play_id uuid, p_display_name text) TO boardgamebuddy_role;

-- bgb_create_ghost_claim
--   from archive/070_ghost_claims.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_create_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text) TO boardgamebuddy_role;

-- bgb_accept_ghost_claim
--   from archive/070_ghost_claims.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_accept_ghost_claim(p_owner uuid, p_claim_id uuid) TO boardgamebuddy_role;

-- bgb_reject_ghost_claim
--   from archive/070_ghost_claims.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_reject_ghost_claim(p_owner uuid, p_claim_id uuid) TO boardgamebuddy_role;

-- bgb_dismiss_ghost_claim
--   from archive/070_ghost_claims.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_dismiss_ghost_claim(p_claimant uuid, p_owner uuid, p_display_name text) TO boardgamebuddy_role;

-- ── Achievements ──────────────────────────────────────────────────────────────
-- Evaluated against the catalog in 002_seed.sql.

-- bgb_sync_achievements
--   from archive/068_location_achievements.sql
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
  -- country_code rides along from migration 068. It is on the play, so both
  -- legs carry it and the UNION still dedupes on the id.
  WITH my_plays AS (
    SELECT p.id, p.game_id, p.country_code
    FROM public.boardgamebuddy_plays p
    WHERE p.user_id = uid
    UNION
    SELECT p.id, p.game_id, p.country_code
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
    'biggest_table', COALESCE((SELECT MAX(players) FROM table_sizes), 0),
    -- Duelist: a game the BOX is built for two, not an evening that happened
    -- to seat two. `max_players = 2` is the test — a game that can never
    -- seat a third — which keeps 1-2 player games (Patchwork, Watergate) in:
    -- they are duels the moment a second person sits down, and excluding them
    -- on min_players would be a stricter reading than anyone means by "a
    -- two-player game". This is the one metric that has to reach the games
    -- table: migration 020 denormalized name and thumbnail onto plays, never
    -- the player counts.
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
    ),
    -- Chapters this user WROTE that somebody else keeps in their own guide.
    -- Distinct on the chapter: one popular chapter kept by nine people is one
    -- chapter, and the badge only needs the first.
    'chapters_borrowed', (
      SELECT COUNT(DISTINCT uc.chapter_id)
      FROM public.boardgamebuddy_user_chapters uc
      JOIN public.boardgamebuddy_guide_chapters gc ON gc.id = uc.chapter_id
      WHERE gc.created_by = uid AND uc.user_id <> uid
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
    -- ── Migration 068 ──────────────────────────────────────────────────────
    -- Distinct countries. COUNT(DISTINCT …) already skips NULLs, so the
    -- decade of pre-065 plays that have no country simply do not participate;
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
    )
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
GRANT EXECUTE ON FUNCTION public.bgb_sync_achievements(uid uuid) TO boardgamebuddy_role;

-- ── BoardGameGeek sync ────────────────────────────────────────────────────────
-- Progress for the two long-running BGG workers.

-- bgb_bgg_sync_status
--   from archive/039_perf_rpcs_and_indexes.sql
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
  v_pending BIGINT;
  v_errored BIGINT;
  v_last_completed TIMESTAMPTZ;
  v_session_total BIGINT := 0;
  v_session_done BIGINT := 0;
  v_session_errored BIGINT := 0;
  v_names JSONB := '[]'::jsonb;
BEGIN
  SELECT pr.bgg_username,
         (COALESCE(pr.bgg_username, '') <> '' AND COALESCE(pr.bgg_password_enc, '') <> ''),
         pr.bgg_last_sync_started_at
    INTO v_username, v_has_creds, v_session_start
    FROM boardgamebuddy_profiles pr
    WHERE pr.id = p_user;

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
    'session_game_names', v_names
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_bgg_sync_status(p_user uuid) TO boardgamebuddy_role;

-- bgb_bgg_push_status
--   from archive/073_bgg_push_queue.sql
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
GRANT EXECUTE ON FUNCTION public.bgb_bgg_push_status(p_user uuid) TO boardgamebuddy_role;
