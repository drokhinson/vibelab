-- ─────────────────────────────────────────────────────────────────────────────
-- travelscrapbook — places/sources split + phone capture + inbox/staging
--
-- A scrap used to be "one URL glued to one extracted place, inside a trip".
-- This migration splits that into:
--   sources        — one capture event (the URL + og metadata + how it arrived)
--   places         — the canonical place (source of truth; Google-Maps-style
--                    location), deduped per user by normalized name + proximity
--   place_sources  — N sources ↔ N places (one reel can mention many places;
--                    one place can arrive from many URLs)
--   scraps         — now "the user's saved place, in a trip or in the inbox":
--                    status inbox | staged (auto-matched to a trip, awaiting
--                    review) | approved. Processing/failure state moves to the
--                    source. trip_id becomes nullable (NULL = inbox).
--   capture_tokens — personal bearer tokens for the iOS-Shortcut capture path.
-- Trips gain a geocoded destination (lat/lng) so new places can be matched to
-- nearby trips; coordinates are backfilled lazily by the backend (Nominatim is
-- HTTP — can't be called from SQL).
--
-- places.osm_type/osm_id record Nominatim's OSM identity — the forward path to
-- global (cross-user) place dedupe when scraps become browsable by all users.
-- All access is backend-only via service role (no Data API grants, no RPCs).
-- Idempotent: safe to re-run; the scrap restructure is gated on the old shape.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Sources (one capture event: the URL and how the user stumbled on it) ─────
CREATE TABLE IF NOT EXISTS public.travelscrapbook_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  url_normalized TEXT NOT NULL,
  source_domain TEXT,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'ready', 'failed')),
  error_kind TEXT,
  captured_via TEXT NOT NULL DEFAULT 'paste'
    CHECK (captured_via IN ('paste', 'bookmarklet', 'share', 'shortcut')),
  shared_text TEXT,
  capture_notes TEXT,
  trip_hint_id UUID REFERENCES public.travelscrapbook_trips(id) ON DELETE SET NULL,
  og_title TEXT,
  og_description TEXT,
  og_image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ts_sources_user_url
  ON public.travelscrapbook_sources(user_id, url_normalized);
CREATE INDEX IF NOT EXISTS idx_ts_sources_user_status
  ON public.travelscrapbook_sources(user_id, status);
ALTER TABLE public.travelscrapbook_sources ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.travelscrapbook_sources TO travelscrapbook_role;


