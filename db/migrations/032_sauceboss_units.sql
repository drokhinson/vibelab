-- Migration 032: SauceBoss units reference table
-- Canonical unit definitions with type classification and metric conversion factors.
-- Enables backend-side metric toggle and URL import unit resolution.

CREATE TABLE IF NOT EXISTS public.sauceboss_units (
  abbreviation  TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  unit_type     TEXT NOT NULL CHECK (unit_type IN ('volume', 'weight', 'count')),
  standard_unit TEXT NOT NULL,   -- Pint-compatible unit name
  to_ml         REAL,            -- NULL for weight/count units
  to_g          REAL             -- NULL for volume/count units
);

ALTER TABLE public.sauceboss_units ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read sauceboss_units"
  ON public.sauceboss_units FOR SELECT USING (true);

INSERT INTO public.sauceboss_units (abbreviation, display_name, unit_type, standard_unit, to_ml, to_g) VALUES
  ('tsp',    'teaspoon',    'volume', 'teaspoon',    5.0,   NULL),
  ('tbsp',   'tablespoon',  'volume', 'tablespoon',  15.0,  NULL),
  ('cup',    'cup',         'volume', 'cup',         240.0, NULL),
  ('oz',     'fluid ounce', 'volume', 'fluid_ounce', 29.6,  NULL),
  ('ml',     'milliliter',  'volume', 'milliliter',  1.0,   NULL),
  ('g',      'gram',        'weight', 'gram',        NULL,  1.0),
  ('clove',  'clove',       'count',  'clove',       NULL,  NULL),
  ('cloves', 'cloves',      'count',  'clove',       NULL,  NULL),
  ('piece',  'piece',       'count',  'piece',       NULL,  NULL),
  ('pieces', 'pieces',      'count',  'piece',       NULL,  NULL),
  ('pinch',  'pinch',       'count',  'pinch',       NULL,  NULL)
ON CONFLICT (abbreviation) DO NOTHING;
