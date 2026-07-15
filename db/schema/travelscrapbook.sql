-- ─────────────────────────────────────────────────────────────────────────────
-- Travel Scrapbook — current schema snapshot
-- Last updated: 2026-07-15 (matches db/migrations/travelscrapbook/003_anchor_type_and_stay_date.sql)
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
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  destination TEXT,
  cover_icon  TEXT        NOT NULL DEFAULT 'plane',  -- sprite slug
  start_date  DATE,
  end_date    DATE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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

CREATE TABLE IF NOT EXISTS public.travelscrapbook_scraps (
  id                   UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id              UUID             NOT NULL REFERENCES public.travelscrapbook_trips(id) ON DELETE CASCADE,
  user_id              UUID             NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  source_url           TEXT             NOT NULL,
  source_domain        TEXT,
  status               TEXT             NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'failed')),
  error_kind           TEXT,            -- network | blocked | llm | geocode
  og_title             TEXT,
  og_description       TEXT,
  og_image_url         TEXT,
  place_name           TEXT,
  place_city           TEXT,
  place_country        TEXT,
  category             TEXT             NOT NULL DEFAULT 'other'
    REFERENCES public.travelscrapbook_categories(slug),
  lat                  DOUBLE PRECISION,
  lng                  DOUBLE PRECISION,
  geocode_confidence   TEXT             NOT NULL DEFAULT 'none'
    CHECK (geocode_confidence IN ('high', 'medium', 'low', 'none')),
  geocode_display_name TEXT,
  maps_url             TEXT,
  notes                TEXT,
  is_favorite          BOOLEAN          NOT NULL DEFAULT false,
  route_position       INTEGER,
  created_at           TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ      NOT NULL DEFAULT now()
);
-- idx_ts_scraps_trip (trip_id), idx_ts_scraps_user (user_id)
