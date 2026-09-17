-- 039_bgg_hot_snapshots.sql — BGG's hot list, kept.
--
-- WHY. The Discover tab's "Trending on BoardGameGeek" rail read BGG's /hot
-- live, through a one-hour in-process cache (038). That answers "what is hot
-- now" and nothing else: a worker restart forgets it, and "climbing" — the
-- interesting half of a trending list — needs yesterday's ranks to compare
-- against. So each refresh writes the whole list as one run, and the rail
-- reads the newest run diffed against the newest run at least twenty hours
-- older.
--
-- SHAPE. One row per (run, game), keyed by captured_at + bgg_id. No game_id
-- column on purpose: the catalog import runs AFTER the snapshot (the refresh
-- imports up to ten hot games it lacks per run), and a bgg_id join at read
-- time resolves a game imported after its first appearance, which a nullable
-- FK written at snapshot time never would. Thirty days of runs are kept; the
-- refresh prunes older ones (discovery_service.refresh_hot_snapshot).
--
-- WRITTEN BY POST /discover/admin/refresh-trending — an admin from Settings,
-- or the daily .github/workflows/bgb-hot-refresh.yml with the admin key.

BEGIN;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_bgg_hot_snapshots (
  captured_at    TIMESTAMPTZ NOT NULL,
  bgg_id         INTEGER NOT NULL,
  rank           INTEGER NOT NULL,
  name           TEXT NOT NULL,
  year_published INTEGER,
  thumbnail_url  TEXT,
  CONSTRAINT boardgamebuddy_bgg_hot_snapshots_pkey PRIMARY KEY (captured_at, bgg_id)
);
ALTER TABLE public.boardgamebuddy_bgg_hot_snapshots ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_bgg_hot_snapshots TO boardgamebuddy_role;
CREATE INDEX IF NOT EXISTS idx_bgb_hot_snapshots_bgg_captured
  ON public.boardgamebuddy_bgg_hot_snapshots (bgg_id, captured_at DESC);

COMMENT ON TABLE public.boardgamebuddy_bgg_hot_snapshots IS
  'BGG /hot?type=boardgame, one row per (run, game). captured_at is the run id — every row of one refresh shares it. Kept 30 days. Read by bgb_bgg_hot_latest(); joined to the catalog by bgg_id at read time, never by a stored game_id.';

-- ── bgb_bgg_hot_latest ────────────────────────────────────────────────────────
-- The newest run, each row carrying where the same game sat in the newest run
-- at least 20 hours older. Twenty hours rather than a day: the cron fires at
-- the same minute daily and clock drift must not turn "yesterday" into "two
-- days ago"; and two refreshes inside one day (an admin tap after the cron)
-- must not compare a run against itself and read as "no movement".
--
--   prev_rank   NULL when the game was not in the comparison run, or there
--               is no comparison run yet
--   rank_delta  prev_rank - rank: positive = climbing. NULL with prev_rank.
--   is_new      the game was absent from the comparison run. False when there
--               is no comparison run at all — a first snapshot is not fifty
--               new entries, it is no information.
CREATE OR REPLACE FUNCTION public.bgb_bgg_hot_latest()
 RETURNS TABLE(
   bgg_id         integer,
   rank           integer,
   name           text,
   year_published integer,
   thumbnail_url  text,
   prev_rank      integer,
   rank_delta     integer,
   is_new         boolean,
   captured_at    timestamptz
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
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

GRANT EXECUTE ON FUNCTION public.bgb_bgg_hot_latest() TO boardgamebuddy_role;
REVOKE EXECUTE ON FUNCTION public.bgb_bgg_hot_latest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_bgg_hot_latest() TO service_role;

COMMIT;
