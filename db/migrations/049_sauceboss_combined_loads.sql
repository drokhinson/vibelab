-- ─────────────────────────────────────────────────────────────────────────────
-- SauceBoss — combined-load RPCs
-- Bundles multiple per-resource RPCs into a single round-trip per call so the
-- web client only needs one HTTP request on initial page load and one more
-- when the user picks a carb / protein / salad base.
-- ─────────────────────────────────────────────────────────────────────────────

-- Initial-load: carbs + proteins + salad bases in one shot.
CREATE OR REPLACE FUNCTION public.get_sauceboss_initial_load()
RETURNS JSON
LANGUAGE SQL
STABLE
AS $$
  SELECT json_build_object(
    'carbs',      COALESCE((SELECT json_agg(c) FROM public.get_sauceboss_carbs_with_count() c), '[]'::json),
    'proteins',   COALESCE((SELECT json_agg(p) FROM public.get_sauceboss_proteins() p),         '[]'::json),
    'saladBases', COALESCE((SELECT json_agg(b) FROM public.get_sauceboss_salad_bases_with_count() b), '[]'::json)
  );
$$;

-- Carb-load: sauces + ingredients + preparations for a given carb.
CREATE OR REPLACE FUNCTION public.get_sauceboss_carb_load(p_carb_id TEXT)
RETURNS JSON
LANGUAGE SQL
STABLE
AS $$
  SELECT json_build_object(
    'sauces',       COALESCE((SELECT json_agg(s) FROM public.get_sauceboss_sauces_for_carb(p_carb_id)      s), '[]'::json),
    'ingredients',  COALESCE((SELECT json_agg(i) FROM public.get_sauceboss_ingredients_for_carb(p_carb_id) i), '[]'::json),
    'preparations', COALESCE((SELECT json_agg(pr) FROM public.get_sauceboss_carb_preparations(p_carb_id)   pr), '[]'::json)
  );
$$;

-- Protein-load: marinades + ingredients for a given protein.
CREATE OR REPLACE FUNCTION public.get_sauceboss_protein_load(p_addon_id TEXT)
RETURNS JSON
LANGUAGE SQL
STABLE
AS $$
  SELECT json_build_object(
    'marinades',   COALESCE((SELECT json_agg(m) FROM public.get_sauceboss_marinades_for_protein(p_addon_id)  m), '[]'::json),
    'ingredients', COALESCE((SELECT json_agg(i) FROM public.get_sauceboss_ingredients_for_protein(p_addon_id) i), '[]'::json)
  );
$$;

-- Salad-base-load: dressings + ingredients for a given salad base.
CREATE OR REPLACE FUNCTION public.get_sauceboss_salad_base_load(p_base_id TEXT)
RETURNS JSON
LANGUAGE SQL
STABLE
AS $$
  SELECT json_build_object(
    'dressings',   COALESCE((SELECT json_agg(d) FROM public.get_sauceboss_dressings_for_base(p_base_id)  d), '[]'::json),
    'ingredients', COALESCE((SELECT json_agg(i) FROM public.get_sauceboss_ingredients_for_base(p_base_id) i), '[]'::json)
  );
$$;
