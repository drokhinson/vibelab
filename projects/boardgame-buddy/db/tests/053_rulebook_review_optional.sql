-- ─────────────────────────────────────────────────────────────────────────────
-- 053_rulebook_review_optional.sql — the half of migration 053 that lives in
--                                    the database
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY THIS FILE EXISTS. 053 is one statement — bgb_chapters_link_shape, dropped
-- and re-issued so `moderation_status` admits a fourth value — and that shape
-- is exactly what `api/tests/test_rulebook_links.py` cannot see: it drives the
-- API against a fake PostgREST, where every INSERT succeeds.
--
-- A RE-ISSUED CHECK IS THE RISK, not the new value. Postgres has no ALTER
-- CONSTRAINT for a CHECK, so 053 had to write the whole expression out again —
-- and every clause it reproduces is a clause it could have dropped by accident.
-- The IS NOT NULL tests are the ones that would go quietly: **a CHECK whose
-- expression evaluates to NULL PASSES**, so losing one admits a rulebook link
-- with no URL, or one with no gate at all, and nothing anywhere would complain
-- until a reader hit the row. So this file re-runs 052's own backstop
-- assertions against the NEW constraint rather than trusting that a copy
-- stayed a copy.
--
-- SAFE TO RUN ANYWHERE, including production: the whole thing is one
-- transaction that ends in ROLLBACK, and every row it touches is one it
-- inserted under a uuid it invented. It still writes WAL, so prefer a scratch
-- database. Same posture, and the same shape, as
-- db/tests/052_rulebook_links.sql.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/053_rulebook_review_optional.sql
--
-- Every check is an ASSERT inside one DO block, so the first failure raises
-- with the name of the property that broke and nothing further runs. Silence
-- plus "ALL 053 CHECKS PASSED" is a pass.
--
-- Standing up a throwaway database to run it against needs what 052's test
-- lists (the three roles, `auth.users`, the `extensions` schema with pg_trgm,
-- and an `auth.uid()` stub), then db/schema/boardgamebuddy.sql — whose snapshot
-- already carries 053's constraint, which is why the migration is replayed
-- below rather than assumed.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- One game to hang every chapter off. Fixed uuid, v4-shaped, that no real row
-- holds — the same trick 052's test uses so the DO block can name it without a
-- temp table.
INSERT INTO public.boardgamebuddy_games (id, name) VALUES
  ('053a0000-0000-4000-8000-000000000001', 'Unlisted Test');

-- The real migration, run twice: once for the property under test, once for the
-- claim that re-running it is safe. DROP CONSTRAINT IF EXISTS makes the second
-- pass a no-op, and a constraint that came back subtly different on the replay
-- would fail the same assertions below. Both passes roll back with everything
-- else.
\i db/migrations/053_rulebook_review_optional.sql
\i db/migrations/053_rulebook_review_optional.sql

DO $test$
DECLARE
  g         CONSTANT uuid := '053a0000-0000-4000-8000-000000000001';
  author    CONSTANT uuid := gen_random_uuid();
  other     CONSTANT uuid := gen_random_uuid();
  st        text;
  n         int;
