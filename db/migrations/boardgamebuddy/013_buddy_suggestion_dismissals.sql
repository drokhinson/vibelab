-- 013_buddy_suggestion_dismissals.sql — "not interested" on a suggested buddy.
--
-- The three suggestion surfaces (the Feed rail, the Buddies screen's rail, and
-- the Add-buddies card) all offer people the viewer is not connected to. Until
-- now the only way to make one of them go away was to add them, so a suggestion
-- the viewer had already decided against came back on every single visit — the
-- same failure ui/ghost-claim-suggestions.js argues against, and the reason
-- "Not me" exists on the ghost-claim list beside it.
--
-- A dismissal is PER VIEWER and one-directional. It says nothing about the
-- person dismissed, is never shown to them, and does not block anything: they
-- can still find the viewer, still send them a request, and still turn up in
-- /profiles/search. It only removes them from the lists this app volunteers.
--
-- No `id` column: the pair IS the identity. Every read is "everyone this viewer
-- dismissed" and every write addresses one pair, both of which the primary key
-- serves, so a surrogate key would buy a second unique index and nothing else.
--
-- ON DELETE CASCADE on both sides, so a deleted account takes its dismissals
-- with it in either direction — a row naming a profile that is gone would
-- filter nothing and outlive the person it was about.

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_buddy_suggestion_dismissals (
  user_id UUID NOT NULL,
  dismissed_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_buddy_suggestion_dismissals_pkey
    PRIMARY KEY (user_id, dismissed_user_id),
  CONSTRAINT bgb_suggestion_dismissals_user_fkey
    FOREIGN KEY (user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE,
  CONSTRAINT bgb_suggestion_dismissals_dismissed_fkey
    FOREIGN KEY (dismissed_user_id) REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE,
  CONSTRAINT bgb_suggestion_dismissals_not_self CHECK ((user_id <> dismissed_user_id))
);
ALTER TABLE public.boardgamebuddy_buddy_suggestion_dismissals ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_buddy_suggestion_dismissals TO boardgamebuddy_role;

COMMENT ON TABLE public.boardgamebuddy_buddy_suggestion_dismissals IS
  'Per-viewer "stop suggesting this person". Read by the three suggestion RPCs below; never shown to dismissed_user_id and never a block. Cleared when the viewer sends that person a buddy request, so an accidental tap is undone by the act that contradicts it.';


-- ── bgb_suggested_buddies ─────────────────────────────────────────────────────
-- Re-emitted from 003_rpcs.sql:2969 with ONE change: the new `dismissed` CTE
-- and the matching NOT IN below. Signature and return type are untouched, so
-- this is a CREATE OR REPLACE (body only) and the existing GRANT survives —
-- the GRANT is restated anyway, because it is a no-op when it is already there
-- and the one thing a future reader must not have to go and check.
CREATE OR REPLACE FUNCTION public.bgb_suggested_buddies(uid uuid, lim integer DEFAULT 5)
 RETURNS TABLE(user_id uuid, mutual_count bigint, play_count bigint, pending_mutual_count bigint, via_user_id uuid)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH my_edges AS (
    SELECT be.user_a, be.user_b, be.status, be.requested_by
      FROM public.boardgamebuddy_buddy_edges be
     WHERE uid IN (be.user_a, be.user_b)
  ),
  -- Anyone already linked to the viewer in any way: accepted, pending in
  -- either direction, or blocked. None of them are suggestable.
  connected AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS other_id
      FROM my_edges me
  ),
  -- NEW here. People the viewer has said "not interested" about. A separate
  -- CTE from `connected` on purpose: they are not connected, they are refused,
  -- and folding the two would make the exclusion above read as something it is
  -- not the next time somebody changes it.
  dismissed AS (
    SELECT d.dismissed_user_id AS other_id
      FROM public.boardgamebuddy_buddy_suggestion_dismissals d
     WHERE d.user_id = uid
  ),
  my_buddies AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS friend_id
      FROM my_edges me
     WHERE me.status = 'accepted'
  ),
  -- The people the viewer has ASKED and who have not answered. An incoming
  -- request is not in here: someone else's interest in the viewer says
  -- nothing about who the viewer knows.
  my_requested AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS target_id
      FROM my_edges me
     WHERE me.status = 'pending' AND me.requested_by = uid
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
    SELECT fof.candidate,
           COUNT(DISTINCT fof.friend_id)::BIGINT AS n,
           -- Postgres has no min(uuid); array_agg + [1] is the deterministic
           -- "pick one" and reads as the choice it is.
           (ARRAY_AGG(fof.friend_id ORDER BY fof.friend_id))[1] AS via_any
      FROM fof
     GROUP BY fof.candidate
  ),
  -- The same hop, one status weaker on the first leg only.
  fof_pending AS (
    SELECT
      CASE WHEN be.user_a = mr.target_id THEN be.user_b ELSE be.user_a END AS candidate,
      mr.target_id AS via
    FROM my_requested mr
    JOIN public.boardgamebuddy_buddy_edges be
      ON be.status = 'accepted'
     AND mr.target_id IN (be.user_a, be.user_b)
  ),
  pending_mutuals AS (
    SELECT fof_pending.candidate,
           COUNT(DISTINCT fof_pending.via)::BIGINT AS n,
           (ARRAY_AGG(fof_pending.via ORDER BY fof_pending.via))[1] AS via_any
      FROM fof_pending
     GROUP BY fof_pending.candidate
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
  -- Three sources now, so the FULL OUTER JOIN 057 used becomes a union of ids
  -- with the counts hung off it. Same result for the two it used to join.
  candidate_ids AS (
    SELECT candidate FROM mutuals
    UNION
    SELECT candidate FROM pending_mutuals
    UNION
    SELECT candidate FROM played_with
  ),
  candidates AS (
    SELECT
      ci.candidate,
      COALESCE(m.n, 0)  AS mutuals,
      COALESCE(w.n, 0)  AS plays,
      COALESCE(pm.n, 0) AS pending_mutuals,
      -- An accepted link explains the suggestion better than a pending one.
      COALESCE(m.via_any, pm.via_any) AS via_user_id
    FROM candidate_ids ci
    LEFT JOIN mutuals         m  ON m.candidate  = ci.candidate
    LEFT JOIN pending_mutuals pm ON pm.candidate = ci.candidate
    LEFT JOIN played_with     w  ON w.candidate  = ci.candidate
  )
  SELECT c.candidate, c.mutuals, c.plays, c.pending_mutuals, c.via_user_id
    FROM candidates c
    JOIN public.boardgamebuddy_profiles pr ON pr.id = c.candidate
   WHERE c.candidate <> uid
     AND pr.needs_setup IS NOT TRUE          -- added in 066
     AND c.candidate NOT IN (SELECT x.other_id FROM connected x)
     AND c.candidate NOT IN (SELECT x.other_id FROM dismissed x)   -- added in 013 (this file)
     AND (c.mutuals > 0 OR c.plays > 0 OR c.pending_mutuals > 0)
   -- Earned signals keep their order; the new one sorts below both, because a
   -- request nobody has answered is the weakest thing in the list.
   ORDER BY (c.plays > 0) DESC, c.plays DESC, c.mutuals DESC,
            c.pending_mutuals DESC, c.candidate
   LIMIT lim;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_suggested_buddies(uid uuid, lim integer) TO boardgamebuddy_role;


-- ── bgb_onboarding_buddy_suggestions ──────────────────────────────────────────
-- Re-emitted from 003_rpcs.sql:3089, same one change. The filter goes on
-- `eligible`, which is the shared floor both tiers draw from — so a dismissal
-- removes the person from the earned-signal tier AND from the recently-active
-- fallback, rather than hiding them from one list and offering them in the
-- other two screens later.
CREATE OR REPLACE FUNCTION public.bgb_onboarding_buddy_suggestions(uid uuid, lim integer DEFAULT 12, active_window_days integer DEFAULT 90)
 RETURNS TABLE(user_id uuid, mutual_count bigint, play_count bigint, pending_mutual_count bigint, via_user_id uuid, source text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH my_edges AS (
    SELECT be.user_a, be.user_b, be.status, be.requested_by
      FROM public.boardgamebuddy_buddy_edges be
     WHERE uid IN (be.user_a, be.user_b)
  ),
  connected AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS other_id
      FROM my_edges me
  ),
  -- NEW here — see bgb_suggested_buddies above.
  dismissed AS (
    SELECT d.dismissed_user_id AS other_id
      FROM public.boardgamebuddy_buddy_suggestion_dismissals d
     WHERE d.user_id = uid
  ),
  my_buddies AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS friend_id
      FROM my_edges me
     WHERE me.status = 'accepted'
  ),
  my_requested AS (
    SELECT CASE WHEN me.user_a = uid THEN me.user_b ELSE me.user_a END AS target_id
      FROM my_edges me
     WHERE me.status = 'pending' AND me.requested_by = uid
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
    SELECT fof.candidate,
           COUNT(DISTINCT fof.friend_id)::BIGINT AS n,
           -- Postgres has no min(uuid); array_agg + [1] is the deterministic
           -- "pick one" and reads as the choice it is.
           (ARRAY_AGG(fof.friend_id ORDER BY fof.friend_id))[1] AS via_any
      FROM fof
     GROUP BY fof.candidate
  ),
  fof_pending AS (
    SELECT
      CASE WHEN be.user_a = mr.target_id THEN be.user_b ELSE be.user_a END AS candidate,
      mr.target_id AS via
    FROM my_requested mr
    JOIN public.boardgamebuddy_buddy_edges be
      ON be.status = 'accepted'
     AND mr.target_id IN (be.user_a, be.user_b)
  ),
  pending_mutuals AS (
    SELECT fof_pending.candidate,
           COUNT(DISTINCT fof_pending.via)::BIGINT AS n,
           (ARRAY_AGG(fof_pending.via ORDER BY fof_pending.via))[1] AS via_any
      FROM fof_pending
     GROUP BY fof_pending.candidate
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
  candidate_ids AS (
    SELECT candidate FROM mutuals
    UNION
    SELECT candidate FROM pending_mutuals
    UNION
    SELECT candidate FROM played_with
  ),
  graph AS (
    SELECT
      ci.candidate,
      COALESCE(m.n, 0)  AS mutuals,
      COALESCE(w.n, 0)  AS plays,
      COALESCE(pm.n, 0) AS pending_mutuals,
      COALESCE(m.via_any, pm.via_any) AS via_user_id
    FROM candidate_ids ci
    LEFT JOIN mutuals         m  ON m.candidate  = ci.candidate
    LEFT JOIN pending_mutuals pm ON pm.candidate = ci.candidate
    LEFT JOIN played_with     w  ON w.candidate  = ci.candidate
  ),
  -- Suggestable at all: a real, set-up profile that is neither the viewer,
  -- already connected to them, nor someone they have dismissed. Both tiers
  -- below draw from this.
  eligible AS (
    SELECT pr.id, pr.created_at
      FROM public.boardgamebuddy_profiles pr
     WHERE pr.id <> uid
       AND pr.needs_setup IS NOT TRUE
       AND pr.id NOT IN (SELECT c.other_id FROM connected c)
       AND pr.id NOT IN (SELECT d.other_id FROM dismissed d)   -- added in 013 (this file)
  ),
  tier_graph AS (
    SELECT
      e.id                AS user_id,
      g.mutuals           AS mutual_count,
      g.plays             AS play_count,
      g.pending_mutuals   AS pending_mutual_count,
      g.via_user_id       AS via_user_id,
      'graph'::TEXT       AS source,
      0                   AS tier,
      -- Played-with outranks a graph path, most plays first (057's rule);
      -- a request nobody has answered yet sorts under both (072's).
      ROW_NUMBER() OVER (
        ORDER BY (g.plays > 0) DESC, g.plays DESC, g.mutuals DESC,
                 g.pending_mutuals DESC, e.id
      )                   AS rank_in_tier
    FROM graph g
    JOIN eligible e ON e.id = g.candidate
    WHERE g.mutuals > 0 OR g.plays > 0 OR g.pending_mutuals > 0
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
      0::BIGINT                     AS pending_mutual_count,
      NULL::UUID                    AS via_user_id,
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
  SELECT t.user_id, t.mutual_count, t.play_count,
         t.pending_mutual_count, t.via_user_id, t.source
    FROM (
      SELECT * FROM tier_graph
      UNION ALL
      SELECT * FROM tier_active
    ) t
   ORDER BY t.tier, t.rank_in_tier
   LIMIT lim;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_onboarding_buddy_suggestions(uid uuid, lim integer, active_window_days integer) TO boardgamebuddy_role;


-- ── bgb_onboarding_suggestion_network ─────────────────────────────────────────
-- Re-emitted from 003_rpcs.sql:3253, same one change. This is the second hop
-- the onboarding deck promotes into its grid on a tick, so without the filter a
-- dismissed person would be gone from the first paint and then appear the
-- moment the user ticked one of their buddies.
CREATE OR REPLACE FUNCTION public.bgb_onboarding_suggestion_network(uid uuid, seed_ids uuid[], per_seed integer DEFAULT 6, lim integer DEFAULT 48)
 RETURNS TABLE(via_user_id uuid, user_id uuid, buddy_count bigint, rank_in_seed integer)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH seeds AS (
    SELECT DISTINCT s.seed_id
      FROM unnest(COALESCE(seed_ids, ARRAY[]::UUID[])) AS s(seed_id)
     WHERE s.seed_id IS NOT NULL
  ),
  connected AS (
    SELECT CASE WHEN be.user_a = uid THEN be.user_b ELSE be.user_a END AS other_id
      FROM public.boardgamebuddy_buddy_edges be
     WHERE uid IN (be.user_a, be.user_b)
  ),
  -- NEW here — see bgb_suggested_buddies above.
  dismissed AS (
    SELECT d.dismissed_user_id AS other_id
      FROM public.boardgamebuddy_buddy_suggestion_dismissals d
     WHERE d.user_id = uid
  ),
  -- One row per (seed, person the seed has accepted).
  hops AS (
    SELECT
      s.seed_id AS via,
      CASE WHEN be.user_a = s.seed_id THEN be.user_b ELSE be.user_a END AS candidate
    FROM seeds s
    JOIN public.boardgamebuddy_buddy_edges be
      ON be.status = 'accepted'
     AND s.seed_id IN (be.user_a, be.user_b)
  ),
  -- How connected each candidate is in their own right — the rank inside a
  -- seed, and a number the client can show if it ever wants to. Counted off
  -- the DISTINCT candidate set: a person reachable from three seeds appears
  -- three times in hops, and counting from there would treble their edges.
  hop_candidates AS (
    SELECT DISTINCT h.candidate FROM hops h
  ),
  buddy_counts AS (
    SELECT hc.candidate, COUNT(*)::BIGINT AS n
      FROM hop_candidates hc
      JOIN public.boardgamebuddy_buddy_edges be
        ON be.status = 'accepted'
       AND hc.candidate IN (be.user_a, be.user_b)
     GROUP BY hc.candidate
  ),
  ranked AS (
    SELECT
      h.via,
      h.candidate,
      COALESCE(bc.n, 0) AS n,
      ROW_NUMBER() OVER (
        PARTITION BY h.via
        ORDER BY COALESCE(bc.n, 0) DESC, h.candidate
      )::INT AS rank_in_seed
    FROM hops h
    JOIN public.boardgamebuddy_profiles pr ON pr.id = h.candidate
    LEFT JOIN buddy_counts bc ON bc.candidate = h.candidate
    WHERE h.candidate <> uid
      AND pr.needs_setup IS NOT TRUE
      AND h.candidate NOT IN (SELECT c.other_id FROM connected c)
      AND h.candidate NOT IN (SELECT d.other_id FROM dismissed d)   -- added in 013 (this file)
      AND h.candidate NOT IN (SELECT s.seed_id FROM seeds s)
  )
  SELECT r.via, r.candidate, r.n, r.rank_in_seed
    FROM ranked r
   WHERE r.rank_in_seed <= GREATEST(per_seed, 1)
   ORDER BY r.rank_in_seed, r.n DESC, r.via, r.candidate
   LIMIT lim;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_onboarding_suggestion_network(uid uuid, seed_ids uuid[], per_seed integer, lim integer) TO boardgamebuddy_role;
