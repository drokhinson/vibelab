-- ─────────────────────────────────────────────────────────────────────────────
-- Travel Scrapbook — performance RPCs: collapse multi-query reads into one
-- round-trip each.
--
-- Before this migration every hot read fanned out into 4–9 sequential
-- Supabase round-trips (trip bundle: access check + owner name + anchors +
-- memberships + 4-query hydrate; trips list: 4 queries; inbox/visited/
-- community: fetch-all-then-paginate in Python). The sync supabase client
-- blocks the event loop per query, so each collapsed round-trip pays off
-- twice.
--
-- Shape contract: every scrap JSON object mirrors services/hydrate.py —
-- flat place fields, `sources` chips (newest first), `og_image_url` = first
-- non-null image among the place's sources (newest first), membership
-- fields (scrap_trip_id/trip_id/status/route_position/plan_date/plan_time)
-- on trip surfaces, and raw `vibes` rows. The `consensus` roll-up stays in
-- Python (services/hydrate.attach_consensus) so the tie-break logic lives
-- in one tested place.
--
-- Access control: the service-role key bypasses RLS, so the bundle RPCs
-- take the viewer's UUID and enforce owner-or-accepted-member access
-- internally, returning NULL when the viewer has no access (the route layer
-- maps that to 404 without leaking existence).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;


-- ── Internal helper: flattened place fields + source chips for one scrap ────
-- Mirrors hydrate_scraps' per-scrap place block exactly.
CREATE OR REPLACE FUNCTION public.travelscrapbook__scrap_place_json(p_place_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'place_name', p.name,
    'place_city', p.city,
    'place_region', p.region,
    'place_country', p.country,
    'category', COALESCE(p.category, 'other'),
    'lat', p.lat,
    'lng', p.lng,
    'geocode_confidence', COALESCE(p.geocode_confidence, 'none'),
    'geocode_display_name', p.geocode_display_name,
    'maps_url', p.maps_url,
    'og_image_url', (
      SELECT src.og_image_url
      FROM travelscrapbook_place_sources ps
      JOIN travelscrapbook_sources src ON src.id = ps.source_id
      WHERE ps.place_id = p.id AND src.og_image_url IS NOT NULL
      ORDER BY ps.created_at DESC
      LIMIT 1
    ),
    'sources', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', src.id,
        'url', src.url,
        'source_domain', src.source_domain,
        'og_title', src.og_title
      ) ORDER BY ps.created_at DESC)
      FROM travelscrapbook_place_sources ps
      JOIN travelscrapbook_sources src ON src.id = ps.source_id
      WHERE ps.place_id = p.id
    ), '[]'::jsonb)
  )
  FROM travelscrapbook_places p
  WHERE p.id = p_place_id
$$;


-- ── Internal helper: one membership's vibe rows (traveler + level) ──────────
CREATE OR REPLACE FUNCTION public.travelscrapbook__membership_vibes_json(p_membership_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'user_id', v.user_id,
    'display_name', COALESCE(pr.display_name, 'Traveler'),
    'level', v.level
  ) ORDER BY v.created_at), '[]'::jsonb)
  FROM travelscrapbook_scrap_vibes v
  LEFT JOIN travelscrapbook_profiles pr ON pr.id = v.user_id
  WHERE v.scrap_trip_id = p_membership_id
$$;


-- ── travelscrapbook_trip_bundle ──────────────────────────────────────────────
-- Everything the trip screen needs in ONE round trip: the trip row, the
-- viewer's role, owner display name, anchors, every membership's hydrated
-- scrap (with vibes), the member roster, and the viewer's wishlist
-- candidates (write-roles only; scope filtering stays in Python, it's pure
-- math over fields returned here). NULL = no access (route layer 404s).
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

  -- Wishlist candidates: the viewer's unvisited places not yet on this trip.
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


