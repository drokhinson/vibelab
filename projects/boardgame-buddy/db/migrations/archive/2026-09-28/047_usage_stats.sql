-- ─────────────────────────────────────────────────────────────────────────────
-- 047_usage_stats.sql — bgb_admin_usage_stats(), the admin Usage spoke's payload
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The app has per-user stats (bgb_user_stats_detail, behind the Profile hub's
-- Stats spoke) and per-queue admin counts (/admin/review-counts, behind the
-- Settings gear's dot). It has had nothing that answers "how is the app being
-- used, overall" — how many accounts exist, how many people opened it
-- yesterday, how much Postgres it is consuming, which screens anyone actually
-- opens. This is that function.
--
-- ONE FUNCTION RETURNING JSONB, for the reasons archive/058_user_stats_detail
-- gives: the screen wants eleven unrelated aggregates and a dozen round trips
-- to draw one page is the wrong price. `LANGUAGE sql` + `STABLE` so it runs
-- inside the read-only transaction PostgREST opens.
--
-- ── NO NEW INSTRUMENTATION ───────────────────────────────────────────────────
--
-- Three of the four blocks read tables that are already being written:
--
--   active   public.api_logs. main.py's self-timing middleware writes one row
--            per request to /bootstrap, /bootstrap/game-bundles and /feed,
--            carrying user_id — which is the account's app_uid, i.e. exactly
--            boardgamebuddy_profiles.id (jwt_auth._app_uid). Every app open by
--            a signed-in account hits /bootstrap, so COUNT(DISTINCT user_id)
--            over a window IS the active-user count, with the history the
--            table already has. It counts SIGNED-IN accounts that made a
--            boot-critical request; the UI says so rather than calling it DAU
--            and leaving the reader to guess.
--
--   screens  public.analytics_events. web/domain/view.js fires
--            `view:<route>` on every navigation and has for a long time, so
--            the screen leaderboard has real history on day one. No user
--            column here (the track endpoint is unauthenticated by design),
--            which is why `active` comes from api_logs instead.
--
--   database pg_class. Sizes need no columns of their own.
--
-- ── WHY NOT public.admin_table_sizes() ───────────────────────────────────────
--
-- It does exactly the pg_class query in the `database` block below, and the
-- shared Supabase database has it. But it is defined by the OTHER apps'
-- migration tree (db/migrations/_shared/002_admin_rpcs.sql at the repo root),
-- and this project's own db/migrations/_shared/ carries only 001_analytics and
-- 004_api_logs — so a fresh BoardgameBuddy-only database would not have it and
-- this function would 42883 on first call. BoardgameBuddy is isolated
-- (projects/boardgame-buddy/CLAUDE.md); the twenty duplicated lines are the
-- cost of that, and cheaper than the cross-tree dependency.
--
-- ── THREE THINGS THAT LOOK WRONG AND ARE NOT ─────────────────────────────────
--
-- 1. `COUNT(DISTINCT user_id::text)`, not a bare user_id. api_logs.user_id was
--    added to the live table after _shared/004_api_logs.sql was written — that
--    migration does not declare it — so its type is not verifiable from the
--    repo. The cast counts correctly whether it is uuid or text, and a count
--    needs no join.
--
-- 2. Play origin is DERIVED and the order matters. There is no source column
--    on boardgamebuddy_plays. A BGG-imported play carries an import_batch_id
--    too, so the batch test has to come last or it would swallow both
--    integrations: bgg_play_id → 'bgg', else bga_table_id → 'bga', else
--    import_batch_id → 'import', else 'manual'.
--
-- 3. reltuples is an ESTIMATE, refreshed by ANALYZE, and -1 on a table never
--    analysed. It is labelled "≈ rows" in the UI and clamped at 0 here. The
--    numbers people will act on live in `domain`, which counts rows properly.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bgb_admin_usage_stats()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
WITH
-- ── Accounts ────────────────────────────────────────────────────────────────
user_counts AS (
  SELECT jsonb_build_object(
    'total',        COUNT(*),
    'new_24h',      COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours'),
    'new_7d',       COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days'),
    'new_30d',      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days'),
    'admins',       COUNT(*) FILTER (WHERE is_admin),
    'bgg_linked',   COUNT(*) FILTER (WHERE bgg_username IS NOT NULL),
    'first_signup', MIN(created_at)
  ) AS j
  FROM boardgamebuddy_profiles
),
push AS (
  SELECT COUNT(DISTINCT user_id) AS n FROM boardgamebuddy_push_subscriptions
),
-- ── Active accounts, from the request log ───────────────────────────────────
-- Scoped to this app: api_logs is cross-app.
logs AS (
  SELECT user_id, sent_at
  FROM api_logs
  WHERE app = 'boardgame-buddy' AND user_id IS NOT NULL
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
  SELECT event, created_at FROM analytics_events WHERE app = 'boardgame-buddy'
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
                SELECT  1 AS ord, created_at  AS happened_at FROM boardgamebuddy_plays
      UNION ALL SELECT  2,        created_at               FROM boardgamebuddy_plays WHERE photo_url IS NOT NULL
      UNION ALL SELECT  3,        created_at               FROM boardgamebuddy_play_sessions
      UNION ALL SELECT  4,        joined_at                FROM boardgamebuddy_play_session_participants
      UNION ALL SELECT  5,        created_at               FROM boardgamebuddy_guide_chapters
      UNION ALL SELECT  6,        created_at               FROM boardgamebuddy_user_chapters
      UNION ALL SELECT  7,        created_at               FROM boardgamebuddy_play_reactions
      UNION ALL SELECT  8,        added_at                 FROM boardgamebuddy_collections
      UNION ALL SELECT  9,        accepted_at              FROM boardgamebuddy_buddy_edges WHERE accepted_at IS NOT NULL
      UNION ALL SELECT 10,        created_at               FROM boardgamebuddy_ghost_claims
      UNION ALL SELECT 11,        unlocked_at              FROM boardgamebuddy_user_achievements
      UNION ALL SELECT 12,        created_at               FROM boardgamebuddy_feedback
      UNION ALL SELECT 13,        created_at               FROM boardgamebuddy_games
    ) src
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
$$;

-- Naming PUBLIC alone does NOT close this — Supabase's stock default
-- privileges hand anon and authenticated their own direct ACL entries, which
-- survive a revoke from PUBLIC. See 028_revoke_definer_execute.sql.
REVOKE EXECUTE ON FUNCTION public.bgb_admin_usage_stats() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.bgb_admin_usage_stats() TO service_role;

COMMENT ON FUNCTION public.bgb_admin_usage_stats() IS
  'App-wide usage for the admin Usage spoke: accounts, active accounts (from '
  'api_logs), Postgres footprint, screen views, domain counters, play origins. '
  'Read by GET /api/v1/boardgame_buddy/admin/usage.';

-- Verification (mirrors _shared/008): anon and authenticated must not appear.
--   SELECT proacl FROM pg_proc WHERE proname = 'bgb_admin_usage_stats';
