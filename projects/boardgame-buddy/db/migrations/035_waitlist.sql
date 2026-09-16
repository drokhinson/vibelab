-- 035_waitlist.sql — pre-launch email capture for the landing page.
--
-- Deliberately standalone and deliberately temporary. The landing view exists
-- only while COMING_SOON is on; once the app goes live at bgbuddy.app this
-- table stops being written to, and it can be exported and dropped. Nothing
-- else references it, so dropping it later is a one-liner.
--
-- No FK to auth.users and no RLS policy for the anon role: the row is written
-- by the backend with the service-role key (see routes/waitlist_routes.py),
-- never by the browser, so the anon key cannot read the list. That matters —
-- an email list readable by anyone who views the page would be a leak.

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_waitlist (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  source     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedupe on the case-folded address, so Alice@x.com and alice@x.com are one
-- signup. A functional unique index rather than a UNIQUE column, because the
-- original casing is worth keeping for when the mail actually goes out.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bgb_waitlist_email_lower
  ON public.boardgamebuddy_waitlist (lower(email));

CREATE INDEX IF NOT EXISTS idx_bgb_waitlist_created_at
  ON public.boardgamebuddy_waitlist (created_at DESC);

-- RLS on with NO policies = nothing reaches the anon or authenticated roles.
-- The service-role key used by the backend bypasses RLS, which is exactly the
-- split we want: the page can add an address, nobody can read the list.
ALTER TABLE public.boardgamebuddy_waitlist ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.boardgamebuddy_waitlist IS
  'Pre-launch landing-page signups. Written only by the backend service role; RLS with no policies keeps it unreadable from the browser. Temporary — export and drop after launch.';
