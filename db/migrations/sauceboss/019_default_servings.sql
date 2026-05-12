-- sauceboss — add default_servings to sauceboss_sauce
--
-- Stores the number of servings the recipe's ingredient quantities are
-- authored for. The viewer uses this as the divisor when scaling:
--   factor = viewerServings / default_servings
-- Existing recipes default to 2 (the historical hard-coded assumption).

ALTER TABLE public.sauceboss_sauce
  ADD COLUMN IF NOT EXISTS default_servings SMALLINT NOT NULL DEFAULT 2;

ALTER TABLE public.sauceboss_sauce
  ADD CONSTRAINT sauceboss_sauce_default_servings_range
    CHECK (default_servings BETWEEN 1 AND 12);


-- ── Update create_sauceboss_sauce to persist default_servings ───────────────
CREATE OR REPLACE FUNCTION public.create_sauceboss_sauce(p_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_id   TEXT;
  v_sauce_type TEXT;
  v_created_by UUID;
  v_parent     TEXT;
  v_cuisine    TEXT;
  v_cui_emoji  TEXT;
  v_step       JSONB;
  v_step_id    BIGINT;
  v_ing        JSONB;
  v_ing_name   TEXT;
  v_ing_norm   TEXT;
  v_ing_id     TEXT;
  v_attach     JSONB;
  v_kind       TEXT;
  v_value      TEXT;
  v_dish       TEXT;
BEGIN
  v_sauce_id   := p_data->>'id';
  v_sauce_type := COALESCE(p_data->>'sauceType', 'sauce');
  v_created_by := NULLIF(p_data->>'createdBy', '')::UUID;
  v_parent     := NULLIF(p_data->>'parentSauceId', '');
  v_cuisine    := p_data->>'cuisine';
  v_cui_emoji  := COALESCE(p_data->>'cuisineEmoji', '');

  IF v_cuisine IS NOT NULL AND v_cuisine <> '' AND v_cui_emoji <> '' THEN
    INSERT INTO public.sauceboss_cuisine_info (cuisine, cuisine_emoji)
    VALUES (v_cuisine, v_cui_emoji)
    ON CONFLICT (cuisine) DO UPDATE SET cuisine_emoji = EXCLUDED.cuisine_emoji;
  END IF;

  INSERT INTO public.sauceboss_sauce
    (id, name, cuisine, color, description, sauce_type, source_url, created_by, parent_sauce_id, default_servings)
  VALUES (
    v_sauce_id,
    p_data->>'name',
    v_cuisine,
    p_data->>'color',
    COALESCE(p_data->>'description', ''),
    v_sauce_type,
    NULLIF(p_data->>'sourceUrl', ''),
    v_created_by,
    v_parent,
    COALESCE((p_data->>'defaultServings')::smallint, 2)
  );

  IF p_data ? 'attachments' AND jsonb_array_length(p_data->'attachments') > 0 THEN
    FOR v_attach IN SELECT * FROM jsonb_array_elements(p_data->'attachments')
    LOOP
      INSERT INTO public.sauceboss_sauce_to_dish (sauce_id, target_kind, target_value)
        VALUES (v_sauce_id, v_attach->>'kind', v_attach->>'value')
        ON CONFLICT DO NOTHING;
    END LOOP;
  ELSIF p_data ? 'itemIds' THEN
    FOR v_dish IN SELECT jsonb_array_elements_text(p_data->'itemIds')
    LOOP
      INSERT INTO public.sauceboss_sauce_to_dish (sauce_id, target_kind, target_value)
        VALUES (v_sauce_id, 'dish', v_dish)
        ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  FOR v_step IN SELECT * FROM jsonb_array_elements(p_data->'steps')
  LOOP
    INSERT INTO public.sauceboss_sauce_step
      (sauce_id, step_order, title, instructions, input_from_step, estimated_time)
    VALUES (
      v_sauce_id,
      (v_step->>'stepOrder')::INT,
      v_step->>'title',
      NULLIF(v_step->>'instructions', ''),
      CASE WHEN v_step->>'inputFromStep' IS NOT NULL THEN (v_step->>'inputFromStep')::INT ELSE NULL END,
      CASE WHEN v_step->>'estimatedTime' IS NOT NULL THEN (v_step->>'estimatedTime')::INT ELSE NULL END
    )
    RETURNING id INTO v_step_id;

    FOR v_ing IN SELECT * FROM jsonb_array_elements(v_step->'ingredients')
    LOOP
      v_ing_name := TRIM(COALESCE(v_ing->>'name', ''));
      v_ing_norm := LOWER(v_ing_name);
      v_ing_id   := NULL;

      IF v_ing_name <> '' THEN
        INSERT INTO public.sauceboss_ingredient (id, name, name_normalized)
        VALUES (
          LEFT(REGEXP_REPLACE(v_ing_norm, '[^a-z0-9]+', '-', 'g'), 60)
            || '-' || SUBSTR(MD5(v_ing_norm), 1, 6),
          v_ing_name,
          v_ing_norm
        )
        ON CONFLICT (name_normalized) DO NOTHING;
        SELECT id INTO v_ing_id FROM public.sauceboss_ingredient WHERE name_normalized = v_ing_norm;
      END IF;

      INSERT INTO public.sauceboss_sauce_step_ingredient
        (step_id, ingredient_id, unit_id, original_text, quantity, quantity_canonical_ml, quantity_canonical_g)
      VALUES (
        v_step_id,
        v_ing_id,
        NULLIF(v_ing->>'unitId', ''),
        v_ing->>'originalText',
        (v_ing->>'amount')::numeric,
        NULLIF(v_ing->>'canonicalMl', '')::double precision,
        NULLIF(v_ing->>'canonicalG',  '')::double precision
      );
    END LOOP;
  END LOOP;

  RETURN v_sauce_id;
END;
$$;


-- ── Update update_sauceboss_sauce to persist default_servings ───────────────
CREATE OR REPLACE FUNCTION public.update_sauceboss_sauce(p_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_id   TEXT;
  v_sauce_type TEXT;
  v_cuisine    TEXT;
  v_cui_emoji  TEXT;
  v_step       JSONB;
  v_step_id    BIGINT;
  v_ing        JSONB;
  v_ing_name   TEXT;
  v_ing_norm   TEXT;
  v_ing_id     TEXT;
  v_attach     JSONB;
  v_dish       TEXT;
BEGIN
  v_sauce_id   := p_data->>'id';
  v_sauce_type := COALESCE(p_data->>'sauceType', 'sauce');
  v_cuisine    := p_data->>'cuisine';
  v_cui_emoji  := COALESCE(p_data->>'cuisineEmoji', '');

  IF NOT EXISTS (SELECT 1 FROM public.sauceboss_sauce WHERE id = v_sauce_id) THEN
    RAISE EXCEPTION 'update_sauceboss_sauce: sauce % not found', v_sauce_id;
  END IF;

  IF v_cuisine IS NOT NULL AND v_cuisine <> '' AND v_cui_emoji <> '' THEN
    INSERT INTO public.sauceboss_cuisine_info (cuisine, cuisine_emoji)
    VALUES (v_cuisine, v_cui_emoji)
    ON CONFLICT (cuisine) DO UPDATE SET cuisine_emoji = EXCLUDED.cuisine_emoji;
  END IF;

  UPDATE public.sauceboss_sauce SET
    name              = p_data->>'name',
    cuisine           = v_cuisine,
    color             = p_data->>'color',
    description       = COALESCE(p_data->>'description', ''),
    sauce_type        = v_sauce_type,
    source_url        = NULLIF(p_data->>'sourceUrl', ''),
    parent_sauce_id   = NULLIF(p_data->>'parentSauceId', ''),
    default_servings  = COALESCE((p_data->>'defaultServings')::smallint, 2)
  WHERE id = v_sauce_id;

  DELETE FROM public.sauceboss_sauce_to_dish WHERE sauce_id = v_sauce_id;

  IF p_data ? 'attachments' AND jsonb_array_length(p_data->'attachments') > 0 THEN
    FOR v_attach IN SELECT * FROM jsonb_array_elements(p_data->'attachments')
    LOOP
      INSERT INTO public.sauceboss_sauce_to_dish (sauce_id, target_kind, target_value)
        VALUES (v_sauce_id, v_attach->>'kind', v_attach->>'value')
        ON CONFLICT DO NOTHING;
    END LOOP;
  ELSIF p_data ? 'itemIds' THEN
    FOR v_dish IN SELECT jsonb_array_elements_text(p_data->'itemIds')
    LOOP
      INSERT INTO public.sauceboss_sauce_to_dish (sauce_id, target_kind, target_value)
        VALUES (v_sauce_id, 'dish', v_dish)
        ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  DELETE FROM public.sauceboss_sauce_step WHERE sauce_id = v_sauce_id;
  FOR v_step IN SELECT * FROM jsonb_array_elements(p_data->'steps')
  LOOP
    INSERT INTO public.sauceboss_sauce_step
      (sauce_id, step_order, title, instructions, input_from_step, estimated_time)
    VALUES (
      v_sauce_id,
      (v_step->>'stepOrder')::INT,
      v_step->>'title',
      NULLIF(v_step->>'instructions', ''),
      CASE WHEN v_step->>'inputFromStep' IS NOT NULL THEN (v_step->>'inputFromStep')::INT ELSE NULL END,
      CASE WHEN v_step->>'estimatedTime' IS NOT NULL THEN (v_step->>'estimatedTime')::INT ELSE NULL END
    )
    RETURNING id INTO v_step_id;

    FOR v_ing IN SELECT * FROM jsonb_array_elements(v_step->'ingredients')
    LOOP
      v_ing_name := TRIM(COALESCE(v_ing->>'name', ''));
      v_ing_norm := LOWER(v_ing_name);
      v_ing_id   := NULL;
      IF v_ing_name <> '' THEN
        INSERT INTO public.sauceboss_ingredient (id, name, name_normalized)
        VALUES (
          LEFT(REGEXP_REPLACE(v_ing_norm, '[^a-z0-9]+', '-', 'g'), 60)
            || '-' || SUBSTR(MD5(v_ing_norm), 1, 6),
          v_ing_name, v_ing_norm
        )
        ON CONFLICT (name_normalized) DO NOTHING;
        SELECT id INTO v_ing_id FROM public.sauceboss_ingredient WHERE name_normalized = v_ing_norm;
      END IF;
      INSERT INTO public.sauceboss_sauce_step_ingredient
        (step_id, ingredient_id, unit_id, original_text, quantity, quantity_canonical_ml, quantity_canonical_g)
      VALUES (
        v_step_id,
        v_ing_id,
        NULLIF(v_ing->>'unitId', ''),
        v_ing->>'originalText',
        (v_ing->>'amount')::numeric,
        NULLIF(v_ing->>'canonicalMl', '')::double precision,
        NULLIF(v_ing->>'canonicalG',  '')::double precision
      );
    END LOOP;
  END LOOP;

  RETURN v_sauce_id;
END;
$$;


-- ── Update get_sauceboss_all_sauces_full to include defaultServings ─────────
CREATE OR REPLACE FUNCTION public.get_sauceboss_all_sauces_full()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'cuisine', sauce_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',              s.id,
      'name',            s.name,
      'cuisine',         s.cuisine,
      'cuisineEmoji',    COALESCE(ci.cuisine_emoji, ''),
      'color',           s.color,
      'description',     s.description,
      'sourceUrl',       s.source_url,
      'sauceType',       s.sauce_type,
      'createdBy',       s.created_by,
      'parentSauceId',   s.parent_sauce_id,
      'defaultServings', s.default_servings,
      'attachments', (
        SELECT COALESCE(json_agg(json_build_object('kind', a.target_kind, 'value', a.target_value)
                                 ORDER BY a.target_kind, a.target_value), '[]'::json)
          FROM public.sauceboss_sauce_to_dish a
         WHERE a.sauce_id = s.id
      ),
      'compatibleItems', (
        SELECT COALESCE(json_agg(a3.target_value ORDER BY a3.target_value), '[]'::json)
          FROM public.sauceboss_sauce_to_dish a3
         WHERE a3.sauce_id = s.id AND a3.target_kind = 'dish'
      ),
      'ingredients', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'name',         di.ing_name,
            'amount',       di.quantity,
            'unit',         di.unit_abbr,
            'unitId',       di.unit_id,
            'ingredientId', di.ingredient_id,
            'foodId',       di.ingredient_id,
            'originalText', di.original_text,
            'canonicalMl',  di.canonical_ml,
            'canonicalG',   di.canonical_g
          )
          ORDER BY di.step_order, di.id
        ), '[]'::json)
        FROM (
          SELECT DISTINCT ON (di_inner.ing_name)
            di_inner.id, di_inner.ing_name, di_inner.quantity, di_inner.unit_abbr,
            di_inner.unit_id, di_inner.ingredient_id, di_inner.original_text,
            di_inner.canonical_ml, di_inner.canonical_g, di_inner.step_order
          FROM (
            SELECT
              si.id,
              COALESCE(ing.name, si.original_text) AS ing_name,
              si.quantity::double precision AS quantity,
              COALESCE(u.abbreviation, '') AS unit_abbr,
              si.unit_id,
              si.ingredient_id,
              si.original_text,
              si.quantity_canonical_ml AS canonical_ml,
              si.quantity_canonical_g  AS canonical_g,
              ss.step_order
            FROM public.sauceboss_sauce_step ss
            JOIN public.sauceboss_sauce_step_ingredient si ON si.step_id = ss.id
            LEFT JOIN public.sauceboss_ingredient ing ON ing.id = si.ingredient_id
            LEFT JOIN public.sauceboss_unit u         ON u.id  = si.unit_id
            WHERE ss.sauce_id = s.id
          ) di_inner
          ORDER BY di_inner.ing_name, di_inner.step_order, di_inner.id
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
                  'name',         COALESCE(ing.name, si.original_text),
                  'amount',       si.quantity::double precision,
                  'unit',         COALESCE(u.abbreviation, ''),
                  'unitId',       si.unit_id,
                  'ingredientId', si.ingredient_id,
                  'foodId',       si.ingredient_id,
                  'originalText', si.original_text,
                  'canonicalMl',  si.quantity_canonical_ml,
                  'canonicalG',   si.quantity_canonical_g
                )
                ORDER BY si.id
              ), '[]'::json)
              FROM public.sauceboss_sauce_step_ingredient si
              LEFT JOIN public.sauceboss_ingredient ing ON ing.id = si.ingredient_id
              LEFT JOIN public.sauceboss_unit u         ON u.id  = si.unit_id
              WHERE si.step_id = ss.id
            )
          )
          ORDER BY ss.step_order
        ), '[]'::json)
        FROM public.sauceboss_sauce_step ss
        WHERE ss.sauce_id = s.id
      )
    ) AS sauce_obj
    FROM public.sauceboss_sauce s
    LEFT JOIN public.sauceboss_cuisine_info ci ON ci.cuisine = s.cuisine
  ) sub;
