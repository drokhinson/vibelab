-- TripGuide — current schema snapshot
-- Last updated: 2026-08-02 (through db/migrations/tripguide/002_seed.sql)
-- FOR REFERENCE ONLY — apply changes via db/migrations/

-- Color-scheme presets. palette JSONB keys: primary, bg, surface, text, accent, muted.
CREATE TABLE IF NOT EXISTS public.tripguide_color_schemes (
  slug       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  palette    JSONB NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Trips. Each references one color scheme by slug.
CREATE TABLE IF NOT EXISTS public.tripguide_trips (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  color_scheme TEXT NOT NULL DEFAULT 'alpine' REFERENCES public.tripguide_color_schemes(slug),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tripguide_trips_order ON public.tripguide_trips(sort_order, created_at);

-- Stops ("cards"). content_html holds admin-authored HTML.
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
CREATE INDEX IF NOT EXISTS idx_tripguide_stops_trip ON public.tripguide_stops(trip_id, sort_order);
