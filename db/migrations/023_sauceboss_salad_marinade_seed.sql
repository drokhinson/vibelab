-- Migration 023: SauceBoss — Seed salad bases, dressings, and marinades
-- Run AFTER 022_sauceboss_salad_marinade_rpcs.sql
-- Run in Supabase dashboard → SQL Editor → New Query → Run

-- ── 1. Salad bases ───────────────────────────────────────────────────────────

INSERT INTO sauceboss_salad_bases (id, name, emoji, description) VALUES
  -- Leafy greens
  ('romaine',       'Romaine',       '🥬', 'Crisp, sturdy leaves that stand up to bold dressings'),
  ('spinach',       'Spinach',       '🌿', 'Tender baby leaves with a mild, slightly earthy taste'),
  ('arugula',       'Arugula',       '🍃', 'Peppery and slightly bitter — pairs well with acidic dressings'),
  ('mixed-greens',  'Mixed Greens',  '🥗', 'Mild blend of lettuces, adaptable to any dressing style'),
  ('kale',          'Kale',          '🥦', 'Hearty and chewy — massage with dressing before serving'),
  -- Veggie-based
  ('cucumber-tomato', 'Cucumber & Tomato', '🥒', 'Light chopped salad, best with bright vinaigrettes'),
  ('shaved-beet',   'Shaved Beet',   '🫚', 'Sweet and earthy sliced beet base, great with creamy dressings'),
  -- Grain salads
  ('quinoa',        'Quinoa',        '🌾', 'Protein-rich grain base, holds dressing without getting soggy'),
  ('farro',         'Farro',         '🌰', 'Nutty, chewy ancient grain — robust enough for tangy dressings')
ON CONFLICT (id) DO NOTHING;

-- ── 2. Dressings (sauce_type = 'dressing') ───────────────────────────────────

INSERT INTO sauceboss_sauces (id, name, cuisine, cuisine_emoji, color, description, sauce_type) VALUES
  ('classic-caesar',       'Classic Caesar',       'American',      '🦅', '#F5E642', 'Rich and garlicky with anchovy depth — the original power dressing', 'dressing'),
  ('balsamic-vinaigrette', 'Balsamic Vinaigrette', 'Italian',       '🇮🇹', '#8B0000', 'Tangy-sweet reduction balanced with good olive oil and Dijon', 'dressing'),
  ('lemon-tahini',         'Lemon Tahini',         'Middle Eastern','🌙', '#D4A017', 'Creamy sesame paste brightened with lemon and garlic', 'dressing'),
  ('green-goddess',        'Green Goddess',        'American',      '🦅', '#4CAF50', 'Herby, creamy dressing with tarragon, chives, and avocado', 'dressing'),
  ('sesame-ginger-dressing','Sesame Ginger',       'Asian',         '🥢', '#C8860A', 'Toasted sesame oil with fresh ginger and a touch of rice vinegar', 'dressing'),
  ('honey-mustard-dressing','Honey Mustard',       'American',      '🦅', '#E8B84B', 'Sweet and tangy emulsified dressing — doubles as a dip', 'dressing'),
  ('creamy-avocado',       'Creamy Avocado',       'Mexican',       '🇲🇽', '#5D8A3C', 'Smooth avocado blended with lime, cilantro, and Greek yogurt', 'dressing'),
  ('champagne-vinaigrette','Champagne Vinaigrette','French',        '🇫🇷', '#F0E68C', 'Light and bright with champagne vinegar and a touch of shallot', 'dressing')
ON CONFLICT (id) DO NOTHING;

-- Dressing steps & ingredients

