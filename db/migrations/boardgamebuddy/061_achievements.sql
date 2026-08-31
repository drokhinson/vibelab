-- 061_achievements.sql — the Achievements spoke.
--
-- Sixteen badges hanging off the Profile hub, in four groups: time at the
-- table, victories, the reference guide, and the setup work that makes the app
-- yours. Everything is DERIVED from data the app already writes — plays,
-- winners, buddy edges, guide chapters, the BGG link — with exactly one
-- exception, the PWA install, which nothing in the database could ever know
-- about. That gets a column on the profile rather than a bespoke table: "when
-- did this person put Buddy on their home screen" is a fact about the account,
-- not about the achievement system, and other features may want it later.
--
-- SHAPE. Three objects:
--   • boardgamebuddy_achievement_groups  — the four section headings.
--   • boardgamebuddy_achievements        — the catalog: name, flavour, the
--     metric that drives it and the threshold it needs. Rows, not a Python
--     dict, per .claude/rules/database-supabase.md ("data belongs in the
--     database"): renaming a badge or retuning a tier is then an UPDATE, not a
--     deploy. `icon` is a sprite SLUG (never an emoji, per
--     .claude/rules/assets.md); the frontend resolves it to
--     web/assets/sprites/achievements/bgb-ach-<icon>.svg.
--   • boardgamebuddy_user_achievements   — one row per (user, achievement) the
--     moment it is first earned. This exists ONLY to pin the unlock DATE:
--     earned-ness itself is recomputed from live data on every read, so a
--     deleted play can never leave a badge stranded... except that the row
--     stays, which is deliberate. Once you have logged your hundredth play you
--     have logged your hundredth play; deleting one afterwards does not undo
--     the evening. The RPC therefore reports `earned` as "row exists OR metric
--     currently clears the bar".
--
-- ONE RPC does both halves: bgb_sync_achievements(uid) computes every metric,
-- inserts the unlock rows that are newly due, and returns the whole screen.
-- It is one function rather than a read plus a write because every caller
-- wants both and the metrics CTE is the expensive part — computing it twice to
-- keep a purist read/write split would double the cost of the only call this
-- feature makes.

BEGIN;

-- ── The one fact nothing else can derive ─────────────────────────────────────
-- Set by POST /achievements/installed, which the web app fires the first time
-- it observes itself running in standalone display-mode (or catches the
-- `appinstalled` event). NULL = never installed, and the badge stays locked.
ALTER TABLE public.boardgamebuddy_profiles
  ADD COLUMN IF NOT EXISTS app_installed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.boardgamebuddy_profiles.app_installed_at IS
  'First time this account was seen running as an installed PWA (migration 061). Drives the "Pocket Buddy" achievement; nothing else reads it.';

-- ── Groups ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_achievement_groups (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  blurb         TEXT NOT NULL,
  display_order INT  NOT NULL
);
ALTER TABLE public.boardgamebuddy_achievement_groups ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_achievement_groups TO boardgamebuddy_role;

-- ── Catalog ──────────────────────────────────────────────────────────────────
-- `metric` names a key of the JSONB blob bgb_sync_achievements builds; adding
-- a badge for an existing metric is a pure INSERT here, with no code change on
-- either side. A badge for a NEW metric needs a line in the RPC too — the CHECK
-- keeps that honest by refusing a metric the RPC does not compute.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_achievements (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES public.boardgamebuddy_achievement_groups(id),
  name          TEXT NOT NULL,
  -- One line of flavour, shown under the name on the badge card.
  tagline       TEXT NOT NULL,
  -- What you actually have to do, in plain language. Shown on locked badges.
  requirement   TEXT NOT NULL,
  metric        TEXT NOT NULL CHECK (metric IN (
                  'plays_logged', 'wins', 'biggest_table', 'two_player_games',
                  'buddies', 'guide_chapters', 'chapters_borrowed',
                  'plays_with_notes', 'bgg_linked', 'app_installed')),
  threshold     INT  NOT NULL CHECK (threshold > 0),
  -- Sprite slug → web/assets/sprites/achievements/bgb-ach-<icon>.svg
  icon          TEXT NOT NULL,
  display_order INT  NOT NULL
);
ALTER TABLE public.boardgamebuddy_achievements ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_achievements TO boardgamebuddy_role;

CREATE INDEX IF NOT EXISTS idx_bgb_achievements_order
  ON public.boardgamebuddy_achievements (display_order);

-- ── Unlocks ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_user_achievements (
  user_id        UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL REFERENCES public.boardgamebuddy_achievements(id) ON DELETE CASCADE,
  unlocked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, achievement_id)
);
ALTER TABLE public.boardgamebuddy_user_achievements ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_user_achievements TO boardgamebuddy_role;

-- ── Seed: groups ─────────────────────────────────────────────────────────────
INSERT INTO public.boardgamebuddy_achievement_groups (id, label, blurb, display_order)
VALUES
  ('table',     'At the table',        'Plays logged, and the size of the crowd around them.', 10),
  ('victories', 'Victories',           'What the scorepad says when the dust settles.',        20),
  ('guide',     'The reference guide', 'Chapters you keep, and chapters you write.',           30),
  ('setup',     'Making it yours',     'The small acts that turn the app into your app.',      40)
