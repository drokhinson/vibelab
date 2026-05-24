-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — bootstrap bundle for first-paint client cache
--
-- One round-trip after auth instead of the current N parallel calls. The FE
-- writes everything in here straight into its localStorage-backed cache and
-- only re-fetches in chunks (stale-while-revalidate, on tab focus) thereafter.
--
-- Scope: cold-load only. Pagination and filter changes still hit the existing
-- per-domain endpoints. Background refresh of feed / stats / collection runs
-- independently — bootstrap is not the live-update path.
--
-- Composition strategy: this RPC handles two things that genuinely need SQL —
--   1. The full ProfileSelf bundle (delegated to bgb_profile_bundle).
--   2. game_detail_bundles: one bgb_game_detail_bundle row per owned game,
--      aggregated into a single jsonb_object keyed by game_id. Doing this in
--      SQL is what avoids ~50 round trips on the FE.
-- The feed first page is composed in Python (feed_service.build_feed_page)
-- because the Hot Games / Suggested Buddies / Featured-From-Collection
-- interspersing already lives there and shouldn't be duplicated in SQL.
--
-- bootstrap_version is a small integer the FE compares to its own constant —
-- any change here forces the cache to wipe and rehydrate.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;


CREATE OR REPLACE FUNCTION public.bgb_bootstrap(
  viewer UUID,
  owned_plays_limit INT DEFAULT 5,
  max_game_bundles INT DEFAULT 250
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_user JSONB;
  v_profile_bundle JSONB;
  v_game_bundles JSONB;
  v_owned_count INT;
  v_truncated BOOLEAN := false;
BEGIN
  -- Current user row.
  SELECT to_jsonb(p.*) INTO v_current_user
    FROM boardgamebuddy_profiles p
    WHERE p.id = viewer;

  -- Profile bundle (stats, shelves, recent plays, status map, buddies,
  -- requests) for the viewer looking at themselves.
  v_profile_bundle := bgb_profile_bundle(viewer, viewer, 12, 10);

  -- Owned-game count first so we can mark `truncated` without blowing past
  -- the cap. Base games only — expansions are surfaced via the base game's
  -- bundle.expansions block.
  SELECT COUNT(*) INTO v_owned_count
    FROM boardgamebuddy_collections c
    WHERE c.user_id = viewer
      AND c.status = 'owned'
      AND COALESCE(c.game_is_expansion, false) = false;

  IF v_owned_count > max_game_bundles THEN
    v_truncated := true;
  END IF;

  -- The key new piece: bulk game-detail bundles for everything the viewer
  -- owns, aggregated into one JSONB object keyed by game_id. The FE seeds
  -- its 'game.bundle' namespace with this so opening any owned game's detail
  -- view is instant for the rest of the session.
  WITH owned AS (
    SELECT c.game_id
    FROM boardgamebuddy_collections c
    WHERE c.user_id = viewer
      AND c.status = 'owned'
      AND COALESCE(c.game_is_expansion, false) = false
    ORDER BY c.added_at DESC
    LIMIT max_game_bundles
  )
  SELECT COALESCE(jsonb_object_agg(o.game_id::text, bgb_game_detail_bundle(o.game_id, viewer, owned_plays_limit)), '{}'::jsonb)
    INTO v_game_bundles
    FROM owned o;

  RETURN jsonb_build_object(
    'bootstrap_version', 1,
    'generated_at', now(),
    'current_user', v_current_user,
    'profile_bundle', v_profile_bundle,
    'game_detail_bundles', v_game_bundles,
    'owned_count', v_owned_count,
    'truncated', v_truncated
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.bgb_bootstrap(UUID, INT, INT) TO boardgamebuddy_role;

COMMIT;
