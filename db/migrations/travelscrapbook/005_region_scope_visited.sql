-- ─────────────────────────────────────────────────────────────────────────────
-- travelscrapbook — region tags, trip geographic scope, visited state
--
-- 1. places.region — a third location tier (admin-1: state / province / named
--    region, e.g. Tuscany / Hokkaido / California), auto-populated from the
--    Nominatim geocode on import (address.state). No manual tagging required.
-- 2. trips.scope_level + dest_city/dest_region/dest_country — a trip's
--    geographic scope. The user picks the level (city|country|region); the
--    match values are derived from geocoding the destination. Scope drives
--    tag-based auto-staging and the "from your wishlist" candidates panel.
--    Legacy trips default to 'city' → identical 100 km distance behavior.
-- 3. scraps.visited_at — soft "been there" timestamp (NULL = want to go), in
--    the codebase's _at soft-flag convention (revoked_at, last_used_at).
--    Visited scraps leave the wishlist and surface in the Visited view.
--
-- Columns on already-granted, service-role-only tables — no new GRANT/RLS
-- needed (mirrors 003_anchor_type_and_stay_date.sql). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Region on the canonical place.
ALTER TABLE public.travelscrapbook_places
  ADD COLUMN IF NOT EXISTS region TEXT;

-- 2. Trip geographic scope + derived destination components.
ALTER TABLE public.travelscrapbook_trips
  ADD COLUMN IF NOT EXISTS scope_level TEXT NOT NULL DEFAULT 'city'
    CHECK (scope_level IN ('region', 'country', 'city')),
  ADD COLUMN IF NOT EXISTS dest_city    TEXT,
  ADD COLUMN IF NOT EXISTS dest_region  TEXT,
  ADD COLUMN IF NOT EXISTS dest_country TEXT;

-- Backfill dest_* for existing geocoded trips by re-arming the lazy geocode
-- backfill (Nominatim is HTTP — can't run from SQL). The backend's
-- _backfill_trip_geocodes re-geocodes on the next /trips load and now records
-- the address components (and infers scope_level from addresstype).
UPDATE public.travelscrapbook_trips
  SET destination_geocoded_at = NULL
  WHERE destination IS NOT NULL AND dest_country IS NULL;

-- 3. Visited state on the scrap (NULL = still on the wishlist).
ALTER TABLE public.travelscrapbook_scraps
  ADD COLUMN IF NOT EXISTS visited_at TIMESTAMPTZ;

-- Wishlist/visited splits query scraps by (user_id, status, visited_at); the
-- existing idx_ts_scraps_user_status covers the status prefix.
CREATE INDEX IF NOT EXISTS idx_ts_scraps_user_visited
  ON public.travelscrapbook_scraps(user_id, visited_at);
