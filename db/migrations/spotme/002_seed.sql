-- ─────────────────────────────────────────────────────────────────────────────
-- spotme — reference data seed
-- Hobby categories, starter hobbies, and per-hobby skill level presets.
-- Replaces legacy 012_spotme_seed.sql + 015_spotme_hobby_levels.sql data.
--
-- Idempotent: ON CONFLICT DO NOTHING on natural keys (slug, value) so
-- re-running won't duplicate rows.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Categories ───────────────────────────────────────────────────────────────
INSERT INTO public.spotme_hobby_categories (slug, name, icon, sort_order) VALUES
  ('sports',   'Sports & Fitness',  '🏔️', 1),
  ('books',    'Books & Reading',   '📚', 2),
  ('movies',   'Movies & TV',       '🎬', 3),
  ('crafting', 'Crafting & Making', '🎨', 4),
  ('cooking',  'Cooking & Baking',  '🍳', 5),
  ('music',    'Music',             '🎵', 6),
  ('outdoors', 'Outdoors & Nature', '🌲', 7),
  ('tech',     'Tech & Gaming',     '💻', 8),
  ('other',    'Other',             '✨', 9)
ON CONFLICT (slug) DO NOTHING;


-- ── Starter hobbies ──────────────────────────────────────────────────────────
INSERT INTO public.spotme_hobbies (category_id, name, slug)
SELECT c.id, h.name, h.slug
FROM (VALUES
  -- Sports & Fitness
  ('sports',   'Rock Climbing',     'rock-climbing'),
  ('sports',   'Trail Running',     'trail-running'),
  ('sports',   'Hiking',            'hiking'),
  ('sports',   'Mountain Biking',   'mountain-biking'),
  ('sports',   'Skiing',            'skiing'),
  ('sports',   'Kayaking',          'kayaking'),
  ('sports',   'Swimming',          'swimming'),
  ('sports',   'Yoga',              'yoga'),
  ('sports',   'Surfing',           'surfing'),
  ('sports',   'Snowboarding',      'snowboarding'),
  -- Outdoors & Nature
  ('outdoors', 'Camping',           'camping'),
  ('outdoors', 'Photography',       'photography'),
  ('outdoors', 'Bird Watching',     'bird-watching'),
  ('outdoors', 'Fishing',           'fishing'),
  ('outdoors', 'Gardening',         'gardening'),
  -- Crafting & Making
  ('crafting', 'Pottery',           'pottery'),
  ('crafting', 'Knitting',          'knitting'),
  ('crafting', 'Woodworking',       'woodworking'),
  ('crafting', 'Painting',          'painting'),
  ('crafting', 'Leathercraft',      'leathercraft'),
  -- Cooking & Baking
  ('cooking',  'Thai Cooking',      'thai-cooking'),
  ('cooking',  'Italian Cooking',   'italian-cooking'),
  ('cooking',  'Baking',            'baking'),
  ('cooking',  'BBQ & Grilling',    'bbq-grilling'),
  ('cooking',  'Japanese Cooking',  'japanese-cooking'),
  -- Music
  ('music',    'Guitar',            'guitar'),
  ('music',    'Piano',             'piano'),
  ('music',    'Drums',             'drums'),
  ('music',    'Singing',           'singing'),
  -- Tech & Gaming
  ('tech',     '3D Printing',       '3d-printing'),
  ('tech',     'Board Games',       'board-games'),
  ('tech',     'Video Games',       'video-games'),
  -- Books & Reading
  ('books',    'Fiction',           'fiction'),
  ('books',    'Non-Fiction',       'non-fiction'),
  ('books',    'Sci-Fi & Fantasy',  'sci-fi-fantasy'),
  -- Movies & TV
  ('movies',   'Film Buff',         'film-buff'),
  ('movies',   'Documentaries',     'documentaries'),
  ('movies',   'Anime',             'anime')
) AS h(category_slug, name, slug)
JOIN public.spotme_hobby_categories c ON c.slug = h.category_slug
ON CONFLICT (slug) DO NOTHING;


-- ── Default fallback levels (hobby_id IS NULL) ───────────────────────────────
-- ON CONFLICT can't match NULL via the UNIQUE(hobby_id, value), so guard with
-- a NOT EXISTS subquery.
INSERT INTO public.spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT NULL, lvl.sort_order, lvl.value, lvl.label
FROM (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'beginner',      'Beginner'),
  (2, 'intermediate',  'Intermediate'),
  (3, 'advanced',      'Advanced'),
  (4, 'expert',        'Expert')
) AS lvl(sort_order, value, label)
WHERE NOT EXISTS (
  SELECT 1 FROM public.spotme_hobby_levels
  WHERE hobby_id IS NULL AND value = lvl.value
);


