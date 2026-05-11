-- sauceboss — dynamic cuisine + dish filters for Browse & Saucebook
--
-- Adds:
--   1. get_sauceboss_distinct_cuisines() — all cuisines that appear on ≥1 sauce,
--      with emoji from sauceboss_cuisine_info.
--   2. get_sauceboss_filter_dishes()     — dish-level items targeted by ≥1 sauce
--      via sauceboss_sauce_to_dish (target_kind='dish').
--   3. Updated get_sauceboss_browse()    — adds p_dishes TEXT[] parameter to
--      filter sauces by compatible dish ids.


-- ── 1) Distinct cuisines ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_sauceboss_distinct_cuisines()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(row_obj ORDER BY row_obj->>'cuisine'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'cuisine', s.cuisine,
      'emoji',   COALESCE(ci.cuisine_emoji, '🍽')
    ) AS row_obj
    FROM (SELECT DISTINCT cuisine FROM public.sauceboss_sauce WHERE cuisine IS NOT NULL AND cuisine <> '') s
    LEFT JOIN public.sauceboss_cuisine_info ci ON ci.cuisine = s.cuisine
  ) sub;
$$;


-- ── 2) Filter dishes (only those targeted by ≥1 sauce) ─────────────────────
CREATE OR REPLACE FUNCTION public.get_sauceboss_filter_dishes()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(row_obj ORDER BY row_obj->>'category', row_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',       d.id,
      'name',     d.name,
      'emoji',    d.emoji,
      'category', d.category
    ) AS row_obj
    FROM public.sauceboss_dish d
    WHERE d.dish_level = 'dish'
      AND EXISTS (
        SELECT 1 FROM public.sauceboss_sauce_to_dish st
         WHERE st.target_kind = 'dish' AND st.target_value = d.id
      )
  ) sub;
$$;


-- ── 3) Browse RPC with p_dishes parameter ───────────────────────────────────
DROP FUNCTION IF EXISTS public.get_sauceboss_browse(UUID, TEXT, TEXT[], TEXT[], UUID, INT, INT) CASCADE;

CREATE OR REPLACE FUNCTION public.get_sauceboss_browse(
  p_user_id   UUID,
  p_q         TEXT,
  p_cuisines  TEXT[],
  p_types     TEXT[],
  p_dishes    TEXT[],
  p_author    UUID,
  p_limit     INT,
  p_offset    INT
)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  WITH filtered AS (
    SELECT s.*, COALESCE(p.display_name, '') AS author_name
      FROM public.sauceboss_sauce s
      LEFT JOIN public.sauceboss_user_profiles p ON p.id = s.created_by
     WHERE
       (p_q IS NULL OR p_q = '' OR s.name ILIKE ('%' || p_q || '%'))
       AND (p_cuisines IS NULL OR cardinality(p_cuisines) = 0 OR s.cuisine = ANY(p_cuisines))
       AND (p_types    IS NULL OR cardinality(p_types)    = 0 OR s.sauce_type = ANY(p_types))
       AND (p_dishes   IS NULL OR cardinality(p_dishes)   = 0 OR EXISTS (
              SELECT 1 FROM public.sauceboss_sauce_to_dish sd
               WHERE sd.sauce_id = s.id
                 AND sd.target_kind = 'dish'
                 AND sd.target_value = ANY(p_dishes)
            ))
       AND (p_author IS NULL OR s.created_by = p_author)
       AND s.parent_sauce_id IS NULL
  ),
  total_count AS (SELECT COUNT(*)::int AS n FROM filtered),
  page AS (
    SELECT * FROM filtered
     ORDER BY created_at DESC, id
     OFFSET COALESCE(p_offset, 0)
     LIMIT  COALESCE(p_limit, 20)
  )
  SELECT json_build_object(
    'total', (SELECT n FROM total_count),
    'items', COALESCE((
      SELECT json_agg(
        json_build_object(
          'id',            f.id,
          'name',          f.name,
          'cuisine',       f.cuisine,
          'cuisineEmoji',  COALESCE(ci.cuisine_emoji, ''),
          'color',         f.color,
          'sauceType',     f.sauce_type,
          'sourceUrl',     f.source_url,
          'createdBy',     f.created_by,
          'authorName',    f.author_name,
          'parentSauceId', f.parent_sauce_id,
          'variantCount', (
            SELECT COUNT(*)::int FROM public.sauceboss_sauce v WHERE v.parent_sauce_id = f.id
          ),
          'attachments', (
            SELECT COALESCE(json_agg(json_build_object('kind', a.target_kind, 'value', a.target_value)
                                     ORDER BY a.target_kind, a.target_value), '[]'::json)
              FROM public.sauceboss_sauce_to_dish a
             WHERE a.sauce_id = f.id
          ),
          'inSaucebook', (
            p_user_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.sauceboss_user_saucebook sb
               WHERE sb.user_id = p_user_id AND sb.sauce_id = f.id
            )
          )
        )
      )
      FROM page f
      LEFT JOIN public.sauceboss_cuisine_info ci ON ci.cuisine = f.cuisine
    ), '[]'::json)
  );
$$;
