-- ─────────────────────────────────────────────────────────────────────────────
-- sauceboss — saucebook + pantry
--
-- Adds:
--   * sauceboss_saucebook(user_id, sauce_id) — per-user library; references,
--     not copies. Author of the sauce stays as `created_by` on
--     sauceboss_sauces. Editing a non-owned sauce in the saucebook forks
--     into a variant via fork_sauceboss_sauce() (see below).
--   * sauceboss_pantry_missing(user_id, food_id) — negative list. A row
--     means the user is OUT of that ingredient. Default state is empty
--     (assume you have everything). Keyed by food_id (not free text) so the
--     existing merge_sauceboss_foods RPC keeps the pantry consistent for
--     free.
--
-- New RPCs:
--   * get_sauceboss_saucebook(user_id) — full sauce envelopes for the user's
--     library, mirroring get_sauceboss_all_sauces_full's shape + addedAt.
--   * get_sauceboss_browse(...) — paginated, filterable, sortable read of
--     all sauces for the Browse tab. Returns lightweight rows + total count
--     and an `inSaucebook` boolean per row for the calling user.
--   * get_sauceboss_browse_authors(q) — autocomplete for the Browse author
--     filter; only returns profiles that authored ≥1 sauce.
--   * get_sauceboss_pantry_for_user(user_id) — every food appearing in any
--     sauce in the user's saucebook, with a `missing` flag.
--   * set_sauceboss_pantry_missing(user_id, food_ids[]) — replace the
--     user's missing set in a single round-trip.
--   * fork_sauceboss_sauce(p_source_id, p_root_id, p_user, p_data) — atomic
--     fork: create a new sauce as a variant under p_root_id, owned by
--     p_user, with payload p_data; copy attachments from source if the
--     payload doesn't override them; repoint the user's saucebook entry
--     from p_source_id to the new sauce id; return the new id.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 0) sauceboss_sauces.created_at (so Browse can sort latest-first) ──────────
-- Backfilled to NOW() for existing rows (legacy seed sauces all share a
-- timestamp; tie-break by id, which is stable). New rows pick up DEFAULT NOW().
ALTER TABLE public.sauceboss_sauces
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS sauceboss_sauces_created_at_idx
  ON public.sauceboss_sauces (created_at DESC);


-- ── 1) Saucebook membership ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sauceboss_saucebook (
  user_id  UUID NOT NULL REFERENCES public.sauceboss_profiles(id) ON DELETE CASCADE,
  sauce_id TEXT NOT NULL REFERENCES public.sauceboss_sauces(id)   ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, sauce_id)
);
CREATE INDEX IF NOT EXISTS sauceboss_saucebook_by_sauce_idx
  ON public.sauceboss_saucebook(sauce_id);
ALTER TABLE public.sauceboss_saucebook ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_saucebook TO sauceboss_role;


-- ── 2) Pantry missing list ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sauceboss_pantry_missing (
  user_id UUID NOT NULL REFERENCES public.sauceboss_profiles(id) ON DELETE CASCADE,
  food_id TEXT NOT NULL REFERENCES public.sauceboss_foods(id)    ON DELETE CASCADE,
  PRIMARY KEY (user_id, food_id)
);
CREATE INDEX IF NOT EXISTS sauceboss_pantry_missing_by_user_idx
  ON public.sauceboss_pantry_missing(user_id);
ALTER TABLE public.sauceboss_pantry_missing ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_pantry_missing TO sauceboss_role;


