-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Profile onboarding flag for first-time signups
--
-- Adds `needs_setup BOOLEAN` so the FE can gate brand-new accounts behind
-- the "Create your profile" modal (set display_name + avatar before
-- reaching the feed). New rows default to TRUE; existing rows at migration
-- time are backfilled to FALSE so the rollout only affects fresh signups.
-- POST /profile clears the flag once the user saves the modal — dismissing
-- without saving leaves it TRUE so the modal returns on the next load.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.boardgamebuddy_profiles
  ADD COLUMN IF NOT EXISTS needs_setup BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill: every row that exists right now is an already-onboarded user.
UPDATE public.boardgamebuddy_profiles
   SET needs_setup = FALSE
 WHERE needs_setup IS NOT FALSE;

COMMENT ON COLUMN public.boardgamebuddy_profiles.needs_setup IS
  'TRUE for brand-new accounts that have not yet completed the "Create your profile" modal. Cleared by the first successful POST /profile.';

COMMIT;
