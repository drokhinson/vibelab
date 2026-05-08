-- ─────────────────────────────────────────────────────────────────────────────
-- 008_real_radius_placement.sql — Iteration 3.
-- Replaces the (grid_x INT, grid_y INT, UNIQUE per cell) placement model with
-- continuous (pos_x REAL, pos_y REAL, radius_feet REAL) floats. Overlap is
-- allowed (UI surfaces a "crowded" warning chip). Existing user placements
-- are wiped per the disposability decision documented in 004.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DROP TABLE IF EXISTS public.plantplanner_garden_plants CASCADE;

CREATE TABLE public.plantplanner_garden_plants (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  garden_id    UUID    NOT NULL REFERENCES public.plantplanner_gardens(id) ON DELETE CASCADE,
  plant_id     UUID    NOT NULL REFERENCES public.plantplanner_plants(id),
  pos_x        REAL    NOT NULL,                 -- feet, 0 ≤ pos_x ≤ garden.grid_width
  pos_y        REAL    NOT NULL,                 -- feet, 0 ≤ pos_y ≤ garden.grid_height
  radius_feet  REAL    NOT NULL DEFAULT 0.5,     -- denormalized from plant.spread_inches/24 at save time
  CHECK (pos_x >= 0 AND pos_y >= 0),
  CHECK (radius_feet > 0)
);
CREATE INDEX idx_plantplanner_garden_plants_garden
  ON public.plantplanner_garden_plants(garden_id);
ALTER TABLE public.plantplanner_garden_plants ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.plantplanner_garden_plants TO plantplanner_role;

COMMIT;