ON CONFLICT (id) DO UPDATE
  SET label = EXCLUDED.label,
      blurb = EXCLUDED.blurb,
      display_order = EXCLUDED.display_order;

-- ── Seed: catalog ────────────────────────────────────────────────────────────
INSERT INTO public.boardgamebuddy_achievements
  (id, group_id, name, tagline, requirement, metric, threshold, icon, display_order)
VALUES
  ('plays_10',          'table',     'Table Regular',
   'You have found your seat.',
   'Log 10 plays',                                   'plays_logged',      10, 'table-regular',     10),
  ('plays_100',         'table',     'Century Club',
   'A hundred nights around the board.',
   'Log 100 plays',                                  'plays_logged',     100, 'century-club',      20),
  ('plays_300',         'table',     'Table Titan',
   'Three hundred plays deep, and still dealing.',
   'Log 300 plays',                                  'plays_logged',     300, 'table-titan',       30),
  ('duelist',           'table',     'Duelist',
   'Two chairs, one board, nowhere to hide.',
   'Play a game built for two players only',         'two_player_games',   1, 'duelist',           40),
  ('full_table',        'table',     'Full Table',
   'Everyone came. Someone had to fetch a chair.',
   'Log a play with 5 or more players',              'biggest_table',      5, 'full-table',        50),

  ('wins_10',           'victories', 'Crowned',
   'Ten wins says it was not luck.',
   'Win 10 plays',                                   'wins',              10, 'crowned',           60),
  ('wins_100',          'victories', 'King of the Hill',
   'A hundred wins, and the high ground.',
   'Win 100 plays',                                  'wins',             100, 'king-of-the-hill',  70),
  ('wins_300',          'victories', 'Dynasty',
   'Three hundred wins. The table calls it a reign.',
   'Win 300 plays',                                  'wins',             300, 'dynasty',           80),

  ('chapters_1',        'guide',     'First Page',
   'Your reference guide has a first chapter.',
   'Add 1 chapter to your reference guide',          'guide_chapters',     1, 'first-page',        90),
  ('chapters_10',       'guide',     'Rules Lawyer',
   'Ten chapters. Nobody bluffs past you now.',
   'Add 10 chapters to your reference guide',        'guide_chapters',    10, 'rules-lawyer',     100),
  ('chapters_50',       'guide',     'Loremaster',
   'Fifty chapters — a shelf of your own making.',
   'Add 50 chapters to your reference guide',        'guide_chapters',    50, 'loremaster',       110),
  ('chapter_borrowed',  'guide',     'Cited Source',
   'Someone else keeps a chapter you wrote.',
   'Have a chapter you wrote added to another player''s guide',
                                                     'chapters_borrowed',  1, 'cited-source',     120),

  ('buddy_1',           'setup',     'Buddy System',
   'Games are better with someone across the table.',
   'Add your first buddy',                           'buddies',            1, 'buddy-system',     130),
  ('play_notes_1',      'setup',     'Table Chronicler',
   'The score fades. The story does not.',
   'Add a description to a game you logged',         'plays_with_notes',   1, 'table-chronicler', 140),
  ('bgg_linked',        'setup',     'Geek Certified',
   'Your shelf, straight from BoardGameGeek.',
   'Link your BoardGameGeek account',                'bgg_linked',         1, 'geek-certified',   150),
  ('app_installed',     'setup',     'Pocket Buddy',
   'Buddy lives on your home screen now.',
   'Install the web app on your phone',              'app_installed',      1, 'pocket-buddy',     160)
ON CONFLICT (id) DO UPDATE
  SET group_id      = EXCLUDED.group_id,
      name          = EXCLUDED.name,
      tagline       = EXCLUDED.tagline,
      requirement   = EXCLUDED.requirement,
      metric        = EXCLUDED.metric,
      threshold     = EXCLUDED.threshold,
      icon          = EXCLUDED.icon,
      display_order = EXCLUDED.display_order;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- bgb_sync_achievements(uid) — compute, unlock, and return the whole screen.
--
-- VISIBILITY RULE for plays. Same one migration 045 settled on and 058 reuses:
-- a play counts for a user when they LOGGED it or when they appear on it as a
-- participant. `wins` is necessarily narrower — a win needs a player row — so
-- it counts only plays the user actually sat in.
--
-- VOLATILE because it inserts. PostgREST issues every .rpc() as a POST, so the
-- FastAPI layer calls it exactly like any read.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION public.bgb_sync_achievements(uid UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  m       JSONB;
  payload JSONB;
BEGIN
  -- ── 1. Every metric, in one pass ──────────────────────────────────────────
  WITH my_plays AS (
    SELECT p.id, p.game_id
    FROM public.boardgamebuddy_plays p
    WHERE p.user_id = uid
    UNION
    SELECT p.id, p.game_id
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
$fn$;

GRANT EXECUTE ON FUNCTION public.bgb_sync_achievements(UUID) TO boardgamebuddy_role;

COMMIT;