-- ── 3) Saucebook read ─────────────────────────────────────────────────────────
-- Same shape as get_sauceboss_all_sauces_full + addedAt + variantCount on the
-- family root.
CREATE OR REPLACE FUNCTION public.get_sauceboss_saucebook(p_user_id UUID)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'cuisine', sauce_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',              s.id,
      'name',            s.name,
      'cuisine',         s.cuisine,
      'cuisineEmoji',    s.cuisine_emoji,
      'color',           s.color,
      'description',     s.description,
      'sourceUrl',       s.source_url,
      'sauceType',       s.sauce_type,
      'createdBy',       s.created_by,
      'authorName',      COALESCE(p.display_name, ''),
      'parentSauceId',   s.parent_sauce_id,
      'addedAt',         sb.added_at,
      'variantCount', (
        SELECT COUNT(*)::int FROM public.sauceboss_sauces v
         WHERE v.parent_sauce_id = COALESCE(s.parent_sauce_id, s.id)
      ),
      'attachments', (
        SELECT COALESCE(json_agg(json_build_object('kind', a.target_kind, 'value', a.target_value)
                                 ORDER BY a.target_kind, a.target_value), '[]'::json)
          FROM public.sauceboss_sauce_attachments a
         WHERE a.sauce_id = s.id
      ),
      'compatibleItems', (
        SELECT COALESCE(json_agg(link.item_id), '[]'::json)
        FROM public.sauceboss_sauce_items link
        WHERE link.sauce_id = s.id
      ),
      'ingredients', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'name',         di.food_name,
            'amount',       di.quantity,
            'unit',         di.unit_abbr,
            'unitId',       di.unit_id,
            'foodId',       di.food_id,
            'originalText', di.original_text,
            'canonicalMl',  di.canonical_ml,
            'canonicalG',   di.canonical_g
          )
          ORDER BY di.step_order, di.id
        ), '[]'::json)
        FROM (
          SELECT DISTINCT ON (di_inner.food_name)
            di_inner.id, di_inner.food_name, di_inner.quantity, di_inner.unit_abbr,
            di_inner.unit_id, di_inner.food_id, di_inner.original_text,
            di_inner.canonical_ml, di_inner.canonical_g, di_inner.step_order
          FROM (
            SELECT
              si_inner.id,
              COALESCE(f.name, si_inner.original_text) AS food_name,
              si_inner.quantity::double precision AS quantity,
              COALESCE(u.abbreviation, '') AS unit_abbr,
              si_inner.unit_id,
              si_inner.food_id,
              si_inner.original_text,
              si_inner.quantity_canonical_ml AS canonical_ml,
              si_inner.quantity_canonical_g  AS canonical_g,
              ss_inner.step_order
            FROM public.sauceboss_sauce_steps ss_inner
            JOIN public.sauceboss_step_ingredients si_inner ON si_inner.step_id = ss_inner.id
            LEFT JOIN public.sauceboss_foods f ON f.id = si_inner.food_id
            LEFT JOIN public.sauceboss_units u ON u.id = si_inner.unit_id
            WHERE ss_inner.sauce_id = s.id
          ) di_inner
          ORDER BY di_inner.food_name, di_inner.step_order, di_inner.id
        ) di
      ),
      'steps', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'title',         ss.title,
            'instructions',  ss.instructions,
            'estimatedTime', ss.estimated_time,
            'inputFromStep', ss.input_from_step,
            'ingredients', (
              SELECT COALESCE(json_agg(
                json_build_object(
                  'name',         COALESCE(f.name, si.original_text),
                  'amount',       si.quantity::double precision,
                  'unit',         COALESCE(u.abbreviation, ''),
                  'unitId',       si.unit_id,
                  'foodId',       si.food_id,
                  'originalText', si.original_text,
                  'canonicalMl',  si.quantity_canonical_ml,
                  'canonicalG',   si.quantity_canonical_g
                )
                ORDER BY si.id
              ), '[]'::json)
              FROM public.sauceboss_step_ingredients si
              LEFT JOIN public.sauceboss_foods f ON f.id = si.food_id
              LEFT JOIN public.sauceboss_units u ON u.id = si.unit_id
              WHERE si.step_id = ss.id
            )
          )
          ORDER BY ss.step_order
        ), '[]'::json)
        FROM public.sauceboss_sauce_steps ss
        WHERE ss.sauce_id = s.id
      )
    ) AS sauce_obj
    FROM public.sauceboss_saucebook sb
    JOIN public.sauceboss_sauces s ON s.id = sb.sauce_id
    LEFT JOIN public.sauceboss_profiles p ON p.id = s.created_by
    WHERE sb.user_id = p_user_id
  ) sub;
$$;


