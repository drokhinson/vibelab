-- ─────────────────────────────────────────────────────────────────────────────
-- travelscrapbook — checkpoint ↔ scrap unification, EXPAND phase (020)
--
-- A checkpoint (anchor) was its own table: trip-bound, no user identity, no
-- place dedupe, invisible to the Wander List / Visited / Community. But a
-- checkpoint is just a place (an airport, a train station, a hotel) whose
-- difference is its ROLE in trip planning. This migration dissolves that split:
--
--   checkpoint = place (identity, dedupable, community-poolable)
--              + scrap (the user's saved, visitable copy)
--              + scrap_trips membership carrying role = start|end|stay|travel
--
-- The definitional rule, per layer:
--   - browse/community: a checkpoint PLACE is one whose category has
--     is_checkpoint = true (lodging + the new transport categories);
--   - trip layer: a checkpoint OF A TRIP is a membership with role IS NOT NULL.
--   Creation always sets both, so the layers can't drift.
--
-- Date model: anchor_date ≡ plan_date, anchor_time ≡ plan_time, stay_date ≡
-- plan_date; only stay_end_date needs a new column (plan_end_date). anchor.type
-- dissolves into the place's category (airport/train_station/car_rental/
-- transport; stay → lodging).
--
-- This is the EXPAND phase (013→014 precedent): additive schema + backfill;
-- travelscrapbook_anchors is FROZEN afterwards (no reads/writes from new code)
-- and kept as a rollback backup until 021 drops it after soak.
--
-- Also replaces every RPC that reads memberships, because a membership row can
-- now be a plan (role NULL) or a checkpoint (role set) and the two must never
-- mix: plans lists/route writes filter role IS NULL, the trip bundle's
-- `anchors` array is SYNTHESIZED from role-bearing memberships (preserving the
-- exact shape every timeline/route consumer already reads), and the browse
-- bundles split checkpoint-category scraps into their own arrays.
--
-- ⚠ Deploy order: run this migration and deploy the matching backend
-- BACK-TO-BACK, and avoid using the app in between. The OLD backend reads
-- memberships UNFILTERED: after the backfill it would render the new
-- checkpoint memberships as plan cards, and its trip-picker reconcile
-- (set_scrap_trips) could DELETE a backfilled checkpoint membership — which
-- the marker-guarded backfill would NOT restore on a re-run. The window is
-- minutes for a normal deploy; keep it closed. Idempotent throughout.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Categories: the is_checkpoint flag + transport category seeds
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.travelscrapbook_categories
  ADD COLUMN IF NOT EXISTS is_checkpoint BOOLEAN NOT NULL DEFAULT false;

-- New transport categories (sprites: travel-scrapbook-cat-<icon>.svg under
-- web/assets/sprites/categories/). ON CONFLICT DO NOTHING: never clobber a
-- label/icon the user may have tweaked.
INSERT INTO public.travelscrapbook_categories (slug, label, icon, sort_order) VALUES
  ('airport',       'Airport',       'airport',       90),
  ('train_station', 'Train station', 'train-station', 91),
  ('car_rental',    'Car rental',    'car-rental',    92),
  ('transport',     'Transport',     'transport',     93)
ON CONFLICT (slug) DO NOTHING;

UPDATE public.travelscrapbook_categories
SET is_checkpoint = true
WHERE slug IN ('lodging', 'airport', 'train_station', 'car_rental', 'transport');


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. scrap_trips: role + plan_end_date + constraint swap
-- ═════════════════════════════════════════════════════════════════════════════

-- role NULL = ordinary plan; set = this membership IS the trip's checkpoint.
ALTER TABLE public.travelscrapbook_scrap_trips
  ADD COLUMN IF NOT EXISTS role TEXT
    CHECK (role IS NULL OR role IN ('start', 'end', 'stay', 'travel')),
  ADD COLUMN IF NOT EXISTS plan_end_date DATE;  -- stay check-out (role-agnostic: future multi-day plans)

