-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — baseline: social functions
--
-- Run on an empty database in this order: 001_baseline_tables.sql,
--   002_baseline_functions_play.sql,
--   003_baseline_functions_social.sql (this file), 004_seed.sql
--
-- Generated on 2026-09-29 by .claude/skills/squash-migrations/squash.py from
-- the 58 migrations in archive/2026-09-28/: they were replayed into an
-- empty database and these files were read back out of its catalog. A
-- database built from them diffs clean against that replay.
--
-- FRESH-DB ONLY. Production is already at this state. Do not run it there.
--
-- Needs these first, for the cross-app tables it reads:
-- _shared/001_analytics.sql, _shared/004_api_logs.sql,
-- _shared/005_api_sessions.sql, _shared/006_drop_api_sessions.sql.
--
-- People and what they see: profiles, the feed, buddies and suggestions,
-- notifications, stats, achievements, account deletion, admin usage. 20
-- functions, callees first, so the file runs top to bottom. Bodies are
-- pg_get_functiondef() output: the server's normalized rendering.
--
-- Grants are the difference from Supabase's defaults, which give anon,
-- authenticated and service_role everything on a new table or function (and
-- EXECUTE to PUBLIC). An object with no GRANT/REVOKE lines keeps them.
-- ─────────────────────────────────────────────────────────────────────────────


-- bgb_admin_usage_stats(p_exclude_admins boolean)
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
    -- metadata.admin is stamped by the client (web/domain/api.js) from 055 on;
    -- older rows have no stamp and are always counted.
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
REVOKE EXECUTE ON FUNCTION public.bgb_admin_usage_stats(p_exclude_admins boolean) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.bgb_admin_usage_stats(p_exclude_admins boolean) IS 'App-wide usage for the admin Usage spoke: accounts, active accounts (from api_logs), Postgres footprint, screen views, domain counters, play origins. p_exclude_admins leaves out is_admin accounts from every per-account figure. Read by GET /api/v1/boardgame_buddy/admin/usage.';

