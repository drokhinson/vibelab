-- ─────────────────────────────────────────────────────────────────────────────
-- travelscrapbook — many-to-many scraps ↔ trips (013)
--
-- A scrap becomes "a user's saved place". Its membership in each trip — with
-- that trip's status (staged|approved), route_position, and timeline slot
-- (plan_date/plan_time) — moves to travelscrapbook_scrap_trips. Per-trip
-- "Vibes" re-home onto the membership. Owner fields (notes, rating, visited_at)
-- stay on the scrap.
--
-- This is the EXPAND phase: additive + backfill. The legacy scraps.trip_id /
-- status / route_position / plan_date / plan_time columns are LEFT in place
-- (the new backend stops using them) and dropped later in 014, so this migration
-- is a clean, reversible snapshot. The one non-additive step is swapping the
-- scrap_vibes uniqueness onto the membership (a scrap in >1 trip can't satisfy
-- the old UNIQUE(scrap_id,user_id)); deploy the new backend right after.
--
-- Service-role-only (backend uses SUPABASE_SERVICE_ROLE_KEY): RLS enabled with
-- no policies + SELECT granted to travelscrapbook_role (mirrors 007). Idempotent.
-- Depends on: 007 (scrap_vibes), 009 (plan_date/plan_time on scraps).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Membership join table (scrap ↔ trip), carrying per-trip state.
CREATE TABLE IF NOT EXISTS public.travelscrapbook_scrap_trips (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scrap_id       UUID        NOT NULL REFERENCES public.travelscrapbook_scraps(id) ON DELETE CASCADE,
  trip_id        UUID        NOT NULL REFERENCES public.travelscrapbook_trips(id)  ON DELETE CASCADE,
  status         TEXT        NOT NULL DEFAULT 'approved'
    CHECK (status IN ('staged', 'approved')),   -- no 'inbox': absence of a row = not in the trip
  route_position INTEGER,
  plan_date      DATE,
  plan_time      TIME,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scrap_id, trip_id)
);
CREATE INDEX IF NOT EXISTS idx_ts_scrap_trips_trip
  ON public.travelscrapbook_scrap_trips(trip_id, status);              -- trip detail / approve-all
CREATE INDEX IF NOT EXISTS idx_ts_scrap_trips_scrap
  ON public.travelscrapbook_scrap_trips(scrap_id);                     -- "which trips is this in"
CREATE INDEX IF NOT EXISTS idx_ts_scrap_trips_trip_plan_date
  ON public.travelscrapbook_scrap_trips(trip_id, plan_date);          -- timeline (replaces 009 idx)
ALTER TABLE public.travelscrapbook_scrap_trips ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.travelscrapbook_scrap_trips TO travelscrapbook_role;

-- 2. Backfill one membership per existing trip scrap (skip inbox = trip_id NULL).
INSERT INTO public.travelscrapbook_scrap_trips
  (scrap_id, trip_id, status, route_position, plan_date, plan_time, created_at)
SELECT s.id, s.trip_id,
       CASE WHEN s.status = 'staged' THEN 'staged' ELSE 'approved' END,
       s.route_position, s.plan_date, s.plan_time, s.created_at
FROM public.travelscrapbook_scraps s
WHERE s.trip_id IS NOT NULL
ON CONFLICT (scrap_id, trip_id) DO NOTHING;

-- 3. Trip deletion must NOT delete a place that lives in other trips or the
--    Wander List. Re-point the legacy FK from ON DELETE CASCADE to SET NULL.
--    (scrap_trips already CASCADEs the real memberships.)
ALTER TABLE public.travelscrapbook_scraps
  DROP CONSTRAINT IF EXISTS travelscrapbook_scraps_trip_id_fkey,
  ADD  CONSTRAINT travelscrapbook_scraps_trip_id_fkey
       FOREIGN KEY (trip_id) REFERENCES public.travelscrapbook_trips(id) ON DELETE SET NULL;

-- 4. Re-home vibes onto the membership. A vibe is an opinion about a place ON a
--    specific trip, so referencing the membership makes that a structural
--    invariant (and cascades cleanup when a membership is removed).
ALTER TABLE public.travelscrapbook_scrap_vibes
  ADD COLUMN IF NOT EXISTS scrap_trip_id UUID
    REFERENCES public.travelscrapbook_scrap_trips(id) ON DELETE CASCADE;

-- Each legacy scrap had exactly one trip, so the membership is unambiguous.
UPDATE public.travelscrapbook_scrap_vibes v
SET    scrap_trip_id = st.id
FROM   public.travelscrapbook_scrap_trips st
WHERE  st.scrap_id = v.scrap_id
  AND  v.scrap_trip_id IS NULL;

-- Defensive: drop any vibe that couldn't be mapped (vibe whose scrap had no trip).
DELETE FROM public.travelscrapbook_scrap_vibes WHERE scrap_trip_id IS NULL;

-- Swap uniqueness onto the membership. The old (scrap_id,user_id) unique is
-- incompatible with a scrap in >1 trip, so it must go.
ALTER TABLE public.travelscrapbook_scrap_vibes
  DROP CONSTRAINT IF EXISTS travelscrapbook_scrap_vibes_scrap_id_user_id_key;
ALTER TABLE public.travelscrapbook_scrap_vibes
  ALTER COLUMN scrap_trip_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ts_scrap_vibes_membership_user
  ON public.travelscrapbook_scrap_vibes(scrap_trip_id, user_id);
CREATE INDEX IF NOT EXISTS idx_ts_scrap_vibes_membership
  ON public.travelscrapbook_scrap_vibes(scrap_trip_id);
-- scrap_id kept (now nullable) one release as a rollback aid; dropped in 014.
ALTER TABLE public.travelscrapbook_scrap_vibes ALTER COLUMN scrap_id DROP NOT NULL;
