-- ─────────────────────────────────────────────────────────────────────────────
-- chapter_inspiration.sql — the chapters_inspired metric and its badge
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Fixture: Ana writes a chapter. Ben saves his own version of it, and so does
-- Cy. Ana also saves a version of her own chapter, which must not count, and
-- Ben saves a version of Ben's copy, which counts for Ben's chapter only if
-- somebody else wrote it (nobody did). Expected:
--
--   Ana  chapters_inspired = 2, "You're an Inspiration" earned
--   Ben  chapters_inspired = 0, not earned
--
-- Then Ana's chapter is deleted: the copies keep standing with derived_from
-- NULL, and Ana keeps the badge because an unlock row is permanent.
--
-- SAFE TO RUN ANYWHERE: one transaction ending in ROLLBACK, touching only rows
-- it inserted under uuids it invented.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/chapter_inspiration.sql
--
-- Needs boardgamebuddy_guide_chapters.derived_from and the chapter_inspired
-- achievement. Silence plus "ALL CHAPTER-INSPIRATION CHECKS PASSED" is a pass.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
DECLARE
  ana uuid := 'aaaaaaaa-0000-0000-0000-000000000621';
  ben uuid := 'aaaaaaaa-0000-0000-0000-000000000622';
  cy  uuid := 'aaaaaaaa-0000-0000-0000-000000000623';
  g   uuid := 'a0000000-0000-0000-0000-000000000621';
  src uuid := 'c0000000-0000-0000-0000-000000000621';
  bcp uuid := 'c0000000-0000-0000-0000-000000000622';
  r jsonb;
  badge jsonb;
BEGIN
  INSERT INTO boardgamebuddy_profiles (id, username, display_name) VALUES
    (ana, 'inspire_ana_062', 'Ana'),
    (ben, 'inspire_ben_062', 'Ben'),
    (cy,  'inspire_cy_062',  'Cy');
  INSERT INTO boardgamebuddy_games (id, name) VALUES (g, 'Inspiration Game');

  INSERT INTO boardgamebuddy_guide_chapters (id, game_id, chapter_type, title, content, created_by)
  VALUES (src, g, 'setup', 'Ana''s setup', 'Shuffle.', ana);
  INSERT INTO boardgamebuddy_guide_chapters (id, game_id, chapter_type, title, content, created_by, derived_from)
  VALUES (bcp, g, 'setup', 'Ben''s setup', 'Shuffle twice.', ben, src);
  INSERT INTO boardgamebuddy_guide_chapters (game_id, chapter_type, title, content, created_by, derived_from) VALUES
    (g, 'setup', 'Cy''s setup',     'Shuffle, cut.',  cy,  src),
    (g, 'setup', 'Ana''s setup v2', 'Shuffle more.',  ana, src),
    (g, 'setup', 'Ben''s setup v2', 'Shuffle less.',  ben, bcp);

  r := bgb_sync_achievements(ana);
  IF (r->'metrics'->>'chapters_inspired')::int <> 2 THEN
    RAISE EXCEPTION 'ana chapters_inspired: %', r->'metrics'->>'chapters_inspired';
  END IF;
  SELECT a INTO badge FROM jsonb_array_elements(r->'achievements') a WHERE a->>'id' = 'chapter_inspired';
  IF badge IS NULL OR NOT (badge->>'earned')::boolean THEN
    RAISE EXCEPTION 'ana badge not earned: %', badge;
  END IF;

  r := bgb_sync_achievements(ben);
  IF (r->'metrics'->>'chapters_inspired')::int <> 0 THEN
    RAISE EXCEPTION 'ben chapters_inspired: %', r->'metrics'->>'chapters_inspired';
  END IF;
  SELECT a INTO badge FROM jsonb_array_elements(r->'achievements') a WHERE a->>'id' = 'chapter_inspired';
  IF (badge->>'earned')::boolean THEN
    RAISE EXCEPTION 'ben badge earned: %', badge;
  END IF;

  DELETE FROM boardgamebuddy_guide_chapters WHERE id = src;
  IF EXISTS (SELECT 1 FROM boardgamebuddy_guide_chapters WHERE derived_from = src) THEN
    RAISE EXCEPTION 'copies still point at the deleted original';
  END IF;
  IF (SELECT COUNT(*) FROM boardgamebuddy_guide_chapters WHERE game_id = g) <> 4 THEN
    RAISE EXCEPTION 'deleting the original took copies with it';
  END IF;
  r := bgb_sync_achievements(ana);
  SELECT a INTO badge FROM jsonb_array_elements(r->'achievements') a WHERE a->>'id' = 'chapter_inspired';
  IF NOT (badge->>'earned')::boolean THEN
    RAISE EXCEPTION 'ana lost the badge when her chapter was deleted: %', badge;
  END IF;

  RAISE NOTICE 'ALL CHAPTER-INSPIRATION CHECKS PASSED';
END $$;

ROLLBACK;