DO $$ BEGIN
  ALTER TABLE public.travelscrapbook_scrap_trips
    ADD CONSTRAINT ts_scrap_trips_end_after_start
      CHECK (plan_end_date IS NULL OR plan_date IS NULL OR plan_end_date >= plan_date);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The old UNIQUE(scrap_id, trip_id) must relax: the same airport place is both
-- start AND end (same_as_start), and the same hotel can host two separate
-- mid-trip stays. Uniqueness now applies to PLAN memberships only; the
-- one-start/one-end-per-trip invariant moves here from the anchors table.
ALTER TABLE public.travelscrapbook_scrap_trips
  DROP CONSTRAINT IF EXISTS travelscrapbook_scrap_trips_scrap_id_trip_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ts_scrap_trips_plan_unique
  ON public.travelscrapbook_scrap_trips(scrap_id, trip_id) WHERE role IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ts_scrap_trips_endpoint
  ON public.travelscrapbook_scrap_trips(trip_id, role) WHERE role IN ('start', 'end');
CREATE INDEX IF NOT EXISTS idx_ts_scrap_trips_trip_checkpoints
  ON public.travelscrapbook_scrap_trips(trip_id) WHERE role IS NOT NULL;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. travelscrapbook_add_plan_memberships — the upsert the partial unique broke
-- ═════════════════════════════════════════════════════════════════════════════
-- PostgREST's on_conflict="scrap_id,trip_id" emits ON CONFLICT (scrap_id,
-- trip_id) with no WHERE predicate, which Postgres rejects now that the unique
-- index is partial. Every "add plan membership" write goes through this RPC
-- instead (plan_routes, source capture trip-hint, community save). It takes
-- (scrap, trip) PAIRS so both fan-out shapes — many scraps onto one trip
-- (bulk add) and one scrap onto many trips (the multi-select picker) — are a
-- single round trip.

DROP FUNCTION IF EXISTS public.travelscrapbook_add_plan_memberships(UUID, UUID[], TEXT);

CREATE OR REPLACE FUNCTION public.travelscrapbook_add_plan_memberships(
  p_rows   JSONB,               -- [{"scrap_id": "...", "trip_id": "..."}]
  p_status TEXT DEFAULT 'approved'
)
RETURNS VOID
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO travelscrapbook_scrap_trips (scrap_id, trip_id, status)
  SELECT x.scrap_id, x.trip_id, p_status
  FROM jsonb_to_recordset(p_rows) AS x(scrap_id UUID, trip_id UUID)
  ON CONFLICT (scrap_id, trip_id) WHERE role IS NULL DO NOTHING
