-- ─────────────────────────────────────────────────────────────────────────────
-- 052_rulebook_links.sql — the half of migration 052 that lives in the database
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY THIS FILE EXISTS. `api/tests/test_rulebook_links.py` drives the API
-- against a fake PostgREST, so it can pin who may SEE a link and what the write
-- paths store — and nothing else. The three things 052 puts in Postgres itself
-- have no test there and cannot have one:
--
--   * `bgb_chapters_link_shape`, whose whole job is to be the backstop for a
--     caller that forgot to validate. A CHECK is only worth what it REJECTS,
--     and the most important rejection is the one that looks like it happens
--     for free: **a CHECK whose expression evaluates to NULL passes.** The
--     first draft of this constraint tested `link_url ~* '^https?://…'` with no
--     IS NOT NULL beside it, which admits a rulebook link with no URL at all —
--     the row every read path would then have to guess about.
--   * `idx_bgb_chapters_rulebook_author`, which is what makes a denial stick.
--     A denied row keeps its author's one slot, so re-posting the same link
--     under a new row collides instead of quietly re-entering every buddy's
--     guide. Nothing in the Python suite can see a unique index.
--   * the BACKFILL, which runs exactly once against real data and decides
--     whether every currently-curated game keeps its rulebook on the day this
--     ships. It is run here for real — see the two `\i` lines below — rather
--     than copied into this file, because a copy is a test of the copy.
--
-- SAFE TO RUN ANYWHERE, including production: the whole thing is one
-- transaction that ends in ROLLBACK, and every row it touches is one it
-- inserted under a uuid it invented. It still writes WAL, so prefer a scratch
-- database. Same posture, and the same shape, as
-- db/tests/051_account_deletion_handover.sql.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/052_rulebook_links.sql
--
-- Every check is an ASSERT inside one DO block, so the first failure raises
-- with the name of the property that broke and nothing further runs. Silence
-- plus "ALL 052 CHECKS PASSED" is a pass.
--
-- Standing up a throwaway database to run it against needs the same four
-- Supabase-isms 051's test lists (the three roles, `auth.users`, the
-- `extensions` schema with pg_trgm, and an `auth.uid()` stub), then
-- db/schema/boardgamebuddy.sql, then db/migrations/052_rulebook_links.sql.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── The seed the backfill is aimed at ────────────────────────────────────────
-- Inserted BEFORE the migration is replayed below, which is the whole trick:
-- these three games are what the backfill finds when it runs, so the `\i` lines
-- exercise the real statement rather than a paraphrase of it.
--
-- The uuids are fixed rather than generated so the DO block below can name them
-- without a temp table; they are v4-shaped literals no real row will hold.
INSERT INTO public.boardgamebuddy_games (id, name, rulebook_url) VALUES
  ('052a0000-0000-4000-8000-000000000001', 'Everdell Test',
   'https://example.test/everdell-rules.pdf'),
  -- A legacy value that fails the scheme test. The backfill must SKIP it: one
  -- malformed row aborting the statement would take every good row with it.
  ('052a0000-0000-4000-8000-000000000002', 'Malformed Test',
   'www.example.test/rules.pdf'),
  -- No rulebook at all — the backfill must not invent a chapter for it.
  ('052a0000-0000-4000-8000-000000000003', 'No Rulebook Test', NULL);

-- The real migration, run twice. The first pass is what backfills the games
-- above; the second is the idempotency claim in 052's own header, and the
-- "exactly one chapter" assertions below are what prove it. Both passes are
-- inside this transaction, so both roll back.
\i db/migrations/052_rulebook_links.sql
\i db/migrations/052_rulebook_links.sql

DO $test$
DECLARE
  g_ok      CONSTANT uuid := '052a0000-0000-4000-8000-000000000001';
  g_bad     CONSTANT uuid := '052a0000-0000-4000-8000-000000000002';
  g_none    CONSTANT uuid := '052a0000-0000-4000-8000-000000000003';
  author    CONSTANT uuid := gen_random_uuid();
  other     CONSTANT uuid := gen_random_uuid();
  n         int;
  txt       text;
  ch        record;
