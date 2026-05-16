-- Normalize ingredient names + plurals to lowercase so casing variants
-- ("Jalapeño", "jalapeño", "JALAPEÑO") don't split into separate rows.
-- Display surfaces capitalize the first letter via
-- projects/sauceboss/shared/text.js#capitalizeIngredient.
--
-- name_normalized is already lowercase (CHECK constraint on the column);
-- this brings `name` and `plural` in line so the canonical row always
-- displays consistently. Step ingredients in sauceboss_sauce_step_ingredient
-- store `name` as a denormalized snapshot at save time — those rows are
-- lowercased here too so existing recipes inherit the new convention.

UPDATE public.sauceboss_ingredient
   SET name = lower(name),
       plural = lower(plural)
 WHERE name <> lower(name)
    OR (plural IS NOT NULL AND plural <> lower(plural));

UPDATE public.sauceboss_sauce_step_ingredient
   SET name = lower(name)
 WHERE name <> lower(name);
