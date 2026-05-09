-- ─────────────────────────────────────────────────────────────────────────────
-- 013_user_plants.sql
-- Plant Library — top-level "My Plants" view, peer to "My Gardens".
--
-- Each row tracks ONE user's relationship to ONE species. Three statuses:
--   wishlist — user wants the plant; doesn't own it yet
--   current  — user owns the plant
--   former   — user used to own the plant (explicitly demoted by the user)
--
-- Auto-population hooks (in garden_routes.py):
--   • PUT /gardens/{id} with shortlist_plant_cache_ids → INSERT wishlist rows
--     (ON CONFLICT DO NOTHING — never overwrite existing status)
--   • PUT /gardens/{id}/plants on placement save       → UPSERT current rows
--     (always promote up; never demote)
--
-- Planter membership ("In: Tomato Garden") is computed live by joining
-- plantplanner_garden_plants. NEVER stored on this row.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.plantplanner_user_plants (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES public.plantplanner_profiles(id) ON DELETE CASCADE,
  plant_cache_id  UUID        NOT NULL REFERENCES public.plantplanner_plant_cache(id),
  status          TEXT        NOT NULL DEFAULT 'wishlist'
                  CHECK (status IN ('current', 'former', 'wishlist')),
  quantity        INT         NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  notes           TEXT,
  acquired_at     DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, plant_cache_id)
);

CREATE INDEX IF NOT EXISTS plantplanner_user_plants_user_status_idx
  ON public.plantplanner_user_plants (user_id, status);

CREATE INDEX IF NOT EXISTS plantplanner_user_plants_cache_idx
  ON public.plantplanner_user_plants (plant_cache_id);

ALTER TABLE public.plantplanner_user_plants ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.plantplanner_user_plants TO plantplanner_role;
