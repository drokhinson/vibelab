-- 024_trip_suggestions.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- travelscrapbook_trip_suggestions — the unified "add to trip" picker feed.
-- ═════════════════════════════════════════════════════════════════════════════
-- Both the "+ Todo" and "+ Checkpoint" buttons on the trip screen open one
-- picker backed by this RPC. It merges two pools into a single proximity-ranked,
-- paginated list:
--   • wander  — the viewer's own unvisited saved places (higher priority)
--   • community — the anonymized cross-user pool (canonical facts only)
-- filtered to the trip's geographic scope, split by the checkpoint partition
-- (p_checkpoints = false → plans; true → stays & transport), optionally narrowed
-- to one category, and ordered wander-first then nearest to the trip's existing
-- plans. Category is applied AFTER the merge so the returned `categories` facet
-- (the type filter) always reflects the whole scoped pool, not the current pick.
--
-- Modeled on travelscrapbook_community_places (020 §8) for the community
-- aggregation and on the trip_bundle `candidates` CTE (020 §5) for the wander
-- filter. The proximity math inlines the same haversine as
-- services/optimizer.py haversine_km (6371 km radius). The reference point is
-- the centroid of the trip's placed PLAN pins, falling back to the trip
-- destination centroid when nothing is placed yet.

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
      AND p.lat IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM travelscrapbook_scrap_trips m
        WHERE m.scrap_id = s.id AND m.trip_id = p_trip_id)
      AND NOT EXISTS (
        SELECT 1 FROM travelscrapbook_scrap_trip_dismissals d
        WHERE d.scrap_id = s.id AND d.trip_id = p_trip_id)
      AND (p_q IS NULL OR p.name ILIKE '%' || p_q || '%' OR p.city ILIKE '%' || p_q || '%')
      -- geo scope (only the level the trip is scoped to, when it's set)
      AND (CASE
        WHEN t.scope_level = 'country' AND NULLIF(btrim(t.dest_country), '') IS NOT NULL
          THEN btrim(lower(COALESCE(p.country, ''))) = btrim(lower(t.dest_country))
        WHEN t.scope_level = 'region' AND NULLIF(btrim(t.dest_region), '') IS NOT NULL
          THEN btrim(lower(COALESCE(p.region, ''))) = btrim(lower(t.dest_region))
        WHEN t.scope_level = 'city' THEN (
          (NULLIF(btrim(t.dest_city), '') IS NOT NULL
             AND btrim(lower(COALESCE(p.city, ''))) = btrim(lower(t.dest_city)))
          OR (t.lat IS NOT NULL AND p.lat IS NOT NULL
             -- haversine km (mirrors services/optimizer.py; TRIP_MATCH_RADIUS_KM = 100)
             AND 2 * 6371 * asin(sqrt(
                   power(sin(radians(t.lat - p.lat) / 2), 2) +
                   cos(radians(p.lat)) * cos(radians(t.lat)) *
                   power(sin(radians(t.lng - p.lng) / 2), 2))) <= 100)
          OR (NULLIF(btrim(t.dest_city), '') IS NULL AND t.lat IS NULL))
        ELSE true
      END)
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
    WHERE p.lat IS NOT NULL
      AND COALESCE(c.is_checkpoint, false) = p_checkpoints
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
      AND (CASE
        WHEN t.scope_level = 'country' AND NULLIF(btrim(t.dest_country), '') IS NOT NULL
          THEN btrim(lower(COALESCE(r.country, ''))) = btrim(lower(t.dest_country))
        WHEN t.scope_level = 'region' AND NULLIF(btrim(t.dest_region), '') IS NOT NULL
          THEN btrim(lower(COALESCE(r.region, ''))) = btrim(lower(t.dest_region))
        WHEN t.scope_level = 'city' THEN (
          (NULLIF(btrim(t.dest_city), '') IS NOT NULL
             AND btrim(lower(COALESCE(r.city, ''))) = btrim(lower(t.dest_city)))
          OR (t.lat IS NOT NULL AND r.lat IS NOT NULL
             AND 2 * 6371 * asin(sqrt(
                   power(sin(radians(t.lat - r.lat) / 2), 2) +
                   cos(radians(r.lat)) * cos(radians(t.lat)) *
                   power(sin(radians(t.lng - r.lng) / 2), 2))) <= 100)
          OR (NULLIF(btrim(t.dest_city), '') IS NULL AND t.lat IS NULL))
        ELSE true
      END)
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
