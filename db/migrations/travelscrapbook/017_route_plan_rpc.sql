-- ─────────────────────────────────────────────────────────────────────────────
-- Travel Scrapbook — route + timeline persistence in one call.
--
-- "Sort my route" used to write only route_position (travelscrapbook_set_
-- route_positions, migration 015). It is now checkpoint-aware and also lays
-- unscheduled plans onto the timeline, so it needs to write plan_date too.
-- This RPC does both in a single statement.
--
-- Fill-unscheduled contract (matches the product decision): plan_date is set
-- ONLY when the incoming value is non-null AND the row's existing plan_date is
-- NULL. So a plan the user already hand-scheduled is never moved, and re-running
-- the sort is idempotent for plan_date (only route_position recomputes). The
-- backend already filters to unscheduled plans; the SQL CASE is the safety net.
--
-- p_trip_id scopes the UPDATE so a stray membership id can't touch another
-- trip's rows; the calling route still verifies trip write access first.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION public.travelscrapbook_set_route_plan(
  p_trip_id UUID,
  p_rows    JSONB
)
RETURNS VOID
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE travelscrapbook_scrap_trips m
  SET route_position = x.pos,
      plan_date = CASE
        WHEN x.plan_date IS NOT NULL AND m.plan_date IS NULL
          THEN x.plan_date
        ELSE m.plan_date
      END
  FROM jsonb_to_recordset(p_rows) AS x(id UUID, pos INT, plan_date DATE)
  WHERE m.id = x.id
    AND m.trip_id = p_trip_id
$$;

-- SECURITY DEFINER + service-role-only: never callable through the Data API
-- roles (same lock-down as the 015 RPCs).
REVOKE EXECUTE ON FUNCTION public.travelscrapbook_set_route_plan(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;

COMMIT;

-- Note: travelscrapbook_set_route_positions (015) is superseded by this
-- function and no longer called by any route. It is left in place to avoid a
-- destructive migration.
