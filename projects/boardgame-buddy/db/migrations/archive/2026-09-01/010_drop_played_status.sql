-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Drop legacy 'played' collection status
-- "Played" is now strictly derived from boardgamebuddy_plays. The app stopped
-- writing rows with status='played' back in migration 038. This finalizes the
-- enum at ('owned','wishlist').
-- ─────────────────────────────────────────────────────────────────────────────

-- Defensive sweep: any straggler 'played' rows that survived migration 038.
DELETE FROM public.boardgamebuddy_collections
WHERE status = 'played';

-- Tighten the CHECK constraint to disallow 'played' going forward.
ALTER TABLE public.boardgamebuddy_collections
  DROP CONSTRAINT IF EXISTS boardgamebuddy_collections_status_check;
ALTER TABLE public.boardgamebuddy_collections
  ADD CONSTRAINT boardgamebuddy_collections_status_check
  CHECK (status IN ('owned', 'wishlist'));
