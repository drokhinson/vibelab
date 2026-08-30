-- ─────────────────────────────────────────────────────────────────────────────
-- 057_suggested_buddies_mutuals.sql — "Buddies you may know" is mutuals-only.
--
-- The Feed's suggestion rail is a friends-of-friends rail: a candidate earns a
-- slot by being an accepted buddy of at least one of the viewer's accepted
-- buddies, and the rail is ranked by how many of those it shares. Nobody with
-- zero mutual buddies belongs in it — a stranger the viewer has no path to is
-- not a suggestion, it's a directory listing, and the search box already
-- covers that.
--
-- Two changes on top of the 012 definition:
--
--   1. Candidates already connected to the viewer by ANY edge are excluded,
--      not just accepted ones. The old filter dropped accepted buddies but
--      left pending edges in, so someone the viewer had already requested
--      (or who had already requested the viewer) came back as a suggestion
--      with an "Add" button that POSTs a request they've already sent.
--   2. `lim` defaults to 5 — the rail shows five at a time.
--
-- The mutual-count floor is written as an explicit HAVING rather than left
-- implicit in the GROUP BY, so the rule the rail promises is visible in the
-- query that enforces it.
--
-- Re-runnable: CREATE OR REPLACE, no table changes.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bgb_suggested_buddies(uid UUID, lim INT DEFAULT 5)
RETURNS TABLE (
  user_id        UUID,
  mutual_count   BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH my_edges AS (
    SELECT be.user_a, be.user_b, be.status
    FROM public.boardgamebuddy_buddy_edges be
    WHERE uid IN (be.user_a, be.user_b)
  ),
  -- Anyone already linked to the viewer in any way: accepted, pending in
  -- either direction, or blocked. None of them are suggestable.
  connected AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS other_id
    FROM my_edges me
  ),
  my_buddies AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS friend_id
    FROM my_edges me
    WHERE me.status = 'accepted'
  ),
  fof AS (
    SELECT
      CASE WHEN be.user_a = mb.friend_id THEN be.user_b ELSE be.user_a END AS candidate,
      mb.friend_id
    FROM my_buddies mb
    JOIN public.boardgamebuddy_buddy_edges be
      ON be.status = 'accepted'
     AND mb.friend_id IN (be.user_a, be.user_b)
  )
  SELECT fof.candidate, COUNT(DISTINCT fof.friend_id)::BIGINT AS mutual_count
  FROM fof
  WHERE fof.candidate <> uid
    AND fof.candidate NOT IN (SELECT c.other_id FROM connected c)
  GROUP BY fof.candidate
  HAVING COUNT(DISTINCT fof.friend_id) >= 1
  ORDER BY mutual_count DESC, fof.candidate
  LIMIT lim;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_suggested_buddies(UUID, INT) TO boardgamebuddy_role;
