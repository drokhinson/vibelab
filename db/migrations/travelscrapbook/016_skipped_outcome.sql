-- 016_skipped_outcome.sql — a "Skipped" timeline outcome, sibling to visited_at.
--
-- The trip Timeline's per-plan checkbox cycles clear → visited → skipped → clear.
-- Both "visited" and "skipped" grey the plan on the timeline with a matching tag.
-- Unlike visited_at, skipped_at is a TIMELINE-ONLY flag: it does NOT pull the
-- place off the Wander List (GET /inbox = visited_at IS NULL) nor into the
-- Visited view — it only styles/tags the plan row. The two flags are mutually
-- exclusive at the application layer (setting one clears the other).
ALTER TABLE public.travelscrapbook_scraps
  ADD COLUMN IF NOT EXISTS skipped_at TIMESTAMPTZ;   -- NULL = not skipped; set = skipped on a trip timeline

-- No new grant needed: GRANT SELECT ON travelscrapbook_scraps TO travelscrapbook_role
-- (001_baseline) is table-wide and already covers the new column. RLS stays as-is
-- (backend uses the service role, which bypasses it).