$$;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_add_plan_memberships(JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Backfill: every anchor → place + scrap + role membership
-- ═════════════════════════════════════════════════════════════════════════════

-- Marker column: processed anchors carry the membership they became, making the
-- backfill re-runnable (the whole file is one transaction, so a failure rolls
-- everything back; the marker guards a second full run).
ALTER TABLE public.travelscrapbook_anchors
  ADD COLUMN IF NOT EXISTS migrated_membership_id UUID;

-- Extension-free approximation of Python's normalize_place_name (NFKD accent
-- fold + lowercase + non-alnum→space + strip leading "the "). translate()
-- covers the practical Latin accent set; a rare mismatch just creates a
-- duplicate place (cosmetic — community grouping still merges by name+country).
CREATE OR REPLACE FUNCTION public.travelscrapbook__normalize_name(t TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(regexp_replace(
    regexp_replace(
      translate(
        lower(coalesce(t, '')),
        'àáâãäåāăąèéêëēĕėęěìíîïĩīĭįòóôõöøōŏőùúûüũūŭůçćĉčñńņňýÿžźżšśşğß',
        'aaaaaaaaaeeeeeeeeeiiiiiiiioooooooooouuuuuuuuccccnnnnyyzzzsssgs'
      ),
      '[^a-z0-9]+', ' ', 'g'
    ),
    '^the\s+', ''
  ))
$$;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook__normalize_name(TEXT)
  FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  a            RECORD;
  v_norm       TEXT;
  v_cat        TEXT;
  v_place_id   UUID;
  v_scrap_id   UUID;
  v_member_id  UUID;
  v_visited    TIMESTAMPTZ;
  v_unmigrated INT;
BEGIN
  FOR a IN
    SELECT an.*, t.user_id AS owner_id, t.end_date AS trip_end
    FROM travelscrapbook_anchors an
    JOIN travelscrapbook_trips t ON t.id = an.trip_id
    WHERE an.migrated_membership_id IS NULL
    ORDER BY an.created_at
  LOOP
    v_norm := travelscrapbook__normalize_name(a.label);
    v_cat := CASE
      WHEN a.role = 'stay'            THEN 'lodging'
      WHEN a.type = 'airport'         THEN 'airport'
      WHEN a.type = 'train_station'   THEN 'train_station'
      WHEN a.type = 'car_rental'      THEN 'car_rental'
      ELSE 'transport'
    END;

    -- Place: conservative mirror of services/places.find_or_create_place —
    -- same normalized name AND (coords within ~0.5 km, or either side
    -- ungeocoded with city equal/absent). Geocoded candidates win ties.
    SELECT p.id INTO v_place_id
    FROM travelscrapbook_places p
    WHERE p.user_id = a.owner_id
      AND p.name_normalized = v_norm
      AND (
        (p.lat IS NOT NULL AND a.lat IS NOT NULL
          AND abs(p.lat - a.lat) < 0.005 AND abs(p.lng - a.lng) < 0.008)
        OR ((p.lat IS NULL OR a.lat IS NULL)
          AND (p.city IS NULL OR a.city IS NULL
               OR lower(btrim(p.city)) = lower(btrim(a.city))))
      )
    ORDER BY (p.lat IS NOT NULL) DESC, p.id
    LIMIT 1;

    IF v_place_id IS NULL THEN
      INSERT INTO travelscrapbook_places
        (user_id, name, name_normalized, city, region, country, country_code,
         category, lat, lng, geocode_confidence, maps_url)
      VALUES
        (a.owner_id, a.label, v_norm, a.city, a.region, a.country, a.country_code,
         v_cat, a.lat, a.lng, COALESCE(a.geocode_confidence, 'none'), a.maps_url)
      RETURNING id INTO v_place_id;
    ELSE
      -- Merge: fill gaps from the anchor; promote a placeholder 'other'
      -- category to the checkpoint category (an airport IS an airport).
      UPDATE travelscrapbook_places SET
        category     = CASE WHEN category = 'other' OR category IS NULL THEN v_cat ELSE category END,
        city         = COALESCE(city, a.city),
        region       = COALESCE(region, a.region),
        country      = COALESCE(country, a.country),
        country_code = COALESCE(country_code, a.country_code),
        lat          = CASE WHEN lat IS NULL THEN a.lat ELSE lat END,
        lng          = CASE WHEN lat IS NULL THEN a.lng ELSE lng END,
        maps_url     = COALESCE(maps_url, a.maps_url),
        updated_at   = now()
      WHERE id = v_place_id;
    END IF;

    -- Scrap: the owner's saved copy. A checkpoint from an already-ended trip
    -- lands in Visited (you stayed there), not the Wander List.
    SELECT s.id INTO v_scrap_id
    FROM travelscrapbook_scraps s
    WHERE s.user_id = a.owner_id AND s.place_id = v_place_id
    LIMIT 1;

    IF v_scrap_id IS NULL THEN
      v_visited := CASE
        WHEN a.trip_end IS NOT NULL AND a.trip_end < CURRENT_DATE
          THEN a.trip_end::timestamptz
        ELSE NULL
      END;
      INSERT INTO travelscrapbook_scraps (user_id, place_id, visited_at, created_at)
      VALUES (a.owner_id, v_place_id, v_visited, a.created_at)
      RETURNING id INTO v_scrap_id;
    END IF;

    -- Membership: the checkpoint itself. created_at is COPIED from the anchor —
    -- route_routes.py and route-panel.js both resolve "first stay" by
    -- created_at order, and this preserves that contract exactly.
    INSERT INTO travelscrapbook_scrap_trips
      (scrap_id, trip_id, role, status, plan_date, plan_time, plan_end_date, created_at)
    VALUES
      (v_scrap_id, a.trip_id, a.role, 'approved',
       COALESCE(a.stay_date, a.anchor_date), a.anchor_time, a.stay_end_date,
       a.created_at)
    RETURNING id INTO v_member_id;

    UPDATE travelscrapbook_anchors
    SET migrated_membership_id = v_member_id
    WHERE id = a.id;
  END LOOP;

  SELECT count(*) INTO v_unmigrated
  FROM travelscrapbook_anchors WHERE migrated_membership_id IS NULL;
  IF v_unmigrated > 0 THEN
    RAISE EXCEPTION 'checkpoint backfill incomplete: % anchors unmigrated', v_unmigrated;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. travelscrapbook_trip_bundle v3 — plans filtered, anchors synthesized
-- ═════════════════════════════════════════════════════════════════════════════
-- Deltas from 018: `scraps` takes role-IS-NULL memberships only; `anchors` is
-- synthesized from role-bearing memberships in the exact AnchorResponse shape
-- (ordered by membership created_at — the "first stay" contract); `candidates`
-- additionally excludes checkpoint-category places (a hotel is never suggested
-- as a plan) alongside the 018 dismissals guard.

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
      AND COALESCE(c.is_checkpoint, false) = false   -- 020: hotels/transport aren't plan suggestions
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
    -- Synthesized checkpoints in the legacy anchor shape (020): every
    -- timeline/route consumer keeps reading the same flat array.
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
      WHERE m.trip_id = p_trip_id AND m.role IS NOT NULL
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
      WHERE m.trip_id = p_trip_id AND m.role IS NULL   -- 020: plans only
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


-- ═════════════════════════════════════════════════════════════════════════════
-- 6. travelscrapbook_inbox_bundle — Wander List splits out checkpoints
-- ═════════════════════════════════════════════════════════════════════════════
-- Deltas from 015: base carries is_checkpoint; the paginated scraps / total /
-- nav badge count non-checkpoint places only; a new checkpoint_scraps array
-- (+ checkpoint_total) carries unvisited checkpoint-category scraps (capped —
-- personal checkpoint counts are small); facets stay computed over the FULL
-- base so the geo drill-down narrows both sections; trip_ids aggregation
-- counts PLAN memberships only (the picker reconciles plan memberships).

CREATE OR REPLACE FUNCTION public.travelscrapbook_inbox_bundle(
  p_viewer UUID,
  p_region TEXT DEFAULT NULL,
  p_country TEXT DEFAULT NULL,
  p_city TEXT DEFAULT NULL,
  p_limit INT DEFAULT 24,
  p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT s.*, p.region AS place_region, p.country AS place_country, p.city AS place_city,
           COALESCE(c.is_checkpoint, false) AS is_checkpoint
    FROM travelscrapbook_scraps s
    JOIN travelscrapbook_places p ON p.id = s.place_id
    LEFT JOIN travelscrapbook_categories c ON c.slug = COALESCE(p.category, 'other')
    WHERE s.user_id = p_viewer AND s.visited_at IS NULL
  ),
  geo AS (
    SELECT * FROM base
    WHERE (p_region  IS NULL OR btrim(lower(COALESCE(place_region,  ''))) = btrim(lower(p_region)))
      AND (p_country IS NULL OR btrim(lower(COALESCE(place_country, ''))) = btrim(lower(p_country)))
      AND (p_city    IS NULL OR btrim(lower(COALESCE(place_city,    ''))) = btrim(lower(p_city)))
  ),
  filtered AS (
    SELECT * FROM geo WHERE NOT is_checkpoint
  ),
  cp_filtered AS (
    SELECT * FROM geo WHERE is_checkpoint
  ),
  page AS (
    SELECT * FROM filtered ORDER BY created_at DESC LIMIT p_limit OFFSET p_offset
  ),
  cp_page AS (
    SELECT * FROM cp_filtered ORDER BY created_at DESC LIMIT 48
  )
  SELECT jsonb_build_object(
    'scraps', COALESCE((
      SELECT jsonb_agg(
        (to_jsonb(f.*) - 'place_region' - 'place_country' - 'place_city' - 'is_checkpoint')
        || travelscrapbook__scrap_place_json(f.place_id)
        || jsonb_build_object('trip_ids', COALESCE((
             SELECT jsonb_agg(m.trip_id)
             FROM travelscrapbook_scrap_trips m
             WHERE m.scrap_id = f.id AND m.role IS NULL
           ), '[]'::jsonb))
        ORDER BY f.created_at DESC)
      FROM page f
    ), '[]'::jsonb),
    'checkpoint_scraps', COALESCE((
      SELECT jsonb_agg(
        (to_jsonb(f.*) - 'place_region' - 'place_country' - 'place_city' - 'is_checkpoint')
        || travelscrapbook__scrap_place_json(f.place_id)
        -- No per-row trip_ids subquery: checkpoint cards hide the trip picker
        -- (roles are managed from the trip screen), so the field is unread.
        || jsonb_build_object('trip_ids', '[]'::jsonb)
        ORDER BY f.created_at DESC)
      FROM cp_page f
    ), '[]'::jsonb),
    'total', (SELECT count(*) FROM filtered),
    'checkpoint_total', (SELECT count(*) FROM cp_filtered),
    'unvisited_count', (SELECT count(*) FROM base WHERE NOT is_checkpoint),
    'facets', jsonb_build_object(
      'regions', COALESCE((
        SELECT jsonb_agg(t.v ORDER BY t.v)
        FROM (SELECT DISTINCT place_region AS v FROM base WHERE place_region IS NOT NULL) t
      ), '[]'::jsonb),
      'countries', COALESCE((
        SELECT jsonb_agg(t.v ORDER BY t.v)
        FROM (
          SELECT DISTINCT place_country AS v FROM base
          WHERE place_country IS NOT NULL
            AND (p_region IS NULL OR btrim(lower(COALESCE(place_region, ''))) = btrim(lower(p_region)))
        ) t
      ), '[]'::jsonb),
      'cities', COALESCE((
        SELECT jsonb_agg(t.v ORDER BY t.v)
        FROM (
          SELECT DISTINCT place_city AS v FROM base
          WHERE place_city IS NOT NULL
            AND (p_region  IS NULL OR btrim(lower(COALESCE(place_region,  ''))) = btrim(lower(p_region)))
            AND (p_country IS NULL OR btrim(lower(COALESCE(place_country, ''))) = btrim(lower(p_country)))
        ) t
      ), '[]'::jsonb)
    ),
    'processing_sources', COALESCE((
      SELECT jsonb_agg(to_jsonb(src.*) ORDER BY src.created_at DESC)
      FROM travelscrapbook_sources src
      WHERE src.user_id = p_viewer AND src.status = 'processing'
    ), '[]'::jsonb),
    'failed_sources', COALESCE((
      SELECT jsonb_agg(to_jsonb(src.*) ORDER BY src.created_at DESC)
      FROM travelscrapbook_sources src
      WHERE src.user_id = p_viewer AND src.status = 'failed'
    ), '[]'::jsonb),
    'geocoded_trips', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'cover_icon', t.cover_icon,
        'lat', t.lat, 'lng', t.lng, 'end_date', t.end_date,
        'scope_level', t.scope_level, 'dest_city', t.dest_city,
        'dest_region', t.dest_region, 'dest_country', t.dest_country
      ))
      FROM travelscrapbook_trips t
      WHERE t.user_id = p_viewer AND t.lat IS NOT NULL
    ), '[]'::jsonb)
  )
