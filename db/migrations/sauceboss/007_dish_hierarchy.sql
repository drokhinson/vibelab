-- ─────────────────────────────────────────────────────────────────────────────
-- sauceboss — 3-level dish hierarchy (category → dish → subtype)
--
-- Adds:
--   * sauceboss_items.dish_level  — explicit level marker. 'dish' for top
--     rows under a category (e.g. Rice, Bread, Chicken, Romaine); 'subtype'
--     for leaf rows nested under a dish (e.g. Basmati under Rice, Pretzel
--     under Bread).
--   * sauceboss_items_dish_level_check trigger — enforces:
--       dish    ⇒ parent_id IS NULL
--       subtype ⇒ parent.dish_level = 'dish' (no subtype-of-subtype)
--
-- Backfill: today's two-level world maps 1:1. Rows with parent_id IS NULL
-- become 'dish'; rows with parent_id IS NOT NULL become 'subtype'. No data
-- moves; no FKs change. Sauces stay attached to their existing item ids
-- (which are now 'dish' rows) — migration 008 will widen attachment to
-- category and subtype as well.
--
-- Read RPCs (get_sauceboss_initial_load / get_sauceboss_items_by_category /
-- get_sauceboss_variants_for_item / get_sauceboss_item_load) are NOT
-- changed here — migration 008 reworks them to expose dishLevel + the new
-- attachments table together so the frontend sees one consistent shape.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1) Column ─────────────────────────────────────────────────────────────────
ALTER TABLE public.sauceboss_items
  ADD COLUMN IF NOT EXISTS dish_level TEXT NOT NULL DEFAULT 'dish'
    CHECK (dish_level IN ('dish', 'subtype'));

-- Backfill for existing rows. New rows inherit the 'dish' default.
UPDATE public.sauceboss_items
   SET dish_level = 'subtype'
 WHERE parent_id IS NOT NULL
   AND dish_level <> 'subtype';


-- ── 2) Indexes ────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS sauceboss_items_type_by_category_idx;
DROP INDEX IF EXISTS sauceboss_items_variants_by_parent_idx;

CREATE INDEX IF NOT EXISTS sauceboss_items_by_category_level_idx
  ON public.sauceboss_items (category, dish_level);

CREATE INDEX IF NOT EXISTS sauceboss_items_subtypes_by_parent_idx
  ON public.sauceboss_items (parent_id)
  WHERE dish_level = 'subtype';


-- ── 3) Trigger: dish_level ↔ parent_id consistency ────────────────────────────
CREATE OR REPLACE FUNCTION public.sauceboss_items_dish_level_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_parent_level TEXT;
BEGIN
  IF NEW.dish_level = 'dish' THEN
    IF NEW.parent_id IS NOT NULL THEN
      RAISE EXCEPTION 'sauceboss_items: dish row % cannot have parent_id (got %)',
        NEW.id, NEW.parent_id;
    END IF;
    RETURN NEW;
  END IF;

  -- subtype: must point at a dish-level parent
  IF NEW.parent_id IS NULL THEN
    RAISE EXCEPTION 'sauceboss_items: subtype row % requires parent_id', NEW.id;
  END IF;

  SELECT dish_level INTO v_parent_level
    FROM public.sauceboss_items
   WHERE id = NEW.parent_id;

  IF v_parent_level IS DISTINCT FROM 'dish' THEN
    RAISE EXCEPTION 'sauceboss_items: subtype % must point at a dish-level parent (parent % is %)',
      NEW.id, NEW.parent_id, COALESCE(v_parent_level, '<missing>');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sauceboss_items_dish_level_check_trg ON public.sauceboss_items;
CREATE TRIGGER sauceboss_items_dish_level_check_trg
  BEFORE INSERT OR UPDATE OF dish_level, parent_id ON public.sauceboss_items
  FOR EACH ROW EXECUTE FUNCTION public.sauceboss_items_dish_level_check();
