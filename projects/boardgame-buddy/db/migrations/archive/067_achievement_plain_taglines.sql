-- 067_achievement_plain_taglines.sql — say what the badge is for.
--
-- Migration 062 gave every badge a one-line `tagline` of pure flavour
-- ("Two chairs, one board, nowhere to hide.") and put the plain-language
-- statement in `requirement`, which the UI prints ONLY on locked badges. The
-- result: once you earn a badge, the app stops telling you what you did. The
-- unlock popup has the same problem — it celebrates with a riddle.
--
-- This migration rewrites `tagline` into a plain statement of what earned the
-- badge ("Played a game made specifically for 2 players."), so the detail
-- sheet and the unlock popup both explain themselves. `requirement` keeps its
-- imperative voice ("Play a game made specifically for 2 players") because it
-- is a to-do shown while the badge is still locked; the two are now the same
-- fact in the two tenses the two states need, which is why several
-- requirements are reworded here too rather than left to drift from the
-- description beside them.
--
-- CAVEAT on the guide tier. "Authored N reference guide chapters" is the
-- wording asked for, but `guide_chapters` counts rows in
-- boardgamebuddy_user_chapters — chapters KEPT in your guide, including ones
-- copied from another player's (that is precisely what the chapters_borrowed
-- metric leans on). A player who mostly saves other people's chapters earns
-- these three on someone else's writing. Fixing it is either a wording change
-- back to "Added"/"Kept", or a metric that joins guide_chapters on
-- created_by = uid; both are a follow-up, not this migration.
--
-- Data only — no shape change, so db/schema/boardgamebuddy.sql is untouched.

BEGIN;

UPDATE public.boardgamebuddy_achievements AS a
SET tagline     = v.tagline,
    requirement = v.requirement
FROM (VALUES
  -- At the table
  ('plays_10',
   'You''ve logged 10 plays.',
   'Log 10 plays'),
  ('plays_100',
   'You''ve logged 100 plays.',
   'Log 100 plays'),
  ('plays_300',
   'You''ve logged 300 plays.',
   'Log 300 plays'),
  ('duelist',
   'Played a game made specifically for 2 players.',
   'Play a game made specifically for 2 players'),
  ('full_table',
   'Logged a play with 5 or more players at the table.',
   'Log a play with 5 or more players'),

  -- Victories
  ('wins_10',
   'Logged 10 game wins.',
   'Log 10 game wins'),
  ('wins_100',
   'Logged 100 game wins.',
   'Log 100 game wins'),
  ('wins_300',
   'Logged 300 game wins.',
   'Log 300 game wins'),

  -- The reference guide
  ('chapters_1',
   'Authored 1 reference guide chapter.',
   'Author 1 reference guide chapter'),
  ('chapters_10',
   'Authored 10 reference guide chapters.',
   'Author 10 reference guide chapters'),
  ('chapters_50',
   'Authored 50 reference guide chapters.',
   'Author 50 reference guide chapters'),
  ('chapter_borrowed',
   'Another player cited your chapter in their reference guide.',
   'Have another player cite your chapter in their reference guide'),

  -- Making it yours
  ('buddy_1',
   'Added your first buddy.',
   'Add your first buddy'),
  ('play_notes_1',
   'Added a description to a play you logged.',
   'Add a description to a play you logged'),
  ('bgg_linked',
   'Linked your BoardGameGeek account.',
   'Link your BoardGameGeek account'),
  ('app_installed',
   'Installed the web app on your phone.',
   'Install the web app on your phone')
) AS v(id, tagline, requirement)
WHERE a.id = v.id;

COMMIT;
