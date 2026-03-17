-- 015_spotme_hobby_levels.sql
-- Move hobby skill level presets from application code into the database.
-- Run in Supabase SQL Editor after 014_spotme_skill_levels.sql.

-- ── Table ─────────────────────────────────────────────────────────────────────
CREATE TABLE spotme_hobby_levels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hobby_id   uuid REFERENCES spotme_hobbies(id) ON DELETE CASCADE,
  sort_order int  NOT NULL DEFAULT 0,
  value      text NOT NULL,
  label      text NOT NULL,
  UNIQUE (hobby_id, value)
);

CREATE INDEX idx_spotme_hobby_levels_hobby ON spotme_hobby_levels(hobby_id);

-- ── Default fallback levels (hobby_id IS NULL) ────────────────────────────────
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label) VALUES
  (NULL, 0, 'want_to_learn', 'Want to Learn'),
  (NULL, 1, 'beginner',      'Beginner'),
  (NULL, 2, 'intermediate',  'Intermediate'),
  (NULL, 3, 'advanced',      'Advanced'),
  (NULL, 4, 'expert',        'Expert');

-- ── Hobby-specific levels ─────────────────────────────────────────────────────
-- Helper macro: for each hobby slug, CROSS JOIN with its level rows.

-- skiing
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'green_circle',  'Green Circle'),
  (2, 'blue_square',   'Blue Square'),
  (3, 'black_diamond', 'Black Diamond'),
  (4, 'double_black',  'Double Black Diamond')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'skiing';

-- snowboarding
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'green_circle',  'Green Circle'),
  (2, 'blue_square',   'Blue Square'),
  (3, 'black_diamond', 'Black Diamond'),
  (4, 'double_black',  'Double Black Diamond')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'snowboarding';

-- rock-climbing
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'top_rope',      'Top Rope'),
  (2, 'sport_510',     'Sport 5.10'),
  (3, 'sport_512',     'Sport 5.12+'),
  (4, 'trad',          'Trad / Multi-pitch')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'rock-climbing';

-- mountain-biking
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'flow_trails',   'Flow Trails'),
  (2, 'technical_xc',  'Technical XC'),
  (3, 'enduro',        'Enduro'),
  (4, 'dh',            'DH / Park')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'mountain-biking';

-- surfing
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'white_water',   'White Water'),
  (2, 'green_waves',   'Green Waves'),
  (3, 'overhead',      'Overhead+'),
  (4, 'big_wave',      'Big Wave')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'surfing';

-- kayaking
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'flatwater',     'Flatwater'),
  (2, 'class_ii',      'Class II-III'),
  (3, 'class_iv',      'Class IV+'),
  (4, 'expedition',    'Expedition')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'kayaking';

-- trail-running
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, '5k_trail',      '5K Trail'),
  (2, 'half_trail',    'Half Marathon Distance'),
  (3, 'marathon',      'Marathon'),
  (4, 'ultra',         'Ultra')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'trail-running';

-- hiking
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'day_hikes',     'Day Hikes'),
  (2, 'overnight',     'Overnight'),
  (3, 'multi_day',     'Multi-Day'),
  (4, 'peak_bagging',  'Peak Bagging')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'hiking';

-- swimming
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'recreational',  'Recreational'),
  (2, 'lap_swimmer',   'Lap Swimmer'),
  (3, 'competitive',   'Competitive'),
  (4, 'open_water',    'Open Water')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'swimming';

-- yoga
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'beginner',      'Beginner'),
  (2, 'practitioner',  'Practitioner'),
  (3, 'advanced',      'Advanced / Teacher')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'yoga';

-- board-games
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'casual',        'Casual (Party Games)'),
  (2, 'gamer',         'Gamer (40-90 min strategy)'),
  (3, 'hardcore',      'Hardcore (no time limit)')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'board-games';

-- video-games
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'casual',        'Casual'),
  (2, 'regular',       'Regular'),
  (3, 'competitive',   'Competitive'),
  (4, 'pro',           'Pro / Esports')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'video-games';

-- camping
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'car_camper',    'Car Camper'),
  (2, 'backpacker',    'Backpacker'),
  (3, 'wilderness',    'Wilderness / Off-grid')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'camping';

-- photography
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',  'Want to Learn'),
  (1, 'phone_shooter',  'Phone / Point-and-Shoot'),
  (2, 'dslr_hobbyist',  'DSLR Hobbyist'),
  (3, 'semi_pro',       'Semi-Pro'),
  (4, 'professional',   'Professional')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'photography';

-- bird-watching
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',   'Want to Learn'),
  (1, 'backyard_birder', 'Backyard Birder'),
  (2, 'local_lister',    'Local Lister'),
  (3, 'serious_birder',  'Serious Birder')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'bird-watching';

-- fishing
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'casual',        'Casual'),
  (2, 'freshwater',    'Freshwater Angler'),
  (3, 'fly_fisher',    'Saltwater / Fly Fisher')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'fishing';

-- gardening
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',  'Want to Learn'),
  (1, 'container',      'Container / Patio'),
  (2, 'veggie_garden',  'Veggie Garden'),
  (3, 'landscape',      'Landscape / Permaculture')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'gardening';

