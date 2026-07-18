-- ─────────────────────────────────────────────────────────────────────────────
-- travelscrapbook — checkpoint (anchor) location fields (019)
--
-- Anchors (start/end/stay/travel checkpoints) stored only lat/lng — no
-- city/region/country. Manual checkpoint edits can now take a Google Maps URL
-- (parsed to itself, no AI) and every anchor's geocode already resolves these
-- fields, so persist + surface them, matching places.
--
-- Service-role-only (backend uses SUPABASE_SERVICE_ROLE_KEY): the anchors table
-- already has RLS + a role grant from its baseline; ADD COLUMN inherits both.
-- Idempotent. Depends on: 012 (travel_checkpoints / anchors).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.travelscrapbook_anchors
  ADD COLUMN IF NOT EXISTS city         TEXT,
  ADD COLUMN IF NOT EXISTS region       TEXT,   -- macro-region (UN subregion), derived from country_code
  ADD COLUMN IF NOT EXISTS country      TEXT,
  ADD COLUMN IF NOT EXISTS country_code TEXT,
  ADD COLUMN IF NOT EXISTS maps_url     TEXT;    -- user-pasted Google Maps link, when provided

COMMIT;
