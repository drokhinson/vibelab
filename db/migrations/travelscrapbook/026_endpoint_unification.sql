-- 026_endpoint_unification.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- Arrival & departure become ordinary PLACES that bookend the trip.
-- ═════════════════════════════════════════════════════════════════════════════
-- Since 020 an "arrival"/"departure" was a role='start'/'end' checkpoint —
-- structurally already a place + scrap + membership, but serialized into a
-- separate anchors[] array and created through a bespoke /anchors API. This
-- migration finishes the unification for start/end ONLY: they become
-- role IS NULL plans distinguished by two boolean membership flags. stay/travel
-- checkpoints are untouched and keep the anchors[] machinery.
--
-- Why booleans, not a route_position sentinel: route ordering has been fully
-- client-side and ephemeral since 022 (travelscrapbook_set_route_plan was
-- dropped; nothing writes route_position). So the durable "this membership is
-- the trip's arrival/departure" designation must be an explicit column. Two
-- booleans also let ONE membership be both ends (the same_as_start case — you
-- fly out of the same airport you flew into) while respecting the
-- role-IS-NULL-only plan-uniqueness index.
--
-- Date model (uniform): arrival day = the is_arrival row's plan_date; departure
-- day = the is_departure row's plan_end_date. A same-place-both-ends row carries
-- both (plan_date = arrival, plan_end_date = departure); distinct arrival and
-- departure places are two rows.

-- ── 1. Flag columns ──────────────────────────────────────────────────────────
ALTER TABLE public.travelscrapbook_scrap_trips
  ADD COLUMN IF NOT EXISTS is_arrival   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_departure BOOLEAN NOT NULL DEFAULT false;

-- ── 2. Backfill: fold every start/end membership into a role-NULL plan row ────
-- Process starts before ends so a same_as_start end merges onto the plan row the
-- start just became (one row, both flags) instead of colliding on the
-- plan-uniqueness index.
DO $$
DECLARE
  ep       RECORD;
  v_plan   UUID;
BEGIN
  FOR ep IN
    SELECT id, scrap_id, trip_id, role, plan_date, plan_time
    FROM travelscrapbook_scrap_trips
    WHERE role IN ('start', 'end')
    ORDER BY (role = 'start') DESC, created_at
  LOOP
    -- An existing plan membership for this (scrap, trip)? (a same_as_start end
    -- after the start became a plan, or a place that was already a plan too.)
    SELECT id INTO v_plan
    FROM travelscrapbook_scrap_trips
    WHERE scrap_id = ep.scrap_id AND trip_id = ep.trip_id AND role IS NULL
    LIMIT 1;

    IF v_plan IS NOT NULL THEN
      IF ep.role = 'start' THEN
        UPDATE travelscrapbook_scrap_trips
          SET is_arrival = true,
              plan_date  = COALESCE(plan_date, ep.plan_date),
              plan_time  = COALESCE(plan_time, ep.plan_time)
          WHERE id = v_plan;
      ELSE
        UPDATE travelscrapbook_scrap_trips
          SET is_departure  = true,
              plan_end_date = COALESCE(plan_end_date, ep.plan_date)
          WHERE id = v_plan;
      END IF;
      DELETE FROM travelscrapbook_scrap_trips WHERE id = ep.id;
    ELSE
      -- Promote this endpoint row itself to a plan.
      IF ep.role = 'start' THEN
        UPDATE travelscrapbook_scrap_trips
          SET role = NULL, is_arrival = true
          WHERE id = ep.id;
      ELSE
        -- Departure day lives in plan_end_date; clear the now-misnamed plan_date.
        UPDATE travelscrapbook_scrap_trips
          SET role = NULL, is_departure = true,
              plan_end_date = COALESCE(plan_end_date, ep.plan_date),
              plan_date = NULL, plan_time = NULL
          WHERE id = ep.id;
      END IF;
    END IF;
  END LOOP;
END $$;

-- ── 3. Index + constraint swap ───────────────────────────────────────────────
-- Old one-start/one-end invariant → one-arrival/one-departure per trip.
DROP INDEX IF EXISTS idx_ts_scrap_trips_endpoint;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ts_scrap_trips_arrival
  ON public.travelscrapbook_scrap_trips(trip_id) WHERE is_arrival;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ts_scrap_trips_departure
  ON public.travelscrapbook_scrap_trips(trip_id) WHERE is_departure;

-- role no longer carries start/end.
ALTER TABLE public.travelscrapbook_scrap_trips
  DROP CONSTRAINT IF EXISTS travelscrapbook_scrap_trips_role_check;
