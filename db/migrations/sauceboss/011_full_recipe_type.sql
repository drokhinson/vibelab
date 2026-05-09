-- ─────────────────────────────────────────────────────────────────────────────
-- sauceboss — add 'full_recipe' sauce type
--
-- Standalone recipes that aren't paired with any dish category. Saved by the
-- user as a marinara, soup, etc. Show up in Saucebook + Browse and can be
-- filtered by type, but never surface in the meal builder's category-driven
-- sauce list (the resolver matches on attachments, and full recipes have
-- none — sauceboss_sauce_attachments_check() rejects any insert for them).
--
-- Updates:
--   * sauceboss_sauces.sauce_type CHECK — allow 'full_recipe'.
--   * sauceboss_type_to_category() — return NULL for 'full_recipe' so the
--     attachment trigger has a single source of truth (no implicit category
--     map for unpaired types).
--   * sauceboss_sauce_attachments_check() — explicit error message when the
--     trigger fires on a full_recipe row, so the failure mode is obvious to
--     anyone (or any client) attempting to attach a dish to one.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1) Allow 'full_recipe' on sauceboss_sauces.sauce_type ─────────────────────
ALTER TABLE public.sauceboss_sauces
  DROP CONSTRAINT IF EXISTS sauceboss_sauces_sauce_type_check;

ALTER TABLE public.sauceboss_sauces
  ADD CONSTRAINT sauceboss_sauces_sauce_type_check
    CHECK (sauce_type IN ('sauce', 'dressing', 'marinade', 'dip', 'full_recipe'));


-- ── 2) Type→category map: full_recipe is unpaired ────────────────────────────
CREATE OR REPLACE FUNCTION public.sauceboss_type_to_category(p_sauce_type TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE p_sauce_type
    WHEN 'sauce'       THEN 'carb'
    WHEN 'dip'         THEN 'carb'
    WHEN 'marinade'    THEN 'protein'
    WHEN 'dressing'    THEN 'salad'
    WHEN 'full_recipe' THEN NULL  -- standalone; attachments rejected by trigger
    ELSE NULL
  END;
$$;


-- ── 3) Refine attachment trigger error for full_recipe ───────────────────────
-- Without the explicit branch the trigger would still reject (because
-- sauceboss_type_to_category returns NULL), but with the misleading message
-- "unknown sauce_type=full_recipe". This branch surfaces a clearer error.
CREATE OR REPLACE FUNCTION public.sauceboss_sauce_attachments_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_type   TEXT;
  v_expected_cat TEXT;
  v_item_cat     TEXT;
  v_item_level   TEXT;
BEGIN
  SELECT sauce_type INTO v_sauce_type
    FROM public.sauceboss_sauces
   WHERE id = NEW.sauce_id;

  IF v_sauce_type = 'full_recipe' THEN
    RAISE EXCEPTION 'sauceboss_sauce_attachments: full_recipe sauces are standalone and cannot have dish/category/subtype attachments (sauce=%, kind=%, value=%)',
      NEW.sauce_id, NEW.target_kind, NEW.target_value;
  END IF;

  v_expected_cat := public.sauceboss_type_to_category(v_sauce_type);
  IF v_expected_cat IS NULL THEN
    RAISE EXCEPTION 'sauceboss_sauce_attachments: unknown sauce_type=% on sauce %',
      v_sauce_type, NEW.sauce_id;
  END IF;

  IF NEW.target_kind = 'category' THEN
    IF NEW.target_value NOT IN ('carb','protein','salad') THEN
      RAISE EXCEPTION 'sauceboss_sauce_attachments: category target must be one of carb/protein/salad (got %)',
        NEW.target_value;
    END IF;
    IF NEW.target_value <> v_expected_cat THEN
      RAISE EXCEPTION 'sauceboss_sauce_attachments: sauce_type=% expects category=% (got %)',
        v_sauce_type, v_expected_cat, NEW.target_value;
    END IF;
    RETURN NEW;
  END IF;

  -- dish or subtype: look up the item
  SELECT category, dish_level INTO v_item_cat, v_item_level
    FROM public.sauceboss_items
   WHERE id = NEW.target_value;

  IF v_item_cat IS NULL THEN
    RAISE EXCEPTION 'sauceboss_sauce_attachments: unknown item % for kind=%',
      NEW.target_value, NEW.target_kind;
  END IF;

  IF v_item_level <> NEW.target_kind THEN
    RAISE EXCEPTION 'sauceboss_sauce_attachments: item % is dish_level=% but attachment kind=%',
      NEW.target_value, v_item_level, NEW.target_kind;
  END IF;

  IF v_item_cat <> v_expected_cat THEN
    RAISE EXCEPTION 'sauceboss_sauce_attachments: sauce_type=% expects category=% but item % is category=%',
      v_sauce_type, v_expected_cat, NEW.target_value, v_item_cat;
  END IF;

  RETURN NEW;
END;
$$;
