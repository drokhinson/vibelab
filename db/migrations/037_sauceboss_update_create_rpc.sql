-- ─────────────────────────────────────────────────────────────────────────────
-- 037_sauceboss_update_create_rpc.sql
-- Updates create_sauceboss_sauce RPC to write fields added in migrations 032–036:
--   sauceboss_sauces:           sauce_type, servings, yield_quantity, yield_unit,
--                               source_url, source_name
--   sauceboss_step_ingredients: unit_type, original_text
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_sauceboss_sauce(p_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_id TEXT;
  v_step     JSONB;
  v_step_id  BIGINT;
  v_ing      JSONB;
  v_carb     TEXT;
BEGIN
  v_sauce_id := p_data->>'id';

  -- 1. Insert sauce (includes all new optional fields)
  INSERT INTO sauceboss_sauces (
    id, name, cuisine, cuisine_emoji, color, description,
    sauce_type, servings, yield_quantity, yield_unit, source_url, source_name
  ) VALUES (
    v_sauce_id,
    p_data->>'name',
    p_data->>'cuisine',
    p_data->>'cuisineEmoji',
    p_data->>'color',
    COALESCE(p_data->>'description', ''),
    COALESCE(p_data->>'sauce_type', 'sauce'),
    NULLIF(p_data->>'servings',       '')::INT,
    NULLIF(p_data->>'yield_quantity', '')::REAL,
    NULLIF(p_data->>'yield_unit',     ''),
    NULLIF(p_data->>'source_url',     ''),
    NULLIF(p_data->>'source_name',    '')
  );

  -- 2. Insert carb pairings
  FOR v_carb IN SELECT jsonb_array_elements_text(p_data->'carbIds')
  LOOP
    INSERT INTO sauceboss_sauce_carbs (sauce_id, carb_id)
    VALUES (v_sauce_id, v_carb);
  END LOOP;

  -- 3. Insert steps and their ingredients
  FOR v_step IN SELECT * FROM jsonb_array_elements(p_data->'steps')
  LOOP
    INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, input_from_step)
    VALUES (
      v_sauce_id,
      (v_step->>'stepOrder')::INT,
      v_step->>'title',
      NULLIF(v_step->>'inputFromStep', '')::INT
    )
    RETURNING id INTO v_step_id;

    FOR v_ing IN SELECT * FROM jsonb_array_elements(v_step->'ingredients')
    LOOP
      INSERT INTO sauceboss_step_ingredients (
        step_id, name, amount, unit, unit_type, original_text
      ) VALUES (
        v_step_id,
        v_ing->>'name',
        (v_ing->>'amount')::REAL,
        v_ing->>'unit',
        COALESCE(NULLIF(v_ing->>'unit_type', ''), 'volume'),
        NULLIF(v_ing->>'original_text', '')
      );
    END LOOP;
  END LOOP;

  RETURN v_sauce_id;
END;
$$;