-- Classic Caesar (2 steps)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('classic-caesar', 0, 'Build the base', 3),
    ('classic-caesar', 1, 'Emulsify and season', 2)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'garlic',          2,   'clove'),
  (0, 'anchovy paste',   1,   'tsp'),
  (0, 'dijon mustard',   1,   'tsp'),
  (0, 'lemon juice',     2,   'tbsp'),
  (1, 'mayonnaise',      0.25,'cup'),
  (1, 'parmesan',        0.25,'cup'),
  (1, 'black pepper',    0.5, 'tsp'),
  (1, 'worcestershire',  1,   'tsp')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- Balsamic Vinaigrette (1 step — shake together)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('balsamic-vinaigrette', 0, 'Whisk and emulsify', 3)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'balsamic vinegar',  3,    'tbsp'),
  (0, 'olive oil',         6,    'tbsp'),
  (0, 'dijon mustard',     1,    'tsp'),
  (0, 'honey',             1,    'tsp'),
  (0, 'garlic',            1,    'clove'),
  (0, 'salt',              0.25, 'tsp'),
  (0, 'black pepper',      0.25, 'tsp')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- Lemon Tahini (1 step)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('lemon-tahini', 0, 'Whisk until smooth', 3)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'tahini',      0.25, 'cup'),
  (0, 'lemon juice', 3,    'tbsp'),
  (0, 'garlic',      1,    'clove'),
  (0, 'olive oil',   1,    'tbsp'),
  (0, 'water',       3,    'tbsp'),
  (0, 'salt',        0.25, 'tsp'),
  (0, 'cumin',       0.25, 'tsp')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- Green Goddess (2 steps)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('green-goddess', 0, 'Blend herbs and avocado', 3),
    ('green-goddess', 1, 'Add creamy base and blend smooth', 2)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'avocado',       1,    'piece'),
  (0, 'fresh tarragon',2,    'tbsp'),
  (0, 'chives',        2,    'tbsp'),
  (0, 'parsley',       0.25, 'cup'),
  (0, 'lemon juice',   2,    'tbsp'),
  (1, 'greek yogurt',  0.25, 'cup'),
  (1, 'olive oil',     2,    'tbsp'),
  (1, 'garlic',        1,    'clove'),
  (1, 'salt',          0.5,  'tsp')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- Sesame Ginger Dressing (1 step)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('sesame-ginger-dressing', 0, 'Whisk all ingredients together', 3)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'toasted sesame oil', 3,    'tbsp'),
  (0, 'rice vinegar',       2,    'tbsp'),
  (0, 'soy sauce',          1,    'tbsp'),
  (0, 'fresh ginger',       1,    'tsp'),
  (0, 'honey',              1,    'tsp'),
  (0, 'garlic',             1,    'clove'),
  (0, 'sesame seeds',       1,    'tsp')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- Honey Mustard Dressing (1 step)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('honey-mustard-dressing', 0, 'Whisk until emulsified', 2)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'dijon mustard',  2,    'tbsp'),
  (0, 'honey',          2,    'tbsp'),
  (0, 'apple cider vinegar', 1, 'tbsp'),
  (0, 'mayonnaise',     2,    'tbsp'),
  (0, 'olive oil',      2,    'tbsp'),
  (0, 'salt',           0.25, 'tsp')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- Creamy Avocado Dressing (1 step — blender)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('creamy-avocado', 0, 'Blend until smooth and creamy', 3)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'avocado',      1,    'piece'),
  (0, 'greek yogurt', 0.25, 'cup'),
  (0, 'lime juice',   2,    'tbsp'),
  (0, 'cilantro',     0.25, 'cup'),
  (0, 'garlic',       1,    'clove'),
  (0, 'olive oil',    1,    'tbsp'),
  (0, 'water',        2,    'tbsp'),
  (0, 'salt',         0.5,  'tsp'),
  (0, 'jalapeño',     0.5,  'piece')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- Champagne Vinaigrette (1 step)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('champagne-vinaigrette', 0, 'Whisk shallot, vinegar and mustard, drizzle in oil', 3)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'champagne vinegar', 3,    'tbsp'),
  (0, 'olive oil',         6,    'tbsp'),
  (0, 'shallot',           1,    'piece'),
  (0, 'dijon mustard',     0.5,  'tsp'),
  (0, 'honey',             0.5,  'tsp'),
  (0, 'salt',              0.25, 'tsp'),
  (0, 'black pepper',      0.25, 'tsp')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- ── 3. Dressing ↔ Salad base pairings ────────────────────────────────────────

