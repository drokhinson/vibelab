-- 038_discover.sql — the Discover tab: BGG quality stats on the catalog, and
-- the on-demand recommendation RPC that scores it against one user's taste.
--
-- WHY. The app knows two things about a person that BoardGameGeek does not:
-- what is on their shelf and what actually hits their table. The Discover tab
-- turns that into "games you might like" without a live BGG call per view —
-- the catalog (~1000 rows seeded from BGG's top list) is scored in SQL against
-- a taste profile built from the viewer's collection and plays.
--
-- TWO PARTS.
--   1. Five nullable stats columns on boardgamebuddy_games (rating, rank,
--      weight, owner count, synced-at). BGG's /thing?stats=1 carries them;
--      POST /games/admin/backfill-stats fills them in throttled batches of 20
--      (game_routes.py). NULL means "never synced" and every reader treats it
--      as neutral, so the tab works before the backfill has run.
--   2. bgb_discover_recommendations(uid, lim) — the scorer. See its header.
--
-- INDEXES. "New this year" orders by (year, rank); the backfill selects by
-- sync age; the scorer's overlap tests use `&&` on text[], which a GIN index
-- serves once the catalog outgrows a sequential scan.

BEGIN;

-- ── BGG stats on the catalog ──────────────────────────────────────────────────
ALTER TABLE public.boardgamebuddy_games
  ADD COLUMN IF NOT EXISTS bgg_rating          NUMERIC(4,2),
  ADD COLUMN IF NOT EXISTS bgg_rank            INTEGER,
  ADD COLUMN IF NOT EXISTS bgg_weight          NUMERIC(4,2),
  ADD COLUMN IF NOT EXISTS bgg_owned_count     INTEGER,
  ADD COLUMN IF NOT EXISTS bgg_stats_synced_at TIMESTAMPTZ;

COMMENT ON COLUMN public.boardgamebuddy_games.bgg_rating IS
  'BGG geek rating (statistics/ratings/bayesaverage), 1..10. NULL = never synced or unrated. Written by POST /games/admin/backfill-stats.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_rank IS
  'BGG overall board game rank (statistics/ratings/ranks/rank[@name=boardgame]). NULL = "Not Ranked" or never synced.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_weight IS
  'BGG complexity (statistics/ratings/averageweight), 1..5.';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_owned_count IS
  'How many BGG users list the game as owned (statistics/ratings/owned).';
COMMENT ON COLUMN public.boardgamebuddy_games.bgg_stats_synced_at IS
  'When the four bgg_* stats columns were last written. The backfill selects rows WHERE this IS NULL; stamped even when BGG returns no stats so the row leaves the queue.';

CREATE INDEX IF NOT EXISTS idx_bgb_games_year_rank
  ON public.boardgamebuddy_games (year_published DESC, bgg_rank ASC NULLS LAST)
  WHERE is_expansion = false;
CREATE INDEX IF NOT EXISTS idx_bgb_games_stats_synced
  ON public.boardgamebuddy_games (bgg_stats_synced_at ASC NULLS FIRST)
  WHERE bgg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bgb_games_mechanics_gin
  ON public.boardgamebuddy_games USING gin (mechanics)
  WHERE is_expansion = false;

-- ── bgb_discover_recommendations ──────────────────────────────────────────────
-- Score every catalog base game the viewer has no relationship with against a
-- taste profile, and return the top `lim` with a REASON for each.
--
-- THE PROFILE. Every base game with a shelf row or a play is a seed. Its weight
--     w = shelf prior (owned 1.0 / wishlist 0.6 / prev_owned 0.25)
--       + LN(1 + plays) + 1.5 * LN(1 + plays in the last 90 days)
--   Logs, so a 200-play BGG import cannot drown the rest of the shelf; recent
--   plays weigh most because taste drifts. A wishlist row is a seed (the user
--   chose it) but also an exclusion (recommending what someone already wants
--   is not a discovery). prev_owned is a weak seed — they bought it once — and
--   excluded too, since they let it go.
--   Seed weights roll up per mechanic and per category; the viewer's typical
--   table (median seats, median minutes over their plays) is measured too.
--
-- THE SCORE, 0..1 each, relative to the best candidate on that axis:
--     .45 mechanics overlap  .20 categories overlap  .15 seat fit
--     .10 playtime fit       .10 BGG quality prior (NULL = neutral)
--   Overlap is the summed seed weight of the shared tags, divided by
--   sqrt(tag count) so a kitchen-sink game does not win on volume alone, then
--   scaled by the best candidate's score so the weights above mean something.
--
-- THE REASON. The seed game sharing the most mechanics explains the pick when
--   it shares two or more ("Because you play X"); otherwise the shared
--   mechanics, then categories, then table fit, then rating. At most THREE
--   picks per explaining seed, so one habit does not fill the whole rail.
--
-- COLD START. A viewer with no seeds gets zero rows; discovery_service falls
--   back to the best-ranked catalog games and labels them as such.
--
-- SCALE. `candidates` scans the base-game catalog once with two correlated
--   subqueries per row — fine at ~1000 rows. Past ~10k, pre-filter it on
--   `g.mechanics && (SELECT array_agg(mechanic) FROM mech_w)` so the GIN index
--   above carries the scan.
CREATE OR REPLACE FUNCTION public.bgb_discover_recommendations(uid uuid, lim integer DEFAULT 12)
 RETURNS TABLE(
   game_id            uuid,
   score              numeric,
   reason_kind        text,
   reason_game_id     uuid,
   reason_game_name   text,
   shared_mechanics   text[],
   shared_categories  text[]
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH
-- Own plays and plays the viewer was seated in, once each — the same UNION
-- bgb_user_stats uses, so "played" means the same thing here as on Stats.
my_plays AS (
  SELECT p.id, p.game_id, p.played_at
    FROM public.boardgamebuddy_plays p
   WHERE p.user_id = uid
  UNION
  SELECT p.id, p.game_id, p.played_at
    FROM public.boardgamebuddy_plays p
    JOIN public.boardgamebuddy_play_players pp ON pp.play_id = p.id
   WHERE pp.player_user_id = uid
),
play_counts AS (
  SELECT mp.game_id,
         COUNT(*)::INT AS plays,
         COUNT(*) FILTER (WHERE mp.played_at >= CURRENT_DATE - 90)::INT AS recent_plays
    FROM my_plays mp
   GROUP BY mp.game_id
),
-- Expansions are not seeds: their tags duplicate the base game's and would
-- count it twice.
seed_games AS (
  SELECT g.id AS game_id, g.name, g.mechanics, g.categories,
         ( CASE c.status WHEN 'owned' THEN 1.0 WHEN 'wishlist' THEN 0.6 WHEN 'prev_owned' THEN 0.25 ELSE 0 END
           + LN(1 + COALESCE(pc.plays, 0))
           + 1.5 * LN(1 + COALESCE(pc.recent_plays, 0)) )::NUMERIC AS w
    FROM public.boardgamebuddy_games g
    LEFT JOIN play_counts pc ON pc.game_id = g.id
    LEFT JOIN public.boardgamebuddy_collections c ON c.game_id = g.id AND c.user_id = uid
   WHERE (pc.game_id IS NOT NULL OR c.id IS NOT NULL)
     AND NOT g.is_expansion
),
mech_w AS (
  SELECT m AS mechanic, SUM(s.w) AS w
    FROM seed_games s CROSS JOIN LATERAL unnest(COALESCE(s.mechanics, '{}')) AS m
   WHERE m <> ''
   GROUP BY m
),
cat_w AS (
  SELECT c AS category, SUM(s.w) AS w
    FROM seed_games s CROSS JOIN LATERAL unnest(COALESCE(s.categories, '{}')) AS c
   WHERE c <> ''
   GROUP BY c
),
totals AS (
  SELECT (SELECT COUNT(*) FROM seed_games) AS seed_count
),
-- The viewer's typical table. Seats counted off the roster, minutes off the
-- game's listed playing time.
table_profile AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY seats.n)        AS median_seats,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY g.playing_time) AS median_minutes
    FROM my_plays mp
    JOIN public.boardgamebuddy_games g ON g.id = mp.game_id
    JOIN LATERAL (
      SELECT COUNT(*)::INT AS n
        FROM public.boardgamebuddy_play_players pp
       WHERE pp.play_id = mp.id
    ) seats ON true
),
-- Anything on the shelf in any status, or ever played, is not a discovery.
excluded AS (
  SELECT mp.game_id FROM my_plays mp
  UNION
  SELECT c.game_id FROM public.boardgamebuddy_collections c WHERE c.user_id = uid
),
candidates AS (
  SELECT g.id, g.name, g.mechanics, g.categories, g.min_players, g.max_players,
         g.playing_time, g.bgg_rating,
         COALESCE((SELECT SUM(mw.w) FROM unnest(COALESCE(g.mechanics, '{}')) m JOIN mech_w mw ON mw.mechanic = m), 0)
           / sqrt(GREATEST(1, cardinality(COALESCE(g.mechanics, '{}'))))  AS mech_score,
         COALESCE((SELECT SUM(cw.w) FROM unnest(COALESCE(g.categories, '{}')) c JOIN cat_w cw ON cw.category = c), 0)
           / sqrt(GREATEST(1, cardinality(COALESCE(g.categories, '{}')))) AS cat_score,
         ARRAY(SELECT mw.mechanic FROM unnest(COALESCE(g.mechanics, '{}')) m JOIN mech_w mw ON mw.mechanic = m
                ORDER BY mw.w DESC, mw.mechanic LIMIT 3) AS shared_m,
         ARRAY(SELECT cw.category FROM unnest(COALESCE(g.categories, '{}')) c JOIN cat_w cw ON cw.category = c
                ORDER BY cw.w DESC, cw.category LIMIT 3) AS shared_c
    FROM public.boardgamebuddy_games g
   WHERE NOT g.is_expansion
     AND NOT EXISTS (SELECT 1 FROM excluded e WHERE e.game_id = g.id)
),
scored AS (
  SELECT c.*,
         c.mech_score / NULLIF(MAX(c.mech_score) OVER (), 0) AS mech_norm,
         c.cat_score  / NULLIF(MAX(c.cat_score)  OVER (), 0) AS cat_norm,
         CASE WHEN tp.median_seats IS NOT NULL
               AND c.min_players IS NOT NULL AND c.max_players IS NOT NULL
               AND tp.median_seats BETWEEN c.min_players AND c.max_players THEN 1 ELSE 0 END AS seat_fit,
         COALESCE(
           CASE WHEN tp.median_minutes IS NULL OR c.playing_time IS NULL THEN 0.5
                ELSE 1 - LEAST(1, ABS(c.playing_time - tp.median_minutes) / NULLIF(tp.median_minutes, 0)) END,
           0.5) AS time_fit,
         -- 5.5 is BGG's centre of mass; 9 maps to +1, NULL (unsynced) to 0.
         COALESCE((c.bgg_rating - 5.5) / 3.5, 0) AS quality
    FROM candidates c
    CROSS JOIN table_profile tp
),
weighted AS (
  SELECT s.*,
         ( 0.45 * COALESCE(s.mech_norm, 0)
         + 0.20 * COALESCE(s.cat_norm, 0)
         + 0.15 * s.seat_fit
         + 0.10 * s.time_fit
         + 0.10 * s.quality )::NUMERIC(6,4) AS score
    FROM scored s
),
-- The single seed that explains this candidate best: most shared mechanics,
-- ties broken by the seed's own weight.
explained AS (
  SELECT w.*, bs.game_id AS seed_id, bs.name AS seed_name, bs.shared AS seed_shared
    FROM weighted w
    LEFT JOIN LATERAL (
      SELECT s.game_id, s.name,
             cardinality(ARRAY(SELECT unnest(s.mechanics) INTERSECT SELECT unnest(w.mechanics))) AS shared
        FROM seed_games s
       WHERE s.mechanics && w.mechanics
       ORDER BY 3 DESC, s.w DESC, s.game_id
       LIMIT 1
    ) bs ON true
),
labelled AS (
  SELECT e.id, e.score,
         CASE
           WHEN COALESCE(e.seed_shared, 0) >= 2               THEN 'because_you_play'
           WHEN cardinality(e.shared_m) >= 1                  THEN 'shared_mechanics'
           WHEN cardinality(e.shared_c) >= 1                  THEN 'shared_categories'
           WHEN e.seat_fit = 1 AND e.time_fit >= 0.7          THEN 'fits_your_table'
           ELSE 'highly_rated'
         END AS reason_kind,
         CASE WHEN COALESCE(e.seed_shared, 0) >= 2 THEN e.seed_id   END AS reason_game_id,
         CASE WHEN COALESCE(e.seed_shared, 0) >= 2 THEN e.seed_name END AS reason_game_name,
         e.shared_m, e.shared_c,
         ROW_NUMBER() OVER (
           PARTITION BY CASE WHEN COALESCE(e.seed_shared, 0) >= 2 THEN e.seed_id END
           ORDER BY e.score DESC, e.id
         ) AS per_seed_rank
    FROM explained e
   WHERE e.score > 0
)
SELECT l.id, l.score, l.reason_kind, l.reason_game_id, l.reason_game_name, l.shared_m, l.shared_c
  FROM labelled l
 CROSS JOIN totals t
 WHERE t.seed_count > 0
   AND (l.reason_game_id IS NULL OR l.per_seed_rank <= 3)
 ORDER BY l.score DESC, l.id
 LIMIT lim;
$function$;

-- SECURITY DEFINER + published by PostgREST: the anon key must not reach it.
-- Same trio 028 applies to every bgb RPC.
GRANT EXECUTE ON FUNCTION public.bgb_discover_recommendations(uid uuid, lim integer) TO boardgamebuddy_role;
REVOKE EXECUTE ON FUNCTION public.bgb_discover_recommendations(uid uuid, lim integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_discover_recommendations(uid uuid, lim integer) TO service_role;

COMMIT;
