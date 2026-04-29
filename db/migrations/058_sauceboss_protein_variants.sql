-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 058 — SauceBoss: protein variants
-- Convert beef / chicken / tofu Type rows into generic parents and seed
-- preparation variants under each (mirrors how rice / pasta already work).
-- Existing sauceboss_sauce_items pairings stay attached at the parent level
-- and apply to every variant via the parent.
-- ─────────────────────────────────────────────────────────────────────────────

-- Parents become generic (no cook info; variants carry cook details).
UPDATE public.sauceboss_items
   SET name = 'Beef',
       description = '',
       cook_time_minutes = NULL,
       instructions = NULL
 WHERE id = 'beef'
   AND parent_id IS NULL;

UPDATE public.sauceboss_items
   SET name = 'Chicken',
       description = '',
       cook_time_minutes = NULL,
       instructions = NULL
 WHERE id = 'chicken'
   AND parent_id IS NULL;

UPDATE public.sauceboss_items
   SET name = 'Tofu',
       description = '',
       cook_time_minutes = NULL,
       instructions = NULL
 WHERE id = 'tofu'
   AND parent_id IS NULL;

-- Beef variants
INSERT INTO public.sauceboss_items (
  id, category, parent_id, name, emoji, description, sort_order,
  cook_time_minutes, instructions, water_ratio, portion_per_person, portion_unit
) VALUES
  ('beef-strips', 'protein', 'beef', 'Strips', '🥩',
   'Thin sliced for stir-fry or fajitas', 0,
   8,
   'Pat strips dry. Heat 1 tbsp oil in a heavy pan over high heat until shimmering. Add beef in a single layer, do not crowd. Sear 2 min per side until browned. Season with salt and pepper. Rest 2 min off heat.',
   NULL, 150, 'g'),
  ('beef-tbone-steak', 'protein', 'beef', 'T-Bone Steak', '🥩',
   'Bone-in cut, sear and rest', 1,
   14,
   'Bring steak to room temp (20 min). Pat dry, salt generously. Heat cast-iron over high until smoking. Sear 4 min per side, then 2 min on the bone edge. Baste with butter, thyme, garlic for the last min. Rest 5–8 min before slicing.',
   NULL, 300, 'g')
ON CONFLICT (id) DO NOTHING;

-- Chicken variants
INSERT INTO public.sauceboss_items (
  id, category, parent_id, name, emoji, description, sort_order,
  cook_time_minutes, instructions, water_ratio, portion_per_person, portion_unit
) VALUES
  ('chicken-breast', 'protein', 'chicken', 'Breast', '🍗',
   'Lean white meat, quick cooking', 0,
   18,
   'Pat dry, season both sides with salt, pepper, paprika. Heat 1 tbsp oil over medium-high. Cook 6–7 min per side until internal temp reaches 74°C / 165°F. Rest 5 min before slicing against the grain.',
   NULL, 150, 'g'),
  ('chicken-thighs', 'protein', 'chicken', 'Thighs', '🍗',
   'Dark meat, more forgiving and richer', 1,
   25,
   'Pat dry, season skin-side and underside. Heat 1 tbsp oil over medium. Place skin-side down, cook 8–10 min undisturbed until skin is crisp. Flip, cook 6–8 min more until internal temp 74°C / 165°F. Rest 3 min.',
   NULL, 180, 'g')
ON CONFLICT (id) DO NOTHING;

-- Tofu variants
INSERT INTO public.sauceboss_items (
  id, category, parent_id, name, emoji, description, sort_order,
  cook_time_minutes, instructions, water_ratio, portion_per_person, portion_unit
) VALUES
  ('tofu-silken', 'protein', 'tofu', 'Silken', '🧈',
   'Soft custard texture, best in soups and sauces', 0,
   5,
   'Drain gently. Slide cubes into hot broth or sauce in the last 3–5 min of cooking. Do not stir aggressively — silken tofu breaks apart easily.',
   NULL, 150, 'g'),
  ('tofu-firm', 'protein', 'tofu', 'Firm', '🧈',
   'Holds shape; good for stir-fry and grilling', 1,
   28,
   'Press 20 min between paper towels with a weight to remove water. Cube. Toss with cornstarch, salt. Pan-fry in 2 tbsp oil over medium-high, 2–3 min per side until each face is golden and crisp.',
   NULL, 150, 'g'),
  ('tofu-extra-firm', 'protein', 'tofu', 'Extra-Firm', '🧈',
   'Densest, holds shape on grill or in stir-fry', 2,
   30,
   'Press 15 min (less water than firm). Slice into planks or large cubes. Brush with oil and marinade. Sear in a hot pan 3–4 min per side, or grill 4 min per side. Finish with sauce off-heat.',
   NULL, 150, 'g')
ON CONFLICT (id) DO NOTHING;
