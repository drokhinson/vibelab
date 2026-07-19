-- 025_trip_suggestions_union.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- travelscrapbook_trip_suggestions — additive-union scope + pinless matching.
-- ═════════════════════════════════════════════════════════════════════════════
-- Fixes the "+ Todo / + Checkpoint" picker coming back empty while import
-- happily auto-stages the same places. Two changes vs 024:
--
--   1. ADDITIVE UNION SCOPE. A trip's effective geography is no longer just its
--      single geocoded destination — it's the UNION of that destination with
--      every country/region already present among the trip's approved members
--      (plans + stay/travel checkpoints + arrival/departure). A candidate now
--      matches when its country is in the trip's country-set OR its region is in
--      the region-set OR (city scope) it matches the destination city / centroid
--      radius. This is what makes a multi-city or multi-country trip suggest
--      everything across the geographies it actually touches.
--
--        • Members ALWAYS contribute their country/region to the union.
--        • The trip's OWN destination contributes only at its scope granularity
--          (country scope → dest_country; region scope → dest_region; city scope
--          uses the city-name / radius branch and broadens only via members) so
--          a fresh city trip with no members stays tight to its city instead of
--          ballooning to the whole country.
--
--   2. NO BLANKET lat REQUIREMENT. 024 dropped every candidate without a pin
--      (`AND p.lat IS NOT NULL` on both pools). That silently excluded
--      country/region-scoped places the Python matcher (services/places.py
--      place_matches_trip_scope) accepts on tag equality alone — the concrete
--      empty-picker bug. Coordinates are now required ONLY inside the city
--      radius sub-branch; pinless rows sort last via `dist_km NULLS LAST`.
--
-- Everything else (two-pool wander/community merge, proximity ranking off the
-- placed-plan centroid, category facet, pagination) is unchanged from 024.

DROP FUNCTION IF EXISTS public.travelscrapbook_trip_suggestions(UUID, UUID, TEXT, BOOLEAN, TEXT, INT, INT);