-- ── 4) Browse list (paginated, filtered, sorted latest-first) ─────────────────
-- Lightweight rows (no steps/ingredients) — Browse is read-only and only
-- needs name / type / author / variant count + the family root id so the
-- frontend can group variants. The full envelope is fetched on detail view.
CREATE OR REPLACE FUNCTION public.get_sauceboss_browse(
  p_user_id   UUID,
  p_q         TEXT,
  p_cuisines  TEXT[],
  p_types     TEXT[],
  p_author    UUID,
  p_limit     INT,
  p_offset    INT
)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  WITH filtered AS (
    SELECT s.*, COALESCE(p.display_name, '') AS author_name
      FROM public.sauceboss_sauces s
      LEFT JOIN public.sauceboss_profiles p ON p.id = s.created_by
     WHERE
       (p_q IS NULL OR p_q = '' OR s.name ILIKE ('%' || p_q || '%'))
       AND (p_cuisines IS NULL OR cardinality(p_cuisines) = 0 OR s.cuisine = ANY(p_cuisines))
       AND (p_types    IS NULL OR cardinality(p_types)    = 0 OR s.sauce_type = ANY(p_types))
       AND (p_author IS NULL OR s.created_by = p_author)
       -- Browse only surfaces family roots; variants are a detail-view concern.
       AND s.parent_sauce_id IS NULL
  ),
  total_count AS (SELECT COUNT(*)::int AS n FROM filtered),
  page AS (
    SELECT *
      FROM filtered
     ORDER BY created_at DESC, id
     OFFSET COALESCE(p_offset, 0)
     LIMIT COALESCE(p_limit, 20)
  )
  SELECT json_build_object(
    'total', (SELECT n FROM total_count),
    'items', COALESCE((
      SELECT json_agg(
        json_build_object(
          'id',            f.id,
          'name',          f.name,
          'cuisine',       f.cuisine,
          'cuisineEmoji',  f.cuisine_emoji,
          'color',         f.color,
          'sauceType',     f.sauce_type,
          'sourceUrl',     f.source_url,
          'createdBy',     f.created_by,
          'authorName',    f.author_name,
          'parentSauceId', f.parent_sauce_id,
          'variantCount', (
            SELECT COUNT(*)::int FROM public.sauceboss_sauces v WHERE v.parent_sauce_id = f.id
          ),
          'attachments', (
            SELECT COALESCE(json_agg(json_build_object('kind', a.target_kind, 'value', a.target_value)
                                     ORDER BY a.target_kind, a.target_value), '[]'::json)
              FROM public.sauceboss_sauce_attachments a
             WHERE a.sauce_id = f.id
          ),
          'inSaucebook', (
            p_user_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.sauceboss_saucebook sb
               WHERE sb.user_id = p_user_id AND sb.sauce_id = f.id
            )
          )
        )
      )
      FROM page f
    ), '[]'::json)
  );
$$;


-- ── 5) Browse author autocomplete ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_sauceboss_browse_authors(p_q TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."displayName"), '[]'::json)
  FROM (
    SELECT
      p.id           AS "userId",
      p.display_name AS "displayName",
      (SELECT COUNT(*)::int FROM public.sauceboss_sauces s WHERE s.created_by = p.id) AS "sauceCount"
    FROM public.sauceboss_profiles p
    WHERE EXISTS (SELECT 1 FROM public.sauceboss_sauces s WHERE s.created_by = p.id)
      AND (p_q IS NULL OR p_q = '' OR p.display_name ILIKE ('%' || p_q || '%'))
    LIMIT 20
  ) t;
$$;


-- ── 6) Pantry read ────────────────────────────────────────────────────────────
-- Surface every food appearing in any sauce in the user's saucebook + a
-- `missing` flag from sauceboss_pantry_missing.
CREATE OR REPLACE FUNCTION public.get_sauceboss_pantry_for_user(p_user_id UUID)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  WITH user_sauces AS (
    SELECT sauce_id FROM public.sauceboss_saucebook WHERE user_id = p_user_id
  ),
  user_foods AS (
    SELECT DISTINCT si.food_id, f.name
      FROM user_sauces us
      JOIN public.sauceboss_sauce_steps ss      ON ss.sauce_id = us.sauce_id
      JOIN public.sauceboss_step_ingredients si ON si.step_id = ss.id
      LEFT JOIN public.sauceboss_foods f         ON f.id = si.food_id
     WHERE si.food_id IS NOT NULL
  )
  SELECT json_build_object(
    'ingredients', COALESCE((
      SELECT json_agg(
        json_build_object(
          'foodId',  uf.food_id,
          'name',    uf.name,
          'missing', EXISTS (
            SELECT 1 FROM public.sauceboss_pantry_missing pm
             WHERE pm.user_id = p_user_id AND pm.food_id = uf.food_id
          )
        )
        ORDER BY uf.name
      )
      FROM user_foods uf
    ), '[]'::json),
    'saucebookSauceIds', COALESCE((SELECT json_agg(sauce_id) FROM user_sauces), '[]'::json)
  );