BEGIN
  INSERT INTO public.boardgamebuddy_profiles (id, display_name, username) VALUES
    (author, 'Ana',  'ana_'  || left(author::text, 8)),
    (other,  'Bram', 'bram_' || left(other::text, 8));

  -- ON CONFLICT DO NOTHING for the reason 052's test gives: a real database
  -- already has these (002_seed, 021, 052) and a scratch one stood up from
  -- db/schema/ has no seed rows at all — the snapshot carries shape, not data.
  INSERT INTO public.boardgamebuddy_chapter_types (id, label, icon, display_order) VALUES
    ('setup', 'Setup', 'box', 10),
    ('rulebook', 'Rulebook', 'book-open', 6)
  ON CONFLICT (id) DO NOTHING;

  -- ── 1. the new value is accepted ───────────────────────────────────────────
  -- The whole point of the migration: a link its author never submitted.
  INSERT INTO public.boardgamebuddy_guide_chapters
    (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
  VALUES (g, 'rulebook', 'Unlisted Test rulebook',
          '[Rulebook](https://example.test/mine.pdf)', 'rulebook_link',
          'https://example.test/mine.pdf', 'unlisted', author);

  SELECT moderation_status INTO st FROM public.boardgamebuddy_guide_chapters
   WHERE game_id = g AND created_by = author AND layout = 'rulebook_link';
  ASSERT st = 'unlisted',
    'an unlisted rulebook link must store its status verbatim, got '
    || COALESCE(st, 'NULL');

  -- ── 2. …and the original three still are ───────────────────────────────────
  -- 053 re-issued the constraint. A typo in the re-issued array would not break
  -- the new value — it is the one the author of the typo was looking at — it
  -- would break one of the three that were already working.
  UPDATE public.boardgamebuddy_guide_chapters
     SET moderation_status = 'pending'
   WHERE game_id = g AND created_by = author;
  UPDATE public.boardgamebuddy_guide_chapters
     SET moderation_status = 'approved'
   WHERE game_id = g AND created_by = author;
  UPDATE public.boardgamebuddy_guide_chapters
     SET moderation_status = 'denied'
   WHERE game_id = g AND created_by = author;
  UPDATE public.boardgamebuddy_guide_chapters
     SET moderation_status = 'unlisted'
   WHERE game_id = g AND created_by = author;

  -- ── 3. the set is still CLOSED ─────────────────────────────────────────────
  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES (g, 'rulebook', 'Bogus', 'x', 'rulebook_link',
            'https://example.test/a.pdf', 'maybe', other);
    ASSERT false, 'moderation_status is a closed set of four, not an open column';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A near-miss of the new value in particular: a status set that admits
  -- 'unlisted' by prefix or by case would admit these too.
  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES (g, 'rulebook', 'Shouty', 'x', 'rulebook_link',
            'https://example.test/a.pdf', 'UNLISTED', other);
    ASSERT false, 'the status values are lower-case literals, not a case-insensitive match';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── 4. the NULL backstops survived the re-issue ────────────────────────────
  -- THE regression this file exists for. A CHECK whose expression evaluates to
  -- NULL passes, so dropping either IS NOT NULL while retyping the constraint
  -- would admit these two silently — and both are rows every read path would
  -- then have to guess about.
  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES (g, 'rulebook', 'No URL', 'x', 'rulebook_link', NULL, 'unlisted', other);
    ASSERT false, 'a rulebook_link row with NULL link_url must still be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES (g, 'rulebook', 'No gate', 'x', 'rulebook_link',
            'https://example.test/a.pdf', NULL, other);
    ASSERT false, 'a rulebook_link row with NULL moderation_status must still be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── 5. …and so did the scheme test ─────────────────────────────────────────
  -- The one clause whose absence is a security bug rather than a data bug.
  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES (g, 'rulebook', 'Script', 'x', 'rulebook_link',
            'javascript:alert(1)', 'unlisted', other);
    ASSERT false, 'a javascript: URL must never reach this column';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── 6. …and the OTHER branch, which is easy to lose entirely ───────────────
  -- The half that matters most: a URL smuggled onto a text chapter carries NO
  -- moderation status, because the gate hangs off the layout — so nothing would
  -- ever review it.
  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES (g, 'setup', 'Setup', 'body', 'text',
            'https://example.test/a.pdf', NULL, other);
    ASSERT false, 'link_url belongs to one layout only';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, moderation_status, created_by)
    VALUES (g, 'setup', 'Setup', 'body', 'text', 'unlisted', other);
    ASSERT false, 'a text chapter has nothing to gate and must carry no status';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── 7. an ordinary prose chapter still inserts ─────────────────────────────
  -- If the re-issued constraint went wrong in the direction of being too
  -- strict, the damage would not be to rulebook links at all.
  INSERT INTO public.boardgamebuddy_guide_chapters
    (game_id, chapter_type, title, content, layout, created_by)
  VALUES (g, 'setup', 'Setup', 'Deal seven cards.', 'text', other);

  -- ── 8. one link per (game, author), unlisted included ──────────────────────
  -- 053 adds a status that is not in the queue, and the anti-spam property must
  -- not depend on which status a row carries: the index is partial on the
  -- LAYOUT (052), so an unlisted link occupies its author's one slot exactly as
  -- a pending or denied one does.
  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES (g, 'rulebook', 'Unlisted Test rulebook',
            '[Rulebook](https://example.test/second.pdf)', 'rulebook_link',
            'https://example.test/second.pdf', 'unlisted', author);
    ASSERT false, 'an unlisted link still holds its author''s one slot';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  SELECT count(*) INTO n FROM public.boardgamebuddy_guide_chapters
   WHERE game_id = g AND layout = 'rulebook_link';
  ASSERT n = 1, 'expected exactly the one authored link, got ' || n;

  RAISE NOTICE 'ALL 053 CHECKS PASSED';
END
$test$;

ROLLBACK;