BEGIN
  INSERT INTO public.boardgamebuddy_profiles (id, display_name, username) VALUES
    (author, 'Ana',  'ana_'  || left(author::text, 8)),
    (other,  'Bram', 'bram_' || left(other::text, 8));

  -- The two chapter types the prose and grid cases below are filed under.
  -- ON CONFLICT DO NOTHING because a real database already has them (002_seed
  -- and 021) and a scratch one stood up from db/schema/ has NO seed rows at all
  -- — the snapshot carries shape, not data. Without this the test fails on an
  -- FK to the lookup table rather than on anything 052 did. ('rulebook' is not
  -- here: seeding it is 052's own job, and check 1 is what asserts it.)
  INSERT INTO public.boardgamebuddy_chapter_types (id, label, icon, display_order) VALUES
    ('setup', 'Setup', 'box', 10),
    ('scoring_grid', 'Scoring Grid Template', 'table', 5)
  ON CONFLICT (id) DO NOTHING;

  -- ── 1. the type the layout is pinned to ────────────────────────────────────
  SELECT count(*) INTO n FROM public.boardgamebuddy_chapter_types
   WHERE id = 'rulebook' AND display_order = 6;
  ASSERT n = 1, 'the rulebook chapter type must be seeded at display_order 6';

  -- ── 2. the backfill took the curated link ──────────────────────────────────
  SELECT * INTO ch FROM public.boardgamebuddy_guide_chapters
   WHERE game_id = g_ok AND layout = 'rulebook_link';
  ASSERT ch.id IS NOT NULL, 'a game with a rulebook_url must get a chapter';
  ASSERT ch.moderation_status = 'approved',
    'a backfilled link was admin-curated already, so it lands approved, got '
    || COALESCE(ch.moderation_status, 'NULL');
  ASSERT ch.created_by IS NULL,
    'nobody authored a backfilled link as a chapter, so created_by stays NULL';
  ASSERT ch.moderated_by IS NULL,
    'naming an admin who never looked at it would be a lie the audit trail '
    'cannot tell from a real decision';
  ASSERT ch.chapter_type = 'rulebook', 'the backfill must file it under its own type';
  ASSERT ch.title = 'Everdell Test rulebook',
    'the title is derived from the game, got ' || COALESCE(ch.title, 'NULL');
  ASSERT ch.content = '[Rulebook](https://example.test/everdell-rules.pdf)',
    'content is the generated markdown mirror, got ' || COALESCE(ch.content, 'NULL');
  ASSERT ch.grid IS NULL, 'a rulebook link carries no grid';

  -- ── 3. …exactly once, however many times 052 is replayed ───────────────────
  SELECT count(*) INTO n FROM public.boardgamebuddy_guide_chapters
   WHERE game_id = g_ok AND layout = 'rulebook_link';
  ASSERT n = 1,
    'the migration ran twice above; a second pass must add nothing, got ' || n;

  -- ── 4. a malformed legacy URL is skipped, not fatal ────────────────────────
  SELECT count(*) INTO n FROM public.boardgamebuddy_guide_chapters
   WHERE game_id IN (g_bad, g_none);
  ASSERT n = 0,
    'the backfill must skip a URL that fails the scheme test and a game with '
    'none at all, got ' || n;

  -- ── 5. the CHECK rejects a link with no URL ────────────────────────────────
  -- THE regression this file exists for: `link_url ~* '…'` alone evaluates to
  -- NULL here, and a NULL CHECK passes.
  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES (g_ok, 'rulebook', 'No URL', 'x', 'rulebook_link', NULL, 'pending', author);
    ASSERT false, 'a rulebook_link row with NULL link_url must be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── 6. …and one with no gate ───────────────────────────────────────────────
  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES (g_ok, 'rulebook', 'No gate', 'x', 'rulebook_link',
            'https://example.test/a.pdf', NULL, author);
    ASSERT false, 'a rulebook_link row with NULL moderation_status must be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── 7. …and a scheme that is not http(s) ───────────────────────────────────
  -- The reason the scheme test is duplicated in the database at all: the API's
  -- check is one code path, and this is every code path.
  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES (g_ok, 'rulebook', 'Script', 'x', 'rulebook_link',
            'javascript:alert(1)', 'pending', author);
    ASSERT false, 'a javascript: URL must never reach this column';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── 8. …and a status outside the three ─────────────────────────────────────
  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES (g_ok, 'rulebook', 'Bogus', 'x', 'rulebook_link',
            'https://example.test/a.pdf', 'maybe', author);
    ASSERT false, 'moderation_status is a closed set of three';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── 9. a link on a chapter that is not one ─────────────────────────────────
  -- The mirror of 5-8, and the half that matters most: a URL smuggled onto a
  -- text chapter would carry NO moderation status, because the gate hangs off
  -- the layout — so nothing would ever review it.
  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES (g_ok, 'setup', 'Setup', 'body', 'text',
            'https://example.test/a.pdf', NULL, author);
    ASSERT false, 'link_url belongs to one layout only';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, moderation_status, created_by)
    VALUES (g_ok, 'setup', 'Setup', 'body', 'text', 'approved', author);
    ASSERT false, 'a text chapter has nothing to gate and must carry no status';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── 10. an ordinary prose chapter still inserts ────────────────────────────
  -- 052 rewrote bgb_chapters_grid_shape to learn a third layout. If that went
  -- wrong the damage would not be to rulebook links at all — it would be to
  -- every chapter written since 018.
  INSERT INTO public.boardgamebuddy_guide_chapters
    (game_id, chapter_type, title, content, layout, created_by)
  VALUES (g_ok, 'setup', 'Setup', 'Deal seven cards.', 'text', author);

  INSERT INTO public.boardgamebuddy_guide_chapters
    (game_id, chapter_type, title, content, layout, grid, created_by)
  VALUES (g_ok, 'scoring_grid', 'Everdell Test score sheet', '- Cards',
          'scoring_grid', '{"v":1,"rows":[{"label":"Cards"}]}'::jsonb, author);

  -- ── 11. one link per (game, author) ────────────────────────────────────────
  INSERT INTO public.boardgamebuddy_guide_chapters
    (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
  VALUES (g_ok, 'rulebook', 'Everdell Test rulebook',
          '[Rulebook](https://example.test/mine.pdf)', 'rulebook_link',
          'https://example.test/mine.pdf', 'pending', author);

  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES (g_ok, 'rulebook', 'Everdell Test rulebook',
            '[Rulebook](https://example.test/second.pdf)', 'rulebook_link',
            'https://example.test/second.pdf', 'pending', author);
    ASSERT false, 'one rulebook link per game per author';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- A DENIED row still holds the slot. This is what makes a denial stick:
  -- without it, "post it again" is the way around a moderator.
  UPDATE public.boardgamebuddy_guide_chapters
     SET moderation_status = 'denied'
   WHERE game_id = g_ok AND layout = 'rulebook_link' AND created_by = author;

  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES (g_ok, 'rulebook', 'Everdell Test rulebook',
            '[Rulebook](https://example.test/again.pdf)', 'rulebook_link',
            'https://example.test/again.pdf', 'pending', author);
    ASSERT false, 'a denied link keeps its author''s slot';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- ── 12. …but the index is per author, and NULL authors do not collide ──────
  -- Somebody else's link for the same game is a different row (the pool holds
  -- several; each reader adopts one), and the curated rows the backfill writes
  -- carry created_by NULL — which must not lock the game against the next
  -- person who writes one.
  INSERT INTO public.boardgamebuddy_guide_chapters
    (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
  VALUES (g_ok, 'rulebook', 'Everdell Test rulebook',
          '[Rulebook](https://example.test/theirs.pdf)', 'rulebook_link',
          'https://example.test/theirs.pdf', 'pending', other);

  INSERT INTO public.boardgamebuddy_guide_chapters
    (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
  VALUES (g_ok, 'rulebook', 'Everdell Test rulebook',
          '[Rulebook](https://example.test/curated-2.pdf)', 'rulebook_link',
          'https://example.test/curated-2.pdf', 'approved', NULL);

  SELECT count(*) INTO n FROM public.boardgamebuddy_guide_chapters
   WHERE game_id = g_ok AND layout = 'rulebook_link';
  ASSERT n = 4,
    'expected the backfilled link plus three authored ones, got ' || n;

  -- ── 13. the legacy column is untouched ─────────────────────────────────────
  -- 052 reads boardgamebuddy_games.rulebook_url and never writes it. If a later
  -- change starts clearing it, the backfill loses the source it would need to
  -- be re-run from.
  SELECT rulebook_url INTO txt FROM public.boardgamebuddy_games WHERE id = g_ok;
  ASSERT txt = 'https://example.test/everdell-rules.pdf',
    'the migration must not rewrite the column it reads from, got '
    || COALESCE(txt, 'NULL');

  RAISE NOTICE 'ALL 052 CHECKS PASSED';
END
$test$;

ROLLBACK;
