-- ─────────────────────────────────────────────────────────────────────────────
-- sauceboss — step estimated_time persisted on save
--
-- The sauceboss_sauce_steps.estimated_time column has existed since the
-- baseline (read paths emit it as `estimatedTime`), but the create/update
-- RPCs never wrote to it — every step ended up NULL and the recipe view
-- fell back to the hardcoded 5-minute default. This migration redefines
-- both RPCs to read p_data->'steps'->>'estimatedTime' and persist it.
--
-- Bodies are identical to 005_sauce_variants.sql except for the
-- INSERT INTO sauceboss_sauce_steps clause, which gains the
-- estimated_time column + binding.
-- ─────────────────────────────────────────────────────────────────────────────


CREATE OR REPLACE FUNCTION public.create_sauceboss_sauce(p_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_id   TEXT;
  v_sauce_type TEXT;
  v_step       JSONB;
  v_step_id    BIGINT;
  v_ing        JSONB;
  v_item       TEXT;
  v_food_name  TEXT;
  v_food_norm  TEXT;
  v_food_id    TEXT;
  v_created_by UUID;
  v_parent     TEXT;
BEGIN
  v_sauce_id := COALESCE(NULLIF(p_data->>'id', ''),
                          LEFT(REGEXP_REPLACE(LOWER(p_data->>'name'), '[^a-z0-9]+', '-', 'g'), 50)
                            || '-' || SUBSTR(MD5(p_data->>'name' || CLOCK_TIMESTAMP()::TEXT), 1, 6));
  v_sauce_type := COALESCE(p_data->>'sauceType', 'sauce');
  v_created_by := NULLIF(p_data->>'createdBy', '')::UUID;
  v_parent     := NULLIF(p_data->>'parentSauceId', '');

  INSERT INTO public.sauceboss_sauces
    (id, name, cuisine, cuisine_emoji, color, description, sauce_type, source_url, created_by, parent_sauce_id)
  VALUES (
    v_sauce_id,
    p_data->>'name',
    p_data->>'cuisine',
    p_data->>'cuisineEmoji',
    p_data->>'color',
    COALESCE(p_data->>'description', ''),
    v_sauce_type,
    NULLIF(p_data->>'sourceUrl', ''),
    v_created_by,
    v_parent
  );

  FOR v_item IN SELECT jsonb_array_elements_text(p_data->'itemIds')
  LOOP
    INSERT INTO public.sauceboss_sauce_items (sauce_id, item_id) VALUES (v_sauce_id, v_item);
  END LOOP;

  FOR v_step IN SELECT * FROM jsonb_array_elements(p_data->'steps')
  LOOP
    INSERT INTO public.sauceboss_sauce_steps
      (sauce_id, step_order, title, instructions, input_from_step, estimated_time)
    VALUES (
      v_sauce_id,
      (v_step->>'stepOrder')::INT,
      v_step->>'title',
      NULLIF(v_step->>'instructions', ''),
      CASE WHEN v_step->>'inputFromStep' IS NOT NULL
           THEN (v_step->>'inputFromStep')::INT
           ELSE NULL END,
      CASE WHEN NULLIF(v_step->>'estimatedTime', '') IS NOT NULL
           THEN (v_step->>'estimatedTime')::INT
           ELSE NULL END
    )
    RETURNING id INTO v_step_id;

    FOR v_ing IN SELECT * FROM jsonb_array_elements(v_step->'ingredients')
    LOOP
      v_food_name := TRIM(v_ing->>'name');
      v_food_norm := LOWER(v_food_name);
      v_food_id   := NULL;

      IF v_food_name <> '' THEN
        INSERT INTO public.sauceboss_foods (id, name, name_normalized)
        VALUES (
          LEFT(REGEXP_REPLACE(v_food_norm, '[^a-z0-9]+', '-', 'g'), 60)
            || '-' || SUBSTR(MD5(v_food_norm), 1, 6),
          v_food_name,
          v_food_norm
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

  RETURN v_sauce_id;
END;
$$;


CREATE OR REPLACE FUNCTION public.update_sauceboss_sauce(p_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_id   TEXT;
  v_sauce_type TEXT;
  v_step       JSONB;
  v_step_id    BIGINT;
  v_ing        JSONB;
  v_item       TEXT;
  v_food_name  TEXT;
  v_food_norm  TEXT;
  v_food_id    TEXT;
BEGIN
  v_sauce_id   := p_data->>'id';
  v_sauce_type := COALESCE(p_data->>'sauceType', 'sauce');

  IF NOT EXISTS (SELECT 1 FROM public.sauceboss_sauces WHERE id = v_sauce_id) THEN
    RAISE EXCEPTION 'update_sauceboss_sauce: sauce % not found', v_sauce_id;
  END IF;

  UPDATE public.sauceboss_sauces SET
    name            = p_data->>'name',
    cuisine         = p_data->>'cuisine',
    cuisine_emoji   = p_data->>'cuisineEmoji',
    color           = p_data->>'color',
    description     = COALESCE(p_data->>'description', ''),
    sauce_type      = v_sauce_type,
    source_url      = NULLIF(p_data->>'sourceUrl', ''),
    parent_sauce_id = NULLIF(p_data->>'parentSauceId', '')
  WHERE id = v_sauce_id;

  -- Replace item links
  DELETE FROM public.sauceboss_sauce_items WHERE sauce_id = v_sauce_id;
  FOR v_item IN SELECT jsonb_array_elements_text(p_data->'itemIds')
  LOOP
    INSERT INTO public.sauceboss_sauce_items (sauce_id, item_id) VALUES (v_sauce_id, v_item);
  END LOOP;

  -- Replace steps (cascades clean up step ingredients)
  DELETE FROM public.sauceboss_sauce_steps WHERE sauce_id = v_sauce_id;
  FOR v_step IN SELECT * FROM jsonb_array_elements(p_data->'steps')
  LOOP
    INSERT INTO public.sauceboss_sauce_steps
      (sauce_id, step_order, title, instructions, input_from_step, estimated_time)
    VALUES (
      v_sauce_id,
      (v_step->>'stepOrder')::INT,
      v_step->>'title',
      NULLIF(v_step->>'instructions', ''),
      CASE WHEN v_step->>'inputFromStep' IS NOT NULL
           THEN (v_step->>'inputFromStep')::INT
           ELSE NULL END,
      CASE WHEN NULLIF(v_step->>'estimatedTime', '') IS NOT NULL
           THEN (v_step->>'estimatedTime')::INT
           ELSE NULL END
    )
    RETURNING id INTO v_step_id;

    FOR v_ing IN SELECT * FROM jsonb_array_elements(v_step->'ingredients')
    LOOP
      v_food_name := TRIM(v_ing->>'name');
      v_food_norm := LOWER(v_food_name);
      v_food_id   := NULL;

      IF v_food_name <> '' THEN
        INSERT INTO public.sauceboss_foods (id, name, name_normalized)
        VALUES (
          LEFT(REGEXP_REPLACE(v_food_norm, '[^a-z0-9]+', '-', 'g'), 60)
            || '-' || SUBSTR(MD5(v_food_norm), 1, 6),
          v_food_name,
          v_food_norm
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

  RETURN v_sauce_id;
END;
$$;
