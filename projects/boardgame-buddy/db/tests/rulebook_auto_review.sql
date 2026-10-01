-- ─────────────────────────────────────────────────────────────────────────────
-- rulebook_auto_review.sql — the auto-review migration and the re-issued
--                            bgb_chapters_link_shape
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY THIS FILE EXISTS. `api/tests/test_rulebook_links.py` drives the API
-- against a fake PostgREST, where every INSERT succeeds and no row predates the
-- code. Two things here live only in Postgres:
--
--   * the DATA CONVERSION, which runs once against real rows: an admin's own
--     undecided link becomes approved and stamped with that admin, every other
--     'unlisted' link becomes pending, and decided links are left alone.
--   * the RE-ISSUED CHECK. Postgres has no ALTER CONSTRAINT for a CHECK, so the
--     migration writes the whole expression out again, and every clause it
--     reproduces is one it could drop by accident. The IS NOT NULL tests are the
--     ones that would go quietly: **a CHECK whose expression evaluates to NULL
--     PASSES**, so losing one admits a rulebook link with no URL or no gate.
--
-- SAFE TO RUN ANYWHERE, including production: the whole thing is one
-- transaction that ends in ROLLBACK, and every row it touches is one it
-- inserted under a uuid it invented. It still writes WAL, so prefer a scratch
-- database. Same posture, and the same shape, as db/tests/rulebook_links.sql.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/rulebook_auto_review.sql
--
-- Run from projects/boardgame-buddy, so the `\i` paths below resolve. Every
-- check is an ASSERT inside one DO block, so the first failure raises with the
-- name of the property that broke. Silence plus
-- "ALL RULEBOOK-AUTO-REVIEW CHECKS PASSED" is a pass.
--
-- Standing up a throwaway database to run it against needs what
-- rulebook_links.sql lists (the three roles, `auth.users`, the `extensions`
-- schema with pg_trgm, and an `auth.uid()` stub), then
-- db/schema/boardgamebuddy.sql. The snapshot already carries the three-value
-- constraint, so the four-value one is put back below to stage the rows the
-- migration converts.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── The rows the migration is aimed at ───────────────────────────────────────
-- Staged under the four-value constraint, BEFORE the migration is replayed, so
-- the `\i` lines exercise the real statements against 'unlisted' rows.

ALTER TABLE public.boardgamebuddy_guide_chapters
  DROP CONSTRAINT IF EXISTS bgb_chapters_link_shape;
ALTER TABLE public.boardgamebuddy_guide_chapters
  ADD CONSTRAINT bgb_chapters_link_shape CHECK ((((layout = 'rulebook_link'::text) AND (link_url IS NOT NULL) AND (link_url ~* '^https?://[^[:space:]]+$'::text) AND (moderation_status IS NOT NULL) AND (moderation_status = ANY (ARRAY['unlisted'::text, 'pending'::text, 'approved'::text, 'denied'::text]))) OR ((layout <> 'rulebook_link'::text) AND (link_url IS NULL) AND (moderation_status IS NULL))));

-- Fixed, v4-shaped uuids no real row holds, so the DO block can name them.
INSERT INTO public.boardgamebuddy_games (id, name) VALUES
  ('064a0000-0000-4000-8000-000000000001', 'Auto Review Test A'),
  ('064a0000-0000-4000-8000-000000000002', 'Auto Review Test B'),
  ('064a0000-0000-4000-8000-000000000003', 'Auto Review Test C');

INSERT INTO public.boardgamebuddy_profiles (id, display_name, username, is_admin) VALUES
  ('064a0000-0000-4000-8000-0000000000a1', 'Ada',  'ada_064a',  true),
  ('064a0000-0000-4000-8000-0000000000b1', 'Bram', 'bram_064a', false),
  ('064a0000-0000-4000-8000-0000000000c1', 'Cleo', 'cleo_064a', false);

-- ON CONFLICT DO NOTHING: a real database already has these seed rows and a
-- scratch one stood up from db/schema/ has none.
INSERT INTO public.boardgamebuddy_chapter_types (id, label, icon, display_order) VALUES
  ('setup', 'Setup', 'box', 10),
  ('rulebook', 'Rulebook', 'book-open', 6)
ON CONFLICT (id) DO NOTHING;

-- One link per (game, author), so each case gets its own game or author.
--   A/admin unlisted   → approved, stamped
--   B/admin pending    → approved, stamped
--   C/admin denied     → denied, untouched
--   A/Bram  unlisted   → pending
--   B/Bram  approved   → approved, untouched (moderated_by Ada)
--   C/Bram  pending    → pending, untouched
--   A/Cleo  denied     → denied, untouched
INSERT INTO public.boardgamebuddy_guide_chapters
  (id, game_id, chapter_type, title, content, layout, link_url,
   moderation_status, moderated_by, moderated_at, created_by)
