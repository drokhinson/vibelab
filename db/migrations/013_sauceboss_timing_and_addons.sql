-- ─────────────────────────────────────────────────────────────────────────────
-- 013_sauceboss_timing_and_addons.sql
-- Adds: time estimates to steps/carbs, protein & veggie addon options
-- Run AFTER 008_sauceboss_step_refs_and_categories.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Add estimated_time to sauce steps ────────────────────────────────────
ALTER TABLE sauceboss_sauce_steps
  ADD COLUMN IF NOT EXISTS estimated_time INT;  -- minutes, nullable

-- Seed step times for existing sauces
-- Asian
UPDATE sauceboss_sauce_steps SET estimated_time = 3 WHERE sauce_id = 'peanut-sauce'    AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 2 WHERE sauce_id = 'peanut-sauce'    AND step_order = 1;
UPDATE sauceboss_sauce_steps SET estimated_time = 2 WHERE sauce_id = 'teriyaki'        AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 5 WHERE sauce_id = 'teriyaki'        AND step_order = 1;
UPDATE sauceboss_sauce_steps SET estimated_time = 3 WHERE sauce_id = 'gochujang-sauce' AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 3 WHERE sauce_id = 'pad-thai-sauce'  AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 2 WHERE sauce_id = 'sesame-ginger'   AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 2 WHERE sauce_id = 'sesame-ginger'   AND step_order = 1;
-- Italian
UPDATE sauceboss_sauce_steps SET estimated_time = 5  WHERE sauce_id = 'marinara'   AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 15 WHERE sauce_id = 'marinara'   AND step_order = 1;
UPDATE sauceboss_sauce_steps SET estimated_time = 3  WHERE sauce_id = 'alfredo'    AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 5  WHERE sauce_id = 'alfredo'    AND step_order = 1;
UPDATE sauceboss_sauce_steps SET estimated_time = 5  WHERE sauce_id = 'pesto'      AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 5  WHERE sauce_id = 'arrabbiata' AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 15 WHERE sauce_id = 'arrabbiata' AND step_order = 1;
UPDATE sauceboss_sauce_steps SET estimated_time = 8  WHERE sauce_id = 'aglio-olio' AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 2  WHERE sauce_id = 'aglio-olio' AND step_order = 1;
-- Mexican
UPDATE sauceboss_sauce_steps SET estimated_time = 10 WHERE sauce_id = 'salsa-roja'     AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 3  WHERE sauce_id = 'salsa-roja'     AND step_order = 1;
UPDATE sauceboss_sauce_steps SET estimated_time = 3  WHERE sauce_id = 'chipotle-cream' AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 5  WHERE sauce_id = 'quick-mole'     AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 8  WHERE sauce_id = 'quick-mole'     AND step_order = 1;
-- Mediterranean
UPDATE sauceboss_sauce_steps SET estimated_time = 3 WHERE sauce_id = 'tzatziki'      AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 2 WHERE sauce_id = 'tzatziki'      AND step_order = 1;
UPDATE sauceboss_sauce_steps SET estimated_time = 3 WHERE sauce_id = 'chermoula'     AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 3 WHERE sauce_id = 'chermoula'     AND step_order = 1;
UPDATE sauceboss_sauce_steps SET estimated_time = 3 WHERE sauce_id = 'harissa-sauce' AND step_order = 0;
-- BBQ
UPDATE sauceboss_sauce_steps SET estimated_time = 3  WHERE sauce_id = 'bbq-sauce'     AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 10 WHERE sauce_id = 'bbq-sauce'     AND step_order = 1;
UPDATE sauceboss_sauce_steps SET estimated_time = 3  WHERE sauce_id = 'honey-mustard' AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 5  WHERE sauce_id = 'buffalo'       AND step_order = 0;
-- French
UPDATE sauceboss_sauce_steps SET estimated_time = 8 WHERE sauce_id = 'beurre-blanc' AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 5 WHERE sauce_id = 'beurre-blanc' AND step_order = 1;
-- Indian
UPDATE sauceboss_sauce_steps SET estimated_time = 5  WHERE sauce_id = 'tikka-masala' AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 3  WHERE sauce_id = 'tikka-masala' AND step_order = 1;
UPDATE sauceboss_sauce_steps SET estimated_time = 10 WHERE sauce_id = 'tikka-masala' AND step_order = 2;
UPDATE sauceboss_sauce_steps SET estimated_time = 5  WHERE sauce_id = 'saag-sauce'   AND step_order = 0;
UPDATE sauceboss_sauce_steps SET estimated_time = 3  WHERE sauce_id = 'saag-sauce'   AND step_order = 1;
UPDATE sauceboss_sauce_steps SET estimated_time = 5  WHERE sauce_id = 'saag-sauce'   AND step_order = 2;

