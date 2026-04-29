-- ─────────────────────────────────────────────────────────────────────────────
-- SauceBoss — backfill sauceboss_sauce_items from legacy junction tables
-- Run AFTER 052 (items must already exist for the FK to resolve).
-- Veggie addon links are dropped because veggies are not migrated to items.
-- The integrity trigger on sauce_items will validate sauce_type/category match
-- on each insert — if any pre-existing data violates the rule the migration
-- will fail loudly, which is the correct behavior.
-- ─────────────────────────────────────────────────────────────────────────────

-- Sauce ↔ carb
INSERT INTO public.sauceboss_sauce_items (sauce_id, item_id)
SELECT sc.sauce_id, sc.carb_id
FROM public.sauceboss_sauce_carbs sc
ON CONFLICT (sauce_id, item_id) DO NOTHING;

-- Marinade ↔ protein (skip rows whose addon was a veggie — those items don't exist)
INSERT INTO public.sauceboss_sauce_items (sauce_id, item_id)
SELECT sp.sauce_id, sp.addon_id
FROM public.sauceboss_sauce_proteins sp
JOIN public.sauceboss_addons a ON a.id = sp.addon_id
WHERE a.type = 'protein'
ON CONFLICT (sauce_id, item_id) DO NOTHING;

-- Dressing ↔ salad base
INSERT INTO public.sauceboss_sauce_items (sauce_id, item_id)
SELECT ssb.sauce_id, ssb.base_id
FROM public.sauceboss_sauce_salad_bases ssb
ON CONFLICT (sauce_id, item_id) DO NOTHING;
