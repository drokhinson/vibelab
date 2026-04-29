-- ─────────────────────────────────────────────────────────────────────────────
-- SauceBoss — unified items table
-- Replaces the four parallel selector tables (carbs, addons, salad_bases,
-- carb_preparations) with one. Type rows have parent_id IS NULL; Variant rows
-- (e.g. basmati rice as a variant of rice) point at their Type via parent_id.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sauceboss_items (
  id                 TEXT PRIMARY KEY,
  category           TEXT NOT NULL CHECK (category IN ('carb', 'protein', 'salad')),
  parent_id          TEXT REFERENCES public.sauceboss_items(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  emoji              TEXT NOT NULL DEFAULT '',
  description        TEXT NOT NULL DEFAULT '',
  sort_order         INT  NOT NULL DEFAULT 0,
  cook_time_minutes  INT,
  instructions       TEXT,
  water_ratio        TEXT,
  portion_per_person REAL NOT NULL,
  portion_unit       TEXT NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id)
);

ALTER TABLE public.sauceboss_items ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS sauceboss_items_type_by_category_idx
  ON public.sauceboss_items(category)
  WHERE parent_id IS NULL;

CREATE INDEX IF NOT EXISTS sauceboss_items_variants_by_parent_idx
  ON public.sauceboss_items(parent_id)
  WHERE parent_id IS NOT NULL;