$$;
GRANT EXECUTE ON FUNCTION public.travelscrapbook_inbox_bundle(UUID, TEXT, TEXT, TEXT, INT, INT) TO travelscrapbook_role;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_inbox_bundle(UUID, TEXT, TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 7. travelscrapbook_visited_page — same checkpoint split for Visited
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.travelscrapbook_visited_page(
  p_viewer UUID,
  p_region TEXT DEFAULT NULL,
  p_country TEXT DEFAULT NULL,
  p_city TEXT DEFAULT NULL,
  p_limit INT DEFAULT 24,
  p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT s.*, p.region AS place_region, p.country AS place_country, p.city AS place_city,
           COALESCE(c.is_checkpoint, false) AS is_checkpoint
    FROM travelscrapbook_scraps s
    JOIN travelscrapbook_places p ON p.id = s.place_id
    LEFT JOIN travelscrapbook_categories c ON c.slug = COALESCE(p.category, 'other')
    WHERE s.user_id = p_viewer AND s.visited_at IS NOT NULL
  ),
  geo AS (
    SELECT * FROM base
    WHERE (p_region  IS NULL OR btrim(lower(COALESCE(place_region,  ''))) = btrim(lower(p_region)))
      AND (p_country IS NULL OR btrim(lower(COALESCE(place_country, ''))) = btrim(lower(p_country)))
      AND (p_city    IS NULL OR btrim(lower(COALESCE(place_city,    ''))) = btrim(lower(p_city)))
  ),
  filtered AS (
    SELECT * FROM geo WHERE NOT is_checkpoint
  ),
  cp_filtered AS (
    SELECT * FROM geo WHERE is_checkpoint
  ),
  page AS (
    SELECT * FROM filtered ORDER BY visited_at DESC LIMIT p_limit OFFSET p_offset
  ),
  cp_page AS (
    SELECT * FROM cp_filtered ORDER BY visited_at DESC LIMIT 48
  )
  SELECT jsonb_build_object(
    'scraps', COALESCE((
      SELECT jsonb_agg(
        (to_jsonb(f.*) - 'place_region' - 'place_country' - 'place_city' - 'is_checkpoint')
        || travelscrapbook__scrap_place_json(f.place_id)
        ORDER BY f.visited_at DESC)
      FROM page f
    ), '[]'::jsonb),
    'visited_checkpoints', COALESCE((
      SELECT jsonb_agg(
        (to_jsonb(f.*) - 'place_region' - 'place_country' - 'place_city' - 'is_checkpoint')
        || travelscrapbook__scrap_place_json(f.place_id)
        ORDER BY f.visited_at DESC)
      FROM cp_page f
    ), '[]'::jsonb),
    'total', (SELECT count(*) FROM filtered),
    'checkpoint_total', (SELECT count(*) FROM cp_filtered),
    'facets', jsonb_build_object(
      'regions', COALESCE((
        SELECT jsonb_agg(t.v ORDER BY t.v)
        FROM (SELECT DISTINCT place_region AS v FROM base WHERE place_region IS NOT NULL) t
      ), '[]'::jsonb),
      'countries', COALESCE((
        SELECT jsonb_agg(t.v ORDER BY t.v)
        FROM (
          SELECT DISTINCT place_country AS v FROM base
          WHERE place_country IS NOT NULL
            AND (p_region IS NULL OR btrim(lower(COALESCE(place_region, ''))) = btrim(lower(p_region)))
        ) t
      ), '[]'::jsonb),
      'cities', COALESCE((
        SELECT jsonb_agg(t.v ORDER BY t.v)
        FROM (
          SELECT DISTINCT place_city AS v FROM base
          WHERE place_city IS NOT NULL
            AND (p_region  IS NULL OR btrim(lower(COALESCE(place_region,  ''))) = btrim(lower(p_region)))
            AND (p_country IS NULL OR btrim(lower(COALESCE(place_country, ''))) = btrim(lower(p_country)))
        ) t
      ), '[]'::jsonb)
    )
  )
$$;
GRANT EXECUTE ON FUNCTION public.travelscrapbook_visited_page(UUID, TEXT, TEXT, TEXT, INT, INT) TO travelscrapbook_role;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_visited_page(UUID, TEXT, TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 8. travelscrapbook_community_places — checkpoint tab toggle
-- ═════════════════════════════════════════════════════════════════════════════
-- New p_checkpoints flag partitions the pool: false = ordinary places (default,
-- today's behavior for them), true = the "Stays & transport" tab. New signature
-- ⇒ the old 7-arg overload must be dropped first (CREATE OR REPLACE would leave
-- both live).

DROP FUNCTION IF EXISTS public.travelscrapbook_community_places(TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT);

CREATE OR REPLACE FUNCTION public.travelscrapbook_community_places(
  p_q TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_country TEXT DEFAULT NULL,
  p_city TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_limit INT DEFAULT 24,
  p_offset INT DEFAULT 0,
  p_checkpoints BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT p.*,
      CASE WHEN p.osm_id IS NOT NULL
           THEN 'osm:' || COALESCE(p.osm_type, '') || ':' || p.osm_id::text
           ELSE 'name:' || COALESCE(p.name_normalized, '') || ':' || lower(COALESCE(p.country_code, ''))
      END AS gkey
    FROM travelscrapbook_places p
    LEFT JOIN travelscrapbook_categories c ON c.slug = COALESCE(p.category, 'other')
    WHERE p.lat IS NOT NULL
      AND COALESCE(c.is_checkpoint, false) = p_checkpoints
      AND (p_q IS NULL OR p.name ILIKE '%' || p_q || '%' OR p.city ILIKE '%' || p_q || '%')
      AND (p_category IS NULL OR p.category = p_category)
  ),
  grouped AS (
    SELECT gkey,
           count(DISTINCT user_id) AS saved_by_count,
           array_agg(id) AS place_ids
    FROM base GROUP BY gkey
  ),
  rep AS (
    -- Most complete row represents the group (has pin > maps link > city >
    -- specific category); id tie-break keeps the pick deterministic.
    SELECT DISTINCT ON (gkey) *
    FROM base
    ORDER BY gkey,
      (maps_url IS NOT NULL) DESC,
      (city IS NOT NULL) DESC,
      (category IS DISTINCT FROM 'other') DESC,
      id
  ),
  entries AS (
    SELECT r.id AS ref_place_id, r.name, r.city, r.region, r.country,
           COALESCE(r.category, 'other') AS category, r.lat, r.lng, r.maps_url,
           g.saved_by_count, g.place_ids
    FROM rep r JOIN grouped g USING (gkey)
  ),
  filtered AS (
    SELECT * FROM entries
    WHERE (p_region  IS NULL OR btrim(lower(COALESCE(region,  ''))) = btrim(lower(p_region)))
      AND (p_country IS NULL OR btrim(lower(COALESCE(country, ''))) = btrim(lower(p_country)))
      AND (p_city    IS NULL OR btrim(lower(COALESCE(city,    ''))) = btrim(lower(p_city)))
  ),
  page AS (
    SELECT * FROM filtered ORDER BY saved_by_count DESC, name LIMIT p_limit OFFSET p_offset
  ),
  page_sources AS (
    -- Newest link per URL across the entry's member places.
    SELECT DISTINCT ON (pg.ref_place_id, src.url)
      pg.ref_place_id, src.url, src.source_domain, src.og_title,
      src.og_image_url, ps.created_at
    FROM page pg
    JOIN travelscrapbook_place_sources ps ON ps.place_id = ANY (pg.place_ids)
    JOIN travelscrapbook_sources src ON src.id = ps.source_id
    ORDER BY pg.ref_place_id, src.url, ps.created_at DESC
  ),
  ranked AS (
    SELECT *, row_number() OVER (PARTITION BY ref_place_id ORDER BY created_at DESC) AS rn
    FROM page_sources
  ),
  src_agg AS (
    SELECT ref_place_id,
      count(*) AS source_count,
      COALESCE(jsonb_agg(jsonb_build_object(
        'url', url, 'source_domain', source_domain, 'og_title', og_title
      ) ORDER BY created_at DESC) FILTER (WHERE rn <= 3), '[]'::jsonb) AS sample_sources,
      (array_agg(og_image_url ORDER BY created_at DESC) FILTER (WHERE og_image_url IS NOT NULL))[1] AS og_image_url
    FROM ranked GROUP BY ref_place_id
  )
  SELECT jsonb_build_object(
    'places', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'ref_place_id', pg.ref_place_id,
        'name', pg.name,
        'city', pg.city,
        'region', pg.region,
        'country', pg.country,
        'category', pg.category,
        'lat', pg.lat,
        'lng', pg.lng,
        'maps_url', pg.maps_url,
        'saved_by_count', pg.saved_by_count,
        'source_count', COALESCE(sa.source_count, 0),
        'sample_sources', COALESCE(sa.sample_sources, '[]'::jsonb),
        'og_image_url', sa.og_image_url
      ) ORDER BY pg.saved_by_count DESC, pg.name)
      FROM page pg
      LEFT JOIN src_agg sa ON sa.ref_place_id = pg.ref_place_id
    ), '[]'::jsonb),
    'total', (SELECT count(*) FROM filtered),
    'facets', jsonb_build_object(
      'regions', COALESCE((
        SELECT jsonb_agg(t.v ORDER BY t.v)
        FROM (SELECT DISTINCT region AS v FROM entries WHERE region IS NOT NULL) t
      ), '[]'::jsonb),
      'countries', COALESCE((
        SELECT jsonb_agg(t.v ORDER BY t.v)
        FROM (
          SELECT DISTINCT country AS v FROM entries
          WHERE country IS NOT NULL
            AND (p_region IS NULL OR btrim(lower(COALESCE(region, ''))) = btrim(lower(p_region)))
        ) t
      ), '[]'::jsonb),
      'cities', COALESCE((
        SELECT jsonb_agg(t.v ORDER BY t.v)
        FROM (
          SELECT DISTINCT city AS v FROM entries
          WHERE city IS NOT NULL
            AND (p_region  IS NULL OR btrim(lower(COALESCE(region,  ''))) = btrim(lower(p_region)))
            AND (p_country IS NULL OR btrim(lower(COALESCE(country, ''))) = btrim(lower(p_country)))
        ) t
      ), '[]'::jsonb)
    )
  )
