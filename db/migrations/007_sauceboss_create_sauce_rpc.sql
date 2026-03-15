-- ─────────────────────────────────────────────────────────────────────────────
-- 007_sauceboss_create_sauce_rpc.sql
-- Atomic RPC to create a user sauce with steps, ingredients, and carb pairings.
-- Run AFTER 006_sauceboss_carb_preps.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_sauceboss_sauce(p_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_id TEXT;
  v_step JSONB;
  v_step_id BIGINT;
  v_ing JSONB;
  v_carb TEXT;
BEGIN
  v_sauce_id := p_data->>'id';

  -- 1. Insert sauce
  INSERT INTO sauceboss_sauces (id, name, cuisine, cuisine_emoji, color, description)
  VALUES (
    v_sauce_id,
    p_data->>'name',
    p_data->>'cuisine',
    p_data->>'cuisineEmoji',
    p_data->>'color',
    COALESCE(p_data->>'description', '')
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
    INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title)
    VALUES (v_sauce_id, (v_step->>'stepOrder')::INT, v_step->>'title')
    RETURNING id INTO v_step_id;

    FOR v_ing IN SELECT * FROM jsonb_array_elements(v_step->'ingredients')
    LOOP
      INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
      VALUES (
        v_step_id,
        v_ing->>'name',
        (v_ing->>'amount')::REAL,
        v_ing->>'unit'
      );
    END LOOP;
  END LOOP;

  RETURN v_sauce_id;
END;
$$;
