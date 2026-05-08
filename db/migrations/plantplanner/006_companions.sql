-- ─────────────────────────────────────────────────────────────────────────────
-- plantplanner — companion-planting relationships (iteration 2).
-- Adds plantplanner_companions and a settings_json bag on plantplanner_gardens.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE public.plantplanner_companions (
  id           BIGSERIAL  PRIMARY KEY,
  plant_a_id   UUID       NOT NULL REFERENCES public.plantplanner_plants(id) ON DELETE CASCADE,
  plant_b_id   UUID       NOT NULL REFERENCES public.plantplanner_plants(id) ON DELETE CASCADE,
  relationship TEXT       NOT NULL CHECK (relationship IN ('good','bad','neutral')),
  reason       TEXT       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT plantplanner_companions_ordered CHECK (plant_a_id < plant_b_id),
  CONSTRAINT plantplanner_companions_unique  UNIQUE (plant_a_id, plant_b_id)
);

CREATE INDEX IF NOT EXISTS plantplanner_companions_a_idx ON public.plantplanner_companions(plant_a_id);

CREATE INDEX IF NOT EXISTS plantplanner_companions_b_idx ON public.plantplanner_companions(plant_b_id);

ALTER TABLE public.plantplanner_companions ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.plantplanner_companions TO plantplanner_role;

ALTER TABLE public.plantplanner_gardens ADD COLUMN IF NOT EXISTS settings_json jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
