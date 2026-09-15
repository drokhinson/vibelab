-- ─────────────────────────────────────────────────────────────────────────────
-- 063_onboarding_buddy_suggestions.sql — who to suggest to someone who has
-- been in the app for thirty seconds.
--
-- bgb_suggested_buddies (012, rewritten in 057) ranks candidates off two
-- signals the viewer has to have EARNED: a shared play, or a shared accepted
-- buddy. It ends with `AND (c.mutuals > 0 OR c.plays > 0)`, which is the right
-- floor for the Feed rail — a suggestion there has to be able to say why. But
-- it means the function returns the empty set for exactly one user: the one
-- who just signed up. No plays, no buddies, no candidates.
--
-- The onboarding step ("Add buddies", straight after the profile modal) is the
-- one surface where the empty set is the failure case: a brand-new account has
-- nobody, which is precisely why we are asking. So this is a SECOND function
-- rather than a loosened first one — the Feed keeps its earned-signal floor,
-- and the fallback below is scoped to the screen that needs it.
--
-- Two tiers, concatenated, capped at `lim`:
--
--   tier 0 'graph'  — the same earned signals bgb_suggested_buddies ranks on.
--                     Not always empty at onboarding: a friend who already had
--                     an account can have logged the new user into a play (by
--                     account, via player_user_id) or sent them a request
--                     before they finished setup.
--   tier 1 'active' — community fallback, ranked by plays logged in the last
--                     ACTIVE_WINDOW days. "People actually using the app",
--                     which is the honest thing to say about them and is what
--                     the tile's reason line says. Profiles are public in this
--                     app (STRUCTURE.md), so this exposes nothing a profile
--                     search would not.
--
-- The `source` column travels to the client because the tile's reason line
-- cannot be derived from the counts alone: an 'active' candidate has
-- mutual_count = 0 AND play_count = 0, which the rail's existing
-- `play_count > 0 ? "Played with" : "Mutual buddy"` would render as a false
-- "Mutual buddy". The tier is the label.
--
-- Exclusions, matching 057 and adding one:
--   • anyone on ANY existing edge with the viewer (accepted, pending, blocked)
--   • the viewer themselves
--   • candidates with no profile row
--   • NEW: profiles still carrying needs_setup — an account that has not been
--     through the modal one screen earlier still has the email local-part as
--     its display name and the default badge. Suggesting those to a new user
--     is how a discovery screen ends up full of "jsmith84" placeholders.
--
-- Re-runnable. No table changes.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.bgb_onboarding_buddy_suggestions(UUID, INT, INT);

CREATE FUNCTION public.bgb_onboarding_buddy_suggestions(
  uid UUID,
  lim INT DEFAULT 12,
  active_window_days INT DEFAULT 90
)
RETURNS TABLE (
  user_id      UUID,
  mutual_count BIGINT,
  play_count   BIGINT,
  source       TEXT
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
  -- Same visibility rule as bgb_suggested_buddies / bgb_play_partners: plays
  -- the viewer logged, plus plays the viewer was a player in.
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
  graph AS (
    SELECT
      COALESCE(m.candidate, w.candidate) AS candidate,
      COALESCE(m.n, 0) AS mutuals,
      COALESCE(w.n, 0) AS plays
    FROM mutuals m
    FULL OUTER JOIN played_with w ON w.candidate = m.candidate
  ),
  -- Suggestable at all: a real, set-up profile that is neither the viewer nor
  -- already connected to them. Both tiers below draw from this.
  eligible AS (
    SELECT pr.id, pr.created_at
      FROM public.boardgamebuddy_profiles pr
     WHERE pr.id <> uid
       AND pr.needs_setup IS NOT TRUE
       AND pr.id NOT IN (SELECT c.other_id FROM connected c)
  ),
  tier_graph AS (
    SELECT
      e.id                AS user_id,
      g.mutuals           AS mutual_count,
      g.plays             AS play_count,
      'graph'::TEXT       AS source,
      0                   AS tier,
      -- Played-with outranks a graph path, most plays first (057's rule).
      ROW_NUMBER() OVER (
        ORDER BY (g.plays > 0) DESC, g.plays DESC, g.mutuals DESC, e.id
      )                   AS rank_in_tier
    FROM graph g
    JOIN eligible e ON e.id = g.candidate
    WHERE g.mutuals > 0 OR g.plays > 0
  ),
  -- Plays LOGGED in the window, by whoever logged them. Deliberately not the
  -- participated-in union used above: this is "who is running game nights",
  -- and a play counts once for the account that put it in the app.
  recent_activity AS (
    SELECT p.user_id AS candidate, COUNT(*)::BIGINT AS n
      FROM public.boardgamebuddy_plays p
     WHERE p.created_at >= now() - make_interval(days => GREATEST(active_window_days, 1))
     GROUP BY p.user_id
  ),
  tier_active AS (
    SELECT
      e.id                          AS user_id,
      0::BIGINT                     AS mutual_count,
      0::BIGINT                     AS play_count,
      'active'::TEXT                AS source,
      1                             AS tier,
      -- Most active first; newest accounts break ties, so a quiet community
      -- still surfaces the people who just arrived rather than the same
      -- alphabetical head every time.
      ROW_NUMBER() OVER (
        ORDER BY COALESCE(ra.n, 0) DESC, e.created_at DESC, e.id
      )                             AS rank_in_tier
    FROM eligible e
    LEFT JOIN recent_activity ra ON ra.candidate = e.id
    WHERE e.id NOT IN (SELECT tg.user_id FROM tier_graph tg)
  )
  SELECT t.user_id, t.mutual_count, t.play_count, t.source
    FROM (
      SELECT * FROM tier_graph
      UNION ALL
      SELECT * FROM tier_active
    ) t
   ORDER BY t.tier, t.rank_in_tier
   LIMIT lim;
$$;

GRANT EXECUTE ON FUNCTION public.bgb_onboarding_buddy_suggestions(UUID, INT, INT)
  TO boardgamebuddy_role;
