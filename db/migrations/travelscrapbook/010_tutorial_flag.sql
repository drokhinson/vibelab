-- 010_tutorial_flag.sql — first-run tutorial tracking.
--
-- NULL = the user has never seen (or dismissed) the tour → the web app
-- auto-launches it once after login. Stored on the profile (not
-- localStorage) so it follows the user across devices.

ALTER TABLE public.travelscrapbook_profiles
  ADD COLUMN tutorial_seen_at TIMESTAMPTZ;