VALUES
  ('064a0000-0000-4000-8000-000000000101', '064a0000-0000-4000-8000-000000000001',
   'rulebook', 'r', '[Rulebook](https://example.test/1.pdf)', 'rulebook_link',
   'https://example.test/1.pdf', 'unlisted', NULL, NULL,
   '064a0000-0000-4000-8000-0000000000a1'),
  ('064a0000-0000-4000-8000-000000000102', '064a0000-0000-4000-8000-000000000002',
   'rulebook', 'r', '[Rulebook](https://example.test/2.pdf)', 'rulebook_link',
   'https://example.test/2.pdf', 'pending', NULL, NULL,
   '064a0000-0000-4000-8000-0000000000a1'),
  ('064a0000-0000-4000-8000-000000000103', '064a0000-0000-4000-8000-000000000003',
   'rulebook', 'r', '[Rulebook](https://example.test/3.pdf)', 'rulebook_link',
   'https://example.test/3.pdf', 'denied', '064a0000-0000-4000-8000-0000000000a1',
   '2026-01-01T00:00:00Z', '064a0000-0000-4000-8000-0000000000a1'),
  ('064a0000-0000-4000-8000-000000000104', '064a0000-0000-4000-8000-000000000001',
   'rulebook', 'r', '[Rulebook](https://example.test/4.pdf)', 'rulebook_link',
   'https://example.test/4.pdf', 'unlisted', NULL, NULL,
   '064a0000-0000-4000-8000-0000000000b1'),
  ('064a0000-0000-4000-8000-000000000105', '064a0000-0000-4000-8000-000000000002',
   'rulebook', 'r', '[Rulebook](https://example.test/5.pdf)', 'rulebook_link',
   'https://example.test/5.pdf', 'approved', '064a0000-0000-4000-8000-0000000000a1',
   '2026-01-01T00:00:00Z', '064a0000-0000-4000-8000-0000000000b1'),
  ('064a0000-0000-4000-8000-000000000106', '064a0000-0000-4000-8000-000000000003',
   'rulebook', 'r', '[Rulebook](https://example.test/6.pdf)', 'rulebook_link',
   'https://example.test/6.pdf', 'pending', NULL, NULL,
   '064a0000-0000-4000-8000-0000000000b1'),
  ('064a0000-0000-4000-8000-000000000107', '064a0000-0000-4000-8000-000000000001',
   'rulebook', 'r', '[Rulebook](https://example.test/7.pdf)', 'rulebook_link',
   'https://example.test/7.pdf', 'denied', '064a0000-0000-4000-8000-0000000000a1',
   '2026-01-01T00:00:00Z', '064a0000-0000-4000-8000-0000000000c1');

-- The real migration, run twice: once for the conversion, once for the claim
-- that re-running it is safe. Both passes roll back with everything else.
\i db/migrations/064_rulebook_auto_review.sql
\i db/migrations/064_rulebook_auto_review.sql

DO $test$
DECLARE
  g     CONSTANT uuid := '064a0000-0000-4000-8000-000000000001';
  ada   CONSTANT uuid := '064a0000-0000-4000-8000-0000000000a1';
  cleo  CONSTANT uuid := '064a0000-0000-4000-8000-0000000000c1';
  ch    record;
  n     int;
