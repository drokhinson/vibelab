-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Final cleanup after the OOP/Strava redesign cuts over
-- Run ONLY after the new frontend has shipped and play_players is no longer
-- referencing buddy_id.
--
-- Post-redesign roles:
--   * boardgamebuddy_buddy_edges — mutual friendship graph (added in 008).
--   * boardgamebuddy_buddies     — ghost-player nicknames only. The
--                                  linked_user_id column becomes dead weight.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_play_players
  DROP COLUMN IF EXISTS buddy_id;

DROP INDEX IF EXISTS public.idx_bgb_buddies_owner_linked;
DROP INDEX IF EXISTS public.idx_bgb_buddies_linked_user;

ALTER TABLE public.boardgamebuddy_buddies
  DROP COLUMN IF EXISTS linked_user_id;
