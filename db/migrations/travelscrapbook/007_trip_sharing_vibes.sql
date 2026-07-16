-- ─────────────────────────────────────────────────────────────────────────────
-- travelscrapbook — trip sharing (viewer/collaborator) + per-traveler "Vibes"
--
-- 1. travelscrapbook_trip_members — share a trip with other users. The owner
--    stays on travelscrapbook_trips.user_id (NOT a member row); everyone else is
--    a row here. role = viewer (read + vibe) | collaborator (read + vibe + add
--    places). status carries the invite → accept flow: pending (invited) |
--    accepted (has access) | declined. Only 'accepted' rows grant trip access.
-- 2. travelscrapbook_scrap_vibes — each traveler's own take on a saved place,
--    one of booked | must_do | interested | could_skip, rolled up into a group
--    consensus on the card. One vibe per person per scrap (UNIQUE scrap_id,
--    user_id) so ratings never collide across users. Present on all trips (a
--    solo trip just has one voter).
--
-- Both tables are service-role-only (backend uses SUPABASE_SERVICE_ROLE_KEY):
-- RLS enabled with no policies + SELECT granted to travelscrapbook_role for
-- direct psql/TablePlus reads. No Data-API (authenticated) grant — the frontend
-- never touches Supabase directly. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Trip members (sharing + invite state).
CREATE TABLE IF NOT EXISTS public.travelscrapbook_trip_members (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      UUID        NOT NULL REFERENCES public.travelscrapbook_trips(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  role         TEXT        NOT NULL CHECK (role IN ('viewer', 'collaborator')),
  status       TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined')),
  invited_by   UUID        REFERENCES public.travelscrapbook_profiles(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,                    -- when the invitee accepted/declined
  UNIQUE (trip_id, user_id)
);
-- "trips shared with me" (list_trips) filters (user_id, status='accepted');
-- "who's on this trip" (members list) filters (trip_id).
CREATE INDEX IF NOT EXISTS idx_ts_trip_members_user ON public.travelscrapbook_trip_members(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ts_trip_members_trip ON public.travelscrapbook_trip_members(trip_id);
ALTER TABLE public.travelscrapbook_trip_members ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.travelscrapbook_trip_members TO travelscrapbook_role;

-- 2. Per-user "Vibe" on a saved place (consensus input). One vibe per person
--    per scrap; any member/owner of the scrap's trip may set their own.
CREATE TABLE IF NOT EXISTS public.travelscrapbook_scrap_vibes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scrap_id   UUID        NOT NULL REFERENCES public.travelscrapbook_scraps(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  level      TEXT        NOT NULL
    CHECK (level IN ('booked', 'must_do', 'interested', 'could_skip')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scrap_id, user_id)
);
-- Vibes are fetched per scrap batch during hydration (.in_ scrap_id).
CREATE INDEX IF NOT EXISTS idx_ts_scrap_vibes_scrap ON public.travelscrapbook_scrap_vibes(scrap_id);
ALTER TABLE public.travelscrapbook_scrap_vibes ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.travelscrapbook_scrap_vibes TO travelscrapbook_role;