-- ── travelscrapbook_trips_list ───────────────────────────────────────────────
-- The trips landing screen in one round trip: owned + accepted-shared trips
-- with per-trip scrap counts, the viewer's role, and owner display names,
-- newest first. Replaces 4 sequential queries.
CREATE OR REPLACE FUNCTION public.travelscrapbook_trips_list(p_viewer UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(x.row_json ORDER BY x.created_at DESC), '[]'::jsonb)
  FROM (
    SELECT tr.created_at,
      to_jsonb(tr.*) || jsonb_build_object(
        'owner_user_id', tr.user_id,
        'owner_display_name', pr.display_name,
        'role', COALESCE(tm.role, 'owner'),
        'scrap_count', (
          SELECT count(*) FROM travelscrapbook_scrap_trips m WHERE m.trip_id = tr.id
        )
      ) AS row_json
    FROM travelscrapbook_trips tr
    LEFT JOIN travelscrapbook_trip_members tm
      ON tm.trip_id = tr.id AND tm.user_id = p_viewer AND tm.status = 'accepted'
    LEFT JOIN travelscrapbook_profiles pr ON pr.id = tr.user_id
    WHERE tr.user_id = p_viewer OR tm.id IS NOT NULL
  ) x
$$;
GRANT EXECUTE ON FUNCTION public.travelscrapbook_trips_list(UUID) TO travelscrapbook_role;


-- ── travelscrapbook_scrap_card ───────────────────────────────────────────────
-- One fully-hydrated membership-scoped scrap (place + sources + vibes) —
-- the cheap echo for mutation endpoints (assign/approve/schedule/vibe),
-- replacing a ~6-round-trip Python hydration pipeline. NULL when the place
-- isn't on that trip. Access is checked by the calling route BEFORE the
-- mutation, so this helper only ever echoes state the caller could touch.
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
         'route_position', m.route_position,
         'plan_date', m.plan_date,
         'plan_time', m.plan_time,
         'added_by_user_id', s.user_id,
         'added_by_display_name', owner_pr.display_name,
         'vibes', travelscrapbook__membership_vibes_json(m.id)
       )
  FROM travelscrapbook_scrap_trips m
  JOIN travelscrapbook_scraps s ON s.id = m.scrap_id
  LEFT JOIN travelscrapbook_profiles owner_pr ON owner_pr.id = s.user_id
  WHERE m.scrap_id = p_scrap_id AND m.trip_id = p_trip_id
$$;
GRANT EXECUTE ON FUNCTION public.travelscrapbook_scrap_card(UUID, UUID) TO travelscrapbook_role;


