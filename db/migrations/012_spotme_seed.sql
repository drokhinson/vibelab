-- 012_spotme_seed.sql — Seed hobby categories and starter hobbies

-- ── Categories ───────────────────────────────────────────────────────────────
INSERT INTO spotme_hobby_categories (slug, name, icon, sort_order) VALUES
  ('sports',   'Sports & Fitness',  '🏔️', 1),
  ('books',    'Books & Reading',   '📚', 2),
  ('movies',   'Movies & TV',       '🎬', 3),
  ('crafting', 'Crafting & Making', '🎨', 4),
  ('cooking',  'Cooking & Baking',  '🍳', 5),
  ('music',    'Music',             '🎵', 6),
  ('outdoors', 'Outdoors & Nature', '🌲', 7),
  ('tech',     'Tech & Gaming',     '💻', 8),
  ('other',    'Other',             '✨', 9);

-- ── Starter Hobbies ──────────────────────────────────────────────────────────
-- Sports & Fitness
INSERT INTO spotme_hobbies (category_id, name, slug) VALUES
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'sports'), 'Rock Climbing', 'rock-climbing'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'sports'), 'Trail Running', 'trail-running'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'sports'), 'Hiking', 'hiking'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'sports'), 'Mountain Biking', 'mountain-biking'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'sports'), 'Skiing', 'skiing'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'sports'), 'Kayaking', 'kayaking'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'sports'), 'Swimming', 'swimming'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'sports'), 'Yoga', 'yoga'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'sports'), 'Surfing', 'surfing'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'sports'), 'Snowboarding', 'snowboarding');

-- Outdoors & Nature
INSERT INTO spotme_hobbies (category_id, name, slug) VALUES
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'outdoors'), 'Camping', 'camping'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'outdoors'), 'Photography', 'photography'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'outdoors'), 'Bird Watching', 'bird-watching'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'outdoors'), 'Fishing', 'fishing'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'outdoors'), 'Gardening', 'gardening');

-- Crafting & Making
INSERT INTO spotme_hobbies (category_id, name, slug) VALUES
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'crafting'), 'Pottery', 'pottery'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'crafting'), 'Knitting', 'knitting'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'crafting'), 'Woodworking', 'woodworking'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'crafting'), 'Painting', 'painting'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'crafting'), 'Leathercraft', 'leathercraft');

-- Cooking & Baking
INSERT INTO spotme_hobbies (category_id, name, slug) VALUES
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'cooking'), 'Thai Cooking', 'thai-cooking'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'cooking'), 'Italian Cooking', 'italian-cooking'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'cooking'), 'Baking', 'baking'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'cooking'), 'BBQ & Grilling', 'bbq-grilling'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'cooking'), 'Japanese Cooking', 'japanese-cooking');

-- Music
INSERT INTO spotme_hobbies (category_id, name, slug) VALUES
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'music'), 'Guitar', 'guitar'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'music'), 'Piano', 'piano'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'music'), 'Drums', 'drums'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'music'), 'Singing', 'singing');

-- Tech & Gaming
INSERT INTO spotme_hobbies (category_id, name, slug) VALUES
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'tech'), '3D Printing', '3d-printing'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'tech'), 'Board Games', 'board-games'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'tech'), 'Video Games', 'video-games');

-- Books & Reading (the category itself is a hobby)
INSERT INTO spotme_hobbies (category_id, name, slug) VALUES
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'books'), 'Fiction', 'fiction'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'books'), 'Non-Fiction', 'non-fiction'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'books'), 'Sci-Fi & Fantasy', 'sci-fi-fantasy');

-- Movies & TV
INSERT INTO spotme_hobbies (category_id, name, slug) VALUES
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'movies'), 'Film Buff', 'film-buff'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'movies'), 'Documentaries', 'documentaries'),
  ((SELECT id FROM spotme_hobby_categories WHERE slug = 'movies'), 'Anime', 'anime');
