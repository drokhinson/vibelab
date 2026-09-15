-- 019_scoring_grid_achievements.sql — two badges for the scoring-grid loop.
--
-- Migration 018 gave the reference guide a whole authoring-and-adoption loop:
-- write a scoring grid, other people find it in the pool and add it, and from
-- then on their play screen opens on your rows. None of that reached the
-- trophy shelf, which already rewards writing chapters (First Page / Rules
-- Lawyer / Loremaster) and having one picked up (Cited Source).
--
--   Ruled Lines    — you recorded a play on a custom scoring grid.
--   Gold Standard  — a grid you wrote is kept by 5 OTHER players.
--
-- WHY GOLD STANDARD IS A MAX AND NOT A SUM. It is the best SINGLE grid you
-- wrote, not your total adoptions. "Gold standard" names one grid everybody
-- uses; a sum would hand the badge to someone who wrote ten grids that one
-- person each took, which is the opposite claim. This is also what makes it a
-- different achievement from Cited Source rather than a louder version of it:
-- that one asks whether ANY chapter of yours was ever kept once.
--
-- WHY THIS IS ALMOST ENTIRELY DATA. bgb_sync_achievements builds one JSONB of
-- counters and then unlocks every catalog row whose `metric` clears its
-- `threshold`, rendering the screen from the catalog. So a badge is a seed row
-- plus a counter — the unlock, the progress bar, the popup, the grouping and
-- the ordering are all generic, and no application code changes at all.
--
-- DEPENDS ON 018: reads boardgamebuddy_plays.scoring_template and
-- boardgamebuddy_guide_chapters.layout, both of which 018 adds.


-- ── 1. Widen the metric vocabulary ───────────────────────────────────────────
-- archive/068 had to hunt this constraint down by predicate because it was
-- declared inline with a server-generated name; it gave the replacement a name
-- of our own precisely so the next widening would be a one-liner. This is that
-- one-liner.

ALTER TABLE public.boardgamebuddy_achievements
  DROP CONSTRAINT IF EXISTS bgb_achievements_metric_chk;

ALTER TABLE public.boardgamebuddy_achievements
  ADD CONSTRAINT bgb_achievements_metric_chk CHECK (metric IN (
    'plays_logged', 'wins', 'biggest_table', 'two_player_games',
    'buddies', 'guide_chapters', 'chapters_borrowed', 'plays_with_notes',
    'bgg_linked', 'app_installed',
    'countries', 'continents',
    'plays_with_grid', 'grid_adopters'));


-- ── 2. The badges ────────────────────────────────────────────────────────────
-- `tagline` is the plain past-tense statement archive/067 established (printed
-- once the badge is earned, and in the unlock popup); `requirement` is the same
-- fact in the imperative, printed while it is still locked.
--
-- display_order 122/124 sits between Cited Source (120) and Buddy System (130),
-- so the catalog's global order keeps these inside the reference-guide rail.
-- Gold Standard goes last because it is the hardest thing in the group.
--
-- These rows are deliberately NOT added to 002_seed.sql. That file is the
-- post-collapse baseline and a fresh database runs it BEFORE this migration
-- widens the CHECK above, so a row there would fail its own constraint. New
-- achievements live in their own migration until the next collapse folds them
-- back — exactly as 062 and 068 did.
INSERT INTO public.boardgamebuddy_achievements
  (id, group_id, name, tagline, requirement, metric, threshold, icon, display_order)
VALUES
  ('grid_play', 'guide', 'Ruled Lines',
   'Recorded a play on a custom scoring grid.',
   'Record a play on a custom scoring grid',
   'plays_with_grid', 1, 'ruled-lines', 122),
  ('grid_gold_standard', 'guide', 'Gold Standard',
   'A scoring grid you wrote is kept by 5 other players.',
   'Have 5 other players keep one of your scoring grids',
   'grid_adopters', 5, 'gold-standard', 124)
ON CONFLICT (id) DO NOTHING;


-- ── 3. The counters ──────────────────────────────────────────────────────────
-- bgb_sync_achievements
--   from 003_rpcs.sql, + 'plays_with_grid' and 'grid_adopters' on the metrics
--   object. CREATE OR REPLACE needs the whole body, so the rest is copied
--   forward unchanged; the signature and the return shape do not move.
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
GRANT EXECUTE ON FUNCTION public.bgb_sync_achievements(uid uuid) TO boardgamebuddy_role;
