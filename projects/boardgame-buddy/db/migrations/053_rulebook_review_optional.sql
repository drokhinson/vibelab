-- ─────────────────────────────────────────────────────────────────────────────
-- 053 — Asking for review is the author's decision, and an admin's link is not
--       born approved
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 052 shipped the gate with two things wired shut that should have been open,
-- and this file opens both. Nothing about WHO SEES WHAT changes: approved is
-- still public, unreviewed still reaches the author and their accepted buddies,
-- denied still reaches the author and admins. What changes is how a link
-- ENTERS the queue, and who is exempt from it.
--
--   1. EVERY SAVE WAS A SUBMISSION. Writing a rulebook link and asking an admin
--      to vouch for it publicly were the same act, so an author who wanted the
--      PDF their own table reads from — the printing they own, a fan
--      translation, a Google Drive copy of a scan — had no way to keep it
--      between them and their buddies. They got a queue item anyway, and the
--      admin got a decision to make about a link nobody asked them to publish.
--      That is a queue filling with work neither end wanted.
--   2. AN ADMIN'S OWN LINK WAS BORN APPROVED. Defensible on its own terms — the
--      decision the queue collects is theirs — but it made the app tell two
--      different stories at the save screen ("this goes live now" to one
--      author, "your buddies can see it while an admin reviews it" to another)
--      for an action that is the same action, and it meant the one person most
--      likely to paste a link in a hurry was the one person whose link nobody
--      ever looked at. An admin approving their own link from the queue is one
--      tap; being unable to un-publish one they never reviewed is not.
--
-- THE NEW STATUS: `unlisted`. A link its author has NOT asked anyone to review.
-- Visible to exactly who an unreviewed link has always been visible to — its
-- author and their accepted buddies — and, unlike `pending`, not in the admin
-- queue, not in the review-counts badge, and not work anybody owes an answer
-- for. The author turns the review toggle on and it becomes `pending`; they
-- turn it off and it goes back.
--
-- WHY A FOURTH STATUS AND NOT A SECOND COLUMN. A boolean `review_requested`
-- beside `moderation_status` would make two columns answer one question, and
-- every read path would then have to consult both and agree on what
-- (pending, false) or (approved, false) means. The gate is ONE value with four
-- states, and the code that reads it — services/chapter_rulebook.is_visible_to
-- — goes on being the one place the rule lives.
--
-- WHY `unlisted` AND NOT `draft` OR `private`. It is neither: the link is
-- finished, it is live, and other people are already reading it. The one thing
-- it is not is listed for everybody, which is the word for that.
--
-- NO BACKFILL, DELIBERATELY. Every existing `pending` row was written under the
-- old rule, where saving WAS submitting — so its author did ask, by the only
-- means the app gave them, and quietly emptying the queue into `unlisted` would
-- withdraw submissions on their behalf. Existing `approved` rows stay approved,
-- including the ones an admin's own save approved on the way in: 053 changes
-- what happens at the NEXT write, not what an earlier one decided.


-- ── The gate learns its fourth state ─────────────────────────────────────────
-- The constraint is reproduced whole rather than patched, because that is the
-- only way to write it: Postgres has no ALTER CONSTRAINT for a CHECK. Every
-- other clause is 052's, verbatim and for 052's reasons — the IS NOT NULL tests
-- in particular, which are load-bearing (a CHECK whose expression evaluates to
-- NULL PASSES, so the regex alone would admit a rulebook link with no URL, and
-- the status test alone one with no gate at all).

ALTER TABLE public.boardgamebuddy_guide_chapters
  DROP CONSTRAINT IF EXISTS bgb_chapters_link_shape;

ALTER TABLE public.boardgamebuddy_guide_chapters
  ADD CONSTRAINT bgb_chapters_link_shape CHECK (
    (
      layout = 'rulebook_link'
      AND link_url IS NOT NULL
      AND link_url ~* '^https?://[^[:space:]]+$'
      AND moderation_status IS NOT NULL
      AND moderation_status = ANY (
        ARRAY['unlisted'::text, 'pending'::text, 'approved'::text, 'denied'::text]
      )
    )
    OR (
      layout <> 'rulebook_link'
      AND link_url IS NULL
      AND moderation_status IS NULL
    )
  );


-- ── What the columns now mean ────────────────────────────────────────────────
-- idx_bgb_chapters_rulebook_status is left exactly as 052 created it: it leads
-- on (moderation_status, created_at) and the queue's read is still one equality
-- on that column, so a fourth value costs it nothing.

COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.moderation_status IS
  'unlisted | pending | approved | denied, on a layout=''rulebook_link'' chapter only (NULL '
  'everywhere else). Approved is visible to everyone; unlisted and pending only to the author and '
  'their ACCEPTED buddies; denied only to the author and admins. Unlisted and pending differ in '
  'ONE respect and it is not visibility: pending is in the admin queue because its author asked '
  'for review (migration 053''s toggle), unlisted is not. A link authored by an admin is NOT born '
  'approved — as of 053 every author goes through the same gate, and an admin approves their own '
  'from the queue like anyone else''s. The rule is applied by routes/services/chapter_rulebook.py '
  'on every chapter read path, NOT by RLS — this API is service-role and bypasses RLS, and '
  'nothing reads chapters browser-direct. A denial is deliberately not a delete: the row is what '
  'stops the same author re-posting the same link past idx_bgb_chapters_rulebook_author.';

COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.moderated_by IS
  'The admin whose decision moderation_status records. NULL while unlisted or pending — including '
  'on a link an admin wrote themselves, which as of migration 053 is not self-approved on the way '
  'in — and NULL on the rows migration 052 backfilled out of boardgamebuddy_games.rulebook_url, '
  'which were approved by having been admin-only data in the first place. Naming an admin who '
  'never looked at a link would be a lie the audit trail cannot tell apart from a real decision, '
  'which is also why re-opening the gate (a changed URL, a withdrawn request) clears this column '
  'rather than leaving the last decision''s author on a row nobody has decided.';
