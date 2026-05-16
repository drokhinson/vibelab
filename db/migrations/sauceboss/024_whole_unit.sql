-- Add a "whole" count-style unit and use it as the parser's default when an
-- ingredient line has a quantity but no recognizable unit ("2 jalapeños",
-- "3 medium eggs", etc.). The recipe parser now assigns this unit on import;
-- the builder also surfaces it in the unit chip row so users can pick it
-- manually for hand-entered ingredients.

INSERT INTO public.sauceboss_unit
  (id, name, plural, abbreviation, plural_abbreviation, dimension, ml_per_unit, g_per_unit, aliases, quantifiable)
VALUES
  ('whole', 'whole', 'whole', 'whole', 'whole', 'count', NULL, NULL,
   ARRAY['whole','wholes','unit','units'], TRUE)
ON CONFLICT (id) DO NOTHING;

GRANT SELECT ON public.sauceboss_unit TO sauceboss_role;
