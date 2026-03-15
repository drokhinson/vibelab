-- ─────────────────────────────────────────────────────────────────────────────
-- 004_sauceboss_features.sql
-- Adds: portion data to carbs, ingredient categories, ingredient substitutions
-- Run AFTER 003_sauceboss_seed.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Add portion-per-person to carbs ──────────────────────────────────────
ALTER TABLE sauceboss_carbs
  ADD COLUMN IF NOT EXISTS portion_per_person REAL NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS portion_unit TEXT NOT NULL DEFAULT 'g';

UPDATE sauceboss_carbs SET portion_per_person = 100, portion_unit = 'g'      WHERE id = 'pasta';
UPDATE sauceboss_carbs SET portion_per_person = 75,  portion_unit = 'g'      WHERE id = 'rice';
UPDATE sauceboss_carbs SET portion_per_person = 100, portion_unit = 'g'      WHERE id = 'noodles';
UPDATE sauceboss_carbs SET portion_per_person = 2,   portion_unit = 'slices' WHERE id = 'bread';
UPDATE sauceboss_carbs SET portion_per_person = 200, portion_unit = 'g'      WHERE id = 'potatoes';
UPDATE sauceboss_carbs SET portion_per_person = 65,  portion_unit = 'g'      WHERE id = 'couscous';

-- ── 2. Ingredient categories ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sauceboss_ingredient_categories (
  ingredient_name TEXT PRIMARY KEY,
  category TEXT NOT NULL
);

INSERT INTO sauceboss_ingredient_categories (ingredient_name, category) VALUES
  -- Produce
  ('garlic',        'Produce'),
  ('ginger',        'Produce'),
  ('onion',         'Produce'),
  ('shallot',       'Produce'),
  ('tomato',        'Produce'),
  ('spinach',       'Produce'),
  ('lime juice',    'Produce'),
  ('lemon juice',   'Produce'),
  ('cilantro',      'Produce'),
  ('basil',         'Produce'),
  ('parsley',       'Produce'),
  ('dill',          'Produce'),
  -- Dairy
  ('butter',        'Dairy'),
  ('heavy cream',   'Dairy'),
  ('parmesan',      'Dairy'),
  ('sour cream',    'Dairy'),
  ('yogurt',        'Dairy'),
  -- Oils & Fats
  ('olive oil',     'Oils & Fats'),
  ('sesame oil',    'Oils & Fats'),
  -- Sauces & Condiments
  ('soy sauce',     'Sauces & Condiments'),
  ('fish sauce',    'Sauces & Condiments'),
  ('sriracha',      'Sauces & Condiments'),
  ('hot sauce',     'Sauces & Condiments'),
  ('gochujang',     'Sauces & Condiments'),
  ('ketchup',       'Sauces & Condiments'),
  ('mustard',       'Sauces & Condiments'),
  ('dijon mustard', 'Sauces & Condiments'),
  ('mayo',          'Sauces & Condiments'),
  ('worcestershire sauce', 'Sauces & Condiments'),
  ('tomato puree',  'Sauces & Condiments'),
  ('tamarind paste','Sauces & Condiments'),
  ('chipotle',      'Sauces & Condiments'),
  -- Spices
  ('chili flakes',  'Spices'),
  ('chili powder',  'Spices'),
  ('cumin',         'Spices'),
  ('coriander',     'Spices'),
  ('turmeric',      'Spices'),
  ('paprika',       'Spices'),
  ('garam masala',  'Spices'),
  ('oregano',       'Spices'),
  -- Sweeteners
  ('honey',         'Sweeteners'),
  ('sugar',         'Sweeteners'),
  ('brown sugar',   'Sweeteners'),
  -- Nuts & Seeds
  ('peanut butter', 'Nuts & Seeds'),
  ('pine nuts',     'Nuts & Seeds'),
  -- Pantry Staples
  ('vinegar',       'Pantry Staples'),
  ('rice vinegar',  'Pantry Staples'),
  ('mirin',         'Pantry Staples'),
  ('sake',          'Pantry Staples'),
  ('white wine',    'Pantry Staples'),
  ('water',         'Pantry Staples')
ON CONFLICT (ingredient_name) DO NOTHING;

-- ── 3. Ingredient substitutions ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sauceboss_ingredient_substitutions (
  id SERIAL PRIMARY KEY,
  ingredient_name TEXT NOT NULL,
  substitute_name TEXT NOT NULL,
  notes TEXT,
  UNIQUE(ingredient_name, substitute_name)
);

INSERT INTO sauceboss_ingredient_substitutions (ingredient_name, substitute_name, notes) VALUES
  ('soy sauce',     'tamari',           'Gluten-free alternative, same amount'),
  ('soy sauce',     'coconut aminos',   'Lower sodium, slightly sweeter'),
  ('fish sauce',    'soy sauce',        'Add a squeeze of lime to compensate'),
  ('heavy cream',   'coconut cream',    'Dairy-free, same richness'),
  ('butter',        'olive oil',        'Use 3/4 the amount'),
  ('butter',        'coconut oil',      'Dairy-free, use same amount'),
  ('parmesan',      'nutritional yeast','Vegan, use 2/3 the amount'),
  ('parmesan',      'pecorino',         'Sharper flavor, same amount'),
  ('yogurt',        'coconut yogurt',   'Dairy-free'),
  ('yogurt',        'sour cream',       'Tangier but works well'),
  ('sour cream',    'Greek yogurt',     'Lighter, same tanginess'),
  ('honey',         'maple syrup',      'Vegan, slightly different flavor'),
  ('honey',         'agave nectar',     'Vegan, thinner consistency'),
  ('pine nuts',     'walnuts',          'Cheaper, slightly different flavor'),
  ('pine nuts',     'cashews',          'Milder, creamier'),
  ('sriracha',      'chili flakes',     'Use 1/2 tsp per tsp sriracha'),
  ('gochujang',     'sriracha',         'Less complex but similar heat'),
  ('mirin',         'rice vinegar',     'Add a pinch of sugar'),
  ('sake',          'dry white wine',   'Similar acidity profile'),
  ('dijon mustard', 'yellow mustard',   'Milder, add a splash of vinegar'),
  ('mayo',          'Greek yogurt',     'Lighter, tangier'),
  ('chipotle',      'smoked paprika',   'Use 1 tsp per chipotle, less heat'),
  ('tamarind paste','lime juice',       'Different flavor but similar tartness'),
  ('white wine',    'chicken broth',    'Non-alcoholic, add splash of vinegar'),
  ('sesame oil',    'olive oil',        'Loses nuttiness but works in a pinch')
ON CONFLICT (ingredient_name, substitute_name) DO NOTHING;
