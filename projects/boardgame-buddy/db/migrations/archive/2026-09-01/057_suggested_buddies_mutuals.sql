-- ─────────────────────────────────────────────────────────────────────────────
-- 057_suggested_buddies_mutuals.sql — who "Buddies you may know" may suggest.
--
-- The Feed's suggestion rail had one candidate source: friends-of-friends off
-- the accepted-buddy graph. That misses the strongest signal the app has —
-- people the viewer has actually sat at a table with. Someone you have logged
-- a dozen plays against, who happens not to share a buddy with you, could not
-- be suggested at all, even though the app knows their account.
--
-- The candidate pool is now the union of two sources, and a candidate carries
-- the count from each:
--
--   mutual_count — accepted buddies shared with the viewer (friends-of-friends)
--   play_count   — plays shared with the viewer
--
-- Ranking is played-with first: real-world contact outranks a graph path, so
-- anyone with a shared play sorts above every graph-only candidate, most plays
-- first (mutuals break ties). Graph-only candidates fill the remaining slots by
-- mutual count. `lim` defaults to 5 — the rail shows five at a time.
--
-- Shared plays are counted exactly as bgb_play_partners counts them for the
-- Buddies screen's "Played with" list — plays the viewer LOGGED plus plays the
-- viewer APPEARS IN — so the two surfaces can never disagree about who the
-- viewer has played with.
--
-- Two exclusions, both tightened from the 012 definition:
--
--   • Candidates already connected to the viewer by ANY edge are dropped, not
--     just accepted ones. The old filter dropped accepted buddies but left
--     pending edges in, so someone the viewer had already requested (or who
--     had already requested the viewer) came back as a suggestion with an
--     "Add" button that POSTs a request they've already sent.
--   • A candidate with no profile row is dropped here rather than in Python,
--     so LIMIT counts rows the rail can actually render. (Same inner join
--     bgb_play_partners uses on its `recent` list.)
--
-- The "at least one mutual buddy or one shared play" floor holds by
-- construction — every candidate comes from a source that counted at least
-- one — but it is written as an explicit predicate so the rule the rail
-- promises is visible in the query that enforces it.
--
-- DROP + CREATE rather than CREATE OR REPLACE: the return type gains a
-- play_count column, which REPLACE cannot do. Re-runnable; no table changes.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.bgb_suggested_buddies(UUID, INT);

CREATE FUNCTION public.bgb_suggested_buddies(uid UUID, lim INT DEFAULT 5)
RETURNS TABLE (
  user_id        UUID,
  mutual_count   BIGINT,
  play_count     BIGINT
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
  ),
  mutuals AS (
    SELECT fof.candidate, COUNT(DISTINCT fof.friend_id)::BIGINT AS n
      FROM fof
     GROUP BY fof.candidate
  ),
  -- Same visibility rule as bgb_play_partners / bgb_play_stats: plays the
  -- viewer logged, plus plays the viewer was a player in.
  visible_plays AS (
    SELECT p.id FROM public.boardgamebuddy_plays p WHERE p.user_id = uid
    UNION
    SELECT pp.play_id
      FROM public.boardgamebuddy_play_players pp
     WHERE pp.player_user_id = uid
  ),
  played_with AS (
    SELECT pp.player_user_id AS candidate, COUNT(*)::BIGINT AS n
      FROM public.boardgamebuddy_play_players pp
      JOIN visible_plays v ON v.id = pp.play_id
     WHERE pp.player_user_id IS NOT NULL
     GROUP BY pp.player_user_id
  ),
  candidates AS (
    SELECT
      COALESCE(m.candidate, w.candidate) AS candidate,
      COALESCE(m.n, 0) AS mutuals,
      COALESCE(w.n, 0) AS plays
    FROM mutuals m
    FULL OUTER JOIN played_with w ON w.candidate = m.candidate
  )
  SELECT c.candidate, c.mutuals, c.plays
    FROM candidates c
    JOIN public.boardgamebuddy_profiles pr ON pr.id = c.candidate
   WHERE c.candidate <> uid
     AND c.candidate NOT IN (SELECT x.other_id FROM connected x)
     AND (c.mutuals > 0 OR c.plays > 0)
   ORDER BY (c.plays > 0) DESC, c.plays DESC, c.mutuals DESC, c.candidate
   LIMIT lim;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_suggested_buddies(UUID, INT) TO boardgamebuddy_role;