-- pottery
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',  'Want to Learn'),
  (1, 'hand_building',  'Hand Building'),
  (2, 'wheel_throwing', 'Wheel Throwing'),
  (3, 'glazing_firing', 'Glazing & Firing')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'pottery';

-- knitting
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'scarves',       'Scarves & Simple'),
  (2, 'patterns',      'Intermediate Patterns'),
  (3, 'colorwork',     'Complex Colorwork')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'knitting';

-- woodworking
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',  'Want to Learn'),
  (1, 'weekend_diy',    'Weekend DIY'),
  (2, 'furniture',      'Furniture Making'),
  (3, 'fine_woodwork',  'Fine Woodworking')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'woodworking';

-- painting
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'exploring',     'Exploring Mediums'),
  (2, 'developing',    'Developing Style'),
  (3, 'exhibiting',    'Exhibiting / Selling')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'painting';

-- leathercraft
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',     'Want to Learn'),
  (1, 'basic_stitching',   'Basic Stitching'),
  (2, 'bags_accessories',  'Bags & Accessories'),
  (3, 'custom_craft',      'Custom Craft')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'leathercraft';

-- thai-cooking
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',    'Want to Learn'),
  (1, 'home_cook',        'Home Cook'),
  (2, 'dinner_party',     'Dinner Party Host'),
  (3, 'recipe_developer', 'Recipe Developer')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'thai-cooking';

-- italian-cooking
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',    'Want to Learn'),
  (1, 'home_cook',        'Home Cook'),
  (2, 'dinner_party',     'Dinner Party Host'),
  (3, 'recipe_developer', 'Recipe Developer')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'italian-cooking';

-- baking
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',  'Want to Learn'),
  (1, 'simple_treats',  'Simple Treats'),
  (2, 'layer_cakes',    'Layer Cakes & Breads'),
  (3, 'patisserie',     'Patisserie / Artisan')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'baking';

-- bbq-grilling
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn', 'Want to Learn'),
  (1, 'backyard',      'Backyard Griller'),
  (2, 'low_slow',      'Low & Slow BBQ'),
  (3, 'pitmaster',     'Pitmaster')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'bbq-grilling';

-- japanese-cooking
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',    'Want to Learn'),
  (1, 'home_cook',        'Home Cook'),
  (2, 'dinner_party',     'Dinner Party Host'),
  (3, 'recipe_developer', 'Recipe Developer')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'japanese-cooking';

-- guitar
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',  'Want to Learn'),
  (1, 'learning_basics','Learning Basics'),
  (2, 'playing_songs',  'Playing Songs'),
  (3, 'gigging',        'Gigging / Performing')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'guitar';

-- piano
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',  'Want to Learn'),
  (1, 'learning_basics','Learning Basics'),
  (2, 'playing_songs',  'Playing Songs'),
  (3, 'performing',     'Performing')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'piano';

-- drums
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',  'Want to Learn'),
  (1, 'learning_basics','Learning Basics'),
  (2, 'playing_songs',  'Playing Songs'),
  (3, 'gigging',        'Gigging / Performing')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'drums';

-- singing
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',  'Want to Learn'),
  (1, 'shower_singer',  'Shower Singer'),
  (2, 'open_mic',       'Open Mic'),
  (3, 'performing',     'Performing')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'singing';

-- 3d-printing
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',   'Want to Learn'),
  (1, 'printing_models', 'Printing Models'),
  (2, 'customizing',     'Customizing / Remixing'),
  (3, 'designing',       'Designing from Scratch')
) AS lvl(sort_order, value, label)
WHERE h.slug = '3d-printing';

-- fiction
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',   'Want to Learn'),
  (1, 'casual_reader',   'Casual Reader'),
  (2, 'regular_reader',  'Regular Reader'),
  (3, 'voracious_reader','Voracious Reader')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'fiction';

-- non-fiction
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',   'Want to Learn'),
  (1, 'casual_reader',   'Casual Reader'),
  (2, 'regular_reader',  'Regular Reader'),
  (3, 'voracious_reader','Voracious Reader')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'non-fiction';

-- sci-fi-fantasy
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',   'Want to Learn'),
  (1, 'casual_reader',   'Casual Reader'),
  (2, 'regular_reader',  'Regular Reader'),
  (3, 'voracious_reader','Voracious Reader')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'sci-fi-fantasy';

-- film-buff
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',   'Want to Learn'),
  (1, 'casual_viewer',   'Casual Viewer'),
  (2, 'regular_watcher', 'Regular Watcher'),
  (3, 'cinephile',       'Cinephile / Critic')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'film-buff';

-- documentaries
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',   'Want to Learn'),
  (1, 'casual_viewer',   'Casual Viewer'),
  (2, 'regular_watcher', 'Regular Watcher'),
  (3, 'enthusiast',      'Enthusiast / Researcher')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'documentaries';

-- anime
INSERT INTO spotme_hobby_levels (hobby_id, sort_order, value, label)
SELECT h.id, lvl.sort_order, lvl.value, lvl.label
FROM spotme_hobbies h
CROSS JOIN (VALUES
  (0, 'want_to_learn',   'Want to Learn'),
  (1, 'casual_viewer',   'Casual Viewer'),
  (2, 'regular_watcher', 'Regular Watcher'),
  (3, 'otaku',           'Otaku')
) AS lvl(sort_order, value, label)
WHERE h.slug = 'anime';
