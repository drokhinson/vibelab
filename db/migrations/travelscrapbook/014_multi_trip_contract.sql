-- ─────────────────────────────────────────────────────────────────────────────
-- travelscrapbook — multi-trip CONTRACT phase (014)
--
-- Drops the legacy single-trip columns that 013 moved to
-- travelscrapbook_scrap_trips, plus the now-unused scrap_vibes.scrap_id.
--
-- DO NOT RUN until 013 + the multi-trip backend have soaked in production and
-- you no longer need the legacy columns as a rollback aid. Running this while
-- old backend code is live WILL break it. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- Vibes now key on scrap_trip_id; the old scrap_id column + index are dead.
DROP INDEX IF EXISTS idx_ts_scrap_vibes_scrap;
ALTER TABLE public.travelscrapbook_scrap_vibes DROP COLUMN IF EXISTS scrap_id;

-- The five moved scrap columns + their now-superseded indexes.
DROP INDEX IF EXISTS idx_ts_scraps_trip;                 -- (trip_id) — column dropped below
DROP INDEX IF EXISTS idx_ts_scraps_user_status;          -- (user_id, status) — status dropped
DROP INDEX IF EXISTS idx_travelscrapbook_scraps_trip_plan_date;  -- 009 timeline idx, superseded

ALTER TABLE public.travelscrapbook_scraps
  DROP COLUMN IF EXISTS trip_id,        -- also removes the ON DELETE SET NULL FK
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS route_position,
  DROP COLUMN IF EXISTS plan_date,
  DROP COLUMN IF EXISTS plan_time;
