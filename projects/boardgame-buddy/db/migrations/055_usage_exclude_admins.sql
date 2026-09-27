-- ─────────────────────────────────────────────────────────────────────────────
-- 055_usage_exclude_admins.sql — bgb_admin_usage_stats(p_exclude_admins)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The admin Usage spoke counted admins alongside everybody else, and admins
-- are the accounts doing development work — opening every screen, logging
-- test plays — so on a small user base they dominate the numbers. This adds
-- one boolean: when true, every per-account figure leaves out accounts with
-- boardgamebuddy_profiles.is_admin.
--
-- WHAT IT FILTERS, BLOCK BY BLOCK:
--
--   users     total / new_* / bgg_linked / push_enabled drop admins. `admins`
--             itself is always the full count, so the screen can say how many
--             were left out.
--   active    api_logs.user_id is the account's app_uid (= profiles.id), so
--             the filter is a NOT IN over admin ids, cast to text for the same
--             reason 047 casts it.
--   domain    each feature filters on the column naming WHO did it (plays
--             user_id, sessions host_user_id, chapters created_by, buddy links
--             accepted_by, ghost claims claimant_id, …). "Games added to the
--             catalog" has no such column and stays unfiltered.
--   origins   plays.user_id.
--   screens / events
--             analytics_events has no user column (the track endpoint is
--             unauthenticated), so web/domain/api.js now stamps
--             metadata.admin = true on events an admin's client sends, and
--             the filter drops those. Events from before that shipped carry
--             no stamp and are counted — the screen says so.
--   database  unaffected; bytes are bytes.
--
-- DROP, then CREATE, rather than CREATE OR REPLACE: adding a parameter makes a
-- new overload, and leaving the zero-argument one beside it would make a bare
-- rpc() call ambiguous to PostgREST. The DEFAULT keeps a no-argument call
-- meaning exactly what it did.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.bgb_admin_usage_stats();

CREATE OR REPLACE FUNCTION public.bgb_admin_usage_stats(p_exclude_admins BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
$$;

-- Naming PUBLIC alone does NOT close this — see 047 and 028_revoke_definer_execute.sql.
REVOKE EXECUTE ON FUNCTION public.bgb_admin_usage_stats(BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.bgb_admin_usage_stats(BOOLEAN) TO service_role;

COMMENT ON FUNCTION public.bgb_admin_usage_stats(BOOLEAN) IS
  'App-wide usage for the admin Usage spoke: accounts, active accounts (from '
  'api_logs), Postgres footprint, screen views, domain counters, play origins. '
  'p_exclude_admins leaves out is_admin accounts from every per-account figure. '
  'Read by GET /api/v1/boardgame_buddy/admin/usage.';

-- Verification (mirrors _shared/008): anon and authenticated must not appear.
--   SELECT proacl FROM pg_proc WHERE proname = 'bgb_admin_usage_stats';
