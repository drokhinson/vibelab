-- ─────────────────────────────────────────────────────────────────────────────
-- travelscrapbook — 022: drop the orphaned route-write RPCs
--
-- Route ordering is computed client-side (web/domain/route-plan.js) and the
-- backend's POST /trips/{id}/route/optimize endpoint — the only caller of
-- travelscrapbook_set_route_plan — was removed in the code-review cleanup.
-- travelscrapbook_set_route_positions was already dead: superseded by
-- set_route_plan back in migration 017 and never called since.
--
-- Neither function has any remaining caller (backend, trigger, or other RPC),
-- so both are safe to drop. The scraps.route_position column and its readers
-- are untouched — this removes only the unused write path.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.travelscrapbook_set_route_plan(UUID, JSONB);
DROP FUNCTION IF EXISTS public.travelscrapbook_set_route_positions(JSONB);
