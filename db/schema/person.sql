-- ─────────────────────────────────────────────────────────────────────────────
-- person — current schema snapshot
-- Last updated: 2026-08-04 (through db/migrations/person/005_trip_icon.sql)
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- David Rokhinson's personal page: admin-editable travel trips + stops.
-- Backend-only access via service role; writes gated by ADMIN_API_KEY.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.person_trips (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT        UNIQUE NOT NULL,          -- URL segment: /travel/:slug
  title           TEXT        NOT NULL,                 -- card + tab title
  eyebrow         TEXT,                                 -- hero kicker on the trip page
  headline        TEXT,                                 -- hero H1
  lede            TEXT,                                 -- hero paragraph
  photo_album_url TEXT,                                 -- external photo album link
  icon_url        TEXT,                                 -- card art image URL; empty/NULL = default arrow SVG
  card_cta        TEXT,                                 -- card CTA text (default "Follow the route ↗")
  sort_order      INT         NOT NULL DEFAULT 0,       -- order of cards on the about page
  is_published    BOOLEAN     NOT NULL DEFAULT true,    -- false = draft, hidden from public list
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- idx_person_trips_sort (sort_order)

CREATE TABLE IF NOT EXISTS public.person_trip_stops (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      UUID        NOT NULL REFERENCES public.person_trips(id) ON DELETE CASCADE,
  title        TEXT        NOT NULL,                    -- stop card title (city)
  meta         TEXT,                                    -- stop card subline
  note         TEXT,                                    -- stop card teaser
  html_content TEXT        NOT NULL,                    -- full HTML page shown in the popup iframe
  sort_order   INT         NOT NULL DEFAULT 0,          -- position within the trip
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- idx_person_stops_trip (trip_id)
-- idx_person_stops_order (trip_id, sort_order)

-- Single-row profile block for the about page (id is pinned to 1).
-- photo_path reserved for future bucket storage; editor is text-only today.
CREATE TABLE IF NOT EXISTS public.person_profile (
  id         SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton row
  name       TEXT        NOT NULL,                              -- display name (H1)
  role       TEXT,                                              -- role/title line
  bio        TEXT,                                              -- bio paragraph
  photo_path TEXT,                                              -- reserved for future bucket storage
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
