-- ─────────────────────────────────────────────────────────────────────────────
-- 008_sauceboss_step_refs_and_categories.sql
-- 1. Add input_from_step column to sauce steps (step references)
-- 2. Update get_sauceboss_sauces_for_carb to include inputFromStep
-- 3. Update create_sauceboss_sauce to store inputFromStep
-- 4. Add upsert RPC for ingredient categories (user-classified new ingredients)
-- Run AFTER 007_sauceboss_create_sauce_rpc.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add step reference column (nullable — most steps don't reference another)
ALTER TABLE sauceboss_sauce_steps
ADD COLUMN IF NOT EXISTS input_from_step INT DEFAULT NULL;

-- 2. Update sauces_for_carb RPC to include inputFromStep in steps
CREATE OR REPLACE FUNCTION get_sauceboss_sauces_for_carb(p_carb_id TEXT)
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(
      json_build_object(
        'id',            s.id,
        'name',          s.name,
        'cuisine',       s.cuisine,
        'cuisineEmoji',  s.cuisine_emoji,
        'color',         s.color,
        'description',   s.description,
        'compatibleCarbs', (
          SELECT json_agg(sc2.carb_id)
          FROM sauceboss_sauce_carbs sc2
          WHERE sc2.sauce_id = s.id
        ),
        'ingredients', (
          SELECT json_agg(json_build_object('name', di.name, 'amount', di.amount, 'unit', di.unit))
          FROM (
            SELECT DISTINCT ON (si2.name) si2.name, si2.amount, si2.unit
            FROM sauceboss_step_ingredients si2
            JOIN sauceboss_sauce_steps ss2 ON ss2.id = si2.step_id
            WHERE ss2.sauce_id = s.id
            ORDER BY si2.name, si2.id
          ) di
        ),
        'steps', (
          SELECT json_agg(
            json_build_object(
              'title', ss.title,
              'inputFromStep', ss.input_from_step,
              'ingredients', (
                SELECT json_agg(
                  json_build_object('name', si.name, 'amount', si.amount, 'unit', si.unit)
                  ORDER BY si.id
                )
                FROM sauceboss_step_ingredients si
                WHERE si.step_id = ss.id
              )
            )
            ORDER BY ss.step_order
          )
          FROM sauceboss_sauce_steps ss
          WHERE ss.sauce_id = s.id
        )
      )
      ORDER BY s.cuisine, s.name
    ), '[]'::json)
    FROM sauceboss_sauces s
    JOIN sauceboss_sauce_carbs sc_filter ON sc_filter.sauce_id = s.id
    WHERE sc_filter.carb_id = p_carb_id
  );
END;
$$;

-- 3. Update create_sauceboss_sauce to store inputFromStep
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

  INSERT INTO sauceboss_sauces (id, name, cuisine, cuisine_emoji, color, description)
  VALUES (
    v_sauce_id,
    p_data->>'name',
    p_data->>'cuisine',
    p_data->>'cuisineEmoji',
    p_data->>'color',
    COALESCE(p_data->>'description', '')
  );

  FOR v_carb IN SELECT jsonb_array_elements_text(p_data->'carbIds')
  LOOP
    INSERT INTO sauceboss_sauce_carbs (sauce_id, carb_id)
    VALUES (v_sauce_id, v_carb);
  END LOOP;

  FOR v_step IN SELECT * FROM jsonb_array_elements(p_data->'steps')
  LOOP
    INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, input_from_step)
    VALUES (
      v_sauce_id,
      (v_step->>'stepOrder')::INT,
      v_step->>'title',
      CASE WHEN v_step->>'inputFromStep' IS NOT NULL
           THEN (v_step->>'inputFromStep')::INT
           ELSE NULL END
    )
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

-- 4. Upsert ingredient category (for user-classified new ingredients)
CREATE OR REPLACE FUNCTION upsert_sauceboss_ingredient_category(
  p_ingredient_name TEXT,
  p_category TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sauceboss_ingredient_categories (ingredient_name, category)
  VALUES (p_ingredient_name, p_category)
  ON CONFLICT (ingredient_name) DO UPDATE SET category = p_category;
END;
$$;