CREATE OR REPLACE FUNCTION public.travelscrapbook_trip_suggestions(
  p_trip_id UUID,
  p_viewer UUID,
  p_category TEXT DEFAULT NULL,
  p_checkpoints BOOLEAN DEFAULT false,
  p_q TEXT DEFAULT NULL,
  p_limit INT DEFAULT 6,
  p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH trip AS (
    SELECT id, scope_level, dest_region, dest_country, dest_city, lat, lng
    FROM travelscrapbook_trips WHERE id = p_trip_id
  ),
  -- Distinct country/region of every approved member place of the trip (plans,
  -- checkpoints, arrival/departure alike). Approved-only so auto-staged
  -- suggestions can't widen the net and pull in yet more.
  member_geo AS (
    SELECT DISTINCT
      NULLIF(btrim(lower(p.country)), '') AS country,
      NULLIF(btrim(lower(p.region)), '')  AS region
    FROM travelscrapbook_scrap_trips m
    JOIN travelscrapbook_scraps s ON s.id = m.scrap_id
    JOIN travelscrapbook_places p ON p.id = s.place_id
    WHERE m.trip_id = p_trip_id AND m.status = 'approved'
  ),
  -- country-set = members' countries ∪ (dest_country when country-scoped).
  country_set AS (
    SELECT country AS val FROM member_geo WHERE country IS NOT NULL
    UNION
    SELECT btrim(lower(dest_country)) FROM trip
     WHERE scope_level = 'country' AND NULLIF(btrim(dest_country), '') IS NOT NULL
  ),
  -- region-set = members' regions ∪ (dest_region when region-scoped).
  region_set AS (
    SELECT region AS val FROM member_geo WHERE region IS NOT NULL
    UNION
    SELECT btrim(lower(dest_region)) FROM trip
     WHERE scope_level = 'region' AND NULLIF(btrim(dest_region), '') IS NOT NULL
  ),
  -- Reference point for proximity ranking: centroid of the trip's placed PLAN
  -- pins (role IS NULL), falling back to the trip destination centroid.
  ref AS (
    SELECT
      COALESCE(avg(p.lat), (SELECT lat FROM trip)) AS rlat,
      COALESCE(avg(p.lng), (SELECT lng FROM trip)) AS rlng
    FROM travelscrapbook_scrap_trips m
    JOIN travelscrapbook_scraps s ON s.id = m.scrap_id
    JOIN travelscrapbook_places p ON p.id = s.place_id
    WHERE m.trip_id = p_trip_id AND m.role IS NULL AND p.lat IS NOT NULL
  ),

  -- ── Wander pool: the viewer's own candidate places ─────────────────────────
  wander AS (
    SELECT
      'wander'::text AS source,
      s.id::text     AS scrap_id,
      p.id           AS ref_place_id,
      p.name, p.city, p.region, p.country,
      COALESCE(p.category, 'other') AS category,
      p.lat, p.lng, p.maps_url,
      (SELECT src.og_image_url
         FROM travelscrapbook_place_sources ps
         JOIN travelscrapbook_sources src ON src.id = ps.source_id
        WHERE ps.place_id = p.id AND src.og_image_url IS NOT NULL
        ORDER BY ps.created_at DESC LIMIT 1) AS og_image_url,
      0 AS saved_by_count
    FROM travelscrapbook_scraps s
    JOIN travelscrapbook_places p ON p.id = s.place_id
    LEFT JOIN travelscrapbook_categories c ON c.slug = COALESCE(p.category, 'other')
    CROSS JOIN trip t
    WHERE s.user_id = p_viewer
      AND s.visited_at IS NULL
      AND COALESCE(c.is_checkpoint, false) = p_checkpoints
      AND NOT EXISTS (
        SELECT 1 FROM travelscrapbook_scrap_trips m
        WHERE m.scrap_id = s.id AND m.trip_id = p_trip_id)
      AND NOT EXISTS (
        SELECT 1 FROM travelscrapbook_scrap_trip_dismissals d
        WHERE d.scrap_id = s.id AND d.trip_id = p_trip_id)
      AND (p_q IS NULL OR p.name ILIKE '%' || p_q || '%' OR p.city ILIKE '%' || p_q || '%')
      -- additive-union geo scope (see header)
      AND (
        btrim(lower(COALESCE(p.country, ''))) IN (SELECT val FROM country_set)
        OR btrim(lower(COALESCE(p.region, ''))) IN (SELECT val FROM region_set)
        -- city-name match (country-guarded implicitly by the city string)
        OR (NULLIF(btrim(t.dest_city), '') IS NOT NULL
            AND btrim(lower(COALESCE(p.city, ''))) = btrim(lower(t.dest_city)))
        -- centroid radius (the only branch that needs coordinates); mirrors
        -- services/optimizer.py haversine_km, TRIP_MATCH_RADIUS_KM = 100
        OR (t.lat IS NOT NULL AND p.lat IS NOT NULL
            AND 2 * 6371 * asin(sqrt(
                  power(sin(radians(t.lat - p.lat) / 2), 2) +
                  cos(radians(p.lat)) * cos(radians(t.lat)) *
                  power(sin(radians(t.lng - p.lng) / 2), 2))) <= 100)
        -- no scope to match against at all → don't over-restrict to empty
        OR (NOT EXISTS (SELECT 1 FROM country_set)
            AND NOT EXISTS (SELECT 1 FROM region_set)
            AND NULLIF(btrim(t.dest_city), '') IS NULL
            AND t.lat IS NULL)
      )
  ),

  -- ── Community pool: aggregated cross-user places (facts only) ───────────────
  cbase AS (
    SELECT p.*,
      CASE WHEN p.osm_id IS NOT NULL
           THEN 'osm:' || COALESCE(p.osm_type, '') || ':' || p.osm_id::text
           ELSE 'name:' || COALESCE(p.name_normalized, '') || ':' || lower(COALESCE(p.country_code, ''))
      END AS gkey
    FROM travelscrapbook_places p
    LEFT JOIN travelscrapbook_categories c ON c.slug = COALESCE(p.category, 'other')
    WHERE COALESCE(c.is_checkpoint, false) = p_checkpoints
      AND (p_q IS NULL OR p.name ILIKE '%' || p_q || '%' OR p.city ILIKE '%' || p_q || '%')
  ),
  cgrouped AS (
    SELECT gkey, count(DISTINCT user_id) AS saved_by_count, array_agg(id) AS place_ids
    FROM cbase GROUP BY gkey
  ),
  crep AS (
    -- Most complete row represents the group (pin > maps link > city > specific
    -- category); id tie-break keeps the pick deterministic.
    SELECT DISTINCT ON (gkey) *
    FROM cbase
    ORDER BY gkey,
      (maps_url IS NOT NULL) DESC,
      (city IS NOT NULL) DESC,
      (category IS DISTINCT FROM 'other') DESC,
      id
  ),
  community AS (
    SELECT
      'community'::text AS source,
      NULL::text        AS scrap_id,
      r.id              AS ref_place_id,
      r.name, r.city, r.region, r.country,
      COALESCE(r.category, 'other') AS category,
      r.lat, r.lng, r.maps_url,
      (SELECT src.og_image_url
         FROM travelscrapbook_place_sources ps
         JOIN travelscrapbook_sources src ON src.id = ps.source_id
        WHERE ps.place_id = ANY (g.place_ids) AND src.og_image_url IS NOT NULL
        ORDER BY ps.created_at DESC LIMIT 1) AS og_image_url,
      g.saved_by_count
    FROM crep r
    JOIN cgrouped g USING (gkey)
    CROSS JOIN trip t
    WHERE
      -- don't re-show a place the viewer already saved (it's in the wander pool)
      NOT EXISTS (SELECT 1 FROM cbase b WHERE b.gkey = r.gkey AND b.user_id = p_viewer)
      AND (
        btrim(lower(COALESCE(r.country, ''))) IN (SELECT val FROM country_set)
        OR btrim(lower(COALESCE(r.region, ''))) IN (SELECT val FROM region_set)
        OR (NULLIF(btrim(t.dest_city), '') IS NOT NULL
            AND btrim(lower(COALESCE(r.city, ''))) = btrim(lower(t.dest_city)))
        OR (t.lat IS NOT NULL AND r.lat IS NOT NULL
            AND 2 * 6371 * asin(sqrt(
                  power(sin(radians(t.lat - r.lat) / 2), 2) +
                  cos(radians(r.lat)) * cos(radians(t.lat)) *
                  power(sin(radians(t.lng - r.lng) / 2), 2))) <= 100)
        OR (NOT EXISTS (SELECT 1 FROM country_set)
            AND NOT EXISTS (SELECT 1 FROM region_set)
            AND NULLIF(btrim(t.dest_city), '') IS NULL
            AND t.lat IS NULL)
      )
  ),

  -- ── Merge + rank (category NOT yet applied → drives the facet) ──────────────
  merged_all AS (
    SELECT m.*,
      CASE WHEN m.source = 'wander' THEN 0 ELSE 1 END AS source_rank,
      CASE WHEN (SELECT rlat FROM ref) IS NOT NULL AND m.lat IS NOT NULL
        THEN 2 * 6371 * asin(sqrt(
               power(sin(radians((SELECT rlat FROM ref) - m.lat) / 2), 2) +
               cos(radians(m.lat)) * cos(radians((SELECT rlat FROM ref))) *
               power(sin(radians((SELECT rlng FROM ref) - m.lng) / 2), 2)))
        ELSE NULL END AS dist_km
    FROM (SELECT * FROM wander UNION ALL SELECT * FROM community) m
  ),
  filtered AS (
    SELECT * FROM merged_all WHERE (p_category IS NULL OR category = p_category)
  ),
  page AS (
    SELECT * FROM filtered
    ORDER BY source_rank, dist_km ASC NULLS LAST, name
    LIMIT p_limit OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'source', pg.source,
        'scrap_id', pg.scrap_id,
        'ref_place_id', pg.ref_place_id,
        'name', pg.name,
        'city', pg.city,
        'region', pg.region,
        'country', pg.country,
        'category', pg.category,
        'lat', pg.lat,
        'lng', pg.lng,
        'maps_url', pg.maps_url,
        'og_image_url', pg.og_image_url,
        'saved_by_count', pg.saved_by_count,
        'dist_km', pg.dist_km
      ) ORDER BY pg.source_rank, pg.dist_km ASC NULLS LAST, pg.name)
      FROM page pg
    ), '[]'::jsonb),
    'total', (SELECT count(*) FROM filtered),
    'categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'slug', cat.slug, 'label', cat.label, 'icon', cat.icon, 'count', fc.cnt
      ) ORDER BY cat.sort_order, cat.label)
      FROM (SELECT category AS slug, count(*) AS cnt FROM merged_all GROUP BY category) fc
      JOIN travelscrapbook_categories cat ON cat.slug = fc.slug
    ), '[]'::jsonb)
  )
