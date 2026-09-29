-- ─────────────────────────────────────────────────────────────────────────────
-- 063_chapter_inspiration.sql — "You're an Inspiration": another player built
--                               their own version of your chapter
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Edit on a chapter somebody else wrote opens it in the editor and saves the
-- result as the editor's own new chapter. This records where that copy came
-- from and awards the original author a badge for it.
--
-- 1. boardgamebuddy_guide_chapters.derived_from. The chapter a copy was built
--    from, written by POST /games/{id}/chapters when the client sends it. NULL
--    for a chapter written from scratch. ON DELETE SET NULL: deleting the
--    original leaves the copy standing on its own.
--
-- 2. The `chapters_inspired` metric, added to bgb_achievements_metric_chk and
--    computed by bgb_sync_achievements: chapters OTHER people derived from one
--    of yours.
--
-- 3. The achievement row, chapter_inspired, in the guide group beside Cited
--    Source. Art: web/assets/sprites/achievements/bgb-ach-inspiration.svg.
--
-- Deploy order: run this before the API — the create route writes the new
-- column whenever a copy is saved.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Where a copied chapter came from ──────────────────────────────────────

ALTER TABLE public.boardgamebuddy_guide_chapters
  ADD COLUMN IF NOT EXISTS derived_from UUID;

ALTER TABLE public.boardgamebuddy_guide_chapters
  DROP CONSTRAINT IF EXISTS bgb_chapters_derived_from_fkey;
ALTER TABLE public.boardgamebuddy_guide_chapters
  ADD CONSTRAINT bgb_chapters_derived_from_fkey FOREIGN KEY (derived_from)
    REFERENCES public.boardgamebuddy_guide_chapters(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bgb_chapters_derived_from
  ON public.boardgamebuddy_guide_chapters (derived_from)
  WHERE derived_from IS NOT NULL;

COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.derived_from IS
  'The chapter this one was saved as a copy of (Edit on someone else''s chapter). NULL when written from scratch.';

-- ── 2. The metric ────────────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_achievements
  DROP CONSTRAINT IF EXISTS bgb_achievements_metric_chk;
ALTER TABLE public.boardgamebuddy_achievements
  ADD CONSTRAINT bgb_achievements_metric_chk CHECK (metric = ANY (ARRAY[
    'plays_logged', 'wins', 'biggest_table', 'two_player_games', 'buddies',
    'guide_chapters', 'chapters_borrowed', 'plays_with_notes', 'bgg_linked',
    'app_installed', 'countries', 'continents', 'plays_with_grid',
    'grid_adopters', 'team_wins', 'coop_wins', 'chapters_inspired'
  ]));

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
    ), 0),
    -- Chapters OTHER people wrote as their own version of one of this user's
    -- chapters (Edit on someone else's chapter saves a copy, stamping
    -- derived_from). Distinct on the new chapter, and the copier's own
    -- versions of their own chapters do not count.
    'chapters_inspired', (
      SELECT COUNT(DISTINCT child.id)
      FROM public.boardgamebuddy_guide_chapters child
      JOIN public.boardgamebuddy_guide_chapters parent ON parent.id = child.derived_from
      WHERE parent.created_by = uid
        AND child.created_by IS NOT NULL
        AND child.created_by <> uid
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
REVOKE EXECUTE ON FUNCTION public.bgb_sync_achievements(uid uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_sync_achievements(uid uuid) TO boardgamebuddy_role;

-- ── 3. The achievement ───────────────────────────────────────────────────────

INSERT INTO public.boardgamebuddy_achievements
  (id, group_id, name, tagline, requirement, metric, threshold, icon, display_order)
VALUES
  ('chapter_inspired', 'guide', 'You''re an Inspiration',
   'Another player built their own version of your chapter.',
   'Have another player build their own version of one of your chapters',
   'chapters_inspired', 1, 'inspiration', 121)
ON CONFLICT (id) DO NOTHING;

COMMIT;
