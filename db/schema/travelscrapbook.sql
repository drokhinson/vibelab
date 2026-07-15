-- ─────────────────────────────────────────────────────────────────────────────
-- Travel Scrapbook — current schema snapshot
-- Last updated: 2026-07-15 (matches db/migrations/travelscrapbook/004_places_sources.sql)
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.travelscrapbook_profiles (
  id           UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT        NOT NULL,
  username     TEXT        UNIQUE NOT NULL,
  is_admin     BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- icon = custom SVG sprite slug (assets/sprites/categories/travel-scrapbook-cat-<icon>.svg)
CREATE TABLE IF NOT EXISTS public.travelscrapbook_categories (
  slug       TEXT    PRIMARY KEY,
  label      TEXT    NOT NULL,
  icon       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL
);
-- Seeded (002_seed.sql): restaurant, cafe, bar, sight, activity, shop, lodging, other

CREATE TABLE IF NOT EXISTS public.travelscrapbook_trips (
  id                      UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID             NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  name                    TEXT             NOT NULL,
  destination             TEXT,
  cover_icon              TEXT             NOT NULL DEFAULT 'plane',  -- sprite slug
  start_date              DATE,
  end_date                DATE,
  notes                   TEXT,
  lat                     DOUBLE PRECISION,  -- geocoded destination (trip matching)
  lng                     DOUBLE PRECISION,
  geocode_confidence      TEXT             NOT NULL DEFAULT 'none'
    CHECK (geocode_confidence IN ('high', 'medium', 'low', 'none')),
  geocode_display_name    TEXT,
  destination_geocoded_at TIMESTAMPTZ,     -- NULL = never attempted (drives lazy backfill)
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- idx_ts_trips_user (user_id)

CREATE TABLE IF NOT EXISTS public.travelscrapbook_anchors (
  id                 UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id            UUID             NOT NULL REFERENCES public.travelscrapbook_trips(id) ON DELETE CASCADE,
  role               TEXT             NOT NULL CHECK (role IN ('start', 'end', 'stay')),
  label              TEXT             NOT NULL,
  query              TEXT             NOT NULL,
  lat                DOUBLE PRECISION,
  lng                DOUBLE PRECISION,
  geocode_confidence TEXT             NOT NULL DEFAULT 'none'
    CHECK (geocode_confidence IN ('high', 'medium', 'low', 'none')),
  type               TEXT             -- start/end only: airport | train_station | car_rental | other
    CHECK (type IS NULL OR type IN ('airport', 'train_station', 'car_rental', 'other')),
  stay_date          DATE,            -- stay only: a check-in day within the trip's date range
  created_at         TIMESTAMPTZ      NOT NULL DEFAULT now()
);
-- idx_ts_anchors_trip (trip_id)
-- idx_ts_anchors_endpoint UNIQUE (trip_id, role) WHERE role IN ('start', 'end')

-- One capture event: the URL + og metadata + how the user stumbled on it.
-- Processing/failure state lives here (not on scraps); the enrichment pipeline
-- fans one source out into N places.
CREATE TABLE IF NOT EXISTS public.travelscrapbook_sources (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  url            TEXT        NOT NULL,
  url_normalized TEXT        NOT NULL,   -- dedupe key (tracking params/fragment stripped)
  source_domain  TEXT,
  status         TEXT        NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'ready', 'failed')),
  error_kind     TEXT,                   -- network | blocked | llm | no_place
  captured_via   TEXT        NOT NULL DEFAULT 'paste'
    CHECK (captured_via IN ('paste', 'bookmarklet', 'share', 'shortcut')),
  shared_text    TEXT,                   -- share-sheet caption; extra LLM context
  capture_notes  TEXT,                   -- user's note at capture; copied onto created scraps
  trip_hint_id   UUID        REFERENCES public.travelscrapbook_trips(id) ON DELETE SET NULL,
  og_title       TEXT,
  og_description TEXT,
  og_image_url   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- idx_ts_sources_user_url UNIQUE (user_id, url_normalized)
-- idx_ts_sources_user_status (user_id, status)

-- Canonical place — the source of truth. Per-user for now; osm_type/osm_id
-- (from Nominatim) are the forward path to global cross-user dedupe.
CREATE TABLE IF NOT EXISTS public.travelscrapbook_places (
  id                   UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID             NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  name                 TEXT             NOT NULL,
  name_normalized      TEXT             NOT NULL,  -- dedupe key (accent/case/punct-folded)
  city                 TEXT,
  country              TEXT,
  category             TEXT             NOT NULL DEFAULT 'other'
    REFERENCES public.travelscrapbook_categories(slug),
  lat                  DOUBLE PRECISION,
  lng                  DOUBLE PRECISION,
  geocode_confidence   TEXT             NOT NULL DEFAULT 'none'
    CHECK (geocode_confidence IN ('high', 'medium', 'low', 'none')),
  geocode_display_name TEXT,
  osm_type             TEXT,
  osm_id               BIGINT,
  maps_url             TEXT,
  created_at           TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ      NOT NULL DEFAULT now()
);
-- idx_ts_places_user_name (user_id, name_normalized)

-- N sources ↔ N places (one reel mentions many places; one place arrives from
-- many URLs).
CREATE TABLE IF NOT EXISTS public.travelscrapbook_place_sources (
  place_id   UUID        NOT NULL REFERENCES public.travelscrapbook_places(id) ON DELETE CASCADE,
  source_id  UUID        NOT NULL REFERENCES public.travelscrapbook_sources(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (place_id, source_id)
);

-- Personal bearer tokens for the iOS-Shortcut capture path. token_hash is
-- sha256 hex (deterministic → indexable lookup-by-token; safe for 256-bit
-- random tokens). One active token per user, enforced app-side.
CREATE TABLE IF NOT EXISTS public.travelscrapbook_capture_tokens (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  token_hash   TEXT        NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ                     -- soft revoke; active = revoked_at IS NULL
);
-- idx_ts_capture_tokens_user (user_id)

-- A scrap = the user's saved place, in a trip or in the inbox.
-- status: inbox (no trip) | staged (auto-matched to a trip, awaiting review)
--       | approved (a normal trip scrap — the only status routes/exports use).
CREATE TABLE IF NOT EXISTS public.travelscrapbook_scraps (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        UUID        REFERENCES public.travelscrapbook_trips(id) ON DELETE CASCADE,  -- NULL = inbox
  user_id        UUID        NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  place_id       UUID        NOT NULL REFERENCES public.travelscrapbook_places(id) ON DELETE CASCADE,
  status         TEXT        NOT NULL DEFAULT 'inbox'
    CHECK (status IN ('inbox', 'staged', 'approved')),
  notes          TEXT,
  is_favorite    BOOLEAN     NOT NULL DEFAULT false,
  route_position INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- idx_ts_scraps_trip (trip_id), idx_ts_scraps_user (user_id)
-- idx_ts_scraps_user_status (user_id, status), idx_ts_scraps_place (place_id)
