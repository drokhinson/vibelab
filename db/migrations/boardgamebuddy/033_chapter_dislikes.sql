-- 033_chapter_dislikes.sql — "stop recommending this chapter to me".
--
-- Chapters are community-authored and moderation is reactive: there is a Report
-- button and an admin queue, and nothing at all between "this is fine" and
-- "this breaks the rules". A chapter that is merely BAD — a sloppy scoring
-- grid, a rules summary the reader disagrees with — therefore comes back
-- forever. It sits in the pool every time the reference guide builder opens, it
-- inflates the "N of M" denominator on the guide's Edit-chapters button so the
-- guide can never read as complete, and if it is a scoring grid the play screen
-- offers it at the table on every play started with no template adopted.
--
-- A DISLIKE is the missing middle. It is PER VIEWER and one-directional: it
-- says nothing about the chapter, is never shown to its author, changes no
-- popularity count anybody else sees, and removes nothing from the pool for
-- anyone but the person who tapped it. It only takes the chapter out of the
-- lists this app volunteers — the same contract, and for the same reasons, as
-- boardgamebuddy_buddy_suggestion_dismissals (migration 014).
--
-- WHY A COLUMN AND NOT A SECOND TABLE. 014's shape — its own table, keyed on
-- the pair — is the obvious move and is the wrong one here, because the thing
-- being negated already has a table. boardgamebuddy_user_chapters IS the
-- viewer's opinion of a chapter; a dislike is that same opinion with the sign
-- flipped, and the existing UNIQUE (user_id, chapter_id) then IS the rule that
-- you cannot keep and dislike the same chapter. A separate table would have to
-- enforce that across two tables with nothing but application code, and
-- disliking a chapter already in the guide would become a delete plus an insert
-- rather than one UPDATE.
--
-- A NOTE FOR WHOEVER READS archive/018_chapters_rename.sql NEXT. That migration
-- dropped an `is_hidden` column from this very table, on the grounds that row
-- presence means "in my guide" and absence means "not". That invariant is NOT
-- being reversed here: `state = 'kept'` is now what presence means, and every
-- read of this table has been changed to say so out loud. What 018 removed was
-- a second axis on a row that was already in the guide — a kept chapter you
-- could also hide — and nothing here brings that back: a row is kept or it is
-- disliked, never both and never neither.

ALTER TABLE public.boardgamebuddy_user_chapters
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'kept';

-- Every row that existed before this migration was, by definition, a chapter
-- somebody had added — so the DEFAULT is the backfill and there is no UPDATE
-- to write.
ALTER TABLE public.boardgamebuddy_user_chapters
  DROP CONSTRAINT IF EXISTS bgb_user_chapters_state_chk;
ALTER TABLE public.boardgamebuddy_user_chapters
  ADD CONSTRAINT bgb_user_chapters_state_chk
  CHECK ((state = ANY (ARRAY['kept'::text, 'disliked'::text])));

COMMENT ON COLUMN public.boardgamebuddy_user_chapters.state IS
  'kept = in this viewer''s guide (what a row meant before migration 033). disliked = the inverse: the viewer has turned it down, so it is filtered out of their chapter pool, their pool count and the scoring-template offer, and appears only in the builder''s Disliked section. Per-viewer and one-directional — never shown to the author, never a report, and it changes no count anyone else sees.';

-- The Disliked section reads "everything this viewer turned down for this
-- game", which idx_bgb_user_chapters_user_game already serves — but that index
-- carries every kept row too, and the disliked set is the small tail of it.
-- Partial, so the section's read touches only the rows it is about.
CREATE INDEX IF NOT EXISTS idx_bgb_user_chapters_disliked
  ON public.boardgamebuddy_user_chapters USING btree (user_id, game_id)
  WHERE (state = 'disliked'::text);

-- No GRANT and no ENABLE ROW LEVEL SECURITY below: this migration adds no
-- table, and boardgamebuddy_user_chapters has carried both since 001_baseline.


-- ── bgb_sync_achievements ─────────────────────────────────────────────────────
-- Re-emitted from 019_scoring_grid_achievements.sql:80 — which is where this
-- function currently lives, NOT 003_rpcs.sql:3893, which 019 superseded. The
-- signature and the return shape do not move, so this is a CREATE OR REPLACE
-- (body only): the existing GRANT survives, as does the REVOKE from
-- 028_revoke_definer_execute.sql. The GRANT is restated anyway, because it is a
-- no-op when it is already there and the one thing a future reader must not
-- have to go and check.
--
-- THREE changes, all the same change: every subquery that counts
-- boardgamebuddy_user_chapters rows now says which rows it means. A disliked
-- chapter must not count toward the reader's own Librarian tier, must not count
-- as somebody borrowing the author's work, and must not inflate a grid author's
-- adopter high-water mark — in each case because a dislike is the opposite of
-- the thing being counted, and a row that used to mean "adopted" no longer
-- does on its own.
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