-- ── travelscrapbook_inbox_bundle ─────────────────────────────────────────────
-- The Wander List screen in one round trip: one filtered page of the
-- viewer's unvisited scraps (hydrated, with trip_ids for the picker), the
-- filtered total, drill-down geo facets, the global unvisited count (nav
-- badge), processing/failed sources, and the viewer's geocoded trips (the
-- input to Python-side trip suggestions — previously an identical trips
-- query PER SCRAP on the page).
--
-- Filter semantics mirror services/places.geo_match (trimmed
-- case-insensitive equality; unset levels always match) and geo_facets
-- (regions across the whole set; countries narrowed by the picked region;
-- cities narrowed by region + country).
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
    SELECT s.*, p.region AS place_region, p.country AS place_country, p.city AS place_city
    FROM travelscrapbook_scraps s
    JOIN travelscrapbook_places p ON p.id = s.place_id
    WHERE s.user_id = p_viewer AND s.visited_at IS NULL
  ),
  filtered AS (
    SELECT * FROM base
    WHERE (p_region  IS NULL OR btrim(lower(COALESCE(place_region,  ''))) = btrim(lower(p_region)))
      AND (p_country IS NULL OR btrim(lower(COALESCE(place_country, ''))) = btrim(lower(p_country)))
      AND (p_city    IS NULL OR btrim(lower(COALESCE(place_city,    ''))) = btrim(lower(p_city)))
  ),
  page AS (
    SELECT * FROM filtered ORDER BY created_at DESC LIMIT p_limit OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'scraps', COALESCE((
      SELECT jsonb_agg(
        (to_jsonb(f.*) - 'place_region' - 'place_country' - 'place_city')
        || travelscrapbook__scrap_place_json(f.place_id)
        || jsonb_build_object('trip_ids', COALESCE((
             SELECT jsonb_agg(m.trip_id)
             FROM travelscrapbook_scrap_trips m WHERE m.scrap_id = f.id
           ), '[]'::jsonb))
        ORDER BY f.created_at DESC)
      FROM page f
    ), '[]'::jsonb),
    'total', (SELECT count(*) FROM filtered),
    'unvisited_count', (SELECT count(*) FROM base),
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


-- ── travelscrapbook_visited_page ─────────────────────────────────────────────
-- One filtered page of visited places (most recent first) + total + facets.
-- Same filter/facet semantics as the inbox bundle.
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
    SELECT s.*, p.region AS place_region, p.country AS place_country, p.city AS place_city
    FROM travelscrapbook_scraps s
    JOIN travelscrapbook_places p ON p.id = s.place_id
    WHERE s.user_id = p_viewer AND s.visited_at IS NOT NULL
  ),
  filtered AS (
    SELECT * FROM base
    WHERE (p_region  IS NULL OR btrim(lower(COALESCE(place_region,  ''))) = btrim(lower(p_region)))
      AND (p_country IS NULL OR btrim(lower(COALESCE(place_country, ''))) = btrim(lower(p_country)))
      AND (p_city    IS NULL OR btrim(lower(COALESCE(place_city,    ''))) = btrim(lower(p_city)))
  ),
  page AS (
    SELECT * FROM filtered ORDER BY visited_at DESC LIMIT p_limit OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'scraps', COALESCE((
      SELECT jsonb_agg(
        (to_jsonb(f.*) - 'place_region' - 'place_country' - 'place_city')
        || travelscrapbook__scrap_place_json(f.place_id)
        ORDER BY f.visited_at DESC)
      FROM page f
    ), '[]'::jsonb),
    'total', (SELECT count(*) FROM filtered),
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


-- ── travelscrapbook_community_places ─────────────────────────────────────────
-- The community catalog page in one round trip, replacing a 2000-row fetch
-- + Python grouping. Groups places by OSM identity (else normalized name +
-- country code), picks the most complete row as each group's
-- representative, counts distinct savers, filters/facets/paginates, and
-- attaches deduped source chips for the returned page only. Mirrors
-- services/community.aggregate_places.
CREATE OR REPLACE FUNCTION public.travelscrapbook_community_places(
  p_q TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_country TEXT DEFAULT NULL,
  p_city TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
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
    SELECT p.*,
      CASE WHEN p.osm_id IS NOT NULL
           THEN 'osm:' || COALESCE(p.osm_type, '') || ':' || p.osm_id::text
           ELSE 'name:' || COALESCE(p.name_normalized, '') || ':' || lower(COALESCE(p.country_code, ''))
      END AS gkey
    FROM travelscrapbook_places p
    WHERE p.lat IS NOT NULL
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
GRANT EXECUTE ON FUNCTION public.travelscrapbook_community_places(TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT) TO travelscrapbook_role;


-- ── travelscrapbook_set_route_positions ──────────────────────────────────────
-- Persist an optimized route order in one statement instead of one UPDATE
-- per stop. p_positions: [{"id": "<scrap_trip uuid>", "pos": 1}, ...].
-- The calling route verifies trip write access before invoking.
CREATE OR REPLACE FUNCTION public.travelscrapbook_set_route_positions(p_positions JSONB)
RETURNS VOID
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE travelscrapbook_scrap_trips m
  SET route_position = x.pos
  FROM jsonb_to_recordset(p_positions) AS x(id UUID, pos INT)
  WHERE m.id = x.id
$$;


-- ── Lock the RPCs down to the backend ────────────────────────────────────────
-- These run as SECURITY DEFINER with the viewer passed as a parameter, so
-- they must never be callable through the Data API roles.
REVOKE EXECUTE ON FUNCTION public.travelscrapbook__scrap_place_json(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook__membership_vibes_json(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_trip_bundle(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_trips_list(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_scrap_card(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_inbox_bundle(UUID, TEXT, TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_visited_page(UUID, TEXT, TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_community_places(TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_set_route_positions(JSONB) FROM PUBLIC, anon, authenticated;

COMMIT;
