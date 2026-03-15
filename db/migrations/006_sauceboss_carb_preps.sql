-- ─────────────────────────────────────────────────────────────────────────────
-- 006_sauceboss_carb_preps.sql
-- Adds carb preparation options with cooking instructions.
-- Run AFTER 005_sauceboss_rpcs_v2.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Table ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sauceboss_carb_preparations (
  id TEXT PRIMARY KEY,
  carb_id TEXT NOT NULL REFERENCES sauceboss_carbs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT,
  water_ratio TEXT,
  cook_time TEXT,
  instructions TEXT,
  sort_order INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_carb_preps_carb ON sauceboss_carb_preparations(carb_id);

-- ── Seed: Pasta ──────────────────────────────────────────────────────────────
INSERT INTO sauceboss_carb_preparations (id, carb_id, name, emoji, water_ratio, cook_time, instructions, sort_order) VALUES
  ('spaghetti',  'pasta', 'Spaghetti',  '🍝', '1L per 100g', '8-10 min', 'Boil salted water, cook until al dente. Reserve a cup of pasta water before draining.', 0),
  ('penne',      'pasta', 'Penne',      '🫕', '1L per 100g', '11-13 min', 'Boil salted water, cook until al dente. Ridged penne holds chunky sauces best.', 1),
  ('fusilli',    'pasta', 'Fusilli',    '🌀', '1L per 100g', '10-12 min', 'Boil salted water, cook until al dente. Spirals trap sauce in every twist.', 2),
  ('rigatoni',   'pasta', 'Rigatoni',   '🫕', '1L per 100g', '12-14 min', 'Boil salted water, cook until al dente. Great for baked dishes and thick sauces.', 3),
  ('linguine',   'pasta', 'Linguine',   '🍝', '1L per 100g', '9-11 min',  'Boil salted water, cook until al dente. Flatter than spaghetti — pairs well with oil-based sauces.', 4),
  ('farfalle',   'pasta', 'Farfalle',   '🦋', '1L per 100g', '10-12 min', 'Boil salted water, cook until al dente. Bow-ties work great with creamy or light sauces.', 5)
ON CONFLICT (id) DO NOTHING;

-- ── Seed: Rice ───────────────────────────────────────────────────────────────
INSERT INTO sauceboss_carb_preparations (id, carb_id, name, emoji, water_ratio, cook_time, instructions, sort_order) VALUES
  ('basmati',     'rice', 'Basmati',     '🌾', '1:1.5 rice to water', '15-18 min', 'Rinse until water runs clear. Bring to boil, reduce to low, cover and simmer. Rest 5 min before fluffing.', 0),
  ('jasmine',     'rice', 'Jasmine',     '🌸', '1:1.25 rice to water', '12-15 min', 'Rinse briefly. Bring to boil, reduce to low, cover and simmer. Naturally sticky and fragrant.', 1),
  ('short-grain', 'rice', 'Short-Grain', '🍚', '1:1.25 rice to water', '15-18 min', 'Rinse well. Bring to boil, reduce heat, cover and simmer. Stickier texture, great for bowls.', 2),
  ('brown-rice',  'rice', 'Brown Rice',  '🟫', '1:2 rice to water', '40-45 min', 'Rinse, bring to boil, reduce to low, cover and simmer. Takes longer but nuttier flavor and more fiber.', 3)
ON CONFLICT (id) DO NOTHING;

-- ── Seed: Noodles ────────────────────────────────────────────────────────────
INSERT INTO sauceboss_carb_preparations (id, carb_id, name, emoji, water_ratio, cook_time, instructions, sort_order) VALUES
  ('ramen',        'noodles', 'Ramen',        '🍜', '1L per 100g', '2-4 min',  'Boil water, cook until just tender. Do not overcook — they continue cooking in hot broth or sauce.', 0),
  ('udon',         'noodles', 'Udon',         '🍜', '1L per 100g', '8-10 min', 'Boil water, cook thick noodles until chewy. Rinse under cold water if serving cold.', 1),
  ('soba',         'noodles', 'Soba',         '🥢', '1L per 100g', '4-6 min',  'Boil water, cook until just tender. Rinse under cold water to stop cooking and remove starch.', 2),
  ('rice-noodles', 'noodles', 'Rice Noodles', '🍜', 'Soak, no boil', '5-8 min soak', 'Soak in hot (not boiling) water until pliable. Drain well. Stir-fry briefly with sauce.', 3),
  ('egg-noodles',  'noodles', 'Egg Noodles',  '🥚', '1L per 100g', '6-8 min',  'Boil salted water, cook until tender. Rich and slightly chewy — great with creamy sauces.', 4)
ON CONFLICT (id) DO NOTHING;

-- ── Seed: Bread ──────────────────────────────────────────────────────────────
INSERT INTO sauceboss_carb_preparations (id, carb_id, name, emoji, water_ratio, cook_time, instructions, sort_order) VALUES
  ('crusty-loaf',  'bread', 'Crusty Loaf',  '🥖', NULL, '5-8 min warm', 'Slice and warm in oven at 180C/350F. Great for dipping and mopping up sauces.', 0),
  ('flatbread',    'bread', 'Flatbread',    '🫓', NULL, '2-3 min/side', 'Warm in a dry skillet over medium heat until pliable and lightly charred.', 1),
  ('pita',         'bread', 'Pita',         '🫓', NULL, '1-2 min warm', 'Warm in oven or microwave until soft. Cut in half to create pockets for sauces.', 2),
  ('garlic-bread', 'bread', 'Garlic Bread', '🧄', NULL, '8-10 min bake', 'Split loaf, spread with garlic butter, bake at 200C/400F until golden and crispy.', 3)
ON CONFLICT (id) DO NOTHING;

-- ── Seed: Potatoes ───────────────────────────────────────────────────────────
INSERT INTO sauceboss_carb_preparations (id, carb_id, name, emoji, water_ratio, cook_time, instructions, sort_order) VALUES
  ('baked',          'potatoes', 'Baked',          '🥔', NULL, '45-60 min', 'Prick with a fork, rub with oil and salt. Bake at 200C/400F until soft inside and crispy outside.', 0),
  ('mashed',         'potatoes', 'Mashed',         '🥄', 'Cover with water', '15-20 min boil', 'Peel and cube. Boil in salted water until fork-tender. Drain, mash with butter and a splash of milk.', 1),
  ('roasted-wedges', 'potatoes', 'Roasted Wedges', '🔥', NULL, '30-35 min', 'Cut into wedges, toss with oil and salt. Roast at 220C/425F, flipping halfway, until golden.', 2),
  ('fries',          'potatoes', 'Fries',          '🍟', NULL, '20-25 min', 'Cut into strips, soak in cold water 30 min, pat dry. Fry at 180C/350F until golden, or bake at 220C/425F.', 3)
ON CONFLICT (id) DO NOTHING;

-- ── Seed: Couscous ───────────────────────────────────────────────────────────
INSERT INTO sauceboss_carb_preparations (id, carb_id, name, emoji, water_ratio, cook_time, instructions, sort_order) VALUES
  ('regular-couscous', 'couscous', 'Regular Couscous', '🌾', '1:1 couscous to water', '5 min rest', 'Pour boiling water or broth over couscous, cover and let sit 5 minutes. Fluff with a fork.', 0),
  ('pearl-couscous',   'couscous', 'Pearl Couscous',   '⚪', '1:1.5 couscous to water', '8-10 min', 'Toast in a little oil, add water, simmer until tender and water is absorbed. Chewy and nutty.', 1)
ON CONFLICT (id) DO NOTHING;

-- ── RPC ──────────────────────────────────────────────────────────────────────
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
        'instructions', instructions
      )
      ORDER BY sort_order
    ), '[]'::json)
    FROM sauceboss_carb_preparations
    WHERE carb_id = p_carb_id
  );
END;
$$;