-- ── 2. Add cook_time_minutes to carbs ───────────────────────────────────────
ALTER TABLE sauceboss_carbs
  ADD COLUMN IF NOT EXISTS cook_time_minutes INT,
  ADD COLUMN IF NOT EXISTS cook_time_label TEXT;

UPDATE sauceboss_carbs SET cook_time_minutes = 10, cook_time_label = '8-12 min'       WHERE id = 'pasta';
UPDATE sauceboss_carbs SET cook_time_minutes = 18, cook_time_label = '15-20 min'      WHERE id = 'rice';
UPDATE sauceboss_carbs SET cook_time_minutes = 8,  cook_time_label = '5-10 min'       WHERE id = 'noodles';
UPDATE sauceboss_carbs SET cook_time_minutes = 0,  cook_time_label = 'Ready to serve' WHERE id = 'bread';
UPDATE sauceboss_carbs SET cook_time_minutes = 25, cook_time_label = '20-30 min'      WHERE id = 'potatoes';
UPDATE sauceboss_carbs SET cook_time_minutes = 5,  cook_time_label = '5 min'          WHERE id = 'couscous';

-- Also add cook_time_minutes to carb preparations
ALTER TABLE sauceboss_carb_preparations
  ADD COLUMN IF NOT EXISTS cook_time_minutes INT;

UPDATE sauceboss_carb_preparations SET cook_time_minutes = 9  WHERE id = 'spaghetti';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 12 WHERE id = 'penne';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 11 WHERE id = 'fusilli';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 13 WHERE id = 'rigatoni';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 10 WHERE id = 'linguine';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 11 WHERE id = 'farfalle';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 17 WHERE id = 'basmati';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 14 WHERE id = 'jasmine';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 17 WHERE id = 'short-grain';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 43 WHERE id = 'brown-rice';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 3  WHERE id = 'ramen';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 9  WHERE id = 'udon';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 5  WHERE id = 'soba';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 7  WHERE id = 'rice-noodles';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 7  WHERE id = 'egg-noodles';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 7  WHERE id = 'crusty-loaf';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 5  WHERE id = 'flatbread';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 2  WHERE id = 'pita';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 9  WHERE id = 'garlic-bread';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 53 WHERE id = 'baked';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 18 WHERE id = 'mashed';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 33 WHERE id = 'roasted-wedges';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 23 WHERE id = 'fries';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 5  WHERE id = 'regular-couscous';
UPDATE sauceboss_carb_preparations SET cook_time_minutes = 9  WHERE id = 'pearl-couscous';

-- ── 3. Protein & veggie addon options ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS sauceboss_addons (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('protein', 'veggie')),
  name           TEXT NOT NULL,
  emoji          TEXT NOT NULL,
  description    TEXT NOT NULL,
  instructions   TEXT NOT NULL,
  estimated_time INT  NOT NULL,  -- minutes
  sort_order     INT  DEFAULT 0
);

INSERT INTO sauceboss_addons (id, type, name, emoji, description, instructions, estimated_time, sort_order) VALUES
  -- Proteins
  ('chicken',        'protein', 'Chicken Breast',    '🍗', 'Pan-seared and sliced',              'Season with salt and pepper. Heat oil over medium-high. Cook 6-7 min per side until 165°F. Rest 5 min, slice.', 18, 0),
  ('beef',           'protein', 'Beef Strips',       '🥩', 'Quick stir-fried strips',            'Slice against grain into thin strips. Sear in hot oiled pan 2-3 min. Season with salt and pepper.', 8, 1),
  ('tofu',           'protein', 'Crispy Tofu',       '🧈', 'Pressed and pan-fried until golden', 'Press firm tofu 15 min. Cube, toss with cornstarch. Pan-fry in oil, turning until golden on all sides ~10 min.', 28, 2),
  ('fish',           'protein', 'White Fish Fillet',  '🐟', 'Pan-seared with crispy skin',        'Pat dry, season. Place skin-side down in hot oiled pan 4 min, flip, cook 2-3 min more.', 10, 3),
  -- Veggies
  ('mushrooms',      'veggie',  'Grilled Mushrooms',  '🍄', 'Mixed mushrooms, seared until golden', 'Slice mushrooms. Sear in hot pan with butter, don''t crowd. Cook 5-6 min until golden. Season with salt.', 8, 0),
  ('fajita-veggies', 'veggie',  'Fajita-Style Veggies','🫑', 'Bell peppers and onions, charred',     'Slice peppers and onions into strips. Cook in hot oiled pan over high heat 6-8 min until charred edges appear.', 10, 1),
  ('roasted-broccoli','veggie', 'Roasted Broccoli',   '🥦', 'Oven-roasted with garlic',             'Cut into florets, toss with oil, garlic, salt. Roast at 425°F for 18-20 min until edges are crispy.', 22, 2),
  ('sauteed-spinach', 'veggie', 'Sauteed Spinach',    '🥬', 'Quick wilted with garlic',              'Heat oil, add minced garlic for 30 sec. Add spinach, toss until wilted ~2-3 min. Season.', 5, 3)
