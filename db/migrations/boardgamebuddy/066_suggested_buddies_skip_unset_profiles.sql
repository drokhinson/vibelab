-- ─────────────────────────────────────────────────────────────────────────────
-- 066_suggested_buddies_skip_unset_profiles.sql — don't suggest an account that
-- hasn't finished setting itself up.
--
-- Migration 063 added bgb_onboarding_buddy_suggestions for the first-run "Add
-- buddies" step. Its candidate-building CTEs are copied verbatim from
-- bgb_suggested_buddies (057) so the two surfaces can never disagree about who
-- the viewer has played with, and it differs on purpose in exactly one way that
-- matters: a second tier of "active recently" candidates, because 057's
-- earned-signal floor is right for the Feed rail and returns the empty set for
-- the brand-new account that step exists for.
--
-- It also picked up a filter that 057 does not have, and that asymmetry was not
-- a considered decision: 063 drops profiles still carrying needs_setup. Those
-- accounts have never been through the profile modal, so their display name is
-- still the email local-part and their badge is still the BGB default. A tile
-- reading "jsmith84" over a default disc is no better on the Feed than it is
-- during onboarding — it just wasn't where the pain was felt.
--
-- So the filter moves to where it belongs: both suggestion surfaces now skip
-- them, and the only intended difference between the two functions is 063's
-- fallback tier.
--
-- The profile row was already being joined here (057 added the join so LIMIT
-- counts rows the rail can actually render); this only adds a predicate to it.
--
-- CREATE OR REPLACE, not DROP + CREATE. 057 had to drop because it *changed*
-- the return type (it added play_count); this changes only the body, and
-- REPLACE preserves the GRANT EXECUTE below — a drop would silently take it
-- away. Re-runnable; no table changes.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bgb_suggested_buddies(uid UUID, lim INT DEFAULT 5)
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
     AND pr.needs_setup IS NOT TRUE          -- added in 066
     AND c.candidate NOT IN (SELECT x.other_id FROM connected x)
     AND (c.mutuals > 0 OR c.plays > 0)
   ORDER BY (c.plays > 0) DESC, c.plays DESC, c.mutuals DESC, c.candidate
   LIMIT lim;
$$;

GRANT EXECUTE ON FUNCTION public.bgb_suggested_buddies(UUID, INT) TO boardgamebuddy_role;
