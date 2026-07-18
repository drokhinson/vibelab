-- 024_community_excludes_orphans.sql
--
-- Make the Community pool structurally incapable of showing an orphaned place.
--
-- travelscrapbook_community_places reads the places table directly, so any place
-- row with no referencing scrap (a partial-failure orphan, a crash mid-import)
-- shows up as a ghost in the "master list" and inflates saved_by_count. This
-- redefines the RPC with a single added guard on the base CTE:
--
--     AND EXISTS (SELECT 1 FROM travelscrapbook_scraps s WHERE s.place_id = p.id)
--
-- so the pool always reflects places someone currently keeps — permanently, no
-- matter how an orphan arose. (idx_ts_scraps_place backs the EXISTS.) Migration
-- 023 removes the existing dead rows; this keeps future ones from ever surfacing.
--
-- Signature is unchanged, so CREATE OR REPLACE is enough (no DROP needed). The
-- body is otherwise identical to migration 020's definition.

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
      -- Only places someone currently keeps — never an orphaned ghost row.
      AND EXISTS (SELECT 1 FROM travelscrapbook_scraps s WHERE s.place_id = p.id)
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