INSERT INTO sauceboss_sauce_salad_bases (sauce_id, base_id) VALUES
  -- Classic Caesar → romaine (iconic), mixed-greens, kale
  ('classic-caesar',        'romaine'),
  ('classic-caesar',        'mixed-greens'),
  ('classic-caesar',        'kale'),
  -- Balsamic → romaine, arugula, mixed-greens, spinach, shaved-beet, farro
  ('balsamic-vinaigrette',  'romaine'),
  ('balsamic-vinaigrette',  'arugula'),
  ('balsamic-vinaigrette',  'mixed-greens'),
  ('balsamic-vinaigrette',  'spinach'),
  ('balsamic-vinaigrette',  'shaved-beet'),
  ('balsamic-vinaigrette',  'farro'),
  -- Lemon Tahini → kale, mixed-greens, quinoa, farro, cucumber-tomato
  ('lemon-tahini',          'kale'),
  ('lemon-tahini',          'mixed-greens'),
  ('lemon-tahini',          'quinoa'),
  ('lemon-tahini',          'farro'),
  ('lemon-tahini',          'cucumber-tomato'),
  -- Green Goddess → spinach, arugula, mixed-greens, romaine
  ('green-goddess',         'spinach'),
  ('green-goddess',         'arugula'),
  ('green-goddess',         'mixed-greens'),
  ('green-goddess',         'romaine'),
  -- Sesame Ginger → mixed-greens, spinach, quinoa, farro
  ('sesame-ginger-dressing','mixed-greens'),
  ('sesame-ginger-dressing','spinach'),
  ('sesame-ginger-dressing','quinoa'),
  ('sesame-ginger-dressing','farro'),
  -- Honey Mustard → romaine, mixed-greens, spinach
  ('honey-mustard-dressing','romaine'),
  ('honey-mustard-dressing','mixed-greens'),
  ('honey-mustard-dressing','spinach'),
  -- Creamy Avocado → romaine, mixed-greens, spinach, cucumber-tomato
  ('creamy-avocado',        'romaine'),
  ('creamy-avocado',        'mixed-greens'),
  ('creamy-avocado',        'spinach'),
  ('creamy-avocado',        'cucumber-tomato'),
  -- Champagne Vinaigrette → arugula, spinach, mixed-greens, shaved-beet
  ('champagne-vinaigrette', 'arugula'),
  ('champagne-vinaigrette', 'spinach'),
  ('champagne-vinaigrette', 'mixed-greens'),
  ('champagne-vinaigrette', 'shaved-beet')
ON CONFLICT DO NOTHING;

-- ── 4. Marinades (sauce_type = 'marinade') ────────────────────────────────────