DO $$ BEGIN
  ALTER TABLE public.travelscrapbook_scrap_trips
    ADD CONSTRAINT travelscrapbook_scrap_trips_role_check
      CHECK (role IS NULL OR role IN ('stay', 'travel'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 4. travelscrapbook_trip_bundle — start/end leave anchors[], join scraps[] ─
-- anchors[] now synthesizes stay/travel only; each role-NULL scrap carries the
-- endpoint flags + plan_end_date so the client can bookend it. Everything else
-- is copied verbatim from 020 §5.
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

  -- Wishlist candidates: the viewer's unvisited, non-checkpoint places not yet
  -- on this trip and not already resolved for it (018). Viewers get none.
  IF v_role <> 'viewer' THEN
    SELECT COALESCE(jsonb_agg(
      to_jsonb(s.*) || travelscrapbook__scrap_place_json(s.place_id)
      ORDER BY s.created_at DESC), '[]'::jsonb)
    INTO v_candidates
    FROM travelscrapbook_scraps s
    JOIN travelscrapbook_places p ON p.id = s.place_id
    LEFT JOIN travelscrapbook_categories c ON c.slug = COALESCE(p.category, 'other')
    WHERE s.user_id = p_viewer
      AND s.visited_at IS NULL
      AND COALESCE(c.is_checkpoint, false) = false   -- hotels/transport aren't plan suggestions
      AND NOT EXISTS (
        SELECT 1 FROM travelscrapbook_scrap_trips m
        WHERE m.scrap_id = s.id AND m.trip_id = p_trip_id
      )
      AND NOT EXISTS (          -- 018: sticky-resolved suggestions
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
    -- Synthesized checkpoints in the legacy anchor shape — STAY/TRAVEL only now
    -- (026: arrival/departure are plans in scraps[], flagged is_arrival/…).
    'anchors', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id,
        'trip_id', m.trip_id,
        'role', m.role,
        'label', p.name,
        'query', COALESCE(p.geocode_display_name, p.name),
        'lat', p.lat,
        'lng', p.lng,
        'city', p.city,
        'region', p.region,
        'country', p.country,
        'country_code', p.country_code,
        'maps_url', p.maps_url,
        'geocode_confidence', COALESCE(p.geocode_confidence, 'none'),
        'type', CASE
          WHEN m.role = 'stay' THEN NULL
          WHEN p.category IN ('airport', 'train_station', 'car_rental') THEN p.category
          ELSE 'other'
        END,
        'anchor_date', CASE WHEN m.role <> 'stay' THEN m.plan_date END,
        'anchor_time', CASE WHEN m.role <> 'stay' THEN m.plan_time END,
        'stay_date',  CASE WHEN m.role = 'stay' THEN m.plan_date END,
        'stay_end_date', CASE WHEN m.role = 'stay' THEN m.plan_end_date END,
        'created_at', m.created_at,
        'place_id', p.id,
        'scrap_id', s.id
      ) ORDER BY m.created_at)
      FROM travelscrapbook_scrap_trips m
      JOIN travelscrapbook_scraps s ON s.id = m.scrap_id
      JOIN travelscrapbook_places p ON p.id = s.place_id
      WHERE m.trip_id = p_trip_id AND m.role IN ('stay', 'travel')
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
             'plan_end_date', m.plan_end_date,
             'is_arrival', m.is_arrival,
             'is_departure', m.is_departure,
             'added_by_user_id', s.user_id,
             'added_by_display_name', owner_pr.display_name,
             'vibes', travelscrapbook__membership_vibes_json(m.id)
           )
        ORDER BY m.created_at DESC)
      FROM travelscrapbook_scrap_trips m
      JOIN travelscrapbook_scraps s ON s.id = m.scrap_id
      LEFT JOIN travelscrapbook_profiles owner_pr ON owner_pr.id = s.user_id
      WHERE m.trip_id = p_trip_id AND m.role IS NULL   -- plans (incl. arrival/departure)
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

-- ── 5. travelscrapbook_scrap_card — echo the endpoint flags too ──────────────
CREATE OR REPLACE FUNCTION public.travelscrapbook_scrap_card(
  p_scrap_id UUID,
  p_trip_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    to_jsonb(s.*)
    || travelscrapbook__scrap_place_json(s.place_id)
    || jsonb_build_object(
         'scrap_trip_id', m.id,
         'trip_id', m.trip_id,
         'status', m.status,
         'role', m.role,
         'route_position', m.route_position,
         'plan_date', m.plan_date,
         'plan_time', m.plan_time,
         'plan_end_date', m.plan_end_date,
         'is_arrival', m.is_arrival,
         'is_departure', m.is_departure,
         'added_by_user_id', s.user_id,
         'added_by_display_name', owner_pr.display_name,
         'vibes', travelscrapbook__membership_vibes_json(m.id)
       )
  FROM travelscrapbook_scrap_trips m
  JOIN travelscrapbook_scraps s ON s.id = m.scrap_id
  LEFT JOIN travelscrapbook_profiles owner_pr ON owner_pr.id = s.user_id
  WHERE m.scrap_id = p_scrap_id AND m.trip_id = p_trip_id AND m.role IS NULL
$$;
GRANT EXECUTE ON FUNCTION public.travelscrapbook_scrap_card(UUID, UUID) TO travelscrapbook_role;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_scrap_card(UUID, UUID) FROM PUBLIC, anon, authenticated;