$$;


-- ── Update get_sauceboss_saucebook to include defaultServings ───────────────
-- (Uses CTE-scoped version from 018)
CREATE OR REPLACE FUNCTION public.get_sauceboss_saucebook(p_user_id UUID)
RETURNS JSON LANGUAGE SQL STABLE AS $$
WITH user_sauces AS (
  SELECT sauce_id, added_at
  FROM public.sauceboss_user_saucebook
  WHERE user_id = p_user_id
),
variant_counts AS (
  SELECT COALESCE(s.parent_sauce_id, s.id) AS family_root, COUNT(*)::int AS variant_count
  FROM public.sauceboss_sauce s
  WHERE s.parent_sauce_id IS NOT NULL
    AND COALESCE(s.parent_sauce_id, s.id) IN (
      SELECT us.sauce_id FROM user_sauces us
      UNION
      SELECT ss.parent_sauce_id FROM user_sauces us
      JOIN public.sauceboss_sauce ss ON ss.id = us.sauce_id
      WHERE ss.parent_sauce_id IS NOT NULL
    )
  GROUP BY COALESCE(s.parent_sauce_id, s.id)
),
attachments_agg AS (
  SELECT d.sauce_id,
         COALESCE(json_agg(json_build_object('kind', d.target_kind, 'value', d.target_value)
                           ORDER BY d.target_kind, d.target_value), '[]'::json) AS attachments
  FROM public.sauceboss_sauce_to_dish d
  WHERE d.sauce_id IN (SELECT sauce_id FROM user_sauces)
  GROUP BY d.sauce_id
),
compatible_items_agg AS (
  SELECT d.sauce_id,
         COALESCE(json_agg(d.target_value ORDER BY d.target_value), '[]'::json) AS compatible_items
  FROM public.sauceboss_sauce_to_dish d
  WHERE d.target_kind = 'dish'
    AND d.sauce_id IN (SELECT sauce_id FROM user_sauces)
  GROUP BY d.sauce_id
),
ingredient_names_agg AS (
  SELECT ss.sauce_id,
         COALESCE(array_agg(DISTINCT COALESCE(ing.name, si.original_text)
                            ORDER BY COALESCE(ing.name, si.original_text)),
                  ARRAY[]::TEXT[]) AS ingredient_names
  FROM public.sauceboss_sauce_step ss
  JOIN public.sauceboss_sauce_step_ingredient si ON si.step_id = ss.id
  LEFT JOIN public.sauceboss_ingredient ing ON ing.id = si.ingredient_id
  WHERE ss.sauce_id IN (SELECT sauce_id FROM user_sauces)
    AND COALESCE(ing.name, si.original_text) IS NOT NULL
  GROUP BY ss.sauce_id
)
SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'cuisine', sauce_obj->>'name'), '[]'::json)
FROM (
  SELECT json_build_object(
    'id',              s.id,
    'name',            s.name,
    'cuisine',         s.cuisine,
    'cuisineEmoji',    COALESCE(ci.cuisine_emoji, ''),
    'color',           s.color,
    'sauceType',       s.sauce_type,
    'createdBy',       s.created_by,
    'authorName',      COALESCE(p.display_name, ''),
    'parentSauceId',   s.parent_sauce_id,
    'defaultServings', s.default_servings,
    'addedAt',         us.added_at,
    'variantCount',    COALESCE(vc.variant_count, 0),
    'attachments',     COALESCE(aa.attachments, '[]'::json),
    'compatibleItems', COALESCE(ca.compatible_items, '[]'::json),
    'ingredientNames', COALESCE(ia.ingredient_names, ARRAY[]::TEXT[])
  ) AS sauce_obj
  FROM user_sauces us
  JOIN public.sauceboss_sauce s ON s.id = us.sauce_id
  LEFT JOIN public.sauceboss_user_profiles p ON p.id = s.created_by
  LEFT JOIN public.sauceboss_cuisine_info ci ON ci.cuisine = s.cuisine
  LEFT JOIN variant_counts vc ON vc.family_root = COALESCE(s.parent_sauce_id, s.id)
  LEFT JOIN attachments_agg aa ON aa.sauce_id = s.id
  LEFT JOIN compatible_items_agg ca ON ca.sauce_id = s.id
  LEFT JOIN ingredient_names_agg ia ON ia.sauce_id = s.id
) sub;
$$;


