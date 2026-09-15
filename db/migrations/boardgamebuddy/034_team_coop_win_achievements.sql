-- 034_team_coop_win_achievements.sql — two Victories badges for the two modes
-- that are not one player against the rest of the table.
--
-- The Victories group has only ever counted wins in the aggregate: Crowned
-- (10), King of the Hill (100), Dynasty (300). Every one of them is the same
-- counter at a bigger number, and none of them notices that a play carries a
-- `play_mode` — so a night where you and a partner took a team game, or where
-- the whole table beat the box, lands on the shelf as exactly the same fact as
-- beating three friends at Catan.
--
--   Dream Team      — you won 20 plays logged as TEAM games.
--   Machine Breaker — you won 20 plays logged as CO-OP: the table beat the box.
--
-- BOTH SIT AT 20, and neither has a first-win tier under it. A badge for the
-- very first team or co-op win would fire on the night somebody first ticks a
-- box on the log screen, which is a fact about the app's UI and not about how
-- the evening went; 20 is a habit. The two modes therefore get one badge each
-- rather than a ladder, which is also why the art on both wears the gold rim
-- the set reserves for the top of a group.
--
-- WHY `wins` IS LEFT ALONE. team_wins and coop_wins are strict subsets of the
-- existing `wins` metric, and that is on purpose: the three tier badges are
-- about how often you come first, whoever or whatever you came first against,
-- and narrowing them now would un-earn badges people are already wearing.
-- (Note this is the OPPOSITE call from bgb_user_stats_detail, which holds co-op
-- out of the head-to-head win rate — a ratio that silently folds in games
-- nobody could lose to a person is a number that misreports itself. A COUNT of
-- wins makes no such claim, so it has nothing to protect.)
--
-- WHY THE MODE IS READ OFF THE PLAY AND NOT THE GAME. Both tables carry
-- play_mode; the game's is derived from BGG mechanics at import time and is the
-- default the log screen offers, while the play's is what the table actually
-- did that evening. A co-op game played in a competitive variant is a
-- competitive play, and the badge should agree with the scorepad.
--
-- WHY THIS IS ALMOST ENTIRELY DATA, again. As 019 set out: a badge is a seed
-- row plus a counter. The unlock, the progress bar, the popup, the grouping and
-- the ordering are generic and catalog-driven, so no application code changes
-- here either — not the route, not the service, not the web client.


-- ── 1. Widen the metric vocabulary ───────────────────────────────────────────
-- Same one-liner shape 019 left behind: the constraint carries a name of our
-- own precisely so widening it is a DROP and an ADD rather than a hunt.

ALTER TABLE public.boardgamebuddy_achievements
  DROP CONSTRAINT IF EXISTS bgb_achievements_metric_chk;

ALTER TABLE public.boardgamebuddy_achievements
  ADD CONSTRAINT bgb_achievements_metric_chk CHECK (metric IN (
    'plays_logged', 'wins', 'biggest_table', 'two_player_games',
    'buddies', 'guide_chapters', 'chapters_borrowed', 'plays_with_notes',
    'bgg_linked', 'app_installed',
    'countries', 'continents',
    'plays_with_grid', 'grid_adopters',
    'team_wins', 'coop_wins'));


-- ── 2. The badges ────────────────────────────────────────────────────────────
-- `tagline` is the plain past-tense statement printed once the badge is earned
-- (and in the unlock polaroid); `requirement` is the same fact in the
-- imperative, printed while it is still locked.
--
-- display_order 82 and 84 sit after Dynasty (80) and before First Page (90), so
-- the catalog's global order keeps both inside the Victories rail, after the
-- three tiers they narrow. The rail itself re-sorts done → in progress → not
-- started at render time; this is the order WITHIN each of those buckets.
--
-- Deliberately NOT added to 002_seed.sql, for the reason 019 gives: that file
-- is the post-collapse baseline and a fresh database runs it BEFORE the CHECK
-- above is widened, so a row there would fail its own constraint. New
-- achievements live in their own migration until the next collapse folds them
-- back.
INSERT INTO public.boardgamebuddy_achievements
  (id, group_id, name, tagline, requirement, metric, threshold, icon, display_order)
VALUES
  ('team_wins_20', 'victories', 'Dream Team',
   'Won 20 games played in teams.',
   'Win 20 games played in teams',
   'team_wins', 20, 'dream-team', 82),
  ('coop_wins_20', 'victories', 'Machine Breaker',
   'Beat the game itself 20 times.',
   'Win 20 co-op games',
   'coop_wins', 20, 'machine-breaker', 84)
ON CONFLICT (id) DO NOTHING;


-- ── 3. The counters ──────────────────────────────────────────────────────────
-- bgb_sync_achievements
--   Re-emitted from 033_chapter_dislikes.sql:81 — which is where this function
--   currently lives, NOT 003_rpcs.sql:3893 (superseded by 019) and not
--   019_scoring_grid_achievements.sql:80 (superseded by 033). CREATE OR REPLACE
--   needs the whole body, so everything else is copied forward unchanged; the
--   signature and the return shape do not move, which means the existing GRANT
--   survives, as does the REVOKE from 028_revoke_definer_execute.sql. The GRANT
--   is restated anyway — it is a no-op when it is already there, and it is the
--   one thing a future reader must not have to go and check.
--
--   TWO changes: my_plays carries p.play_mode (both legs, so the UNION still
--   dedupes on the id), and the metrics object gains team_wins and coop_wins.
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
GRANT EXECUTE ON FUNCTION public.bgb_sync_achievements(uid uuid) TO boardgamebuddy_role;
