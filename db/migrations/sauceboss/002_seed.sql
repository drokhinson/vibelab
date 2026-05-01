-- ─────────────────────────────────────────────────────────────────────────────
-- sauceboss — reference data seed
--
-- Seeds the *small, exactly-reproducible* reference tables:
--   1. sauceboss_units                  — Mealie unit registry (from migration 063)
--   2. sauceboss_ingredient_categories  — produce / dairy / spices / etc. (from
--                                         migration 004) + broths (migration 065)
--   3. sauceboss_ingredient_substitutions — ingredient-swap suggestions (004)
--
-- The full sauce + item catalog (sauceboss_items, sauceboss_sauces,
-- sauceboss_sauce_items, sauceboss_sauce_steps, sauceboss_step_ingredients,
-- sauceboss_foods) is INTENTIONALLY NOT seeded here:
--
--   * Sauces and items grew through the legacy carbs/addons/salad_bases tables
--     (migrations 003, 014, 023) and were repacked into sauceboss_items by
--     the 052/053 backfills. Reproducing the post-053 row set from migration
--     SQL alone — including the migration 063 normalization that resolves
--     each ingredient to a sauceboss_foods row + canonical mL/g — is fragile
--     and would silently drift from production.
--   * Foods auto-populate via create_sauceboss_sauce on first insert; no need
--     to pre-seed them.
--
-- For a fresh DB, populate the catalog via either:
--   a) `pg_dump --data-only` from production, restoring just the catalog tables; or
--   b) the in-app Sauce Manager UI (each save calls create_sauceboss_sauce
--      which writes the full normalized shape).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Unit registry (migration 063) ─────────────────────────────────────────
INSERT INTO public.sauceboss_units
  (id, name, plural, abbreviation, plural_abbreviation, dimension, ml_per_unit, g_per_unit, aliases) VALUES
  ('teaspoon',    'teaspoon',    'teaspoons',    'tsp',      'tsp',      'volume',  4.92892, NULL,    ARRAY['tsp','tsps','teaspoon','teaspoons','t']),
  ('tablespoon',  'tablespoon',  'tablespoons',  'tbsp',     'tbsp',     'volume',  14.7868, NULL,    ARRAY['tbsp','tbsps','tablespoon','tablespoons','tbs','tbl','T']),
  ('cup',         'cup',         'cups',         'cup',      'cups',     'volume',  236.588, NULL,    ARRAY['cup','cups','c']),
  ('fluid_ounce', 'fluid ounce', 'fluid ounces', 'fl oz',    'fl oz',    'volume',  29.5735, NULL,    ARRAY['fl oz','fl. oz.','fluid ounce','fluid ounces','floz']),
  ('millilitre',  'millilitre',  'millilitres',  'ml',       'ml',       'volume',  1.0,     NULL,    ARRAY['ml','milliliter','milliliters','millilitre','millilitres']),
  ('litre',       'litre',       'litres',       'l',        'l',        'volume',  1000.0,  NULL,    ARRAY['l','liter','liters','litre','litres']),
  ('gram',        'gram',        'grams',        'g',        'g',        'mass',    NULL,    1.0,     ARRAY['g','gram','grams','gr']),
  ('kilogram',    'kilogram',    'kilograms',    'kg',       'kg',       'mass',    NULL,    1000.0,  ARRAY['kg','kilogram','kilograms']),
  ('ounce',       'ounce',       'ounces',       'oz',       'oz',       'mass',    NULL,    28.3495, ARRAY['oz','ounce','ounces']),
  ('pound',       'pound',       'pounds',       'lb',       'lbs',      'mass',    NULL,    453.592, ARRAY['lb','lbs','pound','pounds']),
  ('piece',       'piece',       'pieces',       'piece',    'pieces',   'count',   NULL,    NULL,    ARRAY['piece','pieces','pc','pcs']),
  ('clove',       'clove',       'cloves',       'clove',    'cloves',   'count',   NULL,    NULL,    ARRAY['clove','cloves']),
  ('pinch',       'pinch',       'pinches',      'pinch',    'pinches',  'count',   NULL,    NULL,    ARRAY['pinch','pinches']),
  ('dash',        'dash',        'dashes',       'dash',     'dashes',   'count',   NULL,    NULL,    ARRAY['dash','dashes']),
  ('to_taste',    'to taste',    'to taste',     'to taste', 'to taste', 'count',   NULL,    NULL,    ARRAY['to taste'])
ON CONFLICT (id) DO NOTHING;


-- ── 2. Ingredient categories (migration 004 + broths from migration 065) ─────
INSERT INTO public.sauceboss_ingredient_categories (ingredient_name, category) VALUES
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
  ('soy sauce',           'Sauces & Condiments'),
  ('fish sauce',          'Sauces & Condiments'),
  ('sriracha',            'Sauces & Condiments'),
  ('hot sauce',           'Sauces & Condiments'),
  ('gochujang',           'Sauces & Condiments'),
  ('ketchup',             'Sauces & Condiments'),
  ('mustard',             'Sauces & Condiments'),
  ('dijon mustard',       'Sauces & Condiments'),
  ('mayo',                'Sauces & Condiments'),
  ('worcestershire sauce','Sauces & Condiments'),
  ('tomato puree',        'Sauces & Condiments'),
  ('tamarind paste',      'Sauces & Condiments'),
  ('chipotle',            'Sauces & Condiments'),
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
  ('water',         'Pantry Staples'),
  -- Broths (migration 065)
  ('chicken broth',    'Broths'),
  ('chicken stock',    'Broths'),
  ('beef broth',       'Broths'),
  ('beef stock',       'Broths'),
  ('vegetable broth',  'Broths'),
  ('vegetable stock',  'Broths'),
  ('fish broth',       'Broths'),
  ('fish stock',       'Broths'),
  ('dashi',            'Broths'),
  ('bone broth',       'Broths')
ON CONFLICT (ingredient_name) DO UPDATE SET category = EXCLUDED.category;


-- ── 3. Ingredient substitutions (migration 004) ──────────────────────────────
INSERT INTO public.sauceboss_ingredient_substitutions (ingredient_name, substitute_name, notes) VALUES
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
