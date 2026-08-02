-- ─────────────────────────────────────────────────────────────────────────────
-- tripguide — baseline
-- TripGuide: a generic trip-guide builder. An admin creates a trip (name,
-- description, color scheme) and populates it with ordered "stops" — cards that
-- each hold a name, a short description, and HTML content. Anyone can view;
-- create/edit/reorder/delete is gated by the shared vibelab admin code
-- (ADMIN_API_KEY) at the API layer.
-- All access is backend-only via the service role (no Data API grants, no RPCs).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Project role ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tripguide_role') THEN
    CREATE ROLE tripguide_role LOGIN PASSWORD 'change-me-via-shared-003' NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO tripguide_role;


-- ── Color schemes (seeded option set; see 002_seed.sql) ──────────────────────
-- palette is a JSONB object with keys: primary, bg, surface, text, accent, muted.
-- The web app applies these as CSS custom properties on the trip page + stop
-- cards. A trip references one scheme by slug.
CREATE TABLE IF NOT EXISTS public.tripguide_color_schemes (
  slug       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  palette    JSONB NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE public.tripguide_color_schemes ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.tripguide_color_schemes TO tripguide_role;


-- ── Trips ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tripguide_trips (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  color_scheme TEXT NOT NULL DEFAULT 'alpine'
                 REFERENCES public.tripguide_color_schemes(slug),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tripguide_trips_order
  ON public.tripguide_trips(sort_order, created_at);
ALTER TABLE public.tripguide_trips ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.tripguide_trips TO tripguide_role;


-- ── Stops (the "cards") ──────────────────────────────────────────────────────
-- content_html holds admin-authored HTML rendered inside a standard card frame.
CREATE TABLE IF NOT EXISTS public.tripguide_stops (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      UUID NOT NULL REFERENCES public.tripguide_trips(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  content_html TEXT NOT NULL DEFAULT '',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tripguide_stops_trip
  ON public.tripguide_stops(trip_id, sort_order);
ALTER TABLE public.tripguide_stops ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.tripguide_stops TO tripguide_role;