-- ── Update fork_sauceboss_sauce to carry default_servings forward ───────────
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
  v_ing_name    TEXT;
  v_ing_norm    TEXT;
  v_ing_id      TEXT;
  v_step_id     BIGINT;
  v_cuisine     TEXT;
  v_cui_emoji   TEXT;
BEGIN
  SELECT id, COALESCE(parent_sauce_id, id) AS root_id
    INTO v_src
    FROM public.sauceboss_sauce
   WHERE id = p_source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'fork_sauceboss_sauce: source % not found', p_source_id;
  END IF;
  v_root_id := v_src.root_id;

  v_new_id := COALESCE(NULLIF(p_data->>'id', ''),
    'fork-' || SUBSTR(MD5(p_source_id || '|' || COALESCE(p_user::TEXT, 'anon') || '|' || NOW()::TEXT), 1, 12));

  -- Cuisine emoji upsert (from override only; source's cuisine carries forward).
  v_cuisine   := COALESCE(p_data->>'cuisine',      (SELECT cuisine FROM public.sauceboss_sauce WHERE id = p_source_id));
  v_cui_emoji := COALESCE(p_data->>'cuisineEmoji', '');
  IF v_cuisine IS NOT NULL AND v_cuisine <> '' AND v_cui_emoji <> '' THEN
    INSERT INTO public.sauceboss_cuisine_info (cuisine, cuisine_emoji)
    VALUES (v_cuisine, v_cui_emoji)
    ON CONFLICT (cuisine) DO UPDATE SET cuisine_emoji = EXCLUDED.cuisine_emoji;
  END IF;

  INSERT INTO public.sauceboss_sauce
    (id, name, cuisine, color, description, sauce_type, source_url, created_by, parent_sauce_id, default_servings)
  SELECT
    v_new_id,
    COALESCE(p_data->>'name',         s.name),
    COALESCE(p_data->>'cuisine',      s.cuisine),
    COALESCE(p_data->>'color',        s.color),
    COALESCE(p_data->>'description',  s.description),
    COALESCE(p_data->>'sauceType',    s.sauce_type),
    COALESCE(NULLIF(p_data->>'sourceUrl', ''), s.source_url),
    p_user,
    v_root_id,
    COALESCE((p_data->>'defaultServings')::smallint, s.default_servings)
  FROM public.sauceboss_sauce s
  WHERE s.id = p_source_id;

  IF p_data ? 'attachments' AND jsonb_array_length(p_data->'attachments') > 0 THEN
    INSERT INTO public.sauceboss_sauce_to_dish (sauce_id, target_kind, target_value)
    SELECT v_new_id, a->>'kind', a->>'value'
      FROM jsonb_array_elements(p_data->'attachments') a
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO public.sauceboss_sauce_to_dish (sauce_id, target_kind, target_value)
    SELECT v_new_id, target_kind, target_value
      FROM public.sauceboss_sauce_to_dish
     WHERE sauce_id = p_source_id
    ON CONFLICT DO NOTHING;
  END IF;

  IF p_data ? 'steps' AND jsonb_array_length(p_data->'steps') > 0 THEN
    FOR v_step_data IN SELECT * FROM jsonb_array_elements(p_data->'steps')
    LOOP
      INSERT INTO public.sauceboss_sauce_step
        (sauce_id, step_order, title, instructions, input_from_step, estimated_time)
      VALUES (
        v_new_id,
        (v_step_data->>'stepOrder')::INT,
        v_step_data->>'title',
        NULLIF(v_step_data->>'instructions', ''),
        CASE WHEN v_step_data->>'inputFromStep' IS NOT NULL THEN (v_step_data->>'inputFromStep')::INT ELSE NULL END,
        CASE WHEN v_step_data->>'estimatedTime' IS NOT NULL THEN (v_step_data->>'estimatedTime')::INT ELSE NULL END
      )
      RETURNING id INTO v_step_id;
      FOR v_ing IN SELECT * FROM jsonb_array_elements(v_step_data->'ingredients')
      LOOP
        v_ing_name := TRIM(COALESCE(v_ing->>'name', ''));
        v_ing_norm := LOWER(v_ing_name);
        v_ing_id   := NULL;
        IF v_ing_name <> '' THEN
          INSERT INTO public.sauceboss_ingredient (id, name, name_normalized)
          VALUES (
            LEFT(REGEXP_REPLACE(v_ing_norm, '[^a-z0-9]+', '-', 'g'), 60)
              || '-' || SUBSTR(MD5(v_ing_norm), 1, 6),
            v_ing_name, v_ing_norm
          )
          ON CONFLICT (name_normalized) DO NOTHING;
          SELECT id INTO v_ing_id FROM public.sauceboss_ingredient WHERE name_normalized = v_ing_norm;
        END IF;
        INSERT INTO public.sauceboss_sauce_step_ingredient
          (step_id, ingredient_id, unit_id, original_text, quantity, quantity_canonical_ml, quantity_canonical_g)
        VALUES (
          v_step_id,
          v_ing_id,
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
        FROM public.sauceboss_sauce_step
       WHERE sauce_id = p_source_id
       ORDER BY step_order
    LOOP
      INSERT INTO public.sauceboss_sauce_step
        (sauce_id, step_order, title, instructions, input_from_step, estimated_time)
      VALUES
        (v_new_id, v_step_row.step_order, v_step_row.title, v_step_row.instructions,
         v_step_row.input_from_step, v_step_row.estimated_time)
      RETURNING id INTO v_new_step_id;

      INSERT INTO public.sauceboss_sauce_step_ingredient
        (step_id, ingredient_id, unit_id, original_text, quantity,
         quantity_canonical_ml, quantity_canonical_g)
      SELECT
        v_new_step_id, ingredient_id, unit_id, original_text, quantity,
        quantity_canonical_ml, quantity_canonical_g
        FROM public.sauceboss_sauce_step_ingredient
       WHERE step_id = v_step_row.id;
    END LOOP;
  END IF;

  IF p_user IS NOT NULL THEN
    DELETE FROM public.sauceboss_user_saucebook
     WHERE user_id = p_user AND sauce_id = p_source_id;
    INSERT INTO public.sauceboss_user_saucebook (user_id, sauce_id)
    VALUES (p_user, v_new_id) ON CONFLICT DO NOTHING;
  END IF;

  RETURN v_new_id;
END;
$$;
