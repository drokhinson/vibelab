-- ─────────────────────────────────────────────────────────────────────────────
-- sauceboss — add 'dip' sauce type ("Dip n' Spread")
--
-- Pairs with category=carb (bread, crackers, pretzels, etc.). Same pairing
-- rules as the existing 'sauce' type, just a different label and a different
-- chip in the recipe builder.
--
-- Updates:
--   * sauceboss_sauces.sauce_type CHECK — allow 'dip'.
--   * sauceboss_type_to_category() — map 'dip' → 'carb' so the attachments
--     trigger from migration 008 accepts dip-type sauces paired with carbs.
--   * Drop legacy sauceboss_sauce_items_check trigger — the new attachments
--     trigger is the single source of truth for type/category alignment, and
--     the legacy one wouldn't have allowed 'dip' anyway.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1) Allow 'dip' on sauceboss_sauces.sauce_type ─────────────────────────────
ALTER TABLE public.sauceboss_sauces
  DROP CONSTRAINT IF EXISTS sauceboss_sauces_sauce_type_check;

ALTER TABLE public.sauceboss_sauces
  ADD CONSTRAINT sauceboss_sauces_sauce_type_check
    CHECK (sauce_type IN ('sauce', 'dressing', 'marinade', 'dip'));


-- ── 2) Update type→category map to include 'dip' ──────────────────────────────
CREATE OR REPLACE FUNCTION public.sauceboss_type_to_category(p_sauce_type TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE p_sauce_type
    WHEN 'sauce'    THEN 'carb'
    WHEN 'dip'      THEN 'carb'
    WHEN 'marinade' THEN 'protein'
    WHEN 'dressing' THEN 'salad'
    ELSE NULL
  END;
$$;


-- ── 3) Retire the legacy sauce_items trigger ──────────────────────────────────
-- Replaced by sauceboss_sauce_attachments_check_trg (migration 008). The
-- legacy table stays as a read-only mirror until Native is migrated.
DROP TRIGGER IF EXISTS sauceboss_sauce_items_check_trg ON public.sauceboss_sauce_items;
DROP FUNCTION IF EXISTS public.sauceboss_sauce_items_check();