INSERT INTO sauceboss_sauces (id, name, cuisine, cuisine_emoji, color, description, sauce_type) VALUES
  ('teriyaki-marinade',    'Teriyaki Marinade',    'Japanese',    '🇯🇵', '#8B4513', 'Soy, mirin, and sake reduction with ginger — marinate 30 min to overnight', 'marinade'),
  ('lemon-herb-marinade',  'Lemon Herb',           'Mediterranean','🌊', '#F0E68C', 'Bright lemon with rosemary, thyme, and garlic — classic for chicken or fish', 'marinade'),
  ('chipotle-lime',        'Chipotle Lime',        'Mexican',     '🇲🇽', '#C0392B', 'Smoky chipotle and fresh lime with cumin — bold and charred off the grill', 'marinade'),
  ('soy-ginger-marinade',  'Soy Ginger',           'Asian',       '🥢', '#5D4037', 'Umami-rich with fresh ginger and sesame — perfect for tofu and fish', 'marinade'),
  ('mojo-marinade',        'Cuban Mojo',           'Cuban',       '🌴', '#F39C12', 'Sour orange and garlic paste — Cuban classic for beef and chicken', 'marinade'),
  ('buttermilk-ranch',     'Buttermilk Ranch',     'American',    '🦅', '#FFFDE7', 'Tangy buttermilk with dill and garlic — the ultimate chicken tenderizer', 'marinade'),
  ('miso-sesame',          'Miso Sesame',          'Japanese',    '🇯🇵', '#D4AC0D', 'White miso with sesame and mirin — deep umami for tofu and fish', 'marinade'),
  ('bbq-marinade',         'Smoky BBQ Marinade',   'American',    '🦅', '#7B241C', 'Smoky paprika, brown sugar, and vinegar base — great for beef and chicken', 'marinade')
ON CONFLICT (id) DO NOTHING;

-- Marinade steps & ingredients

-- Teriyaki Marinade (2 steps: mix then marinate)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('teriyaki-marinade', 0, 'Combine and heat to dissolve sugar', 5),
    ('teriyaki-marinade', 1, 'Cool completely, then marinate protein', 30)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'soy sauce',      0.25, 'cup'),
  (0, 'mirin',          3,    'tbsp'),
  (0, 'sake',           2,    'tbsp'),
  (0, 'brown sugar',    2,    'tbsp'),
  (0, 'fresh ginger',   1,    'tbsp'),
  (0, 'garlic',         2,    'clove'),
  (1, 'sesame oil',     1,    'tsp')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- Lemon Herb (1 step)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('lemon-herb-marinade', 0, 'Mix all ingredients and coat protein', 5)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'lemon juice',   4,    'tbsp'),
  (0, 'lemon zest',    1,    'tsp'),
  (0, 'olive oil',     4,    'tbsp'),
  (0, 'garlic',        3,    'clove'),
  (0, 'fresh rosemary',1,    'tbsp'),
  (0, 'fresh thyme',   1,    'tbsp'),
  (0, 'salt',          1,    'tsp'),
  (0, 'black pepper',  0.5,  'tsp')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- Chipotle Lime (1 step)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('chipotle-lime', 0, 'Blend all together and coat protein', 5)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'chipotle in adobo', 2,    'tbsp'),
  (0, 'lime juice',        3,    'tbsp'),
  (0, 'lime zest',         1,    'tsp'),
  (0, 'olive oil',         3,    'tbsp'),
  (0, 'garlic',            2,    'clove'),
  (0, 'cumin',             1,    'tsp'),
  (0, 'smoked paprika',    1,    'tsp'),
  (0, 'salt',              1,    'tsp')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- Soy Ginger (1 step)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('soy-ginger-marinade', 0, 'Whisk together and marinate 30+ minutes', 5)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'soy sauce',     3,    'tbsp'),
  (0, 'fresh ginger',  2,    'tbsp'),
  (0, 'garlic',        2,    'clove'),
  (0, 'sesame oil',    1,    'tbsp'),
  (0, 'rice vinegar',  1,    'tbsp'),
  (0, 'honey',         1,    'tbsp'),
  (0, 'sesame seeds',  1,    'tsp')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- Cuban Mojo (1 step)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('mojo-marinade', 0, 'Blend citrus, garlic, and oil together', 5)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'orange juice',  0.25, 'cup'),
  (0, 'lime juice',    3,    'tbsp'),
  (0, 'garlic',        5,    'clove'),
  (0, 'olive oil',     3,    'tbsp'),
  (0, 'cumin',         1,    'tsp'),
  (0, 'oregano',       1,    'tsp'),
  (0, 'salt',          1,    'tsp'),
  (0, 'black pepper',  0.5,  'tsp')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- Buttermilk Ranch (1 step)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('buttermilk-ranch', 0, 'Whisk together and marinate 4–24 hours', 5)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'buttermilk',    0.5,  'cup'),
  (0, 'mayonnaise',    2,    'tbsp'),
  (0, 'garlic',        2,    'clove'),
  (0, 'fresh dill',    1,    'tbsp'),
  (0, 'chives',        1,    'tbsp'),
  (0, 'onion powder',  0.5,  'tsp'),
  (0, 'salt',          0.5,  'tsp'),
  (0, 'black pepper',  0.25, 'tsp')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- Miso Sesame (1 step)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('miso-sesame', 0, 'Whisk miso paste with remaining ingredients', 5)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'white miso',    3,    'tbsp'),
  (0, 'mirin',         2,    'tbsp'),
  (0, 'sesame oil',    1,    'tbsp'),
  (0, 'soy sauce',     1,    'tbsp'),
  (0, 'rice vinegar',  1,    'tbsp'),
  (0, 'fresh ginger',  1,    'tsp'),
  (0, 'sesame seeds',  1,    'tsp')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- Smoky BBQ Marinade (2 steps)
