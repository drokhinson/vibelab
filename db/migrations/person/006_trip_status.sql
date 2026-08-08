-- ─────────────────────────────────────────────────────────────────────────────
-- person — 006 trip status
-- A trip is now one of three things: 'upcoming' (announced, not started),
-- 'live' (happening now) or 'complete' (over). The about-page card grid renders
-- each differently (live bubble / greyed-out UPCOMING card), and the trip page
-- uses it to pick the stop list's default order — live reads newest-first, the
-- other two read 01-first.
--
-- The default is written twice on purpose. The ADD COLUMN default is what
-- backfills the rows that already exist, and every existing trip is one that has
-- been happening under the old newest-first default — so they backfill to 'live'
-- and their stop order is unchanged. New trips should land as 'upcoming', so the
-- column default is flipped straight afterwards; the backfill has already run by
-- then and is unaffected.
--
-- No new table, so no RLS/GRANT block — the column inherits the grants already
-- on person_trips from 001_baseline.sql.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.person_trips
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'live';

ALTER TABLE public.person_trips
  ALTER COLUMN status SET DEFAULT 'upcoming';

-- ADD CONSTRAINT has no IF NOT EXISTS, so guard on the catalog to keep the
-- migration re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'person_trips_status_check'
  ) THEN
    ALTER TABLE public.person_trips
      ADD CONSTRAINT person_trips_status_check
      CHECK (status IN ('upcoming', 'live', 'complete'));
  END IF;
END $$;
