-- ─────────────────────────────────────────────────────────────────────────────
-- person — 004 profile
-- Backend-persisted profile block for landing/about.html (name, role, bio,
-- photo). Previously static HTML; now admin-editable via the about-page profile
-- pencil. Single-row (singleton) table: the page has exactly one profile.
-- Backend-only access via service role; writes gated by ADMIN_API_KEY.
-- photo_path is reserved for a future Supabase bucket-storage flow — the current
-- editor is text-only and this column is not user-editable yet.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.person_profile (
  id         SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton row
  name       TEXT        NOT NULL,
  role       TEXT,
  bio        TEXT,
  photo_path TEXT,                                              -- reserved for future bucket storage
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.person_profile ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.person_profile TO person_role;

-- Seed the singleton row from the values the page shipped with as static HTML.
INSERT INTO public.person_profile (id, name, role, bio, photo_path) VALUES
  (1,
   'David Rokhinson',
   'Software Engineer',
   'Software engineer with a passion for biking, soccer, travel and everything in between. This is my corner of vibelab — a place to collect the projects, trips and stories worth keeping.',
   'assets/photos/david-summit.jpg')
ON CONFLICT (id) DO NOTHING;
