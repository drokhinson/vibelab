-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — initial-load performance
--
-- Everything here is on the path between "user opens the app" and "user sees
-- the feed". Four changes:
--
--   1. bgb_feed_plays: resolve the page first, then look up its roster.
--      As written in 032 the winners/participants CTEs had no predicate tying
--      them to the visible plays, so Postgres group-aggregated the ENTIRE
--      boardgamebuddy_play_players table (joined to _profiles) on every /feed
--      call — before the LIMIT. It can't push the join qual through a GROUP BY
--      subquery, so the cost grew with total plays across all users rather
--      than with the viewer's. Now a `page` CTE applies the cursor and LIMIT
--      first and a LATERAL resolves each page row's roster through
--      idx_bgb_play_players_play, so the work is bounded by `lim`.
--      Measured on 30k plays / 120k play_players / 500 visible: 105 ms -> 5 ms
--      at both limit=20 and limit=50, with identical rows and row order (390
--      viewer x limit x cursor cases compared against the 032 function).
--      Note the switch to plpgsql + EXECUTE. It is not cosmetic: `lim` has to
--      reach the planner as a literal. Left as a bind parameter alongside an
--      opaque `viewer`, the planner assumed `page` was large, planned the
--      roster join as a hash semi-join over all of play_players, and came out
--      8x SLOWER than the original (555 ms). See the comment on the function.
--
--   2. idx_bgb_plays_played_at: bgb_hot_games (012) filters on a played_at
--      range with no leading-played_at index — only (user_id, played_at) and
--      (game_id, played_at) composites existed — so it seq-scanned the plays
--      table on every feed first page and every /bootstrap.
--
--   3. idx_bgb_play_sessions_expires: bgb_joinable_sessions (037) filters
--      expires_at > now() over all open sessions, unindexed. Partial on
--      status='open' because that's the only status the RPC looks at.
--
--   4. bgb_bootstrap / bgb_game_bundles: the per-owned-game detail bundles are
--      an N+1 in SQL (one bgb_game_detail_bundle per owned game, up to 250,
--      each running ~5 statements) and nothing on the first screen reads them.
--      Split them into their own RPC so /bootstrap doesn't pay for them, and
--      teach bgb_bootstrap to skip the block when max_game_bundles <= 0.
--      bootstrap_version goes to 2 so the FE wipes and rehydrates.
--
-- Behavior is unchanged throughout: same visibility rules, same roster filter,
-- same output columns and order.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;


-- ── 1. Feed plays: resolve the page first, then its roster ───────────────────

DROP FUNCTION IF EXISTS public.bgb_feed_plays(UUID, DATE, TIMESTAMPTZ, INT);

CREATE FUNCTION public.bgb_feed_plays(
  viewer            UUID,
  before_played_at  DATE        DEFAULT NULL,
  before_created_at TIMESTAMPTZ DEFAULT NULL,
  lim               INT         DEFAULT 20
)
RETURNS TABLE (
  play_id              UUID,
  play_user_id         UUID,
  play_user_name       TEXT,
  play_user_avatar     JSONB,
  game_id              UUID,
  game_name            TEXT,
  game_image_url       TEXT,
  game_thumbnail_url   TEXT,
  played_at            DATE,
  created_at           TIMESTAMPTZ,
  notes                TEXT,
  photo_url            TEXT,
  play_mode            TEXT,
  winner_display_name  TEXT,
  participant_count    INT,
  participants         JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
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
$fn$;
GRANT EXECUTE ON FUNCTION public.bgb_feed_plays(UUID, DATE, TIMESTAMPTZ, INT) TO boardgamebuddy_role;


-- ── 2 & 3. Indexes for the two remaining seq scans on the boot path ───────────

-- bgb_hot_games: WHERE played_at >= (CURRENT_DATE - interval) GROUP BY game_id.
CREATE INDEX IF NOT EXISTS idx_bgb_plays_played_at
  ON public.boardgamebuddy_plays (played_at DESC);

-- bgb_joinable_sessions: WHERE status = 'open' AND expires_at > now().
CREATE INDEX IF NOT EXISTS idx_bgb_play_sessions_expires
  ON public.boardgamebuddy_play_sessions (expires_at)
  WHERE status = 'open';


-- ── 4. Split the per-owned-game bundles out of bootstrap ──────────────────────

-- The block lifted out of bgb_bootstrap. Called by GET /bootstrap/game-bundles,
-- which the FE fires from an idle callback after the user has already landed.
CREATE OR REPLACE FUNCTION public.bgb_game_bundles(
  viewer UUID,
  owned_plays_limit INT DEFAULT 5,
  max_bundles INT DEFAULT 250
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;
GRANT EXECUTE ON FUNCTION public.bgb_game_bundles(UUID, INT, INT) TO boardgamebuddy_role;


-- bgb_bootstrap keeps its signature and its bundle block, but the backend now
-- calls it with max_game_bundles = 0 so the block is skipped entirely. Guarded
-- with an explicit IF rather than leaning on LIMIT 0, which would still have
-- reported truncated = true for anyone who owns anything.
CREATE OR REPLACE FUNCTION public.bgb_bootstrap(
  viewer UUID,
  owned_plays_limit INT DEFAULT 5,
  max_game_bundles INT DEFAULT 250
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;
GRANT EXECUTE ON FUNCTION public.bgb_bootstrap(UUID, INT, INT) TO boardgamebuddy_role;

COMMIT;