$$;
GRANT EXECUTE ON FUNCTION public.travelscrapbook_community_places(TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, BOOLEAN) TO travelscrapbook_role;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_community_places(TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, BOOLEAN) FROM PUBLIC, anon, authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 9. travelscrapbook_scrap_card — echoes PLAN memberships only
-- ═════════════════════════════════════════════════════════════════════════════
-- A scrap can now hold a plan membership AND checkpoint memberships on the same
-- trip; this echo backs plan mutations (assign/approve/schedule/vibe), so it
-- must resolve the plan row. Also passes role/plan_end_date through.

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


-- ═════════════════════════════════════════════════════════════════════════════
-- 10. travelscrapbook_set_route_plan — a route run can never move a checkpoint
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.travelscrapbook_set_route_plan(
  p_trip_id UUID,
  p_rows    JSONB
)
RETURNS VOID
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE travelscrapbook_scrap_trips m
  SET route_position = x.pos,
      plan_date = CASE
        WHEN x.plan_date IS NOT NULL AND m.plan_date IS NULL
          THEN x.plan_date
        ELSE m.plan_date
      END
  FROM jsonb_to_recordset(p_rows) AS x(id UUID, pos INT, plan_date DATE)
  WHERE m.id = x.id
    AND m.trip_id = p_trip_id
    AND m.role IS NULL   -- 020: checkpoints are cluster centers, never stops
$$;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_set_route_plan(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;

COMMIT;
