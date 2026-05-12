-- Fix: itemIds branch in update_sauceboss_sauce hardcoded target_kind='dish',
-- but subtypes (like brezel) have dish_level='subtype' and the trigger rejects the mismatch.
-- Now looks up each dish's dish_level to use as target_kind.

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
  v_dish_level TEXT;
  v_ifs_arr    INT[];
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
      SELECT dish_level INTO v_dish_level
        FROM public.sauceboss_dish WHERE id = v_dish;
      INSERT INTO public.sauceboss_sauce_to_dish (sauce_id, target_kind, target_value)
        VALUES (v_sauce_id, COALESCE(v_dish_level, 'dish'), v_dish)
        ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  DELETE FROM public.sauceboss_sauce_step WHERE sauce_id = v_sauce_id;
  FOR v_step IN SELECT * FROM jsonb_array_elements(p_data->'steps')
  LOOP
    v_ifs_arr := COALESCE(
      (SELECT array_agg(val::INT) FROM jsonb_array_elements_text(v_step->'inputFromSteps') AS val),
      CASE WHEN v_step->>'inputFromStep' IS NOT NULL
           THEN ARRAY[(v_step->>'inputFromStep')::INT]
           ELSE '{}'::INT[] END
    );

    INSERT INTO public.sauceboss_sauce_step
      (sauce_id, step_order, title, instructions, input_from_step, input_from_steps, estimated_time)
    VALUES (
      v_sauce_id,
      (v_step->>'stepOrder')::INT,
      v_step->>'title',
      NULLIF(v_step->>'instructions', ''),
      CASE WHEN array_length(v_ifs_arr, 1) > 0 THEN v_ifs_arr[1] ELSE NULL END,
      v_ifs_arr,
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
