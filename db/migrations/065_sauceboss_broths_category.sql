-- ─────────────────────────────────────────────────────────────────────────────
-- 065_sauceboss_broths_category.sql
--
-- Seeds common broths into sauceboss_ingredient_categories so they group under
-- the new "Broths" category in the filter panel. The frontend's CATEGORY_ORDER
-- (web/state.js) is updated in lockstep.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.sauceboss_ingredient_categories (ingredient_name, category) VALUES
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