-- ── Places (canonical place — the source of truth) ───────────────────────────
CREATE TABLE IF NOT EXISTS public.travelscrapbook_places (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  city TEXT,
  country TEXT,
  category TEXT NOT NULL DEFAULT 'other' REFERENCES public.travelscrapbook_categories(slug),
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  geocode_confidence TEXT NOT NULL DEFAULT 'none'
    CHECK (geocode_confidence IN ('high', 'medium', 'low', 'none')),
  geocode_display_name TEXT,
  osm_type TEXT,
  osm_id BIGINT,
  maps_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ts_places_user_name
  ON public.travelscrapbook_places(user_id, name_normalized);
ALTER TABLE public.travelscrapbook_places ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.travelscrapbook_places TO travelscrapbook_role;


-- ── Place ↔ Source links ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.travelscrapbook_place_sources (
  place_id UUID NOT NULL REFERENCES public.travelscrapbook_places(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.travelscrapbook_sources(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (place_id, source_id)
);
ALTER TABLE public.travelscrapbook_place_sources ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.travelscrapbook_place_sources TO travelscrapbook_role;


-- ── Capture tokens (iOS Shortcut auth) ───────────────────────────────────────
-- token_hash is sha256 hex of the plaintext token. A deterministic digest (not
-- bcrypt) is deliberate: tokens are 256-bit random so offline guessing is moot,
-- and /capture must look the row up BY token — which needs an indexable hash.
-- One active token per user, enforced app-side (creating revokes the previous).
CREATE TABLE IF NOT EXISTS public.travelscrapbook_capture_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ts_capture_tokens_user
  ON public.travelscrapbook_capture_tokens(user_id);
ALTER TABLE public.travelscrapbook_capture_tokens ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.travelscrapbook_capture_tokens TO travelscrapbook_role;


-- ── Trips: geocoded destination for trip matching ────────────────────────────
-- destination_geocoded_at NULL = never attempted; the backend lazily geocodes
-- (and always stamps the timestamp, even on a miss, so Nominatim isn't hammered
-- on every trips list).
ALTER TABLE public.travelscrapbook_trips
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS geocode_confidence TEXT NOT NULL DEFAULT 'none'
    CHECK (geocode_confidence IN ('high', 'medium', 'low', 'none')),
  ADD COLUMN IF NOT EXISTS geocode_display_name TEXT,
  ADD COLUMN IF NOT EXISTS destination_geocoded_at TIMESTAMPTZ;


-- ── Scraps: restructure + backfill ───────────────────────────────────────────
-- Gated on the old shape (source_url still present) so re-runs are no-ops.
-- SQL-side URL/name normalization is a coarse one-time approximation of the
-- backend's richer Python normalizers; a mismatch only means a re-shared old
-- URL creates a fresh source row (harmless).
DO $$
DECLARE
  cname TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'travelscrapbook_scraps'
      AND column_name = 'source_url'
  ) THEN
    RETURN;  -- already restructured
  END IF;

  -- 1. Sources: one per distinct (user, normalized URL), newest scrap wins.
  --    pending scraps map to failed/network: their queued BackgroundTasks did
  --    not survive the deploy; the retry affordance re-runs them.
  INSERT INTO public.travelscrapbook_sources
    (user_id, url, url_normalized, source_domain, status, error_kind,
     captured_via, trip_hint_id, og_title, og_description, og_image_url,
     created_at, updated_at)
  SELECT DISTINCT ON (s.user_id, norm.url_normalized)
    s.user_id, s.source_url, norm.url_normalized, s.source_domain,
    CASE WHEN s.status = 'ready' THEN 'ready' ELSE 'failed' END,
    CASE WHEN s.status = 'ready' THEN NULL
         WHEN s.status = 'failed' THEN COALESCE(s.error_kind, 'network')
         ELSE 'network' END,
    'paste', s.trip_id, s.og_title, s.og_description, s.og_image_url,
    s.created_at, s.updated_at
  FROM public.travelscrapbook_scraps s
  CROSS JOIN LATERAL (
    SELECT rtrim(lower(regexp_replace(regexp_replace(
             s.source_url, '^https?://(www\.)?', '', 'i'), '[?#].*$', '')), '/')
           AS url_normalized
  ) norm
  ORDER BY s.user_id, norm.url_normalized, s.created_at DESC;

  -- 2. Places: one per distinct (user, normalized place name), from ready scraps.
  INSERT INTO public.travelscrapbook_places
    (user_id, name, name_normalized, city, country, category, lat, lng,
     geocode_confidence, geocode_display_name, maps_url, created_at, updated_at)
  SELECT DISTINCT ON (s.user_id, norm.name_normalized)
    s.user_id,
    COALESCE(s.place_name, s.og_title, s.source_domain, 'Saved place'),
    norm.name_normalized,
    s.place_city, s.place_country, s.category, s.lat, s.lng,
    s.geocode_confidence, s.geocode_display_name, s.maps_url,
    s.created_at, s.updated_at
  FROM public.travelscrapbook_scraps s
  CROSS JOIN LATERAL (
    SELECT btrim(regexp_replace(
             lower(COALESCE(s.place_name, s.og_title, s.source_domain, 'Saved place')),
             '[^a-z0-9]+', ' ', 'g'))
           AS name_normalized
  ) norm
  WHERE s.status = 'ready'
  ORDER BY s.user_id, norm.name_normalized, s.created_at DESC;

  -- 3. Link each ready scrap's place to its source.
  INSERT INTO public.travelscrapbook_place_sources (place_id, source_id, created_at)
  SELECT DISTINCT p.id, src.id, s.created_at
  FROM public.travelscrapbook_scraps s
  CROSS JOIN LATERAL (
    SELECT rtrim(lower(regexp_replace(regexp_replace(
             s.source_url, '^https?://(www\.)?', '', 'i'), '[?#].*$', '')), '/')
           AS url_normalized,
           btrim(regexp_replace(
             lower(COALESCE(s.place_name, s.og_title, s.source_domain, 'Saved place')),
             '[^a-z0-9]+', ' ', 'g'))
           AS name_normalized
  ) norm
  JOIN public.travelscrapbook_sources src
    ON src.user_id = s.user_id AND src.url_normalized = norm.url_normalized
  JOIN public.travelscrapbook_places p
    ON p.user_id = s.user_id AND p.name_normalized = norm.name_normalized
  WHERE s.status = 'ready'
  ON CONFLICT DO NOTHING;

  -- 4. Restructure scraps into "saved place in a trip or the inbox".
  ALTER TABLE public.travelscrapbook_scraps
    ADD COLUMN place_id UUID REFERENCES public.travelscrapbook_places(id) ON DELETE CASCADE;
  ALTER TABLE public.travelscrapbook_scraps
    ALTER COLUMN trip_id DROP NOT NULL;

  UPDATE public.travelscrapbook_scraps s
  SET place_id = p.id
  FROM public.travelscrapbook_places p
  WHERE s.status = 'ready'
    AND p.user_id = s.user_id
    AND p.name_normalized = btrim(regexp_replace(
          lower(COALESCE(s.place_name, s.og_title, s.source_domain, 'Saved place')),
          '[^a-z0-9]+', ' ', 'g'));

  -- Failure now lives on the source (with trip_hint_id preserved for retry);
  -- pending/failed scrap rows have no place and are dropped.
  DELETE FROM public.travelscrapbook_scraps WHERE status <> 'ready';

  -- One scrap per (user, place) — matches the enrichment rule that a place the
  -- user already saved never gets a second scrap. Keep the row carrying the
  -- most user intent (favorite > has notes > earliest save).
  DELETE FROM public.travelscrapbook_scraps s
  USING (
    SELECT id, row_number() OVER (
      PARTITION BY user_id, place_id
      ORDER BY is_favorite DESC, (notes IS NOT NULL) DESC, created_at ASC
    ) AS rn
    FROM public.travelscrapbook_scraps
  ) ranked
  WHERE s.id = ranked.id AND ranked.rn > 1;

  -- Swap the status CHECK before rewriting statuses (the old CHECK would
  -- reject 'approved'). The name is auto-generated — look it up, don't hardcode.
  FOR cname IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.travelscrapbook_scraps'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.travelscrapbook_scraps DROP CONSTRAINT %I', cname);
  END LOOP;

  -- Existing scraps were explicitly filed into trips → approved, so route
  -- optimization and exports behave exactly as before for existing users.
  UPDATE public.travelscrapbook_scraps SET status = 'approved' WHERE status = 'ready';

  ALTER TABLE public.travelscrapbook_scraps
    ADD CONSTRAINT travelscrapbook_scraps_status_check
    CHECK (status IN ('inbox', 'staged', 'approved'));
  ALTER TABLE public.travelscrapbook_scraps
    ALTER COLUMN status SET DEFAULT 'inbox';

  ALTER TABLE public.travelscrapbook_scraps
    ALTER COLUMN place_id SET NOT NULL;

  -- Everything that moved to places/sources leaves the scrap row.
  ALTER TABLE public.travelscrapbook_scraps
    DROP COLUMN source_url,
    DROP COLUMN source_domain,
    DROP COLUMN error_kind,
    DROP COLUMN og_title,
    DROP COLUMN og_description,
    DROP COLUMN og_image_url,
    DROP COLUMN place_name,
    DROP COLUMN place_city,
    DROP COLUMN place_country,
    DROP COLUMN category,
    DROP COLUMN lat,
    DROP COLUMN lng,
    DROP COLUMN geocode_confidence,
    DROP COLUMN geocode_display_name,
    DROP COLUMN maps_url;
END $$;

CREATE INDEX IF NOT EXISTS idx_ts_scraps_user_status
  ON public.travelscrapbook_scraps(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ts_scraps_place
  ON public.travelscrapbook_scraps(place_id);
