-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 060 — SauceBoss: fish variants
-- Convert the standalone fish row (seeded in migration 013) into a generic
-- parent and seed preparation variants under it. Mirrors the pattern from
-- migration 058 (beef / chicken / tofu). Existing sauceboss_sauce_items
-- pairings stay attached at the parent level and apply to every variant.
-- ─────────────────────────────────────────────────────────────────────────────

-- Parent becomes generic (no cook info; variants carry cook details).
UPDATE public.sauceboss_items
   SET name = 'Fish',
       description = '',
       cook_time_minutes = NULL,
       instructions = NULL
 WHERE id = 'fish'
   AND parent_id IS NULL;

-- Fish variants
INSERT INTO public.sauceboss_items (
  id, category, parent_id, name, emoji, description, sort_order,
  cook_time_minutes, instructions, water_ratio, portion_per_person, portion_unit
) VALUES
  ('fish-white-fillet', 'protein', 'fish', 'White Fillet', '🐟',
   'Cod, haddock, or tilapia — quick pan-sear', 0,
   7,
   'Pat fillet dry, season both sides with salt and pepper. Heat 1 tbsp oil in a non-stick pan over medium-high until shimmering. Place skin-side down, press flat for 10 sec, then cook 4 min until skin is crisp. Flip and cook 2–3 min more until flesh flakes. Rest 1 min off heat.',
   NULL, 150, 'g'),
  ('fish-salmon', 'protein', 'fish', 'Salmon', '🐟',
   'Rich, oily fillet — sear skin then flip', 1,
   10,
   'Pat fillet dry, salt skin generously. Heat 1 tbsp oil in a heavy pan over medium-high. Place skin-side down, press flat for 15 sec, then cook 5–6 min until skin releases easily and is crisp. Flip and cook 2–3 min more for medium. Rest 2 min before plating.',
   NULL, 150, 'g'),
  ('fish-tuna-steak', 'protein', 'fish', 'Tuna Steak', '🐟',
   'Sear hot and fast — center stays rare', 2,
   4,
   'Bring tuna to room temp (15 min). Pat very dry, brush with oil and salt heavily on both sides. Heat a dry pan over high until smoking. Sear 1–2 min per side — the center should stay deep pink. Slice across the grain immediately.',
   NULL, 150, 'g'),
  ('fish-shrimp', 'protein', 'fish', 'Shrimp', '🦐',
   'Peeled and deveined, sauté over high heat', 3,
   5,
   'Pat shrimp dry, toss with salt, pepper, and 1 tbsp oil. Heat a wide pan over high heat until very hot. Add shrimp in a single layer, cook 1–2 min per side until pink, opaque, and curled into a C-shape. Do not overcook — they keep cooking off heat.',
   NULL, 150, 'g')
ON CONFLICT (id) DO NOTHING;