ON CONFLICT (id) DO NOTHING;

-- ── 4. Update RPCs to include timing data ───────────────────────────────────

-- Update carbs RPC to include cook time
CREATE OR REPLACE FUNCTION get_sauceboss_carbs_with_count()
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.name), '[]'::json)
    FROM (
      SELECT c.id, c.name, c.emoji, c.description,
             c.portion_per_person AS "portionPerPerson",
             c.portion_unit AS "portionUnit",
             c.cook_time_minutes AS "cookTimeMinutes",
             c.cook_time_label AS "cookTimeLabel",
             COUNT(sc.sauce_id)::int AS "sauceCount"
      FROM sauceboss_carbs c
      LEFT JOIN sauceboss_sauce_carbs sc ON sc.carb_id = c.id
      GROUP BY c.id
    ) t
  );
END;
$$;

-- Update sauces RPC to include step estimated_time
CREATE OR REPLACE FUNCTION get_sauceboss_sauces_for_carb(p_carb_id TEXT)
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'name'), '[]'::json)
    FROM (
      SELECT json_build_object(
        'id', s.id,
        'name', s.name,
        'cuisine', s.cuisine,
        'cuisineEmoji', s.cuisine_emoji,
        'color', s.color,
        'description', s.description,
        'compatibleCarbs', (
          SELECT COALESCE(json_agg(sc2.carb_id), '[]'::json)
          FROM sauceboss_sauce_carbs sc2
          WHERE sc2.sauce_id = s.id
        ),
        'ingredients', (
          SELECT COALESCE(json_agg(
            json_build_object('name', si.name, 'amount', si.amount, 'unit', si.unit)
            ORDER BY ss_flat.step_order, si.id
          ), '[]'::json)
          FROM (
            SELECT DISTINCT ON (si_inner.name) si_inner.*, ss_inner.step_order
            FROM sauceboss_sauce_steps ss_inner
            JOIN sauceboss_step_ingredients si_inner ON si_inner.step_id = ss_inner.id
            WHERE ss_inner.sauce_id = s.id
            ORDER BY si_inner.name, ss_inner.step_order, si_inner.id
          ) si
          JOIN sauceboss_sauce_steps ss_flat ON ss_flat.id = si.step_id
        ),
        'steps', (
          SELECT COALESCE(json_agg(
            json_build_object(
              'title', ss.title,
              'estimatedTime', ss.estimated_time,
              'inputFromStep', ss.input_from_step,
              'ingredients', (
                SELECT COALESCE(json_agg(
                  json_build_object('name', si.name, 'amount', si.amount, 'unit', si.unit)
                  ORDER BY si.id
                ), '[]'::json)
                FROM sauceboss_step_ingredients si
                WHERE si.step_id = ss.id
              )
            )
            ORDER BY ss.step_order
          ), '[]'::json)
          FROM sauceboss_sauce_steps ss
          WHERE ss.sauce_id = s.id
        )
      ) AS sauce_obj
      FROM sauceboss_sauces s
      JOIN sauceboss_sauce_carbs sc ON sc.sauce_id = s.id AND sc.carb_id = p_carb_id
    ) sub
  );
END;
$$;

-- Update prep RPC to include cook_time_minutes
CREATE OR REPLACE FUNCTION get_sauceboss_carb_preparations(p_carb_id TEXT)
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(
      json_build_object(
        'id', id,
        'name', name,
        'emoji', emoji,
        'waterRatio', water_ratio,
        'cookTime', cook_time,
        'cookTimeMinutes', cook_time_minutes,
        'instructions', instructions
      )
      ORDER BY sort_order
    ), '[]'::json)
    FROM sauceboss_carb_preparations
    WHERE carb_id = p_carb_id
  );
END;
$$;

-- New RPC: get protein/veggie addons
CREATE OR REPLACE FUNCTION get_sauceboss_addons()
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(
      json_build_object(
        'id', id,
        'type', type,
        'name', name,
        'emoji', emoji,
        'desc', description,
        'instructions', instructions,
        'estimatedTime', estimated_time
      )
      ORDER BY type DESC, sort_order  -- proteins first, then veggies
    ), '[]'::json)
    FROM sauceboss_addons
  );
END;
$$;
