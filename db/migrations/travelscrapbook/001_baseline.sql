-- ─────────────────────────────────────────────────────────────────────────────
-- travelscrapbook — baseline
-- Travel Scrapbook: save URLs to trips, AI-extract the place, geocode it,
-- and sort trips into optimized routes.
-- All access is backend-only via service role (no Data API grants, no RPCs).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Project role ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'travelscrapbook_role') THEN
    CREATE ROLE travelscrapbook_role LOGIN PASSWORD 'change-me-via-shared-003' NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO travelscrapbook_role;


-- ── Profiles (linked to Supabase Auth) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.travelscrapbook_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.travelscrapbook_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.travelscrapbook_profiles TO travelscrapbook_role;


-- ── Categories (seeded option set; see 002_seed.sql) ─────────────────────────
-- icon is a sprite slug: the web app renders
-- assets/sprites/categories/travel-scrapbook-cat-<icon>.svg (custom SVG art,
-- never emoji — see .claude/rules/assets.md).
CREATE TABLE IF NOT EXISTS public.travelscrapbook_categories (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  icon TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);
ALTER TABLE public.travelscrapbook_categories ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.travelscrapbook_categories TO travelscrapbook_role;


-- ── Trips ────────────────────────────────────────────────────────────────────
-- cover_icon is a sprite slug: assets/sprites/covers/travel-scrapbook-cover-<slug>.svg
CREATE TABLE IF NOT EXISTS public.travelscrapbook_trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  destination TEXT,
  cover_icon TEXT NOT NULL DEFAULT 'plane',
  start_date DATE,
  end_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ts_trips_user ON public.travelscrapbook_trips(user_id);
ALTER TABLE public.travelscrapbook_trips ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.travelscrapbook_trips TO travelscrapbook_role;


-- ── Anchors (route endpoints and stays) ──────────────────────────────────────
-- role='start'/'end' pin the route's endpoints (e.g. arrival/departure airport);
-- role='stay' marks lodging (hotel/Airbnb) that can seed the route when no
-- explicit start exists. At most one start and one end per trip.
CREATE TABLE IF NOT EXISTS public.travelscrapbook_anchors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES public.travelscrapbook_trips(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('start', 'end', 'stay')),
  label TEXT NOT NULL,
  query TEXT NOT NULL,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  geocode_confidence TEXT NOT NULL DEFAULT 'none'
    CHECK (geocode_confidence IN ('high', 'medium', 'low', 'none')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ts_anchors_trip ON public.travelscrapbook_anchors(trip_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ts_anchors_endpoint
  ON public.travelscrapbook_anchors(trip_id, role)
  WHERE role IN ('start', 'end');
ALTER TABLE public.travelscrapbook_anchors ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.travelscrapbook_anchors TO travelscrapbook_role;


-- ── Scraps (saved links) ─────────────────────────────────────────────────────
-- status lifecycle: pending (just created, enrichment queued) → ready | failed.
-- error_kind on failure: network | blocked | llm | geocode.
-- geocode_display_name stores Nominatim's resolved address so users can spot
-- mis-geocodes; route_position persists the last computed route order.
CREATE TABLE IF NOT EXISTS public.travelscrapbook_scraps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES public.travelscrapbook_trips(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_domain TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  error_kind TEXT,
  og_title TEXT,
  og_description TEXT,
  og_image_url TEXT,
  place_name TEXT,
  place_city TEXT,
  place_country TEXT,
  category TEXT NOT NULL DEFAULT 'other' REFERENCES public.travelscrapbook_categories(slug),
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  geocode_confidence TEXT NOT NULL DEFAULT 'none'
    CHECK (geocode_confidence IN ('high', 'medium', 'low', 'none')),
  geocode_display_name TEXT,
  maps_url TEXT,
  notes TEXT,
  is_favorite BOOLEAN NOT NULL DEFAULT false,
  route_position INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ts_scraps_trip ON public.travelscrapbook_scraps(trip_id);
CREATE INDEX IF NOT EXISTS idx_ts_scraps_user ON public.travelscrapbook_scraps(user_id);
ALTER TABLE public.travelscrapbook_scraps ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.travelscrapbook_scraps TO travelscrapbook_role;
