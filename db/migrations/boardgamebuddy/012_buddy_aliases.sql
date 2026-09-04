-- 012_buddy_aliases.sql — private per-viewer nicknames for buddies.
--
-- A user can rename one of their buddies so two similar display names stop
-- reading as the same person. The alias is visible ONLY to the person who set
-- it: it is never shown to the buddy it names, and it is never written into any
-- shared row (see set_alias in services/buddy_service.py and the
-- player_display_name guards in the web client).
--
-- TWO columns rather than one, because the edge is canonical and undirected:
-- bgb_buddy_edges_canonical forces user_a < user_b, so "the alias I set" is not
-- a property of the ROW, it is a property of which SIDE of the row you are on.
-- One shared column would be read by both parties and would leak the moment
-- either of them opened Buddies.
--
-- No index: the columns are never a predicate, only a projection off a row
-- already located by id or by the existing (user_a|user_b, status) indexes.
-- No new RLS statement and no new GRANT — both are table-level and already
-- cover new columns (001_baseline.sql:351-352).

ALTER TABLE public.boardgamebuddy_buddy_edges
  ADD COLUMN IF NOT EXISTS alias_by_a TEXT,
  ADD COLUMN IF NOT EXISTS alias_by_b TEXT;

COMMENT ON COLUMN public.boardgamebuddy_buddy_edges.alias_by_a IS
  'Private nickname user_a set FOR user_b. Read only when the viewer is user_a; never returned to user_b. NULL = no alias — the endpoint trims and treats empty as a clear, so '''' never reaches the row.';

COMMENT ON COLUMN public.boardgamebuddy_buddy_edges.alias_by_b IS
  'Private nickname user_b set FOR user_a. Mirror of alias_by_a; see that column. Which of the pair applies is decided by the viewer, not by the row.';


-- ── bgb_play_partners ─────────────────────────────────────────────────────────
-- Re-emitted from 003_rpcs.sql:2344 with ONE added key: 'other_alias' on each
-- accounts entry. Postgres has no "add a key to a function's jsonb output", so
-- the whole body is restated; nothing else about it changed.
--
-- The alias is added to `accounts` and deliberately NOT to `recent`. Every
-- accepted buddy is already in accounts, and toPlayerCandidates
-- (web/domain/buddy.js) dedupes accounts before recents, so a recent row that
-- survives to the picker is by definition not a buddy and has no alias to show.
--
-- a_sort stays lower(pr.display_name). Ordering by the alias here would make
-- this RPC disagree with GET /buddies, which sorts in Python; the client
-- re-sorts for display either way.
CREATE OR REPLACE FUNCTION public.bgb_play_partners(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_accounts JSONB;
  v_ghosts JSONB;
  v_recent JSONB;
BEGIN
  -- accounts: accepted mutual edges, from the viewer's side.
  SELECT COALESCE(jsonb_agg(a ORDER BY a_sort), '[]'::jsonb)
    INTO v_accounts
    FROM (
      SELECT jsonb_build_object(
               'id', e.id,
               'other_user_id', pr.id,
               'other_display_name', pr.display_name,
               'other_username', pr.username,
               'other_avatar', pr.avatar,
               -- NEW in 012: the viewer's own private alias for this buddy,
               -- off whichever side of the canonical row the viewer sits on.
               -- NULL for the other party by construction — a per-viewer
               -- projection, not a property of the edge.
               'other_alias',
                 CASE WHEN e.user_a = p_viewer THEN e.alias_by_a ELSE e.alias_by_b END,
               'accepted_at', e.accepted_at,
               'created_at', e.created_at
             ) AS a,
             lower(pr.display_name) AS a_sort
        FROM boardgamebuddy_buddy_edges e
        JOIN boardgamebuddy_profiles pr
          ON pr.id = CASE WHEN e.user_a = p_viewer THEN e.user_b ELSE e.user_a END
       WHERE e.status = 'accepted'
         AND (e.user_a = p_viewer OR e.user_b = p_viewer)
    ) s;

  -- ghosts: free-text names from the viewer's OWN plays, grouped
  -- case-sensitively on the trimmed name.
  SELECT COALESCE(jsonb_agg(g ORDER BY g_count DESC, g_sort), '[]'::jsonb)
    INTO v_ghosts
    FROM (
      SELECT jsonb_build_object(
               'display_name', btrim(pp.player_display_name),
               'play_count', COUNT(*),
               'last_played_at', MAX(p.played_at)
             ) AS g,
             COUNT(*) AS g_count,
             lower(btrim(pp.player_display_name)) AS g_sort
        FROM boardgamebuddy_plays p
        JOIN boardgamebuddy_play_players pp ON pp.play_id = p.id
       WHERE p.user_id = p_viewer
         AND pp.player_user_id IS NULL
         AND btrim(COALESCE(pp.player_display_name, '')) <> ''
       GROUP BY btrim(pp.player_display_name)
    ) s;

  -- recent: real accounts sharing a play with the viewer, ranked by how many.
  -- Visibility matches bgb_play_stats — plays the viewer logged, plus plays
  -- they appear in. Relation flags come from the same pass rather than the
  -- second query _relations_for_viewer used to run.
  WITH visible_plays AS (
    SELECT p.id FROM boardgamebuddy_plays p WHERE p.user_id = p_viewer
    UNION
    SELECT pp.play_id
      FROM boardgamebuddy_play_players pp
     WHERE pp.player_user_id = p_viewer
  ),
  counts AS (
    SELECT pp.player_user_id AS uid, COUNT(*) AS play_count
      FROM boardgamebuddy_play_players pp
      JOIN visible_plays v ON v.id = pp.play_id
     WHERE pp.player_user_id IS NOT NULL
       AND pp.player_user_id <> p_viewer
     GROUP BY pp.player_user_id
  )
  SELECT COALESCE(jsonb_agg(r ORDER BY r_count DESC, r_sort), '[]'::jsonb)
    INTO v_recent
    FROM (
      SELECT jsonb_build_object(
               'user_id', pr.id,
               'display_name', pr.display_name,
               'avatar', pr.avatar,
               'play_count', c.play_count,
               'is_buddy', COALESCE(e.status = 'accepted', FALSE),
               'has_pending_request', COALESCE(e.status = 'pending', FALSE),
               'pending_request_direction',
                 CASE WHEN e.status = 'pending'
                      THEN CASE WHEN e.requested_by = p_viewer THEN 'outgoing' ELSE 'incoming' END
                 END,
               -- NEW in 060: the edge id, so the row can cancel an outgoing
               -- request (or accept an incoming one) without first fetching
               -- /buddies/requests to look it up by other_user_id.
               'pending_request_id',
                 CASE WHEN e.status = 'pending' THEN e.id END
             ) AS r,
             c.play_count AS r_count,
             lower(pr.display_name) AS r_sort
        FROM counts c
        -- Inner join: a co-player with no profile row is dropped, as the
        -- Python did when the profile lookup came back empty.
        JOIN boardgamebuddy_profiles pr ON pr.id = c.uid
        LEFT JOIN boardgamebuddy_buddy_edges e
          ON ((e.user_a = p_viewer AND e.user_b = c.uid)
           OR (e.user_b = p_viewer AND e.user_a = c.uid))
         AND e.status IN ('accepted', 'pending')
    ) s;

  RETURN jsonb_build_object(
    'accounts', v_accounts,
    'ghosts', v_ghosts,
    'recent', v_recent
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_play_partners(p_viewer uuid) TO boardgamebuddy_role;
