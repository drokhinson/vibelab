-- Add quantifiable flag to sauceboss_unit + "splash" unit.
--
-- quantifiable = FALSE means the ingredient has no meaningful numeric amount
-- (like "to taste" or "a splash") — the builder disables the amount field,
-- the pie chart excludes it, and the legend shows the unit name instead of a
-- quantity.

ALTER TABLE public.sauceboss_unit
  ADD COLUMN quantifiable BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE public.sauceboss_unit SET quantifiable = FALSE WHERE id = 'to_taste';

INSERT INTO public.sauceboss_unit
  (id, name, plural, abbreviation, plural_abbreviation, dimension, ml_per_unit, g_per_unit, aliases, quantifiable)
VALUES
  ('splash', 'splash', 'splashes', 'splash', 'splashes', 'count', NULL, NULL, ARRAY['splash','splashes'], FALSE);

GRANT SELECT ON public.sauceboss_unit TO sauceboss_role;