-- ── Hobby-specific levels ────────────────────────────────────────────────────
-- For each hobby slug, insert its level rows. The rows below mirror the
-- HOBBY_LEVEL_PRESETS that used to live in application code.
INSERT INTO public.spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, p.sort_order, p.value, p.label
FROM (VALUES
  -- skiing
  ('skiing',          0, 'want_to_learn', 'Want to Learn'),
  ('skiing',          1, 'green_circle',  'Green Circle'),
  ('skiing',          2, 'blue_square',   'Blue Square'),
  ('skiing',          3, 'black_diamond', 'Black Diamond'),
  ('skiing',          4, 'double_black',  'Double Black Diamond'),
  -- snowboarding
  ('snowboarding',    0, 'want_to_learn', 'Want to Learn'),
  ('snowboarding',    1, 'green_circle',  'Green Circle'),
  ('snowboarding',    2, 'blue_square',   'Blue Square'),
  ('snowboarding',    3, 'black_diamond', 'Black Diamond'),
  ('snowboarding',    4, 'double_black',  'Double Black Diamond'),
  -- rock-climbing
  ('rock-climbing',   0, 'want_to_learn', 'Want to Learn'),
  ('rock-climbing',   1, 'top_rope',      'Top Rope'),
  ('rock-climbing',   2, 'sport_510',     'Sport 5.10'),
  ('rock-climbing',   3, 'sport_512',     'Sport 5.12+'),
  ('rock-climbing',   4, 'trad',          'Trad / Multi-pitch'),
  -- mountain-biking
  ('mountain-biking', 0, 'want_to_learn', 'Want to Learn'),
  ('mountain-biking', 1, 'flow_trails',   'Flow Trails'),
  ('mountain-biking', 2, 'technical_xc',  'Technical XC'),
  ('mountain-biking', 3, 'enduro',        'Enduro'),
  ('mountain-biking', 4, 'dh',            'DH / Park'),
  -- surfing
  ('surfing',         0, 'want_to_learn', 'Want to Learn'),
  ('surfing',         1, 'white_water',   'White Water'),
  ('surfing',         2, 'green_waves',   'Green Waves'),
  ('surfing',         3, 'overhead',      'Overhead+'),
  ('surfing',         4, 'big_wave',      'Big Wave'),
  -- kayaking
  ('kayaking',        0, 'want_to_learn', 'Want to Learn'),
  ('kayaking',        1, 'flatwater',     'Flatwater'),
  ('kayaking',        2, 'class_ii',      'Class II-III'),
  ('kayaking',        3, 'class_iv',      'Class IV+'),
  ('kayaking',        4, 'expedition',    'Expedition'),
  -- trail-running
  ('trail-running',   0, 'want_to_learn', 'Want to Learn'),
  ('trail-running',   1, '5k_trail',      '5K Trail'),
  ('trail-running',   2, 'half_trail',    'Half Marathon Distance'),
  ('trail-running',   3, 'marathon',      'Marathon'),
  ('trail-running',   4, 'ultra',         'Ultra'),
  -- hiking
  ('hiking',          0, 'want_to_learn', 'Want to Learn'),
  ('hiking',          1, 'day_hikes',     'Day Hikes'),
  ('hiking',          2, 'overnight',     'Overnight'),
  ('hiking',          3, 'multi_day',     'Multi-Day'),
  ('hiking',          4, 'peak_bagging',  'Peak Bagging'),
  -- swimming
  ('swimming',        0, 'want_to_learn', 'Want to Learn'),
  ('swimming',        1, 'recreational',  'Recreational'),
  ('swimming',        2, 'lap_swimmer',   'Lap Swimmer'),
  ('swimming',        3, 'competitive',   'Competitive'),
  ('swimming',        4, 'open_water',    'Open Water'),
  -- yoga
  ('yoga',            0, 'want_to_learn', 'Want to Learn'),
  ('yoga',            1, 'beginner',      'Beginner'),
  ('yoga',            2, 'practitioner',  'Practitioner'),
  ('yoga',            3, 'advanced',      'Advanced / Teacher'),
  -- board-games
  ('board-games',     0, 'want_to_learn', 'Want to Learn'),
  ('board-games',     1, 'casual',        'Casual (Party Games)'),
  ('board-games',     2, 'gamer',         'Gamer (40-90 min strategy)'),
  ('board-games',     3, 'hardcore',      'Hardcore (no time limit)'),
  -- video-games
  ('video-games',     0, 'want_to_learn', 'Want to Learn'),
  ('video-games',     1, 'casual',        'Casual'),
  ('video-games',     2, 'regular',       'Regular'),
  ('video-games',     3, 'competitive',   'Competitive'),
  ('video-games',     4, 'pro',           'Pro / Esports'),
  -- camping
  ('camping',         0, 'want_to_learn', 'Want to Learn'),
  ('camping',         1, 'car_camper',    'Car Camper'),
  ('camping',         2, 'backpacker',    'Backpacker'),
  ('camping',         3, 'wilderness',    'Wilderness / Off-grid'),
  -- photography
  ('photography',     0, 'want_to_learn', 'Want to Learn'),
  ('photography',     1, 'phone_shooter', 'Phone / Point-and-Shoot'),
  ('photography',     2, 'dslr_hobbyist', 'DSLR Hobbyist'),
  ('photography',     3, 'semi_pro',      'Semi-Pro'),
  ('photography',     4, 'professional',  'Professional'),
  -- bird-watching
  ('bird-watching',   0, 'want_to_learn',   'Want to Learn'),
  ('bird-watching',   1, 'backyard_birder', 'Backyard Birder'),
  ('bird-watching',   2, 'local_lister',    'Local Lister'),
  ('bird-watching',   3, 'serious_birder',  'Serious Birder'),
  -- fishing
  ('fishing',         0, 'want_to_learn', 'Want to Learn'),
  ('fishing',         1, 'casual',        'Casual'),
  ('fishing',         2, 'freshwater',    'Freshwater Angler'),
  ('fishing',         3, 'fly_fisher',    'Saltwater / Fly Fisher'),
  -- gardening
  ('gardening',       0, 'want_to_learn', 'Want to Learn'),
  ('gardening',       1, 'container',     'Container / Patio'),
  ('gardening',       2, 'veggie_garden', 'Veggie Garden'),
  ('gardening',       3, 'landscape',     'Landscape / Permaculture'),
  -- pottery
  ('pottery',         0, 'want_to_learn',  'Want to Learn'),
  ('pottery',         1, 'hand_building',  'Hand Building'),
  ('pottery',         2, 'wheel_throwing', 'Wheel Throwing'),
  ('pottery',         3, 'glazing_firing', 'Glazing & Firing'),
  -- knitting
  ('knitting',        0, 'want_to_learn', 'Want to Learn'),
  ('knitting',        1, 'scarves',       'Scarves & Simple'),
  ('knitting',        2, 'patterns',      'Intermediate Patterns'),
  ('knitting',        3, 'colorwork',     'Complex Colorwork'),
  -- woodworking
  ('woodworking',     0, 'want_to_learn', 'Want to Learn'),
  ('woodworking',     1, 'weekend_diy',   'Weekend DIY'),
  ('woodworking',     2, 'furniture',     'Furniture Making'),
  ('woodworking',     3, 'fine_woodwork', 'Fine Woodworking'),
  -- painting
  ('painting',        0, 'want_to_learn', 'Want to Learn'),
  ('painting',        1, 'exploring',     'Exploring Mediums'),
  ('painting',        2, 'developing',    'Developing Style'),
  ('painting',        3, 'exhibiting',    'Exhibiting / Selling'),
  -- leathercraft
  ('leathercraft',    0, 'want_to_learn',    'Want to Learn'),
  ('leathercraft',    1, 'basic_stitching',  'Basic Stitching'),
  ('leathercraft',    2, 'bags_accessories', 'Bags & Accessories'),
  ('leathercraft',    3, 'custom_craft',     'Custom Craft'),
  -- thai-cooking, italian-cooking, japanese-cooking share the cooking template
  ('thai-cooking',    0, 'want_to_learn',    'Want to Learn'),
  ('thai-cooking',    1, 'home_cook',        'Home Cook'),
  ('thai-cooking',    2, 'dinner_party',     'Dinner Party Host'),
  ('thai-cooking',    3, 'recipe_developer', 'Recipe Developer'),
  ('italian-cooking', 0, 'want_to_learn',    'Want to Learn'),
  ('italian-cooking', 1, 'home_cook',        'Home Cook'),
  ('italian-cooking', 2, 'dinner_party',     'Dinner Party Host'),
  ('italian-cooking', 3, 'recipe_developer', 'Recipe Developer'),
  ('japanese-cooking',0, 'want_to_learn',    'Want to Learn'),
  ('japanese-cooking',1, 'home_cook',        'Home Cook'),
  ('japanese-cooking',2, 'dinner_party',     'Dinner Party Host'),
  ('japanese-cooking',3, 'recipe_developer', 'Recipe Developer'),
  -- baking
  ('baking',          0, 'want_to_learn', 'Want to Learn'),
  ('baking',          1, 'simple_treats', 'Simple Treats'),
  ('baking',          2, 'layer_cakes',   'Layer Cakes & Breads'),
  ('baking',          3, 'patisserie',    'Patisserie / Artisan'),
  -- bbq-grilling
  ('bbq-grilling',    0, 'want_to_learn', 'Want to Learn'),
  ('bbq-grilling',    1, 'backyard',      'Backyard Griller'),
  ('bbq-grilling',    2, 'low_slow',      'Low & Slow BBQ'),
  ('bbq-grilling',    3, 'pitmaster',     'Pitmaster'),
  -- guitar, drums share the gigging template
  ('guitar',          0, 'want_to_learn',   'Want to Learn'),
  ('guitar',          1, 'learning_basics', 'Learning Basics'),
  ('guitar',          2, 'playing_songs',   'Playing Songs'),
  ('guitar',          3, 'gigging',         'Gigging / Performing'),
  ('drums',           0, 'want_to_learn',   'Want to Learn'),
  ('drums',           1, 'learning_basics', 'Learning Basics'),
  ('drums',           2, 'playing_songs',   'Playing Songs'),
  ('drums',           3, 'gigging',         'Gigging / Performing'),
  -- piano
  ('piano',           0, 'want_to_learn',   'Want to Learn'),
  ('piano',           1, 'learning_basics', 'Learning Basics'),
  ('piano',           2, 'playing_songs',   'Playing Songs'),
  ('piano',           3, 'performing',      'Performing'),
  -- singing
  ('singing',         0, 'want_to_learn', 'Want to Learn'),
  ('singing',         1, 'shower_singer', 'Shower Singer'),
  ('singing',         2, 'open_mic',      'Open Mic'),
  ('singing',         3, 'performing',    'Performing'),
  -- 3d-printing
  ('3d-printing',     0, 'want_to_learn',   'Want to Learn'),
  ('3d-printing',     1, 'printing_models', 'Printing Models'),
  ('3d-printing',     2, 'customizing',     'Customizing / Remixing'),
  ('3d-printing',     3, 'designing',       'Designing from Scratch'),
  -- fiction, non-fiction, sci-fi-fantasy share the reader template
  ('fiction',         0, 'want_to_learn',    'Want to Learn'),
  ('fiction',         1, 'casual_reader',    'Casual Reader'),
  ('fiction',         2, 'regular_reader',   'Regular Reader'),
  ('fiction',         3, 'voracious_reader', 'Voracious Reader'),
  ('non-fiction',     0, 'want_to_learn',    'Want to Learn'),
  ('non-fiction',     1, 'casual_reader',    'Casual Reader'),
  ('non-fiction',     2, 'regular_reader',   'Regular Reader'),
  ('non-fiction',     3, 'voracious_reader', 'Voracious Reader'),
  ('sci-fi-fantasy',  0, 'want_to_learn',    'Want to Learn'),
  ('sci-fi-fantasy',  1, 'casual_reader',    'Casual Reader'),
  ('sci-fi-fantasy',  2, 'regular_reader',   'Regular Reader'),
  ('sci-fi-fantasy',  3, 'voracious_reader', 'Voracious Reader'),
  -- film-buff
  ('film-buff',       0, 'want_to_learn',   'Want to Learn'),
  ('film-buff',       1, 'casual_viewer',   'Casual Viewer'),
  ('film-buff',       2, 'regular_watcher', 'Regular Watcher'),
  ('film-buff',       3, 'cinephile',       'Cinephile / Critic'),
  -- documentaries
  ('documentaries',   0, 'want_to_learn',   'Want to Learn'),
  ('documentaries',   1, 'casual_viewer',   'Casual Viewer'),
  ('documentaries',   2, 'regular_watcher', 'Regular Watcher'),
  ('documentaries',   3, 'enthusiast',      'Enthusiast / Researcher'),
  -- anime
  ('anime',           0, 'want_to_learn',   'Want to Learn'),
  ('anime',           1, 'casual_viewer',   'Casual Viewer'),
  ('anime',           2, 'regular_watcher', 'Regular Watcher'),
  ('anime',           3, 'otaku',           'Otaku')
) AS p(hobby_slug, sort_order, value, label)
JOIN public.spotme_hobbies h ON h.slug = p.hobby_slug
ON CONFLICT (hobby_id, value) DO NOTHING;
