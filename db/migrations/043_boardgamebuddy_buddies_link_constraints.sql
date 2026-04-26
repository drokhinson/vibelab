-- 043_boardgamebuddy_buddies_link_constraints.sql
-- Tighten boardgamebuddy_buddies for the buddy-linking feature.
--
-- 1. Partial unique index on (owner_id, linked_user_id):
--    Once buddy X is linked to user B, any other buddy from the same owner
--    that gets linked to B must merge into X (handled in the link endpoint).
--    The constraint guarantees we never end up with two linked rows for the
--    same (owner, target) pair.
--
-- 2. Plain index on linked_user_id:
--    Used by GET /plays to find every buddy where the current user is the
--    linked person, so their plays can be surfaced in the linked user's log.

CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_buddies_owner_linked
  ON public.boardgamebuddy_buddies (owner_id, linked_user_id)
  WHERE linked_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bgb_buddies_linked_user
  ON public.boardgamebuddy_buddies (linked_user_id)
  WHERE linked_user_id IS NOT NULL;