$$;

GRANT EXECUTE ON FUNCTION public.travelscrapbook_trip_suggestions(UUID, UUID, TEXT, BOOLEAN, TEXT, INT, INT) TO travelscrapbook_role;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_trip_suggestions(UUID, UUID, TEXT, BOOLEAN, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- travelscrapbook_inbox_bundle — carry each geocoded trip's member country/region
-- sets so the inbox trip-suggestions (services/places.suggest_trips) apply the
-- SAME additive-union scope as the live picker. Only the geocoded_trips block
-- changes vs 020; everything else is copied verbatim.
-- ═════════════════════════════════════════════════════════════════════════════
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
        'dest_region', t.dest_region, 'dest_country', t.dest_country,
        -- additive-union scope: countries/regions of the trip's approved members
        'member_countries', COALESCE((
          SELECT jsonb_agg(DISTINCT btrim(lower(mp.country)))
          FROM travelscrapbook_scrap_trips mm
          JOIN travelscrapbook_scraps ms ON ms.id = mm.scrap_id
          JOIN travelscrapbook_places mp ON mp.id = ms.place_id
          WHERE mm.trip_id = t.id AND mm.status = 'approved'
            AND NULLIF(btrim(mp.country), '') IS NOT NULL
        ), '[]'::jsonb),
        'member_regions', COALESCE((
          SELECT jsonb_agg(DISTINCT btrim(lower(mp.region)))
          FROM travelscrapbook_scrap_trips mm
          JOIN travelscrapbook_scraps ms ON ms.id = mm.scrap_id
          JOIN travelscrapbook_places mp ON mp.id = ms.place_id
          WHERE mm.trip_id = t.id AND mm.status = 'approved'
            AND NULLIF(btrim(mp.region), '') IS NOT NULL
        ), '[]'::jsonb)
      ))
      FROM travelscrapbook_trips t
      WHERE t.user_id = p_viewer AND t.lat IS NOT NULL
    ), '[]'::jsonb)
  )
$$;
GRANT EXECUTE ON FUNCTION public.travelscrapbook_inbox_bundle(UUID, TEXT, TEXT, TEXT, INT, INT) TO travelscrapbook_role;
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_inbox_bundle(UUID, TEXT, TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
