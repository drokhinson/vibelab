-- ─────────────────────────────────────────────────────────────────────────────
-- 064_rulebook_auto_review.sql — every rulebook link goes to admin review
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A rulebook link written by a non-admin is `pending`: in the admin queue and
-- visible to everyone meanwhile. A denied link reaches only its author and
-- admins. A link written by an admin is
-- `approved` and stamped with that admin. There is no `unlisted` state.
--
-- 1. Existing links written by an admin that are still undecided (pending or
--    unlisted) become approved, with moderated_by = their author and
--    moderated_at = now().
-- 2. Every remaining unlisted link becomes pending, so it enters the queue.
-- 3. bgb_chapters_link_shape is re-issued without 'unlisted'; the rest of its
--    expression is unchanged.
-- 4. The column comment on moderation_status describes the three states.
--
-- Deploy order: API first, then this migration. The API reads an 'unlisted'
-- row as pending and never writes one, so it runs correctly before this does;
-- the previous API writes 'unlisted', which the new CHECK refuses.
--
-- No BEGIN/COMMIT of its own: db/tests/rulebook_auto_review.sql replays this
-- file inside a transaction that ends in ROLLBACK, and a COMMIT here would
-- commit that test's rows. Safe to re-run.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_guide_chapters
  DROP CONSTRAINT IF EXISTS bgb_chapters_link_shape;

-- ── 1. Admins' own undecided links are approved ──────────────────────────────

UPDATE public.boardgamebuddy_guide_chapters c
   SET moderation_status = 'approved',
       moderated_by      = c.created_by,
       moderated_at      = now()
  FROM public.boardgamebuddy_profiles p
 WHERE p.id = c.created_by
   AND p.is_admin
   AND c.layout = 'rulebook_link'
   AND c.moderation_status IN ('pending', 'unlisted');

-- ── 2. Every other unlisted link enters the queue ────────────────────────────

UPDATE public.boardgamebuddy_guide_chapters
   SET moderation_status = 'pending',
       moderated_by      = NULL,
       moderated_at      = NULL
 WHERE layout = 'rulebook_link'
   AND moderation_status = 'unlisted';

-- ── 3. bgb_chapters_link_shape ───────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_guide_chapters
  ADD CONSTRAINT bgb_chapters_link_shape CHECK ((((layout = 'rulebook_link'::text) AND (link_url IS NOT NULL) AND (link_url ~* '^https?://[^[:space:]]+$'::text) AND (moderation_status IS NOT NULL) AND (moderation_status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text]))) OR ((layout <> 'rulebook_link'::text) AND (link_url IS NULL) AND (moderation_status IS NULL))));

-- ── 4. Column comment ────────────────────────────────────────────────────────

COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.moderation_status IS 'Rulebook links only. approved and pending (in the admin queue): everyone sees it; denied: the author and admins.';
