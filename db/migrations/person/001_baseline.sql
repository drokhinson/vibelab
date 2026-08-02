-- ─────────────────────────────────────────────────────────────────────────────
-- person — baseline
-- David Rokhinson's personal page (landing/about.html): admin-editable travel
-- trips and their stops. Each trip has its own URL (/travel/:slug) and a list of
-- stops; each stop stores a self-contained HTML "postcard" page shown in a popup.
-- All access is backend-only via service role (no Data API grants, no RPCs).
-- Writes are gated by the shared ADMIN_API_KEY (auth.py require_admin).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Project role ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'person_role') THEN
    CREATE ROLE person_role LOGIN PASSWORD 'change-me-via-shared-003' NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO person_role;


-- ── Trips ────────────────────────────────────────────────────────────────────
-- slug is the URL segment: /travel/:slug. sort_order controls the card order on
-- the about page. is_published hides drafts from the public list endpoint.
CREATE TABLE IF NOT EXISTS public.person_trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  eyebrow TEXT,
  headline TEXT,
  lede TEXT,
  photo_album_url TEXT,
  card_cta TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  is_published BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_person_trips_sort ON public.person_trips(sort_order);
ALTER TABLE public.person_trips ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.person_trips TO person_role;


-- ── Trip stops ───────────────────────────────────────────────────────────────
-- html_content is a full, self-contained HTML page rendered in a sandboxed
-- iframe popup on the trip page. title/meta/note drive the stop card; sort_order
-- is the position within the trip.
CREATE TABLE IF NOT EXISTS public.person_trip_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES public.person_trips(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  meta TEXT,
  note TEXT,
  html_content TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_person_stops_trip ON public.person_trip_stops(trip_id);
CREATE INDEX IF NOT EXISTS idx_person_stops_order ON public.person_trip_stops(trip_id, sort_order);
ALTER TABLE public.person_trip_stops ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.person_trip_stops TO person_role;
