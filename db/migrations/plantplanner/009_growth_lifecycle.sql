-- ─────────────────────────────────────────────────────────────────────────────
-- 009_growth_lifecycle.sql — Iteration 5.
-- Adds `lifecycle` (annual|biennial|perennial) and `years_to_maturity` (1-5)
-- to plantplanner_plants for the year 1/2/3+ growth-preview feature. Additive
-- migration — uses ADD COLUMN IF NOT EXISTS so it's safe to re-run. Each of
-- the ~40 catalog rows gets explicit lifecycle/ytm via UPDATE.
-- ─────────────────────────────────────────────────────────────────────────────

-- Add columns
ALTER TABLE public.plantplanner_plants
  ADD COLUMN IF NOT EXISTS lifecycle TEXT NOT NULL DEFAULT 'perennial'
    CHECK (lifecycle IN ('annual','biennial','perennial')),
  ADD COLUMN IF NOT EXISTS years_to_maturity INT NOT NULL DEFAULT 3
    CHECK (years_to_maturity BETWEEN 1 AND 5);

-- Seed lifecycle / ytm per plant. Names must match 005_seed_enriched.sql exactly.
-- Annuals (full size every year):
UPDATE public.plantplanner_plants SET lifecycle='annual', years_to_maturity=1 WHERE name='Tomato';
UPDATE public.plantplanner_plants SET lifecycle='annual', years_to_maturity=1 WHERE name='Pepper';
UPDATE public.plantplanner_plants SET lifecycle='annual', years_to_maturity=1 WHERE name='Lettuce';
UPDATE public.plantplanner_plants SET lifecycle='annual', years_to_maturity=1 WHERE name='Carrot';
UPDATE public.plantplanner_plants SET lifecycle='annual', years_to_maturity=1 WHERE name='Basil';
UPDATE public.plantplanner_plants SET lifecycle='annual', years_to_maturity=1 WHERE name='Kale';
UPDATE public.plantplanner_plants SET lifecycle='annual', years_to_maturity=1 WHERE name='Bush Bean';
UPDATE public.plantplanner_plants SET lifecycle='annual', years_to_maturity=1 WHERE name='Zucchini';
UPDATE public.plantplanner_plants SET lifecycle='annual', years_to_maturity=1 WHERE name='Marigold';

-- Strawberry: short-lived perennial; mostly full by year 2
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=2 WHERE name='Strawberry';
-- Blueberry: slow-establishing
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=5 WHERE name='Blueberry';

-- Bulbs: full by year 2
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=2 WHERE name='Tulip';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=2 WHERE name='Daffodil';

-- Slow-establishing perennials:
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=5 WHERE name='False Indigo (Baptisia)';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=5 WHERE name='Peony';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=5 WHERE name='Joe Pye Weed';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=5 WHERE name='Hydrangea';

-- Woody herbs (3-year ramp):
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Lavender';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Rosemary';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Thyme';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Sage';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Mint';

-- Standard perennials (default ytm=3 catches the rest, but be explicit for the seeded list):
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Echinacea (Purple Coneflower)';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Black-Eyed Susan';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Butterfly Weed';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Bee Balm';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Blazing Star (Liatris)';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Goldenrod';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Wild Columbine';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Cardinal Flower';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Foxglove Beardtongue (Penstemon)';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='New England Aster';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Coral Bells (Heuchera)';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Garden Phlox';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Lance-Leaf Coreopsis';

-- Ornamentals (3-year):
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Hosta';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Daylily';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Salvia (Nemorosa)';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Catmint (Nepeta)';
UPDATE public.plantplanner_plants SET lifecycle='perennial', years_to_maturity=3 WHERE name='Yarrow (Achillea)';
