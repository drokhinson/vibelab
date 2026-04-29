-- ─────────────────────────────────────────────────────────────────────────────
-- SauceBoss — drop legacy selector tables, junctions, and RPCs
--
-- Run AFTER 050–054 are applied AND the backend + frontend cutover (commit
-- containing the public_routes.py / admin_routes.py / helpers.js changes) has
-- been deployed and verified live. The cutover code reads exclusively from
-- sauceboss_items and sauceboss_sauce_items; running this migration before
-- it ships will break the live app.
--
-- Verification before running:
--   SELECT category, count(*) FROM sauceboss_items GROUP BY category;
--   -- expect carb count = (carbs + carb_preparations), protein count =
--   -- (addons WHERE type='protein'), salad count = salad_bases
--   SELECT count(*) FROM sauceboss_sauce_items;
--   -- expect (sauce_carbs + sauce_proteins-where-protein + sauce_salad_bases)
-- ─────────────────────────────────────────────────────────────────────────────

-- Legacy combined-load + per-category RPCs
DROP FUNCTION IF EXISTS public.get_sauceboss_carb_load(TEXT);
DROP FUNCTION IF EXISTS public.get_sauceboss_protein_load(TEXT);
DROP FUNCTION IF EXISTS public.get_sauceboss_salad_base_load(TEXT);
DROP FUNCTION IF EXISTS public.get_sauceboss_sauces_for_carb(TEXT);
DROP FUNCTION IF EXISTS public.get_sauceboss_marinades_for_protein(TEXT);
DROP FUNCTION IF EXISTS public.get_sauceboss_dressings_for_base(TEXT);
DROP FUNCTION IF EXISTS public.get_sauceboss_ingredients_for_carb(TEXT);
DROP FUNCTION IF EXISTS public.get_sauceboss_ingredients_for_protein(TEXT);
DROP FUNCTION IF EXISTS public.get_sauceboss_ingredients_for_base(TEXT);
DROP FUNCTION IF EXISTS public.get_sauceboss_carb_preparations(TEXT);
DROP FUNCTION IF EXISTS public.get_sauceboss_carbs_with_count();
DROP FUNCTION IF EXISTS public.get_sauceboss_salad_bases_with_count();
DROP FUNCTION IF EXISTS public.get_sauceboss_proteins();
DROP FUNCTION IF EXISTS public.get_sauceboss_addons();

-- Legacy junction tables (drop BEFORE the type tables they reference)
DROP TABLE IF EXISTS public.sauceboss_sauce_carbs;
DROP TABLE IF EXISTS public.sauceboss_sauce_proteins;
DROP TABLE IF EXISTS public.sauceboss_sauce_salad_bases;

-- Legacy type/variant tables
DROP TABLE IF EXISTS public.sauceboss_carb_preparations;
DROP TABLE IF EXISTS public.sauceboss_carbs;
DROP TABLE IF EXISTS public.sauceboss_addons;
DROP TABLE IF EXISTS public.sauceboss_salad_bases;
