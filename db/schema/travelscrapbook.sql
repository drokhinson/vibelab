-- ─────────────────────────────────────────────────────────────────────────────
-- Travel Scrapbook — current schema snapshot
-- Last updated: 2026-07-17 (through db/migrations/travelscrapbook/016_skipped_outcome.sql)
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.travelscrapbook_profiles (
  id           UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT        NOT NULL,
  username     TEXT        UNIQUE NOT NULL,
  is_admin     BOOLEAN     NOT NULL DEFAULT false,
  tutorial_seen_at TIMESTAMPTZ,                  -- NULL = auto-launch the tour once (010)
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

-- country_code (ISO-3166 alpha-2) → macro-region (UN M49 subregion). Reference
-- data seeded in 006; read backend-only to tag places/trips with a region.
CREATE TABLE IF NOT EXISTS public.travelscrapbook_regions (
  country_code TEXT PRIMARY KEY,
  region       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.travelscrapbook_trips (
  id                      UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID             NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  name                    TEXT             NOT NULL,
  destination             TEXT,
  cover_icon              TEXT             NOT NULL DEFAULT 'plane',  -- sprite slug
  start_date              DATE,
  end_date                DATE,
  notes                   TEXT,
  -- Geographic scope: user picks the level, match values derived from geocoding
  -- the destination (dest_*). Drives tag-based staging + the candidates panel.
  scope_level             TEXT             NOT NULL DEFAULT 'city'
    CHECK (scope_level IN ('region', 'country', 'city')),
  dest_city               TEXT,            -- from destination geocode (address.city)
  dest_region             TEXT,            -- macro-region (UN subregion) via travelscrapbook_regions
  dest_country            TEXT,            -- from destination geocode (address.country)
  dest_country_code       TEXT,            -- ISO-3166 alpha-2 (region lookup key)
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
  role               TEXT             NOT NULL CHECK (role IN ('start', 'end', 'stay', 'travel')),  -- travel = mid-trip leg (012)
  label              TEXT             NOT NULL,
  query              TEXT             NOT NULL,
  lat                DOUBLE PRECISION,
  lng                DOUBLE PRECISION,
  geocode_confidence TEXT             NOT NULL DEFAULT 'none'
    CHECK (geocode_confidence IN ('high', 'medium', 'low', 'none')),
  type               TEXT             -- start/end/travel: airport | train_station | car_rental | other
    CHECK (type IS NULL OR type IN ('airport', 'train_station', 'car_rental', 'other')),
  stay_date          DATE,            -- stay only: a check-in day within the trip's date range
  stay_end_date      DATE,            -- stay only: check-out day (009)
  anchor_date        DATE,            -- start: arrival; end: departure; travel: leg day (009/012)
  anchor_time        TIME,            -- optional; NULL = all-day point marker (009)
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
  region               TEXT,            -- macro-region (UN subregion) via travelscrapbook_regions
  country              TEXT,
  country_code         TEXT,            -- ISO-3166 alpha-2 (region lookup key)
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

-- A scrap = the user's saved place. Since 013 it's just the place (owner fields
-- notes/rating/visited_at); its membership in each trip lives in
-- travelscrapbook_scrap_trips (a place can be in many trips at once). It stays on
-- the Wander List (GET /inbox = visited_at IS NULL) regardless of trips.
-- The five legacy single-trip columns below (trip_id/status/route_position/
-- plan_date/plan_time) are UNUSED after 013 and get dropped in 014; trip_id's FK
-- was re-pointed to ON DELETE SET NULL in 013 so deleting a trip can't delete a
-- place that lives in other trips.
CREATE TABLE IF NOT EXISTS public.travelscrapbook_scraps (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        UUID        REFERENCES public.travelscrapbook_trips(id) ON DELETE SET NULL,  -- LEGACY (013→014)
  user_id        UUID        NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  place_id       UUID        NOT NULL REFERENCES public.travelscrapbook_places(id) ON DELETE CASCADE,
  status         TEXT        NOT NULL DEFAULT 'inbox'                             -- LEGACY (013→014)
    CHECK (status IN ('inbox', 'staged', 'approved')),
  notes          TEXT,
  rating         TEXT                                -- owner's own priority (NULL = unrated)
    CHECK (rating IS NULL OR rating IN ('booked', 'must_do', 'interested', 'could_skip')),
  visited_at     TIMESTAMPTZ,                        -- NULL = on the Wander List; set = visited
  skipped_at     TIMESTAMPTZ,                        -- 016: timeline-only "Skipped" outcome (does NOT leave Wander List)
  route_position INTEGER,                            -- LEGACY (013→014) → scrap_trips.route_position
  plan_date      DATE,                               -- LEGACY (013→014) → scrap_trips.plan_date
  plan_time      TIME,                               -- LEGACY (013→014) → scrap_trips.plan_time
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- idx_ts_scraps_trip (trip_id), idx_ts_scraps_user (user_id)
-- idx_ts_scraps_user_status (user_id, status), idx_ts_scraps_place (place_id)
-- idx_ts_scraps_user_visited (user_id, visited_at)

-- Scrap ↔ trip membership (013): a place's presence on one trip, carrying that
-- trip's status + route position + timeline slot. Absence of a row = not in the
-- trip. Deleting the scrap OR the trip cascades the membership (and its vibes).
CREATE TABLE IF NOT EXISTS public.travelscrapbook_scrap_trips (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scrap_id       UUID        NOT NULL REFERENCES public.travelscrapbook_scraps(id) ON DELETE CASCADE,
  trip_id        UUID        NOT NULL REFERENCES public.travelscrapbook_trips(id)  ON DELETE CASCADE,
  status         TEXT        NOT NULL DEFAULT 'approved'
    CHECK (status IN ('staged', 'approved')),
  route_position INTEGER,
  plan_date      DATE,
  plan_time      TIME,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scrap_id, trip_id)
);
-- idx_ts_scrap_trips_trip (trip_id, status), idx_ts_scrap_trips_scrap (scrap_id)
-- idx_ts_scrap_trips_trip_plan_date (trip_id, plan_date)

-- Trip sharing: the owner stays on trips.user_id; everyone else is a row here.
-- role = viewer (read + vibe) | collaborator (read + vibe + add places).
-- status carries invite → accept: pending | accepted (has access) | declined.
CREATE TABLE IF NOT EXISTS public.travelscrapbook_trip_members (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      UUID        NOT NULL REFERENCES public.travelscrapbook_trips(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  role         TEXT        NOT NULL CHECK (role IN ('viewer', 'collaborator')),
  status       TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined')),
  invited_by   UUID        REFERENCES public.travelscrapbook_profiles(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  UNIQUE (trip_id, user_id)
);
-- idx_ts_trip_members_user (user_id, status), idx_ts_trip_members_trip (trip_id)

-- Per-user "Vibe" on a saved place FOR A TRIP — the consensus input. One per
-- person per membership; booked | must_do | interested | could_skip. Since 013
-- it keys on the membership (scrap_trip_id) so a place in >1 trip has independent
-- consensus per trip. scrap_id is LEGACY (nullable; dropped in 014).
CREATE TABLE IF NOT EXISTS public.travelscrapbook_scrap_vibes (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scrap_id      UUID        REFERENCES public.travelscrapbook_scraps(id) ON DELETE CASCADE,       -- LEGACY (013→014)
  scrap_trip_id UUID        NOT NULL REFERENCES public.travelscrapbook_scrap_trips(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  level         TEXT        NOT NULL
    CHECK (level IN ('booked', 'must_do', 'interested', 'could_skip')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scrap_trip_id, user_id)
);
-- idx_ts_scrap_vibes_membership_user (scrap_trip_id, user_id) UNIQUE
-- idx_ts_scrap_vibes_membership (scrap_trip_id)