-- bgb_delete_account_rows(p_user uuid)
CREATE OR REPLACE FUNCTION public.bgb_delete_account_rows(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name        TEXT;
  v_photos      INT := 0;
  v_names       INT := 0;
  v_reassigned  INT := 0;
  v_deleted     INT := 0;
BEGIN
  SELECT pr.display_name INTO v_name
  FROM boardgamebuddy_profiles pr WHERE pr.id = p_user;

  -- (a) Unlink photos whose objects the caller has already removed.
  --
  -- Matched on the URL rather than on user_id, and NOT restricted to this
  -- account's plays. The plays layout is `{user_id}/{uuid4hex}.{ext}`, which
  -- appears identically inside both the R2 and the Supabase Storage public
  -- URL, so this is exactly the set of objects that just went. Only the
  -- owner-gated PATCH can attach one, so in practice they are all on this
  -- account's own plays — but a row that pointed at a deleted object from
  -- anywhere else is a broken image either way, and matching the URL costs
  -- one scan of a small table and cannot be wrong. It also makes this
  -- statement independent of the reassignment below, so their order is free.
  --
  -- A uuid contains only hex and hyphens: no `%`, and no `_`, which is the
  -- LIKE wildcard that would otherwise need escaping here.
  UPDATE boardgamebuddy_plays
     SET photo_url = NULL
   WHERE photo_url LIKE '%/' || p_user::text || '/%';
  GET DIAGNOSTICS v_photos = ROW_COUNT;

  -- (b) Give every nameless seat of theirs a name, BEFORE anything nulls the
  -- account off it. See the header: without this the FK's SET NULL can leave a
  -- row failing bgb_play_players_identity_chk and abort the whole delete.
  -- Same expression as bgb_ghost_out_of_plays, including the 'Player' floor
  -- for an account whose own display_name is somehow blank.
  UPDATE boardgamebuddy_play_players pp
     SET player_display_name =
           COALESCE(NULLIF(btrim(COALESCE(v_name, '')), ''), 'Player')
   WHERE pp.player_user_id = p_user
     AND btrim(COALESCE(pp.player_display_name, '')) = '';
  GET DIAGNOSTICS v_names = ROW_COUNT;

  -- (c) Hand over every play that somebody else was also at.
  WITH candidates AS (
    SELECT p.id           AS play_id,
           pp.player_user_id AS heir,
           pp.linked_at   AS seated_at
      FROM boardgamebuddy_plays p
      JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
     WHERE p.user_id = p_user
       AND pp.player_user_id IS NOT NULL
       AND pp.player_user_id <> p_user
       -- Not a candidate if the play would collide with one this account
       -- already holds on any of the three per-owner unique keys. See the
       -- header: BGA tables are the real case, and an heir who already has a
       -- row for the same table already has that night.
       AND NOT EXISTS (
             SELECT 1
               FROM boardgamebuddy_plays x
              WHERE x.user_id = pp.player_user_id
                AND (
                      (p.bgg_play_id  IS NOT NULL AND x.bgg_play_id  = p.bgg_play_id)
                   OR (p.bga_table_id IS NOT NULL AND x.bga_table_id = p.bga_table_id)
                   OR (p.client_key   IS NOT NULL AND x.client_key   = p.client_key)
                )
           )
  ),
  heirs AS (
    -- Earliest seated wins; the uid breaks the tie so a re-run picks the same
    -- person. DISTINCT ON needs the leading ORDER BY column to be the group.
    SELECT DISTINCT ON (c.play_id) c.play_id AS play_id, c.heir AS heir
      FROM candidates c
     ORDER BY c.play_id, c.seated_at ASC, c.heir ASC
  )
  UPDATE boardgamebuddy_plays p
     SET user_id             = h.heir,
         inherited_at        = now(),
         inherited_from_name = COALESCE(NULLIF(btrim(COALESCE(v_name, '')), ''), 'Player')
    FROM heirs h
   WHERE p.id = h.play_id;
  GET DIAGNOSTICS v_reassigned = ROW_COUNT;

  -- (d) Whatever is left was theirs alone, and goes with them.
  SELECT COUNT(*)::int INTO v_deleted
    FROM boardgamebuddy_plays WHERE user_id = p_user;

  -- (e) The profile, and every cascade hanging off it: collections, the
  -- remaining plays, buddies, buddy edges, sessions and participants,
  -- achievements, push subscriptions, pending imports, feedback, BGA links.
  -- Seats on the plays handed over in (c) are NOT among them — they take the
  -- FK's SET NULL and become named ghosts. Guide chapters they authored keep
  -- their text under a NULL created_by.
  DELETE FROM boardgamebuddy_profiles WHERE id = p_user;

  RETURN jsonb_build_object(
    'plays_reassigned', v_reassigned,
    'plays_deleted',    v_deleted,
    'photos_unlinked',  v_photos,
    'names_backfilled', v_names
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_delete_account_rows(p_user uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_delete_account_rows(p_user uuid) TO boardgamebuddy_role;

-- bgb_feed_plays(viewer uuid, before_played_at date, before_created_at timestamp with time zone, lim integer)
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
  -- body: the string is handed to the SQL engine untouched. 015 added
  -- `players` and `expansions` to that set of shadowed names, 016 added
  -- `reactors`, 022 added `import_batch_id` and 031 adds `scoring_template` —
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
           -- New in 022. Free: `page` already reads this row, and the column
           -- is a plain uuid on it.
           p.import_batch_id,
           -- New in 031. Free for the same reason — a jsonb column on the row
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
      -- Migration 005. One representative row per imported run: the lowest id
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
      -- shape migration 043 removed (105 ms -> 5 ms on a 30k-play fixture),
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
      -- The scorecard, added by 015. UNFILTERED, unlike `participants`: this
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
            -- Migration 048. Required, not optional: Play.fromFeedCard passes
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
  -- The one genuinely new read in 015. Same LATERAL shape as the roster so it
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
  -- Reactions, added by 016. Same bounded-by-`lim` LATERAL shape as the two
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
REVOKE EXECUTE ON FUNCTION public.bgb_feed_plays(viewer uuid, before_played_at date, before_created_at timestamp with time zone, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_feed_plays(viewer uuid, before_played_at date, before_created_at timestamp with time zone, lim integer) TO boardgamebuddy_role;

-- bgb_feedback_list(viewer_id uuid, want_status text, want_type text, want_topic text, want_id uuid)
CREATE OR REPLACE FUNCTION public.bgb_feedback_list(viewer_id uuid, want_status text, want_type text DEFAULT NULL::text, want_topic text DEFAULT NULL::text, want_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, user_id uuid, author_name text, feedback_type text, feedback_type_label text, feedback_type_icon text, topic text, topic_label text, topic_icon text, body text, status text, resolved_at timestamp with time zone, resolver_name text, created_at timestamp with time zone, like_count bigint, viewer_liked boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    f.id,
    f.user_id,
    author.display_name,
    f.feedback_type,
    ft.label,
    ft.icon,
    f.topic,
    tp.label,
    tp.icon,
    f.body,
    f.status,
    f.resolved_at,
    resolver.display_name,
    f.created_at,
    -- A correlated count rather than a LEFT JOIN + GROUP BY: it reads off the
    -- likes PK directly (feedback_id leads it) and keeps every column above out
    -- of a GROUP BY clause that would have to list all fourteen of them.
    (SELECT COUNT(*) FROM public.boardgamebuddy_feedback_likes l
      WHERE l.feedback_id = f.id),
    EXISTS (SELECT 1 FROM public.boardgamebuddy_feedback_likes l
             WHERE l.feedback_id = f.id AND l.user_id = viewer_id)
  FROM public.boardgamebuddy_feedback f
  JOIN public.boardgamebuddy_profiles author ON author.id = f.user_id
  JOIN public.boardgamebuddy_feedback_types  ft ON ft.id = f.feedback_type
  JOIN public.boardgamebuddy_feedback_topics tp ON tp.id = f.topic
  -- LEFT, unlike the three above: resolved_by is null on every open item, and an
  -- inner join here would return an empty board.
  LEFT JOIN public.boardgamebuddy_profiles resolver ON resolver.id = f.resolved_by
  WHERE (want_id IS NULL     OR f.id     = want_id)
    -- Skipped entirely on an id lookup — see the header.
    AND (want_id IS NOT NULL OR f.status = want_status)
    AND (want_type  IS NULL OR f.feedback_type = want_type)
    AND (want_topic IS NULL OR f.topic         = want_topic)
  ORDER BY (SELECT COUNT(*) FROM public.boardgamebuddy_feedback_likes l
             WHERE l.feedback_id = f.id) DESC,
           f.created_at DESC;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_feedback_list(viewer_id uuid, want_status text, want_type text, want_topic text, want_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_feedback_list(viewer_id uuid, want_status text, want_type text, want_topic text, want_id uuid) TO boardgamebuddy_role;

-- bgb_mark_link_notifications_seen(p_viewer uuid, p_through timestamp with time zone)
CREATE OR REPLACE FUNCTION public.bgb_mark_link_notifications_seen(p_viewer uuid, p_through timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_through TIMESTAMPTZ := COALESCE(p_through, now());
  v_result  TIMESTAMPTZ;
BEGIN
  UPDATE boardgamebuddy_profiles
     SET link_notifications_seen_at =
           GREATEST(COALESCE(link_notifications_seen_at, '-infinity'::timestamptz), v_through)
   WHERE id = p_viewer
   RETURNING link_notifications_seen_at INTO v_result;
  RETURN v_result;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_mark_link_notifications_seen(p_viewer uuid, p_through timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_mark_link_notifications_seen(p_viewer uuid, p_through timestamp with time zone) TO boardgamebuddy_role;

-- bgb_mark_release_notices_seen(p_viewer uuid, p_through timestamp with time zone)
CREATE OR REPLACE FUNCTION public.bgb_mark_release_notices_seen(p_viewer uuid, p_through timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_through TIMESTAMPTZ := COALESCE(p_through, now());
  v_result  TIMESTAMPTZ;
BEGIN
  UPDATE public.boardgamebuddy_profiles
     SET release_notices_seen_at = GREATEST(release_notices_seen_at, v_through)
   WHERE id = p_viewer
   RETURNING release_notices_seen_at INTO v_result;
  RETURN v_result;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_mark_release_notices_seen(p_viewer uuid, p_through timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_mark_release_notices_seen(p_viewer uuid, p_through timestamp with time zone) TO boardgamebuddy_role;

-- bgb_notifications(p_viewer uuid, p_limit integer, p_before timestamp with time zone, p_before_key text)
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
    -- to_char at UTC rather than l_at::text, unchanged from 009: the key is the
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
           -- game_name / game_thumbnail_url are denormalized (migration 020)
           -- and null on rows written before it, so fall back to the catalog
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
  -- Somebody said yes. Keyed on accepted_by, never on requested_by: see 009's
  -- rationale for that column for why the QR path makes the distinction
  -- load-bearing rather than pedantic. `accepted_by <> p_viewer` is what stops
  -- the feed announcing an act the viewer performed themselves.
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
  -- deleted (051). The fourth kind, and the only one with no actor to join to
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
           -- null on rows written before migration 020.
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
REVOKE EXECUTE ON FUNCTION public.bgb_notifications(p_viewer uuid, p_limit integer, p_before timestamp with time zone, p_before_key text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_notifications(p_viewer uuid, p_limit integer, p_before timestamp with time zone, p_before_key text) TO boardgamebuddy_role;

-- bgb_notifications_unread(p_viewer uuid)
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
      -- 009's reason for giving them no index of their own — that still holds.
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
      -- A play handed over by a deleted account (051). One row per play, no
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
REVOKE EXECUTE ON FUNCTION public.bgb_notifications_unread(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_notifications_unread(p_viewer uuid) TO boardgamebuddy_role;

-- bgb_onboarding_buddy_suggestions(uid uuid, lim integer, active_window_days integer)
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
       AND pr.id NOT IN (SELECT d.other_id FROM dismissed d)   -- added in 014 (this file)
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
REVOKE EXECUTE ON FUNCTION public.bgb_onboarding_buddy_suggestions(uid uuid, lim integer, active_window_days integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_onboarding_buddy_suggestions(uid uuid, lim integer, active_window_days integer) TO boardgamebuddy_role;

-- bgb_onboarding_suggestion_network(uid uuid, seed_ids uuid[], per_seed integer, lim integer)
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
      AND h.candidate NOT IN (SELECT d.other_id FROM dismissed d)   -- added in 014 (this file)
      AND h.candidate NOT IN (SELECT s.seed_id FROM seeds s)
  )
  SELECT r.via, r.candidate, r.n, r.rank_in_seed
    FROM ranked r
   WHERE r.rank_in_seed <= GREATEST(per_seed, 1)
   ORDER BY r.rank_in_seed, r.n DESC, r.via, r.candidate
   LIMIT lim;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_onboarding_suggestion_network(uid uuid, seed_ids uuid[], per_seed integer, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_onboarding_suggestion_network(uid uuid, seed_ids uuid[], per_seed integer, lim integer) TO boardgamebuddy_role;

-- bgb_play_partners(p_viewer uuid)
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
               -- Per 012: the viewer's own private alias for this buddy, off
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

  -- NEW in 049. pending: live requests either way, newest first — a request
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
               -- Per 061: the edge id, so the row can cancel an outgoing
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
REVOKE EXECUTE ON FUNCTION public.bgb_play_partners(p_viewer uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_play_partners(p_viewer uuid) TO boardgamebuddy_role;

-- bgb_play_stats(p_viewer uuid, p_game_ids uuid[])
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
REVOKE EXECUTE ON FUNCTION public.bgb_play_stats(p_viewer uuid, p_game_ids uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_play_stats(p_viewer uuid, p_game_ids uuid[]) TO boardgamebuddy_role;

-- bgb_plays_page(p_target uuid, p_page integer, p_per_page integer, p_game uuid, p_buddy uuid, p_search text, p_own_only boolean)
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
      -- Migration 005. One row per imported run, same representative rule as
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
REVOKE EXECUTE ON FUNCTION public.bgb_plays_page(p_target uuid, p_page integer, p_per_page integer, p_game uuid, p_buddy uuid, p_search text, p_own_only boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_plays_page(p_target uuid, p_page integer, p_per_page integer, p_game uuid, p_buddy uuid, p_search text, p_own_only boolean) TO boardgamebuddy_role;

-- bgb_release_notices_unseen(p_viewer uuid, p_limit integer)
CREATE OR REPLACE FUNCTION public.bgb_release_notices_unseen(p_viewer uuid, p_limit integer DEFAULT 5)
 RETURNS TABLE(id uuid, title text, body_md text, link_route text, link_label text, published_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT newest.id, newest.title, newest.body_md,
         newest.link_route, newest.link_label, newest.published_at
    FROM (
      SELECT n.id, n.title, n.body_md, n.link_route, n.link_label, n.published_at
        FROM public.boardgamebuddy_release_notices n
       WHERE n.published_at IS NOT NULL
         AND n.published_at > (SELECT pr.release_notices_seen_at
                                 FROM public.boardgamebuddy_profiles pr
                                WHERE pr.id = p_viewer)
       ORDER BY n.published_at DESC
       LIMIT GREATEST(COALESCE(p_limit, 5), 1)
    ) newest
   ORDER BY newest.published_at ASC;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_release_notices_unseen(p_viewer uuid, p_limit integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_release_notices_unseen(p_viewer uuid, p_limit integer) TO boardgamebuddy_role;

-- bgb_suggested_buddies(uid uuid, lim integer)
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
     AND c.candidate NOT IN (SELECT x.other_id FROM dismissed x)   -- added in 014 (this file)
     AND (c.mutuals > 0 OR c.plays > 0 OR c.pending_mutuals > 0)
   -- Earned signals keep their order; the new one sorts below both, because a
   -- request nobody has answered is the weakest thing in the list.
   ORDER BY (c.plays > 0) DESC, c.plays DESC, c.mutuals DESC,
            c.pending_mutuals DESC, c.candidate
   LIMIT lim;
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_suggested_buddies(uid uuid, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_suggested_buddies(uid uuid, lim integer) TO boardgamebuddy_role;

-- bgb_sync_achievements(uid uuid)
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
    -- ── Migration 034 ──────────────────────────────────────────────────────
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
        AND uc.state = 'kept'   -- added in 033 (this file)
    ),
    -- Chapters this user WROTE that somebody else keeps in their own guide.
    -- Distinct on the chapter: one popular chapter kept by nine people is one
    -- chapter, and the badge only needs the first.
    'chapters_borrowed', (
      SELECT COUNT(DISTINCT uc.chapter_id)
      FROM public.boardgamebuddy_user_chapters uc
      JOIN public.boardgamebuddy_guide_chapters gc ON gc.id = uc.chapter_id
      WHERE gc.created_by = uid AND uc.user_id <> uid
        AND uc.state = 'kept'   -- added in 033 (this file)
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
    ),
    -- ── Migration 019 ──────────────────────────────────────────────────────
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
          AND uc.state = 'kept'   -- added in 033 (this file)
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
REVOKE EXECUTE ON FUNCTION public.bgb_sync_achievements(uid uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_sync_achievements(uid uuid) TO boardgamebuddy_role;

-- bgb_user_stats(uid uuid)
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
REVOKE EXECUTE ON FUNCTION public.bgb_user_stats(uid uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_user_stats(uid uuid) TO boardgamebuddy_role;

-- bgb_profile_bundle(viewer uuid, target uuid, col_per_page integer, plays_per_page integer)
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
REVOKE EXECUTE ON FUNCTION public.bgb_profile_bundle(viewer uuid, target uuid, col_per_page integer, plays_per_page integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_profile_bundle(viewer uuid, target uuid, col_per_page integer, plays_per_page integer) TO boardgamebuddy_role;

-- bgb_bootstrap(viewer uuid, owned_plays_limit integer, max_game_bundles integer)
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
REVOKE EXECUTE ON FUNCTION public.bgb_bootstrap(viewer uuid, owned_plays_limit integer, max_game_bundles integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_bootstrap(viewer uuid, owned_plays_limit integer, max_game_bundles integer) TO boardgamebuddy_role;

-- bgb_user_stats_detail(uid uuid)
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
         pp.is_winner, pp.score, pp.round_scores,
         -- Did this play record an outcome at all? A play where NO seat is
         -- flagged a winner and NO seat carries a score says nothing about how
         -- it went — it is not a loss, it is a blank. It is still a play (it
         -- counts in total_plays, the heatmap, the podium, table sizes), but a
         -- win-rate denominator that swallows it reports losses nobody had.
         -- Read over the whole roster, not just my own seat: a play someone
         -- else won is decided for me too.
         EXISTS (
           SELECT 1 FROM public.boardgamebuddy_play_players d
            WHERE d.play_id = mp.id
              AND (d.is_winner OR d.score IS NOT NULL)
         ) AS decided
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
    -- The ring's denominator. `plays` above stays the honest play count (it
    -- includes plays I logged but sat out, and plays with no result); this is
    -- the subset that can be won or lost, so wins + losses adds up to it.
    (SELECT COUNT(*)::INT FROM mine m
      WHERE m.game_id = bg.game_id AND m.decided)                         AS decided_plays,
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
    AND m.decided
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
      -- A co-op loss records a deliberate 0 (see the FE's _stampCoopLoss), and
      -- "your personal best at Pandemic: 0" is not a record anybody set.
      AND COALESCE(m.play_mode, 'competitive') <> 'coop'
    ORDER BY m.score DESC, m.played_at DESC
    LIMIT 1
  ) b ON true
  ORDER BY bg.plays DESC, bg.name
  LIMIT 5
)

SELECT jsonb_build_object(
  -- career.win_rate is left to the caller: it divides rated_wins by
  -- rated_plays, never win_count by total_plays. A co-op win is the table
  -- beating the game and belongs in its own block; a play I logged but sat
  -- out has no result at all; and neither does a play nobody won and nobody
  -- scored, which is what `decided` filters out of every ratio below.
  'career', jsonb_build_object(
    'total_plays',     (SELECT COUNT(*)::INT FROM my_plays),
    'unique_games',    (SELECT COUNT(DISTINCT game_id)::INT FROM my_plays),
    'win_count',       (SELECT COUNT(*)::INT FROM mine WHERE is_winner),
    'rated_plays',     (SELECT COUNT(*)::INT FROM mine WHERE COALESCE(play_mode, 'competitive') <> 'coop' AND decided),
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
    FROM mine WHERE play_mode = 'coop' AND decided
  ),

  'personal_bests', COALESCE((SELECT jsonb_agg(to_jsonb(br) ORDER BY br.plays DESC, br.name)
                               FROM best_rows br), '[]'::JSONB)
);
$function$;
REVOKE EXECUTE ON FUNCTION public.bgb_user_stats_detail(uid uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_user_stats_detail(uid uuid) TO boardgamebuddy_role;
