-- ─────────────────────────────────────────────────────────────────────────────
-- SauceBoss — backfill sauceboss_items from legacy tables
-- Order matters: insert Type rows (carbs/proteins/salads) BEFORE their Variant
-- rows (carb_preparations) since variants reference parent_id.
--
-- Per the plan:
--   • Carbs:        category='carb',    parent_id NULL.
--                   Existing portion_per_person / portion_unit preserved.
--                   cook_time_label is discarded (UI formats minutes now).
--   • Carb preps:   parent_id = carb.id, category='carb'.
--                   Inherit portion fields from parent carb.
--                   Legacy TEXT cook_time is discarded.
--   • Proteins:     category='protein', parent_id NULL.
--                   Default portion 150g/person; only type='protein' migrates
--                   (veggie addons are dropped).
--   • Salad bases:  category='salad',   parent_id NULL.
--                   Default portion 80g/person, no cook time.
-- ─────────────────────────────────────────────────────────────────────────────

-- Carbs (Type rows)
INSERT INTO public.sauceboss_items (
  id, category, parent_id, name, emoji, description, sort_order,
  cook_time_minutes, instructions, water_ratio, portion_per_person, portion_unit
)
SELECT
  c.id,
  'carb',
  NULL,
  c.name,
  c.emoji,
  c.description,
  0,
  c.cook_time_minutes,
  NULL,
  NULL,
  c.portion_per_person,
  c.portion_unit
FROM public.sauceboss_carbs c
ON CONFLICT (id) DO NOTHING;

-- Carb preparations (Variant rows; reference parent carb)
INSERT INTO public.sauceboss_items (
  id, category, parent_id, name, emoji, description, sort_order,
  cook_time_minutes, instructions, water_ratio, portion_per_person, portion_unit
)
SELECT
  p.id,
  'carb',
  p.carb_id,
  p.name,
  COALESCE(p.emoji, ''),
  '',
  COALESCE(p.sort_order, 0),
  p.cook_time_minutes,
  p.instructions,
  p.water_ratio,
  parent.portion_per_person,
  parent.portion_unit
FROM public.sauceboss_carb_preparations p
JOIN public.sauceboss_carbs parent ON parent.id = p.carb_id
ON CONFLICT (id) DO NOTHING;

-- Proteins (only addons.type='protein'; veggies are dropped)
INSERT INTO public.sauceboss_items (
  id, category, parent_id, name, emoji, description, sort_order,
  cook_time_minutes, instructions, water_ratio, portion_per_person, portion_unit
)
SELECT
  a.id,
  'protein',
  NULL,
  a.name,
  a.emoji,
  a.description,
  COALESCE(a.sort_order, 0),
  a.estimated_time,
  a.instructions,
  NULL,
  150,
  'g'
FROM public.sauceboss_addons a
WHERE a.type = 'protein'
ON CONFLICT (id) DO NOTHING;

-- Salad bases (Type rows; default portion 80g/person, no cook time)
INSERT INTO public.sauceboss_items (
  id, category, parent_id, name, emoji, description, sort_order,
  cook_time_minutes, instructions, water_ratio, portion_per_person, portion_unit
)
SELECT
  b.id,
  'salad',
  NULL,
  b.name,
  b.emoji,
  COALESCE(b.description, ''),
  0,
  NULL,
  NULL,
  NULL,
  80,
  'g'
FROM public.sauceboss_salad_bases b
ON CONFLICT (id) DO NOTHING;