WITH step_ins AS (
  INSERT INTO sauceboss_sauce_steps (sauce_id, step_order, title, estimated_time) VALUES
    ('bbq-marinade', 0, 'Mix dry rub ingredients', 3),
    ('bbq-marinade', 1, 'Whisk in wet ingredients and coat protein', 5)
  RETURNING id, step_order
)
INSERT INTO sauceboss_step_ingredients (step_id, name, amount, unit)
SELECT s.id, ing.name, ing.amount, ing.unit FROM step_ins s
JOIN (VALUES
  (0, 'smoked paprika', 2,    'tsp'),
  (0, 'garlic powder',  1,    'tsp'),
  (0, 'onion powder',   1,    'tsp'),
  (0, 'cumin',          0.5,  'tsp'),
  (0, 'cayenne',        0.25, 'tsp'),
  (0, 'salt',           1,    'tsp'),
  (1, 'ketchup',        3,    'tbsp'),
  (1, 'apple cider vinegar', 2, 'tbsp'),
  (1, 'brown sugar',    1,    'tbsp'),
  (1, 'worcestershire', 1,    'tbsp'),
  (1, 'olive oil',      2,    'tbsp')
) AS ing(step_order, name, amount, unit) ON s.step_order = ing.step_order;

-- ── 5. Marinade ↔ Protein pairings ──────────────────────────────────────────

INSERT INTO sauceboss_sauce_proteins (sauce_id, addon_id) VALUES
  -- Teriyaki: chicken, beef, tofu, fish
  ('teriyaki-marinade',   'chicken'),
  ('teriyaki-marinade',   'beef'),
  ('teriyaki-marinade',   'tofu'),
  ('teriyaki-marinade',   'fish'),
  -- Lemon Herb: chicken, fish
  ('lemon-herb-marinade', 'chicken'),
  ('lemon-herb-marinade', 'fish'),
  -- Chipotle Lime: chicken, beef
  ('chipotle-lime',       'chicken'),
  ('chipotle-lime',       'beef'),
  -- Soy Ginger: tofu, fish, chicken
  ('soy-ginger-marinade', 'tofu'),
  ('soy-ginger-marinade', 'fish'),
  ('soy-ginger-marinade', 'chicken'),
  -- Cuban Mojo: chicken, beef
  ('mojo-marinade',       'chicken'),
  ('mojo-marinade',       'beef'),
  -- Buttermilk Ranch: chicken only
  ('buttermilk-ranch',    'chicken'),
  -- Miso Sesame: tofu, fish
  ('miso-sesame',         'tofu'),
  ('miso-sesame',         'fish'),
  -- Smoky BBQ: beef, chicken
  ('bbq-marinade',        'beef'),
  ('bbq-marinade',        'chicken')
ON CONFLICT DO NOTHING;