$$;


-- ── 7) Pantry write (replace user's missing set in one call) ──────────────────
CREATE OR REPLACE FUNCTION public.set_sauceboss_pantry_missing(
  p_user_id   UUID,
  p_food_ids  TEXT[]
)
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.sauceboss_pantry_missing WHERE user_id = p_user_id;

  IF p_food_ids IS NOT NULL AND cardinality(p_food_ids) > 0 THEN
    INSERT INTO public.sauceboss_pantry_missing (user_id, food_id)
    SELECT p_user_id, food_id
      FROM UNNEST(p_food_ids) AS food_id
      JOIN public.sauceboss_foods f ON f.id = food_id  -- silently skip unknown ids
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN public.get_sauceboss_pantry_for_user(p_user_id);
END;
$$;


-- ── 8) Fork: copy a sauce as a new variant owned by the user ──────────────────
-- Atomic. Walks the source to its family root (one level deep, enforced by
-- migration 005's trigger), creates a new sauce row with a fresh id,
-- parent_sauce_id = root, created_by = p_user. Copies steps + step ingredients
-- + attachments from the source, then applies overrides from p_data (any
-- keys present in p_data win). Repoints the user's saucebook row from the
-- source id to the new id.
CREATE OR REPLACE FUNCTION public.fork_sauceboss_sauce(
  p_source_id TEXT,
  p_user      UUID,
  p_data      JSONB
)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_root_id     TEXT;
  v_new_id      TEXT;
  v_src         RECORD;
  v_step_row    RECORD;
  v_new_step_id BIGINT;
  v_step_data   JSONB;
  v_ing         JSONB;
  v_food_name   TEXT;
  v_food_norm   TEXT;
  v_food_id     TEXT;
  v_step_id     BIGINT;
BEGIN
  SELECT id, COALESCE(parent_sauce_id, id) AS root_id
    INTO v_src
    FROM public.sauceboss_sauces
   WHERE id = p_source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'fork_sauceboss_sauce: source % not found', p_source_id;
  END IF;
  v_root_id := v_src.root_id;

  v_new_id := COALESCE(NULLIF(p_data->>'id', ''),
    'fork-' || SUBSTR(MD5(p_source_id || '|' || COALESCE(p_user::TEXT, 'anon') || '|' || NOW()::TEXT), 1, 12));

  -- 1) Copy scalar columns from source, overlay p_data overrides.
  INSERT INTO public.sauceboss_sauces
    (id, name, cuisine, cuisine_emoji, color, description, sauce_type,
     source_url, created_by, parent_sauce_id)
  SELECT
    v_new_id,
    COALESCE(p_data->>'name',         s.name),
    COALESCE(p_data->>'cuisine',      s.cuisine),
    COALESCE(p_data->>'cuisineEmoji', s.cuisine_emoji),
    COALESCE(p_data->>'color',        s.color),
    COALESCE(p_data->>'description',  s.description),
    COALESCE(p_data->>'sauceType',    s.sauce_type),
    COALESCE(NULLIF(p_data->>'sourceUrl', ''), s.source_url),
    p_user,
    v_root_id
  FROM public.sauceboss_sauces s
  WHERE s.id = p_source_id;

  -- 2) Attachments: payload wins; otherwise copy from source.
  IF p_data ? 'attachments' AND jsonb_array_length(p_data->'attachments') > 0 THEN
    INSERT INTO public.sauceboss_sauce_attachments (sauce_id, target_kind, target_value)
    SELECT v_new_id, a->>'kind', a->>'value'
      FROM jsonb_array_elements(p_data->'attachments') a
    ON CONFLICT DO NOTHING;
    INSERT INTO public.sauceboss_sauce_items (sauce_id, item_id)
    SELECT v_new_id, a->>'value'
      FROM jsonb_array_elements(p_data->'attachments') a
     WHERE a->>'kind' = 'dish'
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO public.sauceboss_sauce_attachments (sauce_id, target_kind, target_value)
    SELECT v_new_id, target_kind, target_value
      FROM public.sauceboss_sauce_attachments
     WHERE sauce_id = p_source_id
    ON CONFLICT DO NOTHING;
    INSERT INTO public.sauceboss_sauce_items (sauce_id, item_id)
    SELECT v_new_id, item_id
      FROM public.sauceboss_sauce_items
     WHERE sauce_id = p_source_id
    ON CONFLICT DO NOTHING;
  END IF;

  -- 3) Steps: payload wins; otherwise deep-copy from source.
  IF p_data ? 'steps' AND jsonb_array_length(p_data->'steps') > 0 THEN
    FOR v_step_data IN SELECT * FROM jsonb_array_elements(p_data->'steps')
    LOOP
      INSERT INTO public.sauceboss_sauce_steps
        (sauce_id, step_order, title, instructions, input_from_step)
      VALUES (
        v_new_id,
        (v_step_data->>'stepOrder')::INT,
        v_step_data->>'title',
        NULLIF(v_step_data->>'instructions', ''),
        CASE WHEN v_step_data->>'inputFromStep' IS NOT NULL
             THEN (v_step_data->>'inputFromStep')::INT ELSE NULL END
      )
      RETURNING id INTO v_step_id;

      FOR v_ing IN SELECT * FROM jsonb_array_elements(v_step_data->'ingredients')
      LOOP
        v_food_name := TRIM(v_ing->>'name');
        v_food_norm := LOWER(v_food_name);
        v_food_id   := NULL;
        IF v_food_name <> '' THEN
          INSERT INTO public.sauceboss_foods (id, name, name_normalized)
          VALUES (
            LEFT(REGEXP_REPLACE(v_food_norm, '[^a-z0-9]+', '-', 'g'), 60)
              || '-' || SUBSTR(MD5(v_food_norm), 1, 6),
            v_food_name, v_food_norm
          )
          ON CONFLICT (name_normalized) DO NOTHING;
          SELECT id INTO v_food_id FROM public.sauceboss_foods WHERE name_normalized = v_food_norm;
        END IF;
        INSERT INTO public.sauceboss_step_ingredients
          (step_id, food_id, unit_id, original_text, quantity, quantity_canonical_ml, quantity_canonical_g)
        VALUES (
          v_step_id,
          v_food_id,
          NULLIF(v_ing->>'unitId', ''),
          v_ing->>'originalText',
          (v_ing->>'amount')::numeric,
          NULLIF(v_ing->>'canonicalMl', '')::double precision,
          NULLIF(v_ing->>'canonicalG',  '')::double precision
        );
      END LOOP;
    END LOOP;
  ELSE
    FOR v_step_row IN
      SELECT id, step_order, title, instructions, input_from_step, estimated_time
        FROM public.sauceboss_sauce_steps
       WHERE sauce_id = p_source_id
       ORDER BY step_order
    LOOP
      INSERT INTO public.sauceboss_sauce_steps
        (sauce_id, step_order, title, instructions, input_from_step, estimated_time)
      VALUES
        (v_new_id, v_step_row.step_order, v_step_row.title, v_step_row.instructions,
         v_step_row.input_from_step, v_step_row.estimated_time)
      RETURNING id INTO v_new_step_id;

      INSERT INTO public.sauceboss_step_ingredients
        (step_id, food_id, unit_id, original_text, quantity, quantity_canonical_ml, quantity_canonical_g)
      SELECT
        v_new_step_id, food_id, unit_id, original_text, quantity,
        quantity_canonical_ml, quantity_canonical_g
        FROM public.sauceboss_step_ingredients
       WHERE step_id = v_step_row.id;
    END LOOP;
  END IF;

  -- 4) Repoint the user's saucebook row from source → new variant.
  IF p_user IS NOT NULL THEN
    DELETE FROM public.sauceboss_saucebook
     WHERE user_id = p_user AND sauce_id = p_source_id;
    INSERT INTO public.sauceboss_saucebook (user_id, sauce_id)
    VALUES (p_user, v_new_id)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN v_new_id;
END;
$$;
