-- 050_ghost_rpcs_and_status_map.sql — three reads/writes that scaled with the
-- viewer's whole history get bounded.
--
-- 1+2. bgb_link_ghost / bgb_merge_ghosts
--
-- Both used to SELECT every play id the viewer owns, pull the list into
-- Python, and hand it straight back to PostgREST as an `in_` filter.
-- PostgREST puts filters in the QUERY STRING, so at ~37 bytes per UUID a few
-- hundred plays is a multi-kilobyte URL and a few thousand fails outright
-- (414 / proxy header limit). That does not degrade — it stops working, and
-- only for the users with the most history. Migration 047 removed exactly
-- this "pull every play id into Python" pass from /play-partners; it survived
-- here untouched. PostgREST cannot express a subquery in an UPDATE's WHERE,
-- so this has to be SQL.
--
-- 3. bgb_collection_status_map
--
-- GET /collection cost three unbounded round trips — the whole collection
-- with a games join, bgb_play_stats over the viewer's entire visible play
-- history, then an IN-query to hydrate played-not-owned games — to build two
-- small dicts. Its only consumer (web/domain/collection.js) reads four
-- fields and discards the rest, including the play stats that were the sole
-- reason for round trip 2. It re-fires roughly once a minute of active
-- navigation, from Feed, Collection, Wishlist, Explorer, Game Detail and
-- bootstrap, and round trip 2 grew with the viewer's TOTAL VISIBLE plays,
-- which grows with their buddies' logging too.
--
-- GET /collection itself is left alone — the native app consumes its response
-- shape (app/src/api/client.js) and as its bootstrap fallback. The web client
-- moves to GET /collection/status-map, backed by this function.
--
-- No schema change; new functions only.

BEGIN;

-- ── 1. Link every ghost row matching a name to a real account ────────────────
CREATE OR REPLACE FUNCTION public.bgb_link_ghost(
  p_viewer UUID,
  p_display_name TEXT,
  p_target UUID
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM boardgamebuddy_profiles WHERE id = p_target) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- ilike with no wildcards == case-insensitive exact match, matching the
  -- Python this replaces. Scoped to plays the viewer owns, so a caller can
  -- never touch someone else's roster.
  UPDATE boardgamebuddy_play_players pp
     SET player_user_id = p_target
   WHERE pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_viewer
         )
     AND pp.player_display_name ILIKE p_display_name
     AND pp.player_user_id IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_updated);
END;
$$;

-- ── 2. Collapse two spellings of the same ghost into one ────────────────────
CREATE OR REPLACE FUNCTION public.bgb_merge_ghosts(
  p_viewer UUID,
  p_source TEXT,
  p_target TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE boardgamebuddy_play_players pp
     SET player_display_name = p_target
   WHERE pp.play_id IN (
           SELECT id FROM boardgamebuddy_plays WHERE user_id = p_viewer
         )
     AND pp.player_display_name ILIKE p_source
     AND pp.player_user_id IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_updated);
END;
$$;

-- ── 3. The viewer's status map + owned-expansion counts, in one read ────────
CREATE OR REPLACE FUNCTION public.bgb_collection_status_map(p_viewer UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status_map JSONB;
  v_expansion_counts JSONB;
BEGIN
  -- Collection rows first, then a derived 'played' entry for every game the
  -- viewer has a play for and no collection row on. Matches GET /collection's
  -- semantics: there, owned/wishlist rows come from the table and played rows
  -- are synthesized for games with plays but no owned row.
  --
  -- The visibility rule for "has a play" is the participated-in one shared by
  -- bgb_play_stats (039) and fixed across the board in 045: a play counts when
  -- the viewer logged it OR appears on it as a participant. EXISTS rather than
  -- a join, so a multi-player play can't fan out.
  SELECT COALESCE(jsonb_object_agg(game_id, status), '{}'::jsonb)
    INTO v_status_map
    FROM (
      SELECT c.game_id::TEXT AS game_id, c.status AS status
      FROM boardgamebuddy_collections c
      WHERE c.user_id = p_viewer
        AND c.status IN ('owned', 'wishlist', 'played')
      UNION
      SELECT DISTINCT p.game_id::TEXT, 'played'::TEXT
      FROM boardgamebuddy_plays p
      WHERE (
              p.user_id = p_viewer
              OR EXISTS (
                   SELECT 1 FROM boardgamebuddy_play_players pp
                   WHERE pp.play_id = p.id AND pp.player_user_id = p_viewer
                 )
            )
        AND NOT EXISTS (
              SELECT 1 FROM boardgamebuddy_collections c2
              WHERE c2.user_id = p_viewer AND c2.game_id = p.game_id
            )
    ) m;

  -- Owned expansions per base game's bgg_id. Reads the denormalized game_*
  -- columns (migration 020), so no join to boardgamebuddy_games at all.
  -- Identical to bgb_profile_bundle's expansion_counts block (045:359-369).
  SELECT COALESCE(jsonb_object_agg(base_bgg, cnt), '{}'::jsonb)
    INTO v_expansion_counts
    FROM (
      SELECT c.game_base_game_bgg_id AS base_bgg, COUNT(*)::INT AS cnt
      FROM boardgamebuddy_collections c
      WHERE c.user_id = p_viewer
        AND c.status = 'owned'
        AND COALESCE(c.game_is_expansion, false) = true
        AND c.game_base_game_bgg_id IS NOT NULL
      GROUP BY c.game_base_game_bgg_id
    ) e;

  RETURN jsonb_build_object(
    'status_map', v_status_map,
    'expansion_counts', v_expansion_counts
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.bgb_link_ghost(UUID, TEXT, UUID) TO boardgamebuddy_role;
GRANT EXECUTE ON FUNCTION public.bgb_merge_ghosts(UUID, TEXT, TEXT) TO boardgamebuddy_role;
GRANT EXECUTE ON FUNCTION public.bgb_collection_status_map(UUID) TO boardgamebuddy_role;

COMMIT;
