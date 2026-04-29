-- ─────────────────────────────────────────────────────────────────────────────
-- SauceBoss — unified sauce↔item junction
-- Replaces the three parallel junction tables (sauce_carbs, sauce_proteins,
-- sauce_salad_bases). A trigger enforces:
--   • sauce.sauce_type matches item.category
--       sauce    ↔ carb
--       marinade ↔ protein
--       dressing ↔ salad
--   • item.parent_id IS NULL — sauces link to Type rows, never Variant rows
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sauceboss_sauce_items (
  sauce_id TEXT NOT NULL REFERENCES public.sauceboss_sauces(id) ON DELETE CASCADE,
  item_id  TEXT NOT NULL REFERENCES public.sauceboss_items(id)  ON DELETE CASCADE,
  PRIMARY KEY (sauce_id, item_id)
);

ALTER TABLE public.sauceboss_sauce_items ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS sauceboss_sauce_items_by_item_idx
  ON public.sauceboss_sauce_items(item_id);

-- Integrity trigger: keep sauce_type / category aligned and reject variant links.
CREATE OR REPLACE FUNCTION public.sauceboss_sauce_items_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_type TEXT;
  v_category   TEXT;
  v_parent_id  TEXT;
BEGIN
  SELECT sauce_type INTO v_sauce_type
  FROM public.sauceboss_sauces
  WHERE id = NEW.sauce_id;

  SELECT category, parent_id INTO v_category, v_parent_id
  FROM public.sauceboss_items
  WHERE id = NEW.item_id;

  IF v_parent_id IS NOT NULL THEN
    RAISE EXCEPTION 'sauceboss_sauce_items: item % is a Variant (parent_id=%); sauces must link to Type rows only',
      NEW.item_id, v_parent_id;
  END IF;

  IF (v_sauce_type = 'sauce'    AND v_category <> 'carb')    OR
     (v_sauce_type = 'marinade' AND v_category <> 'protein') OR
     (v_sauce_type = 'dressing' AND v_category <> 'salad') THEN
    RAISE EXCEPTION 'sauceboss_sauce_items: sauce_type=% does not match item.category=% (sauce=%, item=%)',
      v_sauce_type, v_category, NEW.sauce_id, NEW.item_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sauceboss_sauce_items_check_trg ON public.sauceboss_sauce_items;
CREATE TRIGGER sauceboss_sauce_items_check_trg
  BEFORE INSERT OR UPDATE ON public.sauceboss_sauce_items
  FOR EACH ROW EXECUTE FUNCTION public.sauceboss_sauce_items_check();
