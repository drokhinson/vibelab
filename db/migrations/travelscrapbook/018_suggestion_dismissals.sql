-- ─────────────────────────────────────────────────────────────────────────────
-- travelscrapbook — sticky-resolved suggestions (018)
--
-- The "Suggested plans" (candidates) panel is a stateless recomputation on every
-- trip load: the viewer's unvisited places that match the trip's scope and are
-- NOT already a member. So the moment a user removes a place from a trip, it
-- re-qualifies and pops up as a suggestion again — even though the user just
-- decided against it.
--
-- Fix: a durable per-(scrap, trip) "the user already resolved this suggestion"
-- marker that SURVIVES membership deletion (the scrap_trips row is hard-deleted
-- on removal, so it can't carry this). The backend writes a dismissal on every
-- membership removal; the candidates query (here + plan_routes.list_trip_candidates)
-- excludes dismissed pairs.
--
-- Service-role-only (backend uses SUPABASE_SERVICE_ROLE_KEY): RLS enabled with
-- no policies + SELECT granted to travelscrapbook_role (mirrors 013). Idempotent.
-- Depends on: 013 (scrap_trips), 015 (travelscrapbook_trip_bundle).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Dismissal marker: the user has explicitly decided this place's fate for
--    this trip (kept then removed, or removed outright). Presence = "don't
--    auto-suggest this pair again". Cascades away with the scrap or the trip.
CREATE TABLE IF NOT EXISTS public.travelscrapbook_scrap_trip_dismissals (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scrap_id   UUID        NOT NULL REFERENCES public.travelscrapbook_scraps(id) ON DELETE CASCADE,
  trip_id    UUID        NOT NULL REFERENCES public.travelscrapbook_trips(id)  ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scrap_id, trip_id)
);
CREATE INDEX IF NOT EXISTS idx_ts_scrap_trip_dismissals_trip
  ON public.travelscrapbook_scrap_trip_dismissals(trip_id);   -- candidate exclusion
ALTER TABLE public.travelscrapbook_scrap_trip_dismissals ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.travelscrapbook_scrap_trip_dismissals TO travelscrapbook_role;


-- 2. Re-declare travelscrapbook_trip_bundle so its candidates query also
--    excludes dismissed (scrap, trip) pairs. Body is identical to 015 except
--    for the added NOT EXISTS guard on the candidates CTE (marked below).
CREATE OR REPLACE FUNCTION public.travelscrapbook_trip_bundle(
  p_trip_id UUID,
  p_viewer UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip travelscrapbook_trips%ROWTYPE;
  v_role TEXT;
  v_candidates JSONB := '[]'::jsonb;
BEGIN
  SELECT * INTO v_trip FROM travelscrapbook_trips WHERE id = p_trip_id;
  IF v_trip.id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_trip.user_id = p_viewer THEN
    v_role := 'owner';
  ELSE
    SELECT tm.role INTO v_role
    FROM travelscrapbook_trip_members tm
    WHERE tm.trip_id = p_trip_id AND tm.user_id = p_viewer AND tm.status = 'accepted';
    IF v_role IS NULL THEN
      RETURN NULL;  -- not a member: don't leak the trip's existence
    END IF;
  END IF;

  -- Wishlist candidates: the viewer's unvisited places not yet on this trip,
  -- and not already resolved by the viewer for this trip (018).
  -- Viewers can't add places, so they get none.
  IF v_role <> 'viewer' THEN
    SELECT COALESCE(jsonb_agg(
      to_jsonb(s.*) || travelscrapbook__scrap_place_json(s.place_id)
      ORDER BY s.created_at DESC), '[]'::jsonb)
    INTO v_candidates
    FROM travelscrapbook_scraps s
    WHERE s.user_id = p_viewer
      AND s.visited_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM travelscrapbook_scrap_trips m
        WHERE m.scrap_id = s.id AND m.trip_id = p_trip_id
      )
      AND NOT EXISTS (          -- ← 018: sticky-resolved suggestions
        SELECT 1 FROM travelscrapbook_scrap_trip_dismissals d
        WHERE d.scrap_id = s.id AND d.trip_id = p_trip_id
      );
  END IF;

  RETURN jsonb_build_object(
    'trip', to_jsonb(v_trip),
    'role', v_role,
    'owner_display_name', (
      SELECT pr.display_name FROM travelscrapbook_profiles pr WHERE pr.id = v_trip.user_id
    ),
    'anchors', COALESCE((
      SELECT jsonb_agg(to_jsonb(a.*) ORDER BY a.created_at)
      FROM travelscrapbook_anchors a
      WHERE a.trip_id = p_trip_id
    ), '[]'::jsonb),
    'scraps', COALESCE((
      SELECT jsonb_agg(
        to_jsonb(s.*)
        || travelscrapbook__scrap_place_json(s.place_id)
        || jsonb_build_object(
             'scrap_trip_id', m.id,
             'trip_id', m.trip_id,
             'status', m.status,
             'route_position', m.route_position,
             'plan_date', m.plan_date,
             'plan_time', m.plan_time,
             'added_by_user_id', s.user_id,
             'added_by_display_name', owner_pr.display_name,
             'vibes', travelscrapbook__membership_vibes_json(m.id)
           )
        ORDER BY m.created_at DESC)
      FROM travelscrapbook_scrap_trips m
      JOIN travelscrapbook_scraps s ON s.id = m.scrap_id
      LEFT JOIN travelscrapbook_profiles owner_pr ON owner_pr.id = s.user_id
      WHERE m.trip_id = p_trip_id
    ), '[]'::jsonb),
    'members', (
      SELECT jsonb_build_array(jsonb_build_object(
        'user_id', v_trip.user_id,
        'username', COALESCE(owner_pr.username, ''),
        'display_name', COALESCE(owner_pr.display_name, 'Owner'),
        'role', 'owner',
        'status', 'accepted'
      ))
      FROM (SELECT 1) one
      LEFT JOIN travelscrapbook_profiles owner_pr ON owner_pr.id = v_trip.user_id
    ) || COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'user_id', tm.user_id,
        'username', COALESCE(pr.username, ''),
        'display_name', COALESCE(pr.display_name, 'Traveler'),
        'role', tm.role,
        'status', tm.status
      ) ORDER BY tm.created_at)
      FROM travelscrapbook_trip_members tm
      LEFT JOIN travelscrapbook_profiles pr ON pr.id = tm.user_id
      WHERE tm.trip_id = p_trip_id
    ), '[]'::jsonb),
    'candidates', v_candidates
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.travelscrapbook_trip_bundle(UUID, UUID) TO travelscrapbook_role;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_trip_bundle(UUID, UUID) FROM PUBLIC, anon, authenticated;

COMMIT;