BEGIN
  -- ── 1. an admin's own undecided links are approved and stamped ─────────────
  FOR ch IN
    SELECT * FROM public.boardgamebuddy_guide_chapters
     WHERE id IN ('064a0000-0000-4000-8000-000000000101',
                  '064a0000-0000-4000-8000-000000000102')
  LOOP
    ASSERT ch.moderation_status = 'approved',
      'an admin''s undecided link must become approved, got ' || ch.moderation_status;
    ASSERT ch.moderated_by = ada,
      'an auto-approved link must name its admin author as the decider';
    ASSERT ch.moderated_at IS NOT NULL,
      'an auto-approved link must carry a decision time';
  END LOOP;

  -- ── 2. an admin's denied link is left denied ───────────────────────────────
  SELECT * INTO ch FROM public.boardgamebuddy_guide_chapters
   WHERE id = '064a0000-0000-4000-8000-000000000103';
  ASSERT ch.moderation_status = 'denied',
    'a decided link is not re-decided by the migration, got ' || ch.moderation_status;
  ASSERT ch.moderated_at = '2026-01-01T00:00:00Z'::timestamptz,
    'a decided link keeps its decision time';

  -- ── 3. a non-admin's unlisted link enters the queue ────────────────────────
  SELECT * INTO ch FROM public.boardgamebuddy_guide_chapters
   WHERE id = '064a0000-0000-4000-8000-000000000104';
  ASSERT ch.moderation_status = 'pending',
    'a non-admin''s unlisted link must become pending, got ' || ch.moderation_status;
  ASSERT ch.moderated_by IS NULL AND ch.moderated_at IS NULL,
    'a pending link carries no decision';

  -- ── 4. everything else is untouched ────────────────────────────────────────
  SELECT * INTO ch FROM public.boardgamebuddy_guide_chapters
   WHERE id = '064a0000-0000-4000-8000-000000000105';
  ASSERT ch.moderation_status = 'approved' AND ch.moderated_by = ada
     AND ch.moderated_at = '2026-01-01T00:00:00Z'::timestamptz,
    'an approved link keeps its original decision';

  SELECT * INTO ch FROM public.boardgamebuddy_guide_chapters
   WHERE id = '064a0000-0000-4000-8000-000000000106';
  ASSERT ch.moderation_status = 'pending' AND ch.moderated_by IS NULL,
    'a non-admin''s pending link stays pending';

  SELECT * INTO ch FROM public.boardgamebuddy_guide_chapters
   WHERE id = '064a0000-0000-4000-8000-000000000107';
  ASSERT ch.moderation_status = 'denied',
    'a non-admin''s denied link stays denied';

  SELECT count(*) INTO n FROM public.boardgamebuddy_guide_chapters
   WHERE moderation_status = 'unlisted';
  ASSERT n = 0, 'no unlisted link survives the migration, found ' || n;

  -- ── 5. 'unlisted' is now refused ───────────────────────────────────────────
  BEGIN
    UPDATE public.boardgamebuddy_guide_chapters
       SET moderation_status = 'unlisted'
     WHERE id = '064a0000-0000-4000-8000-000000000104';
    ASSERT false, 'moderation_status does not admit unlisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── 6. …and the three that remain are still accepted ───────────────────────
  -- A typo in the re-issued array would break one of these, not the value
  -- being removed.
  UPDATE public.boardgamebuddy_guide_chapters SET moderation_status = 'approved'
   WHERE id = '064a0000-0000-4000-8000-000000000104';
  UPDATE public.boardgamebuddy_guide_chapters SET moderation_status = 'denied'
   WHERE id = '064a0000-0000-4000-8000-000000000104';
  UPDATE public.boardgamebuddy_guide_chapters SET moderation_status = 'pending'
   WHERE id = '064a0000-0000-4000-8000-000000000104';

  -- ── 7. the set is still closed ─────────────────────────────────────────────
  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES ('064a0000-0000-4000-8000-000000000003', 'rulebook', 'Bogus', 'x',
            'rulebook_link', 'https://example.test/a.pdf', 'maybe', cleo);
    ASSERT false, 'moderation_status is a closed set of three, not an open column';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── 8. the NULL backstops survived the re-issue ────────────────────────────
  -- Inserted on a game Cleo has no link for, so the only thing that can refuse
  -- them is the CHECK.
  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES ('064a0000-0000-4000-8000-000000000002', 'rulebook', 'No URL', 'x',
            'rulebook_link', NULL, 'pending', cleo);
    ASSERT false, 'a rulebook_link row with NULL link_url must still be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES ('064a0000-0000-4000-8000-000000000002', 'rulebook', 'No gate', 'x',
            'rulebook_link', 'https://example.test/a.pdf', NULL, cleo);
    ASSERT false, 'a rulebook_link row with NULL moderation_status must still be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── 9. …and so did the scheme test ─────────────────────────────────────────
  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES ('064a0000-0000-4000-8000-000000000002', 'rulebook', 'Script', 'x',
            'rulebook_link', 'javascript:alert(1)', 'pending', cleo);
    ASSERT false, 'a javascript: URL must never reach this column';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── 10. …and the other branch ──────────────────────────────────────────────
  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
    VALUES (g, 'setup', 'Setup', 'body', 'text',
            'https://example.test/a.pdf', NULL, cleo);
    ASSERT false, 'link_url belongs to one layout only';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.boardgamebuddy_guide_chapters
      (game_id, chapter_type, title, content, layout, moderation_status, created_by)
    VALUES (g, 'setup', 'Setup', 'body', 'text', 'pending', cleo);
    ASSERT false, 'a text chapter has nothing to gate and must carry no status';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ── 11. an ordinary prose chapter and a new pending link still insert ──────
  INSERT INTO public.boardgamebuddy_guide_chapters
    (game_id, chapter_type, title, content, layout, created_by)
  VALUES (g, 'setup', 'Setup', 'Deal seven cards.', 'text', cleo);
  INSERT INTO public.boardgamebuddy_guide_chapters
    (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
  VALUES ('064a0000-0000-4000-8000-000000000002', 'rulebook', 'r',
          '[Rulebook](https://example.test/8.pdf)', 'rulebook_link',
          'https://example.test/8.pdf', 'pending', cleo);

  RAISE NOTICE 'ALL RULEBOOK-AUTO-REVIEW CHECKS PASSED';
END
$test$;

ROLLBACK;
